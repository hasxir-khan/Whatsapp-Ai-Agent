// src/services/tts.js
// Voice replies ("send me a voice note") for $0.
//
// Providers, in order:
//   edge → Microsoft Edge neural voices (free, no key, 100+ languages)
//   groq → Groq Orpheus (excellent English/Arabic, tiny per-character cost)
// Output is converted to Ogg/Opus so WhatsApp shows a real voice note (PTT).
// Without ffmpeg it still works — the note arrives as a normal audio file.

import fs from 'node:fs';
import { config } from '../config/env.js';
import { bumpUsage, getUsage, logEvent } from '../utils/db.js';
import { voiceForLanguage } from './language.js';
import { forSpeech } from '../core/humanizer.js';
import { synthesizeEdge } from './edgeTts.js';
import { hasFfmpeg, toOggOpus } from './ffmpeg.js';
import { tempFile, cleanupPath } from './media.js';

const voiceMap = () => config.owner.profile?.bot?.voice?.voiceByLanguage || {};

export function ttsEnabled() {
  const mode = config.tts.mode;
  if (mode === 'off' || mode === 'never' || !mode) return false;
  const anyProvider =
    config.tts.providers.includes('edge') ||
    (config.tts.providers.includes('groq') && !!config.keys.groq);
  return anyProvider && (config.owner.profile?.bot?.voice?.enabled ?? true);
}

function withinQuota(chars) {
  const used = getUsage().tts_chars || 0;
  return used + chars <= config.limits.dailyTtsChars;
}

/** Trim to something a voice note can handle, cutting at a sentence boundary. */
function speechChunk(text, maxChars) {
  const clean = forSpeech(text);
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return (lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut).trim();
}

async function groqSpeech(text) {
  if (!config.keys.groq) return null;
  const isArabic = /[\u0600-\u06FF]/.test(text);
  const model = isArabic ? 'canopylabs/orpheus-arabic-saudi' : config.tts.groqModelEnglish;
  const voice = isArabic ? 'fahad' : config.tts.groqVoice;

  const res = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.keys.groq}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      voice,
      input: text.slice(0, 195), // Orpheus caps at 200 characters
      response_format: 'wav',
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    const raw = await res.text();
    logEvent('tts_groq_error', null, `${res.status} ${raw.slice(0, 160)}`);
    return null;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer.length > 1000 ? { buffer, ext: 'wav', provider: 'groq', model } : null;
}

/**
 * Render text to speech.
 * @param {string} text
 * @param {{langInfo?:object, number?:string}} opts
 * @returns {Promise<{buffer:Buffer, ext:string, provider:string, model?:string}|null>}
 */
export async function synthesize(text, { langInfo } = {}) {
  if (!text || !ttsEnabled()) return null;

  const chunk = speechChunk(text, config.tts.maxChars);
  if (chunk.length < 2) return null;
  if (!withinQuota(chunk.length)) {
    logEvent('tts_quota_reached', null, chunk.length);
    return null;
  }

  for (const provider of config.tts.providers) {
    try {
      if (provider === 'edge') {
        const voice = config.tts.edgeVoice || voiceForLanguage(langInfo, voiceMap());
        const buffer = await synthesizeEdge(chunk, { voice });
        if (buffer?.length > 1000) {
          bumpUsage('tts_chars', chunk.length);
          return { buffer, ext: 'mp3', provider: 'edge', model: voice };
        }
      }

      if (provider === 'groq') {
        // Orpheus only has English + Saudi Arabic — don't mangle other languages
        if (langInfo && !['en', 'roman-ur', 'ar', 'unknown'].includes(langInfo.code)) continue;
        const result = await groqSpeech(chunk);
        if (result) {
          bumpUsage('tts_chars', chunk.length);
          return result;
        }
      }
    } catch (err) {
      logEvent('tts_error', null, `${provider}: ${err.message}`);
    }
  }

  return null;
}

/**
 * Build the Baileys payload for a voice note.
 * @returns {Promise<{payload:object, provider:string}|null>}
 */
export async function buildVoiceNote(text, { langInfo } = {}) {
  const audio = await synthesize(text, { langInfo });
  if (!audio) return null;

  if (hasFfmpeg()) {
    const input = tempFile(audio.ext, 'tts');
    const output = tempFile('ogg', 'tts');
    try {
      fs.writeFileSync(input, audio.buffer);
      await toOggOpus(input, output);
      if (fs.existsSync(output)) {
        const buffer = fs.readFileSync(output);
        return {
          provider: audio.provider,
          payload: {
            audio: buffer,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
            seconds: estimateSeconds(text),
          },
        };
      }
    } catch (err) {
      logEvent('tts_convert_error', null, err.message);
    } finally {
      cleanupPath(input);
      cleanupPath(output);
    }
  }

  // No ffmpeg: send as a playable audio file (WhatsApp shows a player, not PTT)
  return {
    provider: audio.provider,
    payload: {
      audio: audio.buffer,
      mimetype: audio.ext === 'wav' ? 'audio/wav' : 'audio/mpeg',
      ptt: false,
      fileName: `voice-reply.${audio.ext}`,
      seconds: estimateSeconds(text),
    },
  };
}

function estimateSeconds(text) {
  const words = String(text || '').split(/\s+/).filter(Boolean).length;
  return Math.max(2, Math.round(words / 2.6));
}

const VOICE_REQUEST_RE =
  /\b(voice ?note|voice ?message|audio ?(note|message)?|send (me )?(a )?voice|bol ?kar|bol ?ke|sunao|suna ?do|speak (it|to me)|say it|record(ing)?|awaz|awaaz|samajh nahi aa raha|can'?t read)\b/i;

export function wantsVoice(text = '') {
  return VOICE_REQUEST_RE.test(String(text));
}

/**
 * @param {object} opts
 * @param {'off'|'on_request'|'match_voice'|'always'} [opts.mode]
 * @param {boolean} [opts.clientSentVoice] client sent a voice note
 * @param {string} [opts.text] what the client wrote
 */
export function shouldSpeak({ mode, clientSentVoice = false, text = '' }) {
  if (!ttsEnabled()) return false;
  const m = String(mode || config.tts.mode).toLowerCase();
  const asked = wantsVoice(text);
  if (m === 'always') return true;
  if (m === 'match_voice') return clientSentVoice || asked;
  if (m === 'on_request') return asked;
  return false;
}

export function ttsStatus() {
  return {
    enabled: ttsEnabled(),
    mode: config.tts.mode,
    providers: config.tts.providers,
    ffmpeg: hasFfmpeg(),
    usedChars: getUsage().tts_chars,
    limit: config.limits.dailyTtsChars,
  };
}

export default { synthesize, buildVoiceNote, ttsEnabled, shouldSpeak, wantsVoice, ttsStatus };
