// src/services/embeddings.js
// Gemini free-tier embeddings, batched and rate-limit aware.
//
// Rules this file follows:
//   • never throws — a missing key, a dead network or an exhausted quota all
//     come back as `null`, so retrieval silently falls back to keyword search
//     and the customer still gets a reply
//   • batches small enough to stay inside the free tier, with a sliding-window
//     limiter and retry-after handling for 429s
//   • one model that works is remembered, so we stop probing dead ones

import { config, reloadProfile } from '../config/env.js';
import { GEMINI_BASE, geminiHeaders, isKeyError, explainGeminiError } from '../utils/gemini.js';

/** Ordered by preference. The first that answers is used from then on. */
export const EMBED_MODELS = ['gemini-embedding-001', 'text-embedding-004', 'embedding-001'];

const BATCH_SIZE = 20;
const MAX_CHARS = 6000;
const MAX_RETRIES = 2;
const TIMEOUT_MS = 15000;

let workingModel = config.embed?.model || null;
let lastError = null;
let callsThisWindow = [];
let disabledUntil = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Requests per minute we allow ourselves (free tier, configurable). */
function rpm() {
  const n = Number(config.embed?.rpm);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

function overBudget() {
  const cutoff = Date.now() - 60_000;
  callsThisWindow = callsThisWindow.filter((t) => t > cutoff);
  return callsThisWindow.length >= rpm();
}

function noteCall() {
  callsThisWindow.push(Date.now());
}

export function embeddingsEnabled() {
  return config.embed?.enabled !== false;
}

export function embeddingsAvailable() {
  return embeddingsEnabled() && !!config.keys.gemini;
}

export function embeddingModel() {
  return workingModel;
}

export function embeddingStatus() {
  return {
    enabled: embeddingsEnabled(),
    key: !!config.keys.gemini,
    model: workingModel,
    available: embeddingsAvailable(),
    cooling: Date.now() < disabledUntil,
    lastError,
  };
}

/** Test hook — clears the limiter and the remembered model. */
export function resetEmbeddingState() {
  workingModel = config.embed?.model || null;
  lastError = null;
  callsThisWindow = [];
  disabledUntil = 0;
}

function vectorOf(entry) {
  const values = entry?.values || entry?.embedding?.values || entry?.embedding;
  if (!Array.isArray(values) || !values.length) return null;
  return values.map(Number).filter((n) => Number.isFinite(n));
}

/**
 * Embed a list of texts. Returns `{ vectors, model }` or `null`.
 * Vectors come back in the same order as the input.
 */
export async function embedBatch(texts = [], { taskType = 'RETRIEVAL_DOCUMENT' } = {}) {
  const clean = texts.map((t) => String(t || '').slice(0, MAX_CHARS));
  if (!clean.length) return { vectors: [], model: workingModel };
  if (!embeddingsAvailable() || Date.now() < disabledUntil) return null;

  const candidates = workingModel ? [workingModel] : EMBED_MODELS;
  let lastFailure = null;

  for (const model of candidates) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (overBudget()) {
        lastError = 'local rate limit';
        return null;
      }
      noteCall();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:batchEmbedContents`, {
          method: 'POST',
          headers: geminiHeaders({ 'Content-Type': 'application/json' }),
          signal: controller.signal,
          body: JSON.stringify({
            requests: clean.map((text) => ({
              model: `models/${model}`,
              content: { parts: [{ text }] },
              taskType,
            })),
          }),
        });

        if (res.ok) {
          const data = await res.json();
          const vectors = (data.embeddings || []).map(vectorOf);
          if (vectors.length !== clean.length || vectors.some((v) => !v || !v.length)) {
            lastFailure = new Error('malformed embedding response');
            break;
          }
          workingModel = model;
          lastError = null;
          return { vectors, model };
        }

        const body = await res.text();
        lastFailure = new Error(explainGeminiError(res.status, body));

        if (isKeyError(res.status, body)) {
          lastError = lastFailure.message;
          return null; // a bad key is not a model problem — stop early
        }
        if (res.status === 429) {
          const wait = retryAfterMs(res, body, attempt);
          if (attempt === MAX_RETRIES) {
            // Quota is gone for now: stop asking for a while, fall back to keywords.
            disabledUntil = Date.now() + 60_000;
            lastError = lastFailure.message;
            return null;
          }
          await sleep(wait);
          continue;
        }
        if ([400, 403, 404].includes(res.status)) break; // wrong model → try the next one
        if (res.status >= 500 && attempt < MAX_RETRIES) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        break;
      } catch (err) {
        lastFailure = err;
        // A dead network or an aborted request will not fix itself in 400 ms.
        // Back off for a minute and let keyword search carry the replies.
        if (err?.name === 'AbortError' || err instanceof TypeError) {
          disabledUntil = Date.now() + 60_000;
          lastError = err.name === 'AbortError' ? 'embedding request timed out' : 'network unreachable';
          return null;
        }
        if (attempt < MAX_RETRIES) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        break;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  lastError = lastFailure?.message || 'embeddings unavailable';
  return null;
}

function retryAfterMs(res, body, attempt) {
  const header = Number(res.headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 10_000);
  const match = String(body || '').match(/retry in ([\d.]+)\s*s/i);
  if (match) return Math.min(parseFloat(match[1]) * 1000, 10_000);
  return Math.min(1000 * 2 ** attempt, 8000);
}

/** Embed one text (a customer's question). Returns `number[]` or `null`. */
export async function embedQuery(text) {
  const out = await embedBatch([text], { taskType: 'RETRIEVAL_QUERY' });
  return out?.vectors?.[0] || null;
}

/** Split texts into batches and embed them all, sequentially to stay polite. */
export async function embedAll(texts = [], options = {}) {
  const vectors = [];
  let model = workingModel;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const slice = texts.slice(i, i + BATCH_SIZE);
    const result = await embedBatch(slice, options);
    if (!result) return null;
    vectors.push(...result.vectors);
    model = result.model;
  }
  return { vectors, model };
}

export function cosine(a = [], b = []) {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function packVector(vector = []) {
  return JSON.stringify(vector.map((n) => Math.round(n * 1e5) / 1e5));
}

export function unpackVector(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export { reloadProfile };
export default { embedBatch, embedQuery, embedAll, cosine, packVector, unpackVector, embeddingStatus, embeddingsAvailable };
