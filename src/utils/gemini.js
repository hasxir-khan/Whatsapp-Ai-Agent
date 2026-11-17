// src/utils/gemini.js
// Shared bits for talking to Google's Gemini API.
//
// Two reasons this exists:
//   1. The API key travels in the `x-goog-api-key` header, never in the URL.
//      Keys in query strings end up in logs, crash dumps and proxy access
//      logs — and the header form is what Google recommends anyway.
//   2. Errors are classified once, so the callers (chat, vision, doctor) can
//      tell "your key is wrong" apart from "that model name doesn't exist"
//      apart from "you hit the free-tier limit".

import { config } from '../config/env.js';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Headers for any Gemini REST call.
 * Google hands out two kinds of credentials; both work, but with different
 * headers, so the style is configurable (GEMINI_AUTH_STYLE).
 */
export function geminiHeaders(extra = {}, style = config.geminiAuthStyle) {
  const key = config.keys.gemini || '';
  const auth =
    style === 'bearer'
      ? { Authorization: `Bearer ${key}` }
      : { 'x-goog-api-key': key };
  return { ...auth, ...extra };
}

/** The same headers with the other auth style — used by the doctor's probe. */
export function geminiHeadersWith(style, extra = {}) {
  return geminiHeaders(extra, style);
}

/**
 * True when the request failed because of the key itself, not the model.
 * Retrying every model in the chain with a bad key just wastes a minute.
 */
export function isKeyError(status, body = '') {
  if (status === 401) return true;
  if (status !== 400 && status !== 403) return false;
  return /API_KEY_INVALID|API key not valid|invalid api key|API_KEY_EXPIRED|unauthenticated|expected oauth/i.test(
    String(body || '')
  );
}

/** Human explanation for a failed Gemini response. */
export function explainGeminiError(status, body = '') {
  const detail = extractApiMessage(body);
  if (isKeyError(status, body)) {
    return `Gemini rejected the API key (HTTP ${status})${detail ? `: ${detail}` : ''}. Create a fresh key at https://aistudio.google.com/api-keys and put it in .env as GEMINI_API_KEY=…`;
  }
  if (status === 404) {
    return `Gemini has no such model (HTTP 404)${detail ? `: ${detail}` : ''}. Run \`npm run doctor\` to list the model names your key can use.`;
  }
  if (status === 429) {
    return `Gemini free-tier quota reached (HTTP 429)${detail ? `: ${detail}` : ''}. It resets at midnight Pacific time — or set a second key.`;
  }
  if (status === 400) {
    return `Gemini rejected the request (HTTP 400)${detail ? `: ${detail}` : ''}.`;
  }
  if (status === 403) {
    return `Gemini refused (HTTP 403)${detail ? `: ${detail}` : ''}. The key may be restricted to other APIs.`;
  }
  if (status >= 500) {
    return `Gemini is having trouble on their side (HTTP ${status}). Retrying usually works.`;
  }
  return `Gemini error (HTTP ${status})${detail ? `: ${detail}` : ''}.`;
}

function extractApiMessage(body = '') {
  try {
    const parsed = JSON.parse(body);
    return String(parsed?.error?.message || '').slice(0, 200);
  } catch {
    return String(body || '').slice(0, 200);
  }
}

/**
 * Key formats, as Google issues them:
 *   AQ.…  → current Gemini API keys (what AI Studio hands out now)
 *   AIza… → legacy Cloud API keys, still accepted
 */
export function keyFormat(key = '') {
  if (/^AQ\./.test(key)) return 'current';
  if (/^AIza/.test(key)) return 'legacy';
  return 'unknown';
}

/** Never print a whole key. */
export function maskKey(key = '') {
  if (!key) return '(not set)';
  if (key.length <= 10) return `${key.slice(0, 2)}…${key.slice(-2)}`;
  return `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)`;
}
