import {billedWorker} from './billingLease.js';
import {admit} from './billingMeter.js';
import {billableAudioSeconds} from './ffmpeg.js';
import { mediaUsage } from './mediaUsage.js';
// src/services/transcription.js
// Speech-to-text with Groq Whisper (free tier).
// Language auto-detection is ON by default so a Spanish, Arabic or Urdu voice
// note is transcribed as-is instead of being forced through Urdu.

import { config } from '../config/env.js';
import { bumpUsage, logEvent } from '../utils/db.js';
import { writeTemp, cleanupPath, extFromMime } from './media.js';
import { hasFfmpeg, extractAudioForStt } from './ffmpeg.js';

const MAX_BYTES = 24 * 1024 * 1024; // stay under the 25 MB upload cap

export function sttEnabled() {
  return config.stt.enabled && !!config.keys.groq;
}

/**
 * @param {Buffer} buffer audio or video bytes
 * @param {object} opts
 * @param {string} [opts.mimetype]
 * @param {string} [opts.language] BCP-47-ish code ('en','ur','ar'…). '' = auto
 * @param {string} [opts.filename]
 * @returns {Promise<{text:string, language:string, duration:number, model:string}|null>}
 */
export async function transcribe(buffer, { mimetype = 'audio/ogg', language = config.stt.language, filename, gate } = {}) {
  if (!sttEnabled()) return null;
  if (!buffer?.length) return null;

  let tmp = null;
  let converted = null;
  let rawInput = null;

  try {
    if (buffer.length > MAX_BYTES) {
      // Try to shrink it first; if we can't, give up politely.
      if (billedWorker() || !hasFfmpeg()) {
        logEvent('stt_too_large', null, buffer.length);
        return null;
      }
      rawInput = writeTemp(buffer, extFromMime(mimetype), 'stt');
      converted = `${rawInput}.mp3`;
      if (!await extractAudioForStt(rawInput, converted)) return null;
      tmp = converted;
    } else {
      tmp = writeTemp(buffer, extFromMime(mimetype), 'stt');
    }

    if (billedWorker()) {
      const seconds = await billableAudioSeconds(tmp);
      if (!seconds || !admit('voice', seconds)) return null;
    }
    const models = [config.stt.model, config.stt.fallbackModel].filter(Boolean);

    for (const model of models) {
      let result;
      if (gate) {
        try {
          result = await gate.attempt('stt', 'groq', (signal) =>
            callWhisper(tmp, model, language, 'speech.' + (converted ? 'mp3' : extFromMime(mimetype)), signal)
          );
        } catch (err) {
          if (err.code !== 'provider_error') throw err;
        }
      } else result = await callWhisper(tmp, model, language, filename);
      mediaUsage('voice', 'groq', model, {
        error: result ? null : 'provider_error',
        protectedCall: !!gate,
        estimated: !!result,
        output: gate && result ? Math.ceil(result.text.length / 4) : 0,
      });
      if (result) {
        if (process.env.TENANT_DASHBOARD === '1' && result.duration)
          logEvent('report_voice_seconds', null, { seconds: result.duration });
        if (result.duration) bumpUsage('stt_seconds', result.duration);
        return { ...result, model };
      }
    }
    return null;
  } catch (err) {
    if (gate && err.code) throw err;
    logEvent('stt_error', null, 'failed');
    return null;
  } finally {
    cleanupPath(rawInput);
    cleanupPath(tmp);
    if (converted && converted !== tmp) cleanupPath(converted);
  }
}

async function callWhisper(filePath, model, language, filename, signal) {
  try {
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(filePath);
    const form = new FormData();
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    form.append('file', blob, filename || filePath.split(/[\\/]/).pop());
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (language) form.append('language', language);

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.keys.groq}` },
      body: form,
      signal: signal || AbortSignal.timeout(120000),
    });

    const raw = await res.text();
    if (!res.ok) {
      // Bad model / unsupported file → try the fallback model
      logEvent('stt_http_error', null, { status: res.status });
      return null;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      if (signal) return null;
      return { text: raw.trim(), language: language || 'unknown', duration: 0 };
    }

    const text = String(data.text || '').trim();
    if (!text) return null;

    return {
      text,
      language: data.language || language || 'unknown',
      duration: Number(data.duration) || 0,
      ...(signal ? { confidence: whisperConfidence(data) } : {}),
    };
  } catch (err) {
    logEvent('stt_request_error', null, 'failed');
    return null;
  }
}

/** Heuristic: did the transcript actually contain words? */
export function looksMeaningful(text = '') {
  const letters = String(text).replace(/[^\p{L}]/gu, '');
  return letters.length >= 2;
}

export default { transcribe, sttEnabled, looksMeaningful };

function whisperConfidence(data) {
  if (typeof data.language_probability === 'number') return data.language_probability;
  const segments = (Array.isArray(data.segments) ? data.segments : []).filter((s) => Number.isFinite(s.avg_logprob));
  if (!segments.length) return null; // absence is not zero or a made-up score
  return (
    segments.reduce((n, s) => n + Math.min(1, Math.exp(s.avg_logprob)) * (1 - (s.no_speech_prob || 0)), 0) /
    segments.length
  );
}
