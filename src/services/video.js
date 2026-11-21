// src/services/video.js
// "Can you see what's in this video?" — three layers, in order of quality:
//   1. Native video understanding (Gemini free tier): frames + audio in one go.
//   2. ffmpeg frames  → vision model, plus Whisper for the soundtrack.
//   3. Whisper only (audio track) when nothing can look at pixels.
// Whatever happens, the caller gets an honest description or null.

import fs from 'node:fs/promises';
import path from 'node:path';
import { detectInjection, neutralise } from '../core/injection.js';
import {
  countMedia,
  defaultTenant,
  providerGate,
  quotaCode,
  reserveMedia,
  withVideoSlot,
  MediaStop,
} from './mediaLimits.js';
import { transcriptQuality } from './voicePolicy.js';
import { config } from '../config/env.js';
import { logEvent } from '../utils/db.js';
import { analyzeVideo, analyzeFrames, visionEnabled } from './vision.js';
import { transcribe, sttEnabled } from './transcription.js';
import {
  hasFfmpeg, extractFrames, extractAudioForStt, duration, cleanup, probeClip, sceneFrames, clipAudio,
} from './ffmpeg.js';
import { writeTemp, tempDir, cleanupPath, MediaTooBigError } from './media.js';

/**
 * @param {object} opts
 * @param {Buffer} opts.buffer
 * @param {string} opts.mimetype
 * @param {string} [opts.caption] what the client typed with the video
 * @param {string} [opts.context] project/client context
 * @returns {Promise<{description:string, transcript:string, provider:string, seconds:number}|null>}
 */
export async function understandVideo({ buffer, mimetype = 'video/mp4', caption = '', context = '', declaredSeconds = 0 }) {
  if (!buffer?.length) return null;
  const notes = [];

  // 1) Best path: native video
  if (visionEnabled()) {
    const native = await analyzeVideo({ buffer, mimetype, caption, context });
    if (native?.description) {
      return {
        description: native.description,
        transcript: '',
        provider: `${native.provider}:native`,
        seconds: declaredSeconds,
      };
    }
  }

  // 2) Frames + audio
  if (hasFfmpeg()) {
    const workDir = tempDir('video');
    let videoFile = null;
    try {
      const ext = /quicktime/.test(mimetype) ? 'mov' : /webm/.test(mimetype) ? 'webm' : /3gpp/.test(mimetype) ? '3gp' : 'mp4';
      videoFile = writeTemp(buffer, ext, 'video');

      const seconds = declaredSeconds || (await duration(videoFile)) || 0;
      const frames = await extractFrames(videoFile, workDir, {
        count: config.vision.videoFrames,
        totalSeconds: seconds,
      });

      let visual = '';
      if (frames.length && visionEnabled()) {
        const frameResult = await analyzeFrames({ frames, caption, context });
        if (frameResult?.description) visual = frameResult.description;
      }

      let transcript = '';
      if (sttEnabled()) {
        const audioPath = await extractAudioForStt(videoFile, `${workDir}/audio.mp3`);
        if (audioPath) {
          const fs = await import('node:fs/promises');
          const audioBuffer = await fs.readFile(audioPath);
          const result = await transcribe(audioBuffer, { mimetype: 'audio/mpeg' });
          if (result?.text) transcript = result.text;
        }
      }

      if (visual || transcript) {
        if (visual && transcript) notes.push('On-screen / visual content:', visual, '', 'What is said in the video:', transcript);
        else if (visual) notes.push(visual);
        else notes.push('Audio transcript of the video (visuals could not be analysed):', transcript);
        return {
          description: notes.join('\n'),
          transcript,
          provider: visual ? 'frames' : 'stt-only',
          seconds,
        };
      }
    } catch (err) {
      logEvent('video_frames_error', null, err.message);
    } finally {
      cleanupPath(videoFile);
      cleanup(workDir);
    }
  }

  // 3) Last resort: just listen to the audio track. WhatsApp videos are usually
  //    mp4, which Whisper accepts directly.
  if (sttEnabled()) {
    try {
      const result = await transcribe(buffer, { mimetype: mimetype.includes('mp4') ? 'audio/mp4' : mimetype });
      if (result?.text) {
        return {
          description: `Audio transcript only (I could not see the picture):\n${result.text}`,
          transcript: result.text,
          provider: 'stt-only',
          seconds: declaredSeconds,
        };
      }
    } catch (err) {
      logEvent('video_stt_error', null, err.message);
    }
  }

  return null;
}

