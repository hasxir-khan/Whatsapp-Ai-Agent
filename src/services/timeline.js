// src/services/timeline.js
// Where the seconds actually go, per reply.
//
// "The bot feels slow" is not actionable. This records the stages of one reply —
// when the message arrived, when it was marked read, when typing started, when
// the model finished, when the message went out — so `.debug last` can say
// "2.1 s debounce, 0.4 s pipeline, 6.8 s waiting on the model, 3.1 s typing".
//
// Kept in memory (a rolling window of the last 50 replies) and mirrored to the
// events table so `.debug` still has something after a restart.

import * as db from '../utils/db.js';
import { config } from '../config/env.js';

const MAX_ENTRIES = 50;
const entries = []; // oldest first
const byChat = new Map(); // chat -> open entry

function nowMs() {
  return Date.now();
}

function open(chat, batch = null) {
  const key = String(chat || 'unknown');
  let entry = byChat.get(key);
  if (entry && !entry.sentAt) return entry;
  entry = {
    chat: key,
    batch,
    receivedAt: null,
    readAt: null,
    batchAt: null,
    typingAt: null,
    providerDoneAt: null,
    sentAt: null,
    provider: null,
    model: null,
    providerMs: null,
    holdSent: false,
    bubbles: 0,
  };
  byChat.set(key, entry);
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  return entry;
}

/** The customer's message arrived. */
export function received(chat, { batch = null, at = nowMs() } = {}) {
  const entry = open(chat, batch);
  entry.receivedAt = at;
  if (batch) entry.batch = batch;
  return entry;
}

/** A named stage was reached. Unknown names are ignored, not stored. */
export const STAGES = ['read', 'batch', 'typing', 'provider_done', 'sent'];

export function mark(chat, stage, extra = {}) {
  if (!STAGES.includes(stage)) return null;
  const entry = open(chat, extra.batch || null);
  const at = Number(extra.at) || nowMs();
  if (stage === 'read') entry.readAt = at;
  if (stage === 'batch') entry.batchAt = at;
  if (stage === 'typing') entry.typingAt = at;
  if (stage === 'provider_done') {
    entry.providerDoneAt = at;
    if (extra.provider) entry.provider = extra.provider;
    if (extra.model) entry.model = extra.model;
    if (Number.isFinite(extra.ms)) entry.providerMs = Number(extra.ms);
  }
  if (stage === 'sent') {
    entry.sentAt = at;
    if (Number.isFinite(extra.bubbles)) entry.bubbles = Number(extra.bubbles);
    if (extra.hold) entry.holdSent = true;
    byChat.delete(String(chat));
  }
  return entry;
}

/** A holding line went out for this reply ("one sec…"). */
export function markHold(chat) {
  const entry = lastFor(chat);
  if (entry) entry.holdSent = true;
  return entry;
}

/** The reply that just went out, for the caller that wants to log it. */
export function lastFor(chat) {
  const key = String(chat || '');
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].chat === key) return entries[i];
  }
  return null;
}

export function list(limit = 5) {
  return entries.filter((e) => e.sentAt || e.providerDoneAt).slice(-limit);
}

/** Seconds between two stage timestamps, or null. */
function delta(from, to) {
  if (!from || !to) return null;
  return Math.max(0, (to - from) / 1000);
}

const secs = (n) => (n === null || n === undefined ? null : `${n.toFixed(1)}s`);

/**
 * A single line per reply, plus the breakdown of where the time went.
 * @returns {string}
 */
