// src/services/languageStick.js
// Which language is this conversation in?
//
// A live test showed the answer was "whichever language the last message
// happened to look like": a customer chatting in English answered "Yes" and got
// a Roman Urdu reply, and a forwarded PDF in Dutch moved the whole chat into
// Dutch. The conversation has a language; a four-word-or-shorter message does
// not get to change it, and neither does a document.
//
// This module answers one question — the dominant language of the last N
// customer messages — and leaves the actual reply rules to `language.js`.

import * as db from '../utils/db.js';
import { detectLanguage } from './language.js';

/** Below this, a message is an acknowledgement, not a language sample. */
export const MIN_WORDS = 4;

const KIND_WEIGHT = {
  document: 0, // a file is not the customer talking
  image: 0, // a forwarded picture
  sticker: 0,
  location: 0.5,
  contact: 0.5,
  voice: 1,
  video: 0.7,
  text: 1,
  '': 1,
};

function words(text = '') {
  return String(text || '').trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function weightOf(code) {
  if (code === 'roman-ur') return 1.15; // the one that gets mistaken for English
  if (code === 'ur') return 1.25;
  if (code === 'unknown') return 0;
  return 1;
}

/**
 * Dominant language over the last N customer messages.
 *
 * @param {string} number
 * @param {{limit?:number, windowHours?:number}} [opts]
 * @returns {{code:string, confidence:number, sample:number, script?:string}}
 */
export function dominantLanguage(number, { limit = 8, windowHours = 72 } = {}) {
  const since = Date.now() - windowHours * 3600 * 1000;
  let rows = [];
  try {
    rows = db.getMessages(number, Math.max(limit * 3, 24)) || [];
  } catch {
    rows = [];
  }

  const scored = new Map();
  let total = 0;
  let sample = 0;

  for (const row of rows) {
    if (row.role !== 'user') continue;
    if (new Date(row.created_at || 0).getTime() < since) continue;
    const kind = String(row.kind || 'text');
    const kindWeight = KIND_WEIGHT[kind] ?? 1;
    if (kindWeight === 0) continue;

    const text = String(row.content || '');
    const meta = row.meta || {};
    const isFile = !!meta.document || /document|forwarded|file/i.test(kind);
    if (isFile) continue;

    const count = words(text);
    if (count < MIN_WORDS) continue; // "Yes", "ok", "haan" never vote

    const info = detectLanguage(text);
    const weight = count * kindWeight * weightOf(info.code);
    if (!weight) continue;
    scored.set(info.code, (scored.get(info.code) || 0) + weight);
    total += weight;
    sample += 1;
    if (sample >= limit) break;
  }

  if (!scored.size) return { code: 'unknown', confidence: 0, sample: 0 };
  const [code, score] = [...scored.entries()].sort((a, b) => b[1] - a[1])[0];
  return { code, confidence: Number((score / total).toFixed(2)), sample };
}

/**
 * The language this batch should be answered in.
 *
 * A long-enough message can move the conversation; a short one cannot. When
 * history has no opinion (new chat, only short messages so far) this turn's
 * own detection wins — but a short message still falls back to whatever the
 * contact record already says, never to a fresh guess.
 *
 * @returns {{...detectLanguage result, sticky:boolean, source:string}}
 */
export function replyLanguage(number, text = '', { kind = 'text', contact = null } = {}) {
  const own = detectLanguage(String(text || ''));
  const ownWords = words(text);
  const dominant = dominantLanguage(number);
  const stored = contact?.language && contact.language !== 'unknown' ? contact.language : null;

  const isFile = /document|file/i.test(kind);
  const trustworthy = ownWords >= MIN_WORDS && !isFile && own.code !== 'unknown';

  let code = own.code;
  let source = 'this message';

  if (dominant.code !== 'unknown' && dominant.sample >= 2) {
    if (!trustworthy) {
      code = dominant.code;
      source = 'conversation';
    } else if (dominant.code === own.code) {
      source = 'conversation and this message agree';
    } else if (dominant.confidence >= 0.7) {
      // The chat has a clear language and this one message disagrees: the chat
      // wins, because one message is how a stray word used to hijack the chat.
      code = dominant.code;
      source = 'conversation (this message disagrees)';
    } else {
      source = 'this message (conversation was split)';
    }
  } else if (!trustworthy) {
    if (stored) {
      code = stored;
      source = 'contact record';
    } else if (dominant.code !== 'unknown') {
      code = dominant.code;
      source = 'earlier messages';
    }
  }

  const merged = code === own.code ? own : { ...detectLanguage(''), code };
  const sticky = source !== 'this message';
  return { ...merged, code, sticky, source, words: ownWords };
}

/** The dominant language as a phrase for the prompt, without a model call. */
export function languageLockInstruction(langInfo) {
  const label = langInfo?.label || langInfo?.code || 'the language the customer is using';
  return `The conversation is in ${label}. Answer in ${label} only — do not switch language because of a short message, a forwarded file, or a document someone sent.`;
}

export function _resetForTests() {
  /* nothing cached: kept so tests can call it without a branch */
}

export default { dominantLanguage, replyLanguage, languageLockInstruction, MIN_WORDS };
