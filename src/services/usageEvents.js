// src/services/usageEvents.js
// One way for a model call to say what it cost.
//
// The platform (platform/usage.js) registers a sink here; src/core/llm.js calls
// `recordUsage()` from its single success branch. Nothing else in the bot knows
// the platform exists, and with the platform switched off `recordUsage()` does
// exactly nothing — no file, no row, no behaviour change.
//
// When the platform is *not* in this process (a bot worker), it can ask the
// worker to keep a local journal (PLATFORM_USAGE_JOURNAL=1) which it imports
// later. The journal never holds a phone number: the chat key is hashed before
// it is written.

import { dimension } from './reportContract.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';

let recorder = null;
const seenUids = new Set();
const SEEN_LIMIT = 5000;

/** Replace the sink. `null` switches recording off. */
export function setUsageRecorder(fn) {
  recorder = typeof fn === 'function' ? fn : null;
  return recorder;
}

export function currentRecorder() {
  return recorder;
}

/** Is the local journal switched on for this process? */
export function journalEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.PLATFORM_USAGE_JOURNAL || '').toLowerCase());
}

export function journalFile() {
  return path.join(config.paths.data, 'usage-events.jsonl');
}

/** Stable, non-reversible conversation handle — a hash, never a number. */
export function conversationHash(chatKey) {
  if (!chatKey) return null;
  return crypto.createHash('sha256').update(String(chatKey)).digest('hex').slice(0, 16);
}

/** Is anything listening? Lets the call site skip the arithmetic entirely. */
export function isRecording() {
  return !!recorder || journalEnabled();
}

/** ~4 characters per token, used only when a provider reports nothing. */
export function estimateTokens(text) {
  const value = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  return Math.max(0, Math.ceil(value.length / 4));
}

function remember(uid) {
  if (seenUids.has(uid)) return false;
  seenUids.add(uid);
  if (seenUids.size > SEEN_LIMIT) {
    const first = seenUids.values().next().value;
    seenUids.delete(first);
  }
  return true;
}

// A last-four label is not an identity. Two rotations can end in the same
// digits, and an old worker may finish a call while it is being stopped.
export function validKeyRef(ref) {
  return typeof ref === 'string' && /^[A-Za-z0-9_-]{16}:[1-9]\d{0,9}$/.test(ref) ? ref : null;
}
function workerKeyRef(event) {
  try { return validKeyRef(JSON.parse(process.env.LLM_KEY_REFS || '{}')?.[`${event.provider}:${event.keySlot}`]); }
  catch { return null; }
}

/**
 * Record one model call.
 * @returns {{ok:boolean, mode:'sink'|'journal'|'off'}}
 */
export function recordUsage(event = {}) {
  // Nothing listening: no hash, no estimate, no file. The bot's behaviour with
  // the platform off is exactly what it was before the platform existed.
  if (!isRecording()) return { ok: false, mode: 'off' };

  const enriched = {
    uid: event.uid || crypto.randomUUID(),
    at: new Date(event.at || Date.now()).toISOString(),
    tenant: event.tenant || config.tenant?.slug || 'default',
    provider: event.provider || null,
    model: event.model || null,
    agent:
      process.env.TENANT_DASHBOARD === '1' && process.env.PLATFORM_TENANT_TOKEN
        ? dimension('agent', event.agent || 'unknown', process.env.PLATFORM_TENANT_TOKEN)
        : event.agent || null,
    kind: event.kind || 'chat',
    conversation: event.conversation || conversationHash(event.chatKey),
    promptTokens: Math.max(0, Number(event.promptTokens) || 0),
    completionTokens: Math.max(0, Number(event.completionTokens) || 0),
    totalTokens: Math.max(0, Number(event.totalTokens) || 0),
    estimated: !!event.estimated,
    latencyMs: Math.max(0, Number(event.latencyMs) || 0),
    // Which slot of the tenant's key chain answered (1–3), and the last four
    // characters so a dashboard row is identifiable without being a secret.
    keyRef: workerKeyRef(event),
    keySlot: Number(event.keySlot) > 0 ? Number(event.keySlot) : null,
    keyLast4: event.keyLast4 ? String(event.keyLast4).slice(-4) : null,
    errorCategory: event.errorCategory ? String(event.errorCategory).slice(0, 20) : null,
  };
  if (!remember(enriched.uid)) return { ok: true, mode: 'off', duplicate: true };

  if (recorder) {
    try {
      recorder(enriched);
      return { ok: true, mode: 'sink' };
    } catch {
      // A broken sink must never break a conversation.
    }
  }
  if (journalEnabled()) {
    try {
      const file = journalFile(), line = `${JSON.stringify(enriched)}\n`;
      // An importer might rename the journal between open and write. Replay
      // the same uid on the new path in that case; import is idempotent.
      for (let i = 0; i < 3; i++) {
        const fd = fs.openSync(file, 'a', 0o600);
        try {
          fs.writeFileSync(fd, line);
          const written = fs.fstatSync(fd), live = fs.statSync(file, { throwIfNoEntry: false });
          if (live?.ino === written.ino && live.dev === written.dev) return { ok: true, mode: 'journal' };
        } finally { fs.closeSync(fd); }
      }
    } catch {
      /* a full disk is not a reason to drop a customer's reply */
    }
  }
  return { ok: false, mode: 'off' };
}

/** Atomically take a closed batch for import. A writer appending after the
 * rename opens the original path. A failed import leaves the batch for retry. */
export function consumeUsageJournal(dir, importBatch, { keepFile = false, filename = 'usage-events.jsonl' } = {}) {
  const source = path.join(dir, filename);
  const batch = keepFile ? source : source + '.importing';
  if (!fs.existsSync(batch)) {
    if (!fs.existsSync(source)) return { ok: true, imported: 0, duplicates: 0, missing: true };
    fs.renameSync(source, batch);
  }
  const result = importBatch(fs.readFileSync(batch, 'utf8').split('\n').filter(Boolean));
  if (result.ok && !keepFile) fs.rmSync(batch, { force: true });
  return result;
}

/** Test hook: forget which uids were handled. */
export function _resetUsageEvents() {
  seenUids.clear();
  recorder = null;
}

export default {
  setUsageRecorder,
  currentRecorder,
  recordUsage,
  isRecording,
  journalEnabled,
  journalFile,
  conversationHash,
  estimateTokens,
};
