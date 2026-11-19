// src/services/learning.js
// Phase 6 Part 3 — the learning loop.
//
// Deliberately boring: a handful of named weights, each moved by a fixed rule
// when an outcome is recorded. No hidden training, no embeddings, no model that
// "learns" in a way the owner cannot read. `.brain weights` prints the table and
// `.brain reset` puts every weight back to 1.0.

import { featureOn } from './profile.js';
import { config } from '../config/env.js';
import * as db from '../utils/db.js';

export const DEFAULT_WEIGHT = 1;
export const MIN_WEIGHT = 0.5;
export const MAX_WEIGHT = 1.5;

/** The rules, in one place, because they are the whole algorithm. */
export const RULES = [
  { outcome: 'converted', delta: +0.05, note: 'an order or booking followed' },
  { outcome: 'replied', delta: +0.02, note: 'the customer wrote back' },
  { outcome: 'asked_owner', delta: 0, note: 'no signal either way' },
  { outcome: 'none', delta: -0.03, note: 'no reply within the window' },
];

export const TRACKED_ACTIONS = ['followup', 'quote_reminder', 'offer', 'upsell', 'review_ask', 'reactivate'];

export function learningEnabled() {
  return featureOn('businessBrain');
}

const tenant = () => config.tenant?.slug || null;
const clamp = (n) => Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, Number(n) || DEFAULT_WEIGHT));

export function weightFor(key) {
  const row = db.get('SELECT value FROM brain_weights WHERE tenant = ? AND key = ?', [tenant(), key]);
  return row ? clamp(row.value) : DEFAULT_WEIGHT;
}

export function setWeight(key, value, now = new Date()) {
  const v = clamp(value);
  db.run(
    `INSERT INTO brain_weights (tenant, key, value, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(tenant, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [tenant(), key, v, now.toISOString()]
  );
  return v;
}

/**
 * Record what happened after an action. `action` is an NBA action id, `agent`
 * an assistant id; both weights move, with the same rule.
 */
export function recordOutcome({ action = null, agent = null, outcome = 'none', now = new Date() } = {}) {
  const rule = RULES.find((r) => r.outcome === outcome) || RULES[RULES.length - 1];
  const changed = [];
  for (const [prefix, id] of [
    ['nba', action],
    ['agent', agent],
  ]) {
    if (!id) continue;
    const key = `${prefix}:${id}`;
    const before = weightFor(key);
    const after = setWeight(key, before + rule.delta, now);
    changed.push({ key, before, after });
  }
  if (changed.length) {
    db.logEvent('brain_weights', null, { outcome, action, agent, changed: changed.map((c) => `${c.key}=${c.after.toFixed(2)}`) });
  }
  return { outcome, rule, changed };
}

// ── turning sends into outcomes ─────────────────────────────

const DAY_MS = 24 * 3600 * 1000;

/** The growth agent that sent the message, as an NBA action id (or null). */
function actionOf(agent, reason = '') {
  const a = String(agent || '').toLowerCase();
  if (TRACKED_ACTIONS.includes(a)) return a;
  const r = String(reason || '').toLowerCase();
  if (a.includes('review') || r.includes('review')) return 'review_ask';
  if (a.includes('reactiv') || r.includes('win-back') || r.includes('wake')) return 'reactivate';
  if (a.includes('follow') || r.includes('follow')) return 'followup';
  if (r.includes('quote')) return 'quote_reminder';
  if (r.includes('offer')) return 'offer';
  return null;
}

function alreadyCounted(number, sendId) {
  return Boolean(
    db.get("SELECT id FROM brain_decisions WHERE chat = ? AND kind = 'learning' AND action = ?", [number, `outcome:${sendId}`])
  );
}

function markCounted(number, sendId, outcome, now) {
  try {
    db.run(
      "INSERT INTO brain_decisions (tenant, chat, kind, action, rationale, payload, outcome, created_at) VALUES (?,?,?,?,?,?,?,?)",
      [tenant(), number, 'learning', `outcome:${sendId}`, `Recorded "${outcome}" for proactive send #${sendId}`.slice(0, 300), null, outcome, now.toISOString()]
    );
  } catch {
    /* the weight already moved; the marker is housekeeping */
  }
}

