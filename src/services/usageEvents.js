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
    agent: event.agent || null,
    kind: event.kind || 'chat',
    conversation: event.conversation || conversationHash(event.chatKey),
    promptTokens: Math.max(0, Number(event.promptTokens) || 0),
    completionTokens: Math.max(0, Number(event.completionTokens) || 0),
    totalTokens: Math.max(0, Number(event.totalTokens) || 0),
    estimated: !!event.estimated,
    latencyMs: Math.max(0, Number(event.latencyMs) || 0),
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
      fs.appendFileSync(journalFile(), `${JSON.stringify(enriched)}\n`, { mode: 0o600 });
      return { ok: true, mode: 'journal' };
    } catch {
      /* a full disk is not a reason to drop a customer's reply */
    }
  }
  return { ok: false, mode: 'off' };
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
