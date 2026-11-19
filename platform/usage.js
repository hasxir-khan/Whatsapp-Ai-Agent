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
import fs from 'node:fs';
import path from 'node:path';
import { get, all, run, lastId } from './db.js';
import { setUsageRecorder } from '../src/services/usageEvents.js';

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
  if (uid && get('SELECT id FROM usage_events WHERE event_uid = ?', [uid])) {
    return { ok: true, duplicate: true };
  }
  const at = new Date(event.at || Date.now()).toISOString();
  const prompt = Math.max(0, Math.round(Number(event.promptTokens) || 0));
  const completion = Math.max(0, Math.round(Number(event.completionTokens) || 0));
  const total = Math.max(0, Math.round(Number(event.totalTokens) || prompt + completion));
  const estimated = event.estimated ? 1 : 0;
  run(
    `INSERT INTO usage_events
       (tenant, event_uid, created_at, day, month, provider, model, agent, kind, conversation,
        prompt_tokens, completion_tokens, total_tokens, estimated, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ],
  );
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
    events,
  };
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
  const file = path.join(dir, 'usage-events.jsonl');
  if (!fs.existsSync(file)) return { ok: true, imported: 0, duplicates: 0, missing: true };
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { ok: false, error: 'unreadable' };
  }
  let imported = 0;
  let duplicates = 0;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const result = record({ ...event, tenant: event.tenant || slug });
    if (result.duplicate) duplicates += 1;
    else if (result.ok) imported += 1;
  }
  if (!keepFile) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* next import will see the same uids and skip them */
    }
  }
  return { ok: true, imported, duplicates };
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
  conversations,
  summary,
  ingestJournal,
  KINDS,
};
