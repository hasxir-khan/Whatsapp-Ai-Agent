// platform/usage.js
// What the assistant actually spent, per tenant — the data Part 2 draws.
//
// There is exactly one place in the bot where a model call succeeds
// (src/core/llm.js), and that is where these events are born. Recording is
// switched on by the platform registering a sink; with the flag off nothing
// happens at all.
//
// Two paths, because a control plane and a bot worker are different processes:
//   • same process  → the sink writes straight into the platform database;
//   • worker process → the bot appends to a private journal in its own data
//     directory, and `ingestJournal()` imports it here (idempotent by uid).
//
// Nothing here stores a message. `conversation` is a truncated SHA-256 of the
// chat key, which is enough to count one conversation and useless for reading
// one.

import crypto from 'node:crypto';
import path from 'node:path';
import { get, all, run, lastId, flush } from './db.js';
import { setUsageRecorder, consumeUsageJournal, validKeyRef } from '../src/services/usageEvents.js';

/** A stable, non-reversible conversation handle. */
export function conversationHash(chatKey) {
  if (!chatKey) return null;
  return crypto.createHash('sha256').update(String(chatKey)).digest('hex').slice(0, 16);
}

export const KINDS = ['chat', 'router', 'reasoning', 'tts', 'vision', 'embedding'];

function normaliseKind(kind) {
  const value = String(kind || 'chat').toLowerCase();
  return KINDS.includes(value) ? value : 'chat';
}

function dayOf(iso) {
  return String(iso).slice(0, 10);
}

function monthOf(iso) {
  return String(iso).slice(0, 7);
}

/**
 * Store one event. Returns `{ok, id, duplicate}`; a malformed event is refused
 * rather than written as zeroes, because a wrong number in a dashboard is worse
 * than a gap.
 */