export function formatTimeline({ limit = 5, chat = null } = {}) {
  const rows = chat ? list(MAX_ENTRIES).filter((e) => e.chat === String(chat)).slice(-limit) : list(limit);
  if (!rows.length) return '';

  const lines = ['⏱️ Reply timeline (newest first)'];
  const totals = { debounce: [], pipeline: [], provider: [], wait: [] };

  for (const entry of [...rows].reverse()) {
    const total = delta(entry.receivedAt, entry.sentAt || entry.providerDoneAt);
    const read = delta(entry.receivedAt, entry.readAt);
    const debounce = delta(entry.receivedAt, entry.batchAt);
    const pipeline = delta(entry.batchAt, entry.providerDoneAt);
    const wait = delta(entry.providerDoneAt, entry.sentAt);

    const bits = [
      total === null ? 'in progress' : `${secs(total)} total`,
      read === null ? null : `read +${secs(read)}`,
      debounce === null ? null : `debounce ${secs(debounce)}`,
      pipeline === null ? null : `pipeline ${secs(pipeline)}`,
      entry.providerMs !== null ? `model ${(entry.providerMs / 1000).toFixed(1)}s` : null,
      wait === null ? null : `hold ${secs(wait)}`,
      entry.provider ? `${entry.provider}/${entry.model}` : null,
      entry.holdSent ? 'holding line sent' : null,
    ].filter(Boolean);
    lines.push(`• +${entry.chat} · ${bits.join(' · ')}`);

    for (const [key, value] of Object.entries({ debounce, pipeline, wait })) {
      if (value !== null) totals[key].push(value);
    }
  }

  const avg = (list_) => (list_.length ? list_.reduce((a, b) => a + b, 0) / list_.length : null);
  const parts = [];
  if (totals.debounce.length) parts.push(`debounce ${avg(totals.debounce).toFixed(1)}s`);
  if (totals.pipeline.length) parts.push(`model+pipeline ${avg(totals.pipeline).toFixed(1)}s`);
  if (totals.wait.length) parts.push(`hold ${avg(totals.wait).toFixed(1)}s`);
  if (parts.length) lines.push(`  where the time goes (avg of last ${rows.length}): ${parts.join(' · ')}`);

  return lines.join('\n');
}

/** Mirror the finished reply into the events table, for post-restart debugging. */
export function commit(chat) {
  const entry = lastFor(chat);
  if (!entry || !entry.sentAt) return null;
  try {
    db.logEvent('reply_timeline', chat, {
      totalMs: entry.sentAt - (entry.receivedAt || entry.sentAt),
      readMs: entry.readAt && entry.receivedAt ? entry.readAt - entry.receivedAt : null,
      debounceMs: entry.batchAt && entry.receivedAt ? entry.batchAt - entry.receivedAt : null,
      pipelineMs: entry.providerDoneAt && entry.batchAt ? entry.providerDoneAt - entry.batchAt : null,
      holdMs: entry.sentAt && entry.providerDoneAt ? entry.sentAt - entry.providerDoneAt : null,
      provider: entry.provider,
      model: entry.model,
      providerMs: entry.providerMs,
      bubbles: entry.bubbles,
      holdSent: entry.holdSent,
    });
  } catch {
    /* the timeline is a debugging aid, never a failure */
  }
  return entry;
}

/** Config summary for `.debug timing` and the docs. */
export function timingSummary(timing) {
  const t = timing || {};
  return [
    `reply timing: ${t.enabled === false ? 'off' : 'on'}`,
    `target ${(t.targetMinMs || 0) / 1000}–${(t.targetMaxMs || 0) / 1000}s · typing ${(t.typingMinMs || 0) / 1000}–${(t.typingMaxMs || 0) / 1000}s · debounce ${(t.debounceMs || 0) / 1000}s`,
    `read receipt ${(t.readMinMs || 0) / 1000}–${(t.readMaxMs || 0) / 1000}s · indicator refresh ${(t.refreshMs || 0) / 1000}s · hard cap ${(t.hardCapMs || 0) / 1000}s`,
    `timezone ${config.timezone}`,
  ].join('\n');
}

export function _resetForTests() {
  entries.length = 0;
  byChat.clear();
}

export default {
  received,
  mark,
  markHold,
  list,
  lastFor,
  formatTimeline,
  commit,
  timingSummary,
  _resetForTests,
  STAGES,
};
