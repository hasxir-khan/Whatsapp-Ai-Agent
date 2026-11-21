// src/services/visualSearch.js
// Phase 4 Part 4 — "does this photo match something we sell?"
//
// Runs a CLIP model locally, on this machine, on a free path:
//   • @xenova/transformers, imported dynamically and cached — one pipeline per
//     process, never one per message;
//   • the model (~90 MB, quantised) is downloaded once, on first use;
//   • if either step fails — no network, no package, no RAM — the caller keeps
//     its existing Gemini vision path and the reason is logged. A photo never
//     goes unanswered because a model was missing.
//
// The rules that make the answer safe:
//   • names, prices and stock come from the catalogue, never from the model;
//   • one confident match → that item; a loose match → the top 3, and a
//     question; nothing close → "I'm not sure", never a guess;
//   • customer photos are embedded in memory and dropped. They are never
//     written into the catalogue and never leave the machine;
//   • one embedding job at a time, with a timeout, an image size limit and a
//     per-tenant daily cap.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config/env.js';
import { featureOn, effectiveCatalog, catalogItems } from './profile.js';
import { run, all, get, logEvent, getSetting, setSetting } from '../utils/db.js';
import { formatMoney } from './geo.js';

// ── settings ─────────────────────────────────────────────────
export const MODEL_ID = 'Xenova/clip-vit-base-patch32';
export const MODEL_DOWNLOAD_MB = 90;
export const ESTIMATED_RAM_MB = 800;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const EMBED_TIMEOUT_MS = 20000;
const TOP_K = 3;

export function visualSearchEnabled() {
  return featureOn('visualSearch');
}

/**
 * Thresholds are cosine similarity between two normalised CLIP vectors.
 * They are deliberately conservative: a wrong "this is our Chicken Karahi"
 * is worse than "I'm not sure", so HIGH sits well above the noise between
 * similar-looking products.
 *
 * Calibrate on your own catalogue: `node scripts/tenant.js index-images <slug>`
 * prints the model and the score each image gets against itself and its
 * neighbours. Lighting and packaging move these numbers; the defaults are a
 * starting point, not a law.
 */
export function thresholds() {
  const high = Number(process.env.VISUAL_HIGH_THRESHOLD);
  const low = Number(process.env.VISUAL_LOW_THRESHOLD);
  const h = Number.isFinite(high) && high > 0 && high <= 1 ? high : 0.88;
  const l = Number.isFinite(low) && low > 0 && low <= 1 ? low : 0.78;
  return { high: Math.max(h, l), low: Math.min(h, l) };
}

export function dailyCap() {
  const n = Number(process.env.VISUAL_SEARCH_DAILY_CAP);
  return Number.isFinite(n) && n >= 0 ? n : 300;
}

// ── maths ────────────────────────────────────────────────────
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
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

export function normalise(vector) {
  const arr = Array.from(vector || [], Number);
  let sum = 0;
  for (const v of arr) sum += v * v;
  const len = Math.sqrt(sum);
  return len ? arr.map((v) => v / len) : arr;
}

export function hashImage(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}

// ── the embedder, lazily and exactly once ────────────────────
let pipelinePromise = null;
let injectedEmbedder = null;
let lastFailure = null;
let queue = Promise.resolve();

/** Tests inject a fake here; production never calls this. */
export function setEmbedder(fn) {
  injectedEmbedder = typeof fn === 'function' ? fn : null;
  pipelinePromise = null;
}

export function resetEmbedderCache() {
  pipelinePromise = null;
  lastFailure = null;
  queue = Promise.resolve();
}

export function embedderState() {
  return { injected: !!injectedEmbedder, loaded: !!pipelinePromise, lastFailure };
}

async function loadPipeline() {
  if (injectedEmbedder) return { kind: 'injected', embed: injectedEmbedder };
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    const mod = await import('@xenova/transformers'); // throws if not installed
    // Everything local: the model is downloaded once by transformers.js into its
    // own cache folder, nothing about the photo leaves the machine.
    if (mod.env && typeof mod.env === 'object') {
      mod.env.allowRemoteModels = true; // first run needs the download
      mod.env.useBrowserCache = false;
    }
    const extractor = await mod.pipeline('image-feature-extraction', MODEL_ID, { quantized: true });
    return {
      kind: 'clip',
      model: MODEL_ID,
      extract: extractor,
      embed: async (buffer) => {
        const out = await extractor(buffer, { pooling: 'mean', normalize: true });
        const data = out?.data ? Array.from(out.data) : Array.from(out || []);
        return normalise(data);
      },
    };
  })();

  try {
    return await pipelinePromise;
  } catch (err) {
    lastFailure = err?.message || String(err);
    pipelinePromise = null;
    throw err;
  }
}