/**
 * The customer wrote back. Credit the most recent proactive message we sent
 * them (once), and count it as a conversion if an order or booking followed.
 */
export function noteReplyOutcome(number, { now = new Date() } = {}) {
  if (!learningEnabled()) return { recorded: 0 };
  const jid = `${number}@s.whatsapp.net`;
  try {
    const send = db.get(
      "SELECT id, agent, reason, created_at FROM growth_sends WHERE number = ? AND result = 'sent' AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
      [number, new Date(now.getTime() - 7 * DAY_MS).toISOString()]
    );
    if (!send || alreadyCounted(number, send.id)) return { recorded: 0 };
    const converted =
      Boolean(db.get("SELECT id FROM orders WHERE (chat = ? OR chat = ?) AND created_at >= ? AND status NOT IN ('cancelled')", [number, jid, send.created_at])) ||
      Boolean(db.get('SELECT id FROM bookings WHERE (chat = ? OR chat = ?) AND created_at >= ?', [number, jid, send.created_at]));
    const outcome = converted ? 'converted' : 'replied';
    recordOutcome({ action: actionOf(send.agent, send.reason), agent: send.agent || null, outcome, now });
    markCounted(number, send.id, outcome, now);
    return { recorded: 1, outcome, send: send.id };
  } catch {
    return { recorded: 0 };
  }
}

/**
 * The other half: messages that got no answer at all. Run once a day (the
 * strategist's brief does it); anything older than `quietDays` with no reply
 * from the contact counts as "none".
 */
export function sweepOutcomes({ now = new Date(), quietDays = 3, limit = 200 } = {}) {
  if (!learningEnabled()) return { swept: 0 };
  const from = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const cutoff = new Date(now.getTime() - quietDays * DAY_MS).toISOString();
  const sends = db.all(
    "SELECT id, number, agent, reason, created_at FROM growth_sends WHERE result = 'sent' AND created_at >= ? AND created_at < ? ORDER BY created_at LIMIT ?",
    [from, cutoff, limit]
  );
  let swept = 0;
  for (const send of sends) {
    if (alreadyCounted(send.number, send.id)) continue;
    const reply = db.get("SELECT id FROM messages WHERE number = ? AND role = 'user' AND created_at > ? LIMIT 1", [send.number, send.created_at]);
    if (reply) continue;
    recordOutcome({ action: actionOf(send.agent, send.reason), agent: send.agent || null, outcome: 'none', now });
    markCounted(send.number, send.id, 'none', now);
    swept += 1;
  }
  return { swept };
}

export function weights() {
  const rows = db.all('SELECT key, value, updated_at FROM brain_weights WHERE tenant = ? ORDER BY key', [tenant()]);
  return rows.map((r) => ({ key: r.key, value: Number(r.value), updatedAt: r.updated_at }));
}

export function resetWeights() {
  const n = db.all('SELECT key FROM brain_weights WHERE tenant = ?', [tenant()]).length;
  db.run('DELETE FROM brain_weights WHERE tenant = ?', [tenant()]);
  db.logEvent('brain_weights_reset', null, { keys: n });
  return { reset: n };
}

export function weightsText() {
  const rows = weights();
  const lines = ['⚖️ *Learning weights*', ''];
  if (!rows.length) {
    lines.push('Everything is at 1.00 — no outcomes recorded yet.');
  } else {
    for (const row of rows) {
      const sign = row.value > 1 ? '+' : '';
      lines.push(`  ${row.key}: ${sign}${(row.value - 1).toFixed(2)} (${row.value.toFixed(2)})`);
    }
  }
  lines.push('', 'How they move:');
  for (const rule of RULES) {
    lines.push(`  ${rule.outcome}: ${rule.delta >= 0 ? '+' : ''}${rule.delta.toFixed(2)} — ${rule.note}`);
  }
  lines.push('', 'Clamped to 0.50–1.50. .brain reset puts them all back to 1.00.');
  return lines.join('\n');
}

export default { weightFor, setWeight, recordOutcome, noteReplyOutcome, sweepOutcomes, weights, resetWeights, weightsText, RULES, TRACKED_ACTIONS, learningEnabled, DEFAULT_WEIGHT };
