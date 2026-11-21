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
// Nothing here stores a message. Both paths key conversation labels before
// writing, including when dashboard reporting is disabled.

import { dashboardEnabled } from './env.js';
import { safeUsageLabels, bounds, replayIdentity } from './reportContext.js';
import { tenantMeterKey } from './meterIdentity.js';
import { alias, masked } from '../src/services/reportContract.js';
import path from 'node:path';
import { get, all, run, lastId, flush } from './db.js';
import { conversationId, setUsageRecorder, consumeUsageJournal, validKeyRef } from '../src/services/usageEvents.js';

const installSalt = () => get('SELECT salt FROM number_identity_salt').salt;
export const meterKeyForTenant = (tenant) => tenantMeterKey(installSalt(), tenant);

export const KINDS = ['chat', 'router', 'reasoning', 'voice', 'tts', 'vision', 'embedding'];

function normaliseKind(kind) {
  const value = String(kind || 'chat').toLowerCase();
  return KINDS.includes(value) ? value : 'chat';
}

// Cached legacy views use the same tenant-local dates and retention as the new pages.
const ROLLUP = `SUM(calls) calls,SUM(tokens) total_tokens,SUM(prompt) prompt_tokens,
 SUM(completion) completion_tokens,SUM(estimated) estimated_calls,SUM(ms) latency_ms`;
const CACHE = ' FROM r_usage WHERE slug=? AND hour=-1 AND day BETWEEN ? AND ?';
function retained(slug,{month,from,to}={}) {
  const {earliest,today}=bounds(slug);
  const first=[earliest,month?month+'-01':'',from||''].sort().at(-1);
  const last=[today,month?month+'-31':today,to||today].sort()[0];
  return [String(slug),first,last];
}
function cachedGroups(slug, group, opts, sort='total_tokens DESC') {
  return all(`SELECT ${group},${ROLLUP}${CACHE} GROUP BY ${group} ORDER BY ${sort}`,retained(slug,opts));
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
  return writeEvent(event, false);
}

function writeEvent(event, fromWorker) {
  const tenant = String(event.tenant || '').trim();
  if (!tenant) return { ok: false, error: 'no_tenant' };
  const reporting = dashboardEnabled();
  if (reporting && !get('SELECT 1 FROM tenants WHERE slug=?', [tenant])) return { ok: false, error: 'unknown_tenant' };
  const salt = reporting || event.chatKey || event.conversation ? installSalt() : null;
  let conversation = null;
  if (fromWorker && masked(event.conversation))
    conversation = event.conversation; // already keyed at the source
  else if (event.chatKey) conversation = conversationId(event.chatKey, tenantMeterKey(salt, tenant));
  else if (event.conversation) conversation = alias(event.conversation, tenantMeterKey(salt, tenant), 'chat');
  let uid = String(event.uid || event.eventUid || '').slice(0, 40) || null;
  if (reporting) {
    const id = replayIdentity(
      tenant,
      uid,
      conversation,
      event.errorCategory,
      salt
    );
    // A pre-dashboard batch may replay before its legacy row is backfilled.
    if (uid && uid !== id.uid && get('SELECT id FROM usage_events WHERE tenant=? AND event_uid=?', [tenant, uid]))
      return { ok: true, duplicate: true };
    uid = id.uid;
    event = { ...event, ...id, ...safeUsageLabels(tenant, event.provider, event.model, event.agent) };
  }
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
      conversation,
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
      return writeEvent(event, true);
    } catch {
      return { ok: false };
    }
  }, meterKeyForTenant);
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
  if (dashboardEnabled()) return cachedGroups(slug, 'day', { from, to }, 'day').map((r) => ({ ...r, bucket: r.day }));
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
  if (dashboardEnabled())
    return cachedGroups(slug, 'substr(day,1,7)', { from, to }, '1').map(({ ['substr(day,1,7)']: month, ...r }) => ({
      ...r,
      month,
      bucket: month,
    }));
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
  if (dashboardEnabled()) return cachedGroups(slug, 'kind', { month });
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
  if (dashboardEnabled()) return cachedGroups(slug, 'provider,model', { month });
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
export function conversations(slug, { month = null } = {}) {
  if (dashboardEnabled())
    return get(
      'SELECT COUNT(DISTINCT who) n FROM r_meter WHERE slug=? AND day BETWEEN ? AND ?',
      retained(slug, { month: month || bounds(slug).today.slice(0, 7) })
    ).n;
  month ??= new Date().toISOString().slice(0, 7);
  const row = get(
    'SELECT COUNT(DISTINCT conversation) AS n FROM usage_events WHERE tenant = ? AND month = ? AND conversation IS NOT NULL',
    [String(slug), String(month).slice(0, 7)]
  );
  return Number(row?.n || 0);
}

/** One object for the dashboard (and for the account export). */
export function summary(slug, { month = null, from = null, to = null } = {}) {
  const cached = dashboardEnabled();
  month ??= (cached ? bounds(slug).today : new Date().toISOString()).slice(0, 7);
  const totals = zeroTotals();
  const kinds = byKind(slug, { month });
  for (const row of kinds) addRow(totals, row);
  const events = cached
    ? get('SELECT SUM(calls) n' + CACHE, retained(slug)).n || 0
    : Number(get('SELECT COUNT(*) AS n FROM usage_events WHERE tenant = ?', [String(slug)])?.n || 0);
  return {
    tenant: slug,
    month,
    totals,
    conversations: conversations(slug, { month }),
    kinds,
    daily: daily(slug, { from: from || `${month}-01`, to: to || (cached ? `${month}-31` : null) }),
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
  if (dashboardEnabled()) {
    return all(
      `SELECT provider,model,slot key_slot,version key_version,key_id,NULL key_last4,SUM(calls) calls,
      SUM(tokens) tokens,SUM(estimated) estimated,SUM(errors) errors,MAX(last_error_at) last_error_at,
      GROUP_CONCAT(DISTINCT NULLIF(category,'')) categories${CACHE}
      GROUP BY provider,model,slot,version,key_id ORDER BY tokens DESC`,
      retained(slug, { month })
    ).map((r) => ({ ...r, error_categories: (r.categories || '').split(',').filter(Boolean) }));
  }
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
        const result = writeEvent({ ...event, tenant: slug }, true);
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