/** One job at a time, with a timeout. A photo down the queue never blocks a reply. */
function serialised(task, timeoutMs = EMBED_TIMEOUT_MS) {
  const run1 = queue.then(() => task());
  queue = run1.catch(() => {});
  return Promise.race([
    run1,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('embed_timeout')), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

/**
 * Embed one image. Returns an array, or null with a reason — never throws into
 * a handler.
 */
export async function embedImage(buffer, { timeoutMs = EMBED_TIMEOUT_MS } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, reason: 'empty_image' };
  if (buffer.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'image_too_large' };

  try {
    const pipe = await loadPipeline();
    const vector = await serialised(() => pipe.embed(buffer), timeoutMs);
    if (!Array.isArray(vector) || !vector.length) return { ok: false, reason: 'empty_vector' };
    return { ok: true, vector: normalise(vector), model: pipe.model || 'injected', kind: pipe.kind };
  } catch (err) {
    const reason = err?.message || String(err);
    lastFailure = reason;
    return { ok: false, reason };
  }
}

/** Is the local model usable at all? Doctor and the indexer both ask. */
export async function probeEmbedder() {
  try {
    await loadPipeline();
    return { ok: true, model: MODEL_ID, downloadMb: MODEL_DOWNLOAD_MB, ramMb: ESTIMATED_RAM_MB };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err), model: MODEL_ID, downloadMb: MODEL_DOWNLOAD_MB, ramMb: ESTIMATED_RAM_MB };
  }
}

// ── the catalogue's images ───────────────────────────────────
/**
 * Resolve `catalog[].image` to a real file inside this tenant's folder.
 * Anything outside the folder, or that is not an image, is refused — a profile
 * is owner-editable, so it is untrusted input.
 */
export function catalogImagePath(imagePath) {
  if (!imagePath || typeof imagePath !== 'string') return { ok: false, reason: 'no_path' };

  // "Inside the tenant folder only" — and the tenant folder is the one that
  // owns this config directory. A profile is owner-editable text, so `../..`
  // in an image path is an attempt, not a mistake we accommodate.
  const base = path.resolve(config.paths.config, '..');
  const candidates = [path.resolve(config.paths.config, imagePath), path.resolve(base, imagePath)];

  for (const candidate of candidates) {
    if (candidate !== base && !candidate.startsWith(base + path.sep)) continue;
    if (!/\.(png|jpe?g|webp)$/i.test(candidate)) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { ok: true, file: candidate };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return { ok: false, reason: 'not_found' };
}

/** Catalogue rows that have an image — the join we index and match against. */
export function catalogImageItems() {
  const raw = catalogItems();
  const normalised = effectiveCatalog();
  const out = [];
  for (const [i, item] of raw.entries()) {
    const image = item?.image || item?.photo || item?.picture || null;
    if (!image) continue;
    const resolved = catalogImagePath(image);
    const norm = normalised[i] || {};
    out.push({
      id: norm.id || item.id || `item_${i + 1}`,
      name: norm.name || item.name || `Item ${i + 1}`,
      image,
      file: resolved.ok ? resolved.file : null,
      missing: resolved.ok ? null : resolved.reason,
      price: norm.price ?? norm.min ?? null,
      max: norm.max ?? null,
      currency: norm.currency || null,
    });
  }
  return out;
}

// ── storage ──────────────────────────────────────────────────
function saveVector({ itemId, imagePath, hash, model, vector }) {
  const existing = get('SELECT id FROM image_embeddings WHERE image_path = ?', [imagePath]);
  const payload = [hash, model || MODEL_ID, vector.length, JSON.stringify(vector), new Date().toISOString()];
  if (existing) {
    run('UPDATE image_embeddings SET hash = ?, model = ?, dim = ?, vector = ?, updated_at = ? WHERE id = ?', [
      ...payload,
      existing.id,
    ]);
    return existing.id;
  }
  run(
    'INSERT INTO image_embeddings (item_id, image_path, hash, model, dim, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [itemId, imagePath, ...payload]
  );
  return get('SELECT id FROM image_embeddings WHERE image_path = ?', [imagePath])?.id || null;
}

export function indexedVectors() {
  return all('SELECT * FROM image_embeddings').map((row) => {
    let vector = [];
    try {
      vector = JSON.parse(row.vector || '[]');
    } catch {
      vector = [];
    }
    return { ...row, vector };
  });
}

/**
 * Embed every catalogue image that changed. The hash is the point: an image
 * that has not changed is not embedded again, so re-running this is cheap.
 */
export async function indexCatalogImages({ force = false, onProgress = null } = {}) {
  const items = catalogImageItems();
  const summary = { seen: items.length, indexed: 0, skipped: 0, missing: 0, failed: 0, model: null, errors: [] };

  for (const item of items) {
    if (!item.file) {
      summary.missing += 1;
      summary.errors.push(`${item.name}: image ${item.missing}`);
      continue;
    }
    let buffer;
    try {
      buffer = fs.readFileSync(item.file);
    } catch (err) {
      summary.failed += 1;
      summary.errors.push(`${item.name}: ${err.message}`);
      continue;
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      summary.failed += 1;
      summary.errors.push(`${item.name}: image is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`);
      continue;
    }

    const hash = hashImage(buffer);
    const existing = get('SELECT hash FROM image_embeddings WHERE image_path = ?', [item.image]);
    if (!force && existing?.hash === hash) {
      summary.skipped += 1;
      onProgress?.({ item, action: 'skipped' });
      continue;
    }

    const embedded = await embedImage(buffer);
    if (!embedded.ok) {
      summary.failed += 1;
      summary.errors.push(`${item.name}: ${embedded.reason}`);
      if (/Cannot find (package|module)|ERR_MODULE_NOT_FOUND|Failed to (fetch|download)/i.test(embedded.reason)) {
        // The model is not available: stop, rather than fail 40 times slowly.
        summary.model = null;
        summary.aborted = 'model_unavailable';
        break;
      }
      continue;
    }
    saveVector({ itemId: item.id, imagePath: item.image, hash, model: embedded.model, vector: embedded.vector });
    summary.indexed += 1;
    summary.model = embedded.model;
    onProgress?.({ item, action: 'indexed' });
  }

  logEvent('visual_index', null, { indexed: summary.indexed, skipped: summary.skipped, missing: summary.missing });
  return summary;
}

export function clearIndex() {
  run('DELETE FROM image_embeddings');
  return { cleared: true };
}

// ── matching ─────────────────────────────────────────────────
/** Score every indexed image against one vector, best first. */
export function rank(vector, { limit = TOP_K } = {}) {
  const items = new Map(catalogImageItems().map((i) => [i.image, i]));
  const rows = indexedVectors();
  const scored = [];
  for (const row of rows) {
    if (!row.vector.length || row.vector.length !== vector.length) continue;
    scored.push({ row, score: cosine(vector, row.vector), item: items.get(row.image_path) || null });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit));
}