export function record(event = {}) {
  const tenant = String(event.tenant || '').trim();
  if (!tenant) return { ok: false, error: 'no_tenant' };
  const uid = String(event.uid || event.eventUid || '').slice(0, 40) || null;
  if (uid && get('SELECT id FROM usage_events WHERE tenant = ? AND event_uid = ?', [tenant, uid])) {
    return { ok: true, duplicate: true };
  }
  const time = new Date(event.at || Date.now());
  if (!Number.isFinite(time.getTime())) return { ok: false, error: 'invalid_time' };
  const at = time.toISOString();
  const ref = validKeyRef(event.keyRef);
  const prompt = Math.max(0, Math.round(Number(event.promptTokens) || 0));
  const completion = Math.max(0, Math.round(Number(event.completionTokens) || 0));
  const total = Math.max(0, Math.round(Number(event.totalTokens) || prompt + completion));
  const estimated = event.estimated ? 1 : 0;
  run(
    `INSERT INTO usage_events
       (tenant, event_uid, created_at, day, month, provider, model, agent, kind, conversation,
        prompt_tokens, completion_tokens, total_tokens, estimated, latency_ms,
        key_slot, key_last4, error_category, key_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenant,
      uid,
      at,
      dayOf(at),
      monthOf(at),
      event.provider ? String(event.provider).slice(0, 40) : null,
      event.model ? String(event.model).slice(0, 80) : null,
      event.agent ? String(event.agent).slice(0, 40) : null,
      normaliseKind(event.kind),
      event.conversation ? String(event.conversation).slice(0, 32) : null,
      prompt,
      completion,
      total,
      estimated,
      Math.max(0, Math.round(Number(event.latencyMs) || 0)),
      Number(event.keySlot) > 0 ? Number(event.keySlot) : null,
      event.keyLast4 ? String(event.keyLast4).slice(-4) : null,
      event.errorCategory ? String(event.errorCategory).slice(0, 20) : null,
      ref,
    ],
  );
  // A delayed journal line must not change the health of a replacement key.
  if (ref && event.keySlot && event.keyLast4 && (!event.errorCategory || ['invalid','quota','rate_limited','failing'].includes(event.errorCategory))) {
    const health = ['invalid','quota','rate_limited','failing'].includes(event.errorCategory) ? event.errorCategory : 'active';
    run(`UPDATE tenant_keys SET last_used_at = ?, health = ?, health_at = ?
         WHERE slug = ? AND provider = ? AND slot = ? AND fingerprint = ? AND status = 'active'
         AND (id || ':' || key_version) = ? AND (health_at IS NULL OR health_at <= ?)`,
      [at, health, at, tenant, String(event.provider), Number(event.keySlot), String(event.keyLast4).slice(-4), ref, at]);
  }
  return { ok: true, id: lastId() };
}

/** Hand the bot's single call site a sink. Called when the platform mounts. */
export function attachUsageSink() {
  setUsageRecorder((event) => {
    try {
      return record(event);
    } catch {
      return { ok: false };
    }
  });
  return true;
}

export function detachUsageSink() {
  setUsageRecorder(null);
  return true;
}

// ── rollups ──────────────────────────────────────────────────
function zeroTotals() {
  return { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, estimated_calls: 0, latency_ms: 0 };
}

function addRow(into, row) {
  into.calls += Number(row.calls) || 0;
  into.prompt_tokens += Number(row.prompt_tokens) || 0;
  into.completion_tokens += Number(row.completion_tokens) || 0;
  into.total_tokens += Number(row.total_tokens) || 0;
  into.estimated_calls += Number(row.estimated_calls) || 0;
  into.latency_ms += Number(row.latency_ms) || 0;
  return into;
}

const AGGREGATE = `COUNT(*) AS calls,
  COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
  COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
  COALESCE(SUM(total_tokens), 0) AS total_tokens,
  COALESCE(SUM(estimated), 0) AS estimated_calls,
  COALESCE(SUM(latency_ms), 0) AS latency_ms`;

/** Per-day rows for a month (or everything). `from`/`to` are ISO dates. */
export function daily(slug, { from = null, to = null } = {}) {
  const params = [String(slug)];
  let sql = `SELECT day, ${AGGREGATE} FROM usage_events WHERE tenant = ?`;
  if (from) {
    sql += ' AND day >= ?';
    params.push(String(from).slice(0, 10));
  }
  if (to) {
    sql += ' AND day <= ?';
    params.push(String(to).slice(0, 10));
  }
  sql += ' GROUP BY day ORDER BY day ASC';
  return all(sql, params).map((row) => ({ bucket: row.day, ...zeroTotals(), ...row, calls: Number(row.calls) || 0 }));
}

export function monthly(slug, { from = null, to = null } = {}) {
  const params = [String(slug)];
  let sql = `SELECT month, ${AGGREGATE} FROM usage_events WHERE tenant = ?`;
  if (from) {
    sql += ' AND month >= ?';
    params.push(String(from).slice(0, 7));
  }
  if (to) {
    sql += ' AND month <= ?';
    params.push(String(to).slice(0, 7));
  }
  sql += ' GROUP BY month ORDER BY month ASC';
  return all(sql, params).map((row) => ({ bucket: row.month, ...zeroTotals(), ...row, calls: Number(row.calls) || 0 }));
}

export function byKind(slug, { month = null } = {}) {
  const params = [String(slug)];
  let sql = `SELECT kind, ${AGGREGATE} FROM usage_events WHERE tenant = ?`;
  if (month) {
    sql += ' AND month = ?';
    params.push(String(month).slice(0, 7));
  }
  sql += ' GROUP BY kind ORDER BY total_tokens DESC';
  return all(sql, params);
}

export function byModel(slug, { month = null } = {}) {
  const params = [String(slug)];
  let sql = `SELECT provider, model, ${AGGREGATE} FROM usage_events WHERE tenant = ?`;
  if (month) {
    sql += ' AND month = ?';
    params.push(String(month).slice(0, 7));
  }
  sql += ' GROUP BY provider, model ORDER BY total_tokens DESC';
  return all(sql, params);
}

/** Distinct conversations this month — what the plan's monthly cap counts. */
export function conversations(slug, { month = new Date().toISOString().slice(0, 7) } = {}) {
  const row = get(
    'SELECT COUNT(DISTINCT conversation) AS n FROM usage_events WHERE tenant = ? AND month = ? AND conversation IS NOT NULL',
    [String(slug), String(month).slice(0, 7)],
  );
  return Number(row?.n || 0);
}

/** One object for the dashboard (and for the account export). */
export function summary(slug, { month = new Date().toISOString().slice(0, 7), from = null, to = null } = {}) {
  const totals = zeroTotals();
  for (const row of byKind(slug, { month })) addRow(totals, row);
  const events = Number(get('SELECT COUNT(*) AS n FROM usage_events WHERE tenant = ?', [String(slug)])?.n || 0);
  return {
    tenant: slug,
    month,
    totals,
    conversations: conversations(slug, { month }),
    kinds: byKind(slug, { month }),
    daily: daily(slug, { from: from || `${month}-01`, to }),
    monthly: monthly(slug, { from, to }),
    models: byModel(slug, { month }),
    keys: byKey(slug, { month }),
    events,
  };
}

/**
 * Calls, tokens and errors per key slot — the "usage per key/provider/model"
 * view. `errors` counts events that arrived with an error category; the caller
 * records those when a call is refused, so the count is real traffic.
 */
export function byKey(slug, { month = null } = {}) {
  const params = [String(slug)];
  let sql = `SELECT provider, model, key_slot, key_last4, key_ref,
      COUNT(*) AS calls,
      COALESCE(SUM(total_tokens), 0) AS tokens,
      COALESCE(SUM(CASE WHEN estimated = 1 THEN 1 ELSE 0 END), 0) AS estimated,
      COALESCE(SUM(CASE WHEN error_category IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors,
      MAX(CASE WHEN error_category IS NOT NULL THEN created_at END) AS last_error_at, GROUP_CONCAT(DISTINCT error_category) AS categories
    FROM usage_events WHERE tenant = ?`;
  if (month) {
    sql += ' AND month = ?';
    params.push(String(month).slice(0, 7));
  }
  sql += ' GROUP BY provider, model, key_slot, key_last4, key_ref ORDER BY tokens DESC';
  const rows = all(sql, params);

  return rows.map(({ key_ref, ...row }) => ({
    ...row,
    key_version: key_ref ? Number(key_ref.split(':')[1]) : null,
    key_slot: row.key_slot === null ? null : Number(row.key_slot),
    calls: Number(row.calls) || 0,
    tokens: Number(row.tokens) || 0,
    estimated: Number(row.estimated) || 0,
    errors: Number(row.errors) || 0,
    error_categories: (row.categories || '').split(',').filter(Boolean),
  }));
}

/** One-line alias used by platform/keys.js. */
export function platformKeyUsage(slug, options = {}) {
  return byKey(slug, options);
}

// ── worker journals ──────────────────────────────────────────
/**
 * Import a tenant's local journal. The file is written by the bot when
 * PLATFORM_USAGE_JOURNAL=1 (the platform sets it while provisioning), one JSON
 * object per line, 0600. Imported lines are removed only after they are stored,
 * so a crash mid-import loses nothing.
 */
export function ingestJournal({ slug, dataDir, keepFile = false } = {}) {
  const dir = dataDir || journalDir(slug);
  try {
    return consumeUsageJournal(dir, (lines) => {
      let imported = 0, duplicates = 0;
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        const result = record({ ...event, tenant: slug });
        if (result.duplicate) duplicates++;
        else if (result.ok) imported++;
      }
      return { ok: flush(), imported, duplicates };
    }, { keepFile });
  } catch { return { ok: false, error: 'journal_unavailable' }; }
}

function journalDir(slug) {
  const root = process.env.TENANTS_DIR || path.join(process.cwd(), 'tenants');
  return path.join(root, String(slug), 'data');
}

export default {
  record,
  attachUsageSink,
  detachUsageSink,
  conversationHash,
  daily,
  monthly,
  byKind,
  byModel,
  byKey,
  platformKeyUsage,
  conversations,
  summary,
  ingestJournal,
  KINDS,
};