export function videoCapabilities() {
  return {
    native: visionEnabled() && config.vision.providers.includes('gemini'),
    frames: hasFfmpeg() && visionEnabled(),
    audioOnly: sttEnabled(),
    ready: visionEnabled() || sttEnabled(),
  };
}

export default { understandVideo, videoCapabilities };

function videoContainer(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  const type = String(mime).toLowerCase().split(';')[0];
  if (buffer.toString('ascii', 4, 8) === 'ftyp')
    return ['video/mp4', 'video/3gpp', 'video/quicktime', 'audio/mp4'].includes(type);
  return buffer.readUInt32BE(0) === 0x1a45dfa3 && ['video/webm', 'video/x-matroska', 'audio/webm'].includes(type);
}
const clean = (v, max = 180) =>
  neutralise(typeof v === 'string' ? v.slice(0, 5000) : '')
    .replace(/\[removed:[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const SUBJECTS = new Set(['product', 'shop', 'complaint', 'payment', 'other']);
const complaint = /broken|damaged|complain|not working|cracked|خراب|شکایت|ٹوٹ|kharab|toot|shikayat/i;
const sensitive =
  /\b(?:patient|injury|chest pain|medicine|medication|dose|dosage|prescription|invest(?:ment)?|loan|legal advice|diagnos\w*|medical|lawyer|lawsuit|financial advice|account number|bank|refund|receipt|paid|payment|card number|threat|hurt|suicide|violence|passport|identity card)\b|ادائیگی|رسید|مریض|قانونی|بینک|رقم|دوا|علاج|قرض|dawai|ilaaj|qarz/i;
export function summarizeClip({ speech, vision, caption = '', incomplete = false }) {
  let observed = null;
  if (vision?.description) {
    try {
      const raw = JSON.parse(vision.description.replace(/^```(?:json)?\s*|\s*```$/gi, ''));
      if (
        typeof raw.shown === 'string' &&
        typeof raw.unclear === 'boolean' &&
        typeof raw.sensitive === 'boolean' &&
        SUBJECTS.has(raw.subject)
      )
        observed = raw;
    } catch {
      /* malformed vision is not evidence */
    }
  }
  const text = [speech?.text, caption, observed?.shown, observed?.onScreenText].filter(Boolean).join('\n');
  const injection = detectInjection(text).found;
  const identityRequest =
    /\b(?:who is (?:this|that)|whose face|identify|recognize this person)\b|یہ کون ہے|yeh? kaun hai/i.test(
      [speech?.text, caption].join(' ')
    );
  const identity =
    identityRequest ||
    /\b(?:person|man|woman|girl|boy|child|face|identit\w*|identif\w*|recognis\w*|recogniz\w*|looks like|appears to be|celebrity|person named|face of|presumably)\b/i.test(
      observed?.shown || ''
    );
  const said = clean(speech?.text),
    shown = identity ? 'Identity not assessed.' : clean(observed?.shown),
    label = clean(observed?.onScreenText, 80);
  const subject = complaint.test(text)
    ? 'complaint'
    : observed?.subject ||
      (/\b(?:shop|store|location|directions)\b/i.test(text)
        ? 'shop'
        : /\b(?:product|lamp|item)\b/i.test(text)
          ? 'product'
          : 'other');
  const want =
    subject === 'complaint'
      ? 'resolve_issue'
      : subject === 'payment' || /receipt|payment|ادائیگی/i.test(text)
        ? 'review_payment'
        : /\b(?:where|directions|location|address)\b|کہاں|پتہ/i.test(text)
          ? 'directions'
          : /\b(?:available|stock|availability)\b|دستیاب|mil sak/i.test(text)
            ? 'availability'
            : 'unconfirmed';
  const unclear =
    incomplete ||
    !!observed?.unclear ||
    (!said && !shown) ||
    (!!vision && !observed) ||
    (!!speech && transcriptQuality(speech.text, speech).low);
  return {
    said,
    shown,
    label,
    want,
    unclear,
    subject,
    sensitive: identity || !!observed?.sensitive || sensitive.test(text),
    injection,
  };
}
export function clipHandoff(summary, business = config.owner.profile?.business || {}) {
  const regulated =
    business.regulated === true ||
    /clinic|medical|doctor|dentist|pharmac|legal|law firm|financ|insurance/i.test(
      [business.type, business.template, config.owner.profile?._template?.id].join(' ')
    );
  return (
    regulated ||
    summary.sensitive ||
    summary.unclear ||
    summary.injection ||
    ['complaint', 'payment'].includes(summary.subject)
  );
}

// The protected alternative to understandVideo. All heavy work, including
// the bounded download, is inside the tenant lease. No native-video upload
// and no retry of the original file as audio. Output text is turn-local.
export async function inspectClip(
  {
    download,
    caption = '',
    declaredSeconds = 0,
    tenant = defaultTenant(),
    limits = config.media,
    thumbnail = false,
    gate = providerGate({ tenant, limits }),
  },
  adapters = {}
) {
  const probe = adapters.probe || probeClip,
    framesFor = adapters.frames || sceneFrames,
    audioFor = adapters.audio || clipAudio;
  const see = adapters.see || analyzeFrames,
    listen = adapters.listen || transcribe;
  const start = Date.now();
  let seconds = null,
    bytes = null,
    result;
  try {
    result = await withVideoSlot(tenant, async () => {
      if (declaredSeconds > limits.maxSeconds) throw new MediaStop('too_long');
      const exhausted = quotaCode('videos', tenant, new Date(), limits);
      if (exhausted) throw new MediaStop(exhausted);
      const { buffer, mimetype } = await download({ maxBytes: limits.maxBytes, timeoutMs: limits.timeoutMs });
      bytes = buffer?.length || 0;
      if (bytes > limits.maxBytes) throw new MediaStop('too_large');
      if (!videoContainer(buffer, mimetype)) throw new MediaStop('unreadable');
      if (!adapters.probe && !hasFfmpeg()) throw new MediaStop('unavailable');
      const dir = tempDir('clip');
      try {
        const file = path.join(dir, 'input');
        await fs.writeFile(file, buffer, { mode: 0o600 });
        const streams = await probe(file, limits);
        if (!streams || !(streams.seconds > 0) || !Number.isFinite(streams.seconds)) throw new MediaStop('unreadable');
        seconds = streams.seconds;
        if (seconds > limits.maxSeconds) throw new MediaStop('too_long');
        const visionLimit = streams.video && quotaCode('vision', tenant, new Date(), limits);
        if (visionLimit) throw new MediaStop(visionLimit);
        reserveMedia('videos', tenant, limits);
        let speech = null,
          vision = null,
          preview = null,
          missed = false,
          decodable = false;
        if (streams.audio) {
          const audio = await audioFor(file, dir, { seconds }).catch(() => {
            missed = true;
            return null;
          });
          if (audio) {
            decodable = true;
            if (sttEnabled() || adapters.listen) {
              try {
                speech = await listen(await fs.readFile(audio), { mimetype: 'audio/mpeg', gate });
              } catch (err) {
                if (err.code !== 'breaker' && err.code !== 'provider_error') throw err;
              }
            }
            missed ||= !speech;
          }
        }
        if (streams.video) {
          const frames = (await framesFor(file, dir, { count: limits.frames, seconds }).catch(() => [])).slice(
            0,
            limits.frames
          );
          decodable ||= !!frames.length;
          if (frames.length && (visionEnabled() || adapters.see)) vision = await see({ frames, gate });
          if (frames.length && thumbnail === true) preview = await fs.readFile(frames[0].path);
          missed ||= !vision;
        }
        if (!speech && !vision) throw new MediaStop(gate.errors || decodable ? 'unavailable' : 'unreadable');
        const summary = summarizeClip({ speech, vision, caption, incomplete: missed });
        return { outcome: 'processed', summary, speech, preview, provider: vision?.provider || 'groq' };
      } finally {
        cleanup(dir);
      }
    });
  } catch (e) {
    result = { outcome: e instanceof MediaTooBigError ? 'too_large' : e instanceof MediaStop ? e.code : 'unreadable' };
  }
  const ms = Date.now() - start;
  countMedia(result.outcome === 'processed' ? 'processed' : 'refused', 1, tenant);
  countMedia('video_ms', ms, tenant);
  logEvent('media_video', null, { outcome: result.outcome, seconds, bytes, ms, provider: result.provider || null });
  return { ...result, seconds, bytes, ms };
}