export function decide(matches, limits = thresholds()) {
  const best = matches[0];
  if (!best) return { decision: 'none', score: 0 };
  if (best.score >= limits.high) return { decision: 'match', score: best.score };
  if (best.score >= limits.low) return { decision: 'ambiguous', score: best.score };
  return { decision: 'none', score: best.score };
}

function priceLine(item) {
  const money = formatMoney(item.price ?? 0, item.currency || undefined);
  if (item.price !== null && item.price !== undefined && item.max && item.max !== item.price) {
    return `${money} – ${formatMoney(item.max, item.currency || undefined)}`;
  }
  return money;
}

function stockLine(item) {
  const norm = effectiveCatalog().find((i) => i.id === item.id) || {};
  if (norm.stock === null || norm.stock === undefined) return null;
  return Number(norm.stock) > 0 ? `${norm.stock} in stock` : 'out of stock right now';
}

/** The reply, built from catalogue fields only. */
export function composeReply(decision, matches, { lang = 'en' } = {}) {
  const roman = lang === 'roman-ur';
  const urdu = lang === 'ur';

  if (decision.decision === 'match') {
    const item = matches[0].item;
    const price = priceLine(item);
    const stock = stockLine(item);
    const stockText = stock ? (/(out of stock)/i.test(stock) ? stock : stock) : null;
    if (urdu) {
      return `${item.name} — ${price}${stockText ? ` · ${stockText}` : ''}.`;
    }
    if (roman) {
      return `Ye *${item.name}* lag raha hai — ${price}${stockText ? ` · ${stockText}` : ''}.${
        /out of stock/i.test(stockText || '') ? ' Filhal stock mein nahi hai.' : ' Order karna ho to bata dein.'
      }`;
    }
    return `That looks like *${item.name}* — ${price}${stockText ? ` · ${stockText}` : ''}.${
      /out of stock/i.test(stockText || '') ? " It's out of stock at the moment." : ' Want to order it? Just say so.'
    }`;
  }

  if (decision.decision === 'ambiguous') {
    const lines = matches
      .filter((m) => m.item)
      .map((m) => `• ${m.item.name} — ${priceLine(m.item)}`)
      .join('\n');
    if (urdu) return `کون سی چیز ہے؟\n${lines}`;
    if (roman) return `Kaunsi cheez hai? Ye kuch milti hain:\n${lines}\nNaam bata dein.`;
    return `Which one is it? This looks closest to:\n${lines}\nTell me the name and I'll take it from there.`;
  }

  if (urdu) return 'مجھے یقین نہیں کہ یہ ہماری کوئی چیز ہے۔ نام بتا دیں یا واضح تصویر بھیجیں۔';
  if (roman) return "Mujhe yaqeen nahi ke ye hamari koi cheez hai — main andaza nahi lagaunga. Naam bata dein, ya saaf photo bhejein.";
  return "I'm not sure which of our items this is, so I won't guess. Tell me the name, send a clearer photo, or I can pass you to a human.";
}

// ── caps and sweeping ────────────────────────────────────────
function todayKey(now = new Date()) {
  return `visual_search_calls:${now.toISOString().slice(0, 10)}`;
}

export function callsToday(now = new Date()) {
  const n = Number(getSetting(todayKey(now), 0));
  return Number.isFinite(n) ? n : 0;
}

export function withinCap(now = new Date()) {
  return callsToday(now) < dailyCap();
}

function countCall(now = new Date()) {
  const key = todayKey(now);
  const next = callsToday(now) + 1;
  setSetting(key, next);
  return next;
}

/** Nothing should be in there, but if a decoder ever writes a temp file, it dies. */
export function sweepVisualTmp({ now = new Date(), maxAgeMs = 60 * 60 * 1000 } = {}) {
  const dir = path.join(config.paths.tmp, 'visual');
  let removed = 0;
  try {
    if (!fs.existsSync(dir)) return { removed, dir };
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (now.getTime() - fs.statSync(file).mtimeMs > maxAgeMs) {
          fs.rmSync(file, { force: true });
          removed += 1;
        }
      } catch {
        /* a file that vanished is not a problem */
      }
    }
  } catch {
    /* no tmp folder is not a problem */
  }
  return { removed, dir };
}

/**
 * The whole turn for one customer photo.
 *   handled:false → the caller keeps its own vision path (used when the model
 *   is unavailable, or the cap is reached, or the flag is off).
 */
export async function visualLookup({ buffer, mimetype = 'image/jpeg', number = null, lang = 'en', now = new Date() } = {}) {
  if (!visualSearchEnabled()) return { handled: false, reason: 'disabled' };
  if (!withinCap(now)) {
    logEvent('visual_capped', number, { cap: dailyCap() });
    return { handled: false, reason: 'daily_cap' };
  }

  const rows = indexedVectors();
  if (!rows.length) {
    logEvent('visual_no_index', number, null);
    return { handled: false, reason: 'no_index' };
  }

  sweepVisualTmp({ now });
  const embedded = await embedImage(buffer);
  if (!embedded.ok) {
    logEvent('visual_model_unavailable', number, embedded.reason);
    return { handled: false, reason: 'model_unavailable', error: embedded.reason };
  }

  countCall(now);
  const matches = rank(embedded.vector, { limit: TOP_K });
  const decision = decide(matches);
  const reply = composeReply(decision, matches, { lang });

  logEvent('visual_match', number, {
    decision: decision.decision,
    score: Number(decision.score.toFixed(3)),
    top: matches.slice(0, TOP_K).map((m) => ({ id: m.item?.id || m.row.item_id, score: Number(m.score.toFixed(3)) })),
  });

  return {
    handled: true,
    reason: 'matched',
    decision: decision.decision,
    score: decision.score,
    matches,
    reply,
    mimetype,
  };
}

/** For /api/status and doctor: is this thing actually able to work? */
export function visualStatus() {
  return {
    enabled: visualSearchEnabled(),
    model: MODEL_ID,
    downloadMb: MODEL_DOWNLOAD_MB,
    estimatedRamMb: ESTIMATED_RAM_MB,
    maxImageBytes: MAX_IMAGE_BYTES,
    thresholds: thresholds(),
    dailyCap: dailyCap(),
    callsToday: callsToday(),
    indexed: indexedVectors().length,
    catalogImages: catalogImageItems().length,
    embedder: embedderState(),
  };
}

export default {
  visualSearchEnabled,
  visualLookup,
  indexCatalogImages,
  catalogImageItems,
  catalogImagePath,
  embedImage,
  probeEmbedder,
  rank,
  decide,
  composeReply,
  thresholds,
  dailyCap,
  callsToday,
  sweepVisualTmp,
  visualStatus,
  setEmbedder,
  resetEmbedderCache,
  clearIndex,
  cosine,
  hashImage,
  MAX_IMAGE_BYTES,
  MODEL_ID,
};
