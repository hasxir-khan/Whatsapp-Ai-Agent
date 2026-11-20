import crypto from 'node:crypto';
import path from 'node:path';
import { ensureOpen, all, get, run, transaction, flush } from './db.js';
import { consumeUsageJournal, validKeyRef } from '../src/services/usageEvents.js';
import {
  cleanPerson,
  cleanCard,
  cleanCurrent,
  fact,
  REPORT_VERSION,
  isoTime,
  zoneName,
  alias,
} from '../src/services/reportContract.js';
import { validDay, partsInTz, midnight } from '../src/services/reportCalendar.js';
import { dashboardEnabled } from './env.js';
import { reportTables } from './reportSchema.js';
import { ingestJournal } from './usage.js';

import { bounds, safeUsageLabels, replayIdentity } from './reportContext.js';
export { bounds };
const del = (table, slug) => run(`DELETE FROM ${table} WHERE slug=?`, [slug]);
export function eraseReports(slug) {
  for (const table of reportTables) del(table, slug);
}
export function purgeReports(slug, now = new Date()) {
  const { earliest, zone } = bounds(slug, now);
  for (const t of ['r_days', 'r_people', 'r_facts', 'r_cards', 'r_usage', 'r_meter'])
    run(`DELETE FROM ${t} WHERE slug=? AND day<?`, [slug, earliest]);
  // Never retain the per-call replay ledger longer than its rollups.
  run('DELETE FROM usage_events WHERE tenant=? AND created_at<?', [slug, midnight(earliest, zone)]);
  const cutoff = midnight(earliest, zone);
  run('DELETE FROM r_state WHERE slug=? AND at<?', [slug, cutoff]);
  for (const col of ['last_call', 'last_success'])
    run(`UPDATE r_cursor SET ${col}=NULL WHERE slug=? AND ${col}<?`, [slug, cutoff]);
}
function batch(sql, rows) {
  const st = ensureOpen().prepare(sql);
  try {
    for (const row of rows) st.run(row);
  } finally {
    st.free();
  }
}
// Replace whole buckets, never blindly add snapshot totals. Compare generation
// time *and* digest: a changed prior date replaces that date, an old replay
// cannot undo a newer snapshot. All buckets + freshness commit together.
export function importReports(slug, lines, now = new Date()) {
  if (!get('SELECT slug FROM tenants WHERE slug=?', [slug])) return { ok: false, error: 'unknown_tenant' };
  let imported = 0,
    duplicates = 0;
  transaction(() => {
    for (const line of lines) {
      const r = JSON.parse(line);
      if (
        r.v !== REPORT_VERSION ||
        !validDay(r.day) ||
        !isoTime(r.at) ||
        Date.parse(r.at) > Number(now) + 60000 ||
        zoneName(r.zone) !== r.zone
      )
        throw new Error('invalid_report');
      const { earliest, today } = bounds(slug, now, r.zone);
      if (r.day < earliest || r.day > today) continue;
      const state = get('SELECT zone,at FROM r_state WHERE slug=?', [slug]);
      if (state && state.zone !== r.zone) {
        if (state.at >= r.at) continue;
        eraseReports(slug); // the next full generation re-buckets local calendar dates
      }
      const old = get('SELECT at,digest FROM r_days WHERE slug=? AND day=?', [slug, r.day]);
      if (old && old.at >= r.at) {
        duplicates++;
        continue;
      }
      const { at, v, ...content } = r;
      const digest = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
      const pre = [slug, r.day];
      if (old?.digest !== digest) {
        for (const t of ['r_people', 'r_facts', 'r_cards']) run(`DELETE FROM ${t} WHERE slug=? AND day=?`, pre);
        batch(
          'INSERT INTO r_people VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          r.people.map((raw) => {
            const p = cleanPerson(raw);
            if (!p.who) throw new Error('invalid_contact');
            return [
              ...pre,
              p.who,
              p.first_at,
              p.owner,
              p.bot,
              p.bookings,
              p.orders,
              p.revenue,
              p.response_ms,
              p.outside,
              p.source,
            ];
          }),
        );
        const buckets = new Map();
        function add(row, hour) {
          const key = JSON.stringify([row.metric, hour, row.a, row.b]);
          const b = buckets.get(key) || [slug, row.metric, r.day, hour, row.a, row.b, 0, 0];
          b[6] += row.n;
          b[7] += row.value;
          buckets.set(key, b);
        }
        for (const raw of r.facts) {
          const f = fact(raw);
          add(f, f.hour);
          if (f.hour >= 0) add(f, -1);
        }
        batch('INSERT INTO r_facts VALUES(?,?,?,?,?,?,?,?)', buckets.values());
        batch(
          'INSERT INTO r_cards VALUES(?,?,?,?,?,?,?,?,?,?)',
          r.cards.map((raw) => {
            const c = cleanCard(raw.kind, raw);
            return [
              slug,
              c.kind,
              r.day,
              c.at,
              c.contact || '',
              c.agent || '',
              c.type || '',
              c.outcome || c.stage || c.state || '',
              c.order || 0,
              JSON.stringify(c),
            ];
          }),
        );
        imported++;
      } else duplicates++;
      run('INSERT OR REPLACE INTO r_days VALUES(?,?,?,?,?)', [...pre, at, digest, +(r.eventsComplete === true)]);
      if (r.current && (!state || at >= state.at))
        run('INSERT OR REPLACE INTO r_state VALUES(?,?,?,?)', [
          slug,
          r.zone,
          at,
          JSON.stringify(cleanCurrent(r.current)),
        ]);
    }
  });
  return { ok: flush(), imported, duplicates };
}
// A high-water mark on increasing insert id, NOT event time. This catches
// late arrivals. One SQL transaction includes both upserts and its cursor.
export function refreshMeter(slug, now = new Date()) {
  const { zone, earliest, today } = bounds(slug, now);
  let cursor = get('SELECT * FROM r_cursor WHERE slug=?', [slug]);
  const reset = cursor && cursor.zone !== zone;
  const rows = all('SELECT * FROM usage_events WHERE tenant=? AND id>? ORDER BY id LIMIT 10000', [
    slug,
    reset ? 0 : cursor?.id || 0,
  ]);
  if (!rows.length && !reset) {
    if (cursor) run('UPDATE r_cursor SET at=? WHERE slug=?', [now.toISOString(), slug]);
    else if (get('SELECT 1 FROM r_state WHERE slug=?', [slug]))
      run('INSERT INTO r_cursor VALUES(?,0,?,?,NULL,NULL)', [slug, zone, now.toISOString()]);
    return 0;
  }
  const install = get('SELECT salt FROM number_identity_salt').salt,
    salt = install + '\0' + slug,
    legacy = [];
  let lastCall = reset ? null : cursor?.last_call || null,
    lastSuccess = reset ? null : cursor?.last_success || null;
  const acc = new Map(),
    meter = new Map(),
    hours = new Map(),
    labels = new Map();
  for (const r of rows) {
    if (!isoTime(r.created_at)) continue;
    const minute = r.created_at.slice(0, 16);
    if (!hours.has(minute)) {
      const p = partsInTz(new Date(r.created_at), zone);
      hours.set(minute, [
        `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`,
        p.hour,
      ]);
    }
    const [day, h] = hours.get(minute);
    if (day < earliest || day > today) continue;
    if (!lastCall || r.created_at > lastCall) lastCall = r.created_at;
    if (!r.error_category && (!lastSuccess || r.created_at > lastSuccess)) lastSuccess = r.created_at;
    const key = JSON.stringify([r.provider, r.model, r.agent]);
    if (!labels.has(key)) labels.set(key, safeUsageLabels(slug, r.provider, r.model, r.agent));
    const { provider, model, agent } = labels.get(key);
    const id = replayIdentity(slug, r.event_uid, r.conversation, r.error_category, install);
    if (
      r.event_uid !== id.uid ||
      r.conversation !== id.conversation ||
      r.error_category !== id.errorCategory ||
      r.model !== model ||
      r.agent !== agent ||
      r.provider !== provider
    )
      legacy.push([id.uid, id.conversation, id.errorCategory, model, agent, provider, slug, r.id]);
    const kind = ['voice', 'tts'].includes(r.kind)
      ? 'voice'
      : ['chat', 'router', 'reasoning', 'vision', 'embedding'].includes(r.kind)
        ? r.kind
        : 'chat';
    const ref = validKeyRef(r.key_ref)?.split(':');
    for (const hour of [-1, h]) {
      const dims = [
          slug,
          day,
          hour,
          provider,
          model,
          agent,
          kind,
          Math.min(3, Math.max(0, +r.key_slot || 0)),
          Number(ref?.[1]) || 0,
          ref ? alias(ref[0], salt, 'key') : 'unknown',
          id.errorCategory || '',
        ],
        k = JSON.stringify(dims);
      const v = acc.get(k) || {
        dims,
        calls: 0,
        tokens: 0,
        estimated: 0,
        errors: 0,
        ms: 0,
        prompt: 0,
        completion: 0,
        lastError: null,
      };
      v.calls++;
      v.tokens += r.total_tokens;
      v.estimated += +!!r.estimated;
      v.ms += r.latency_ms;
      v.prompt += r.prompt_tokens;
      v.completion += r.completion_tokens;
      if (id.errorCategory) {
        v.errors++;
        if (!v.lastError || v.lastError < r.created_at) v.lastError = r.created_at;
      }
      acc.set(k, v);
    }
    if (id.conversation) {
      const who = alias(id.conversation, salt, 'meter');
      meter.set(day + who, [slug, day, who]);
    }
  }
  transaction(() => {
    batch(
      'UPDATE usage_events SET event_uid=?,conversation=?,error_category=?,model=?,agent=?,provider=? WHERE tenant=? AND id=?',
      legacy,
    );
    if (reset) {
      del('r_usage', slug);
      del('r_meter', slug);
    }
    batch(
      `INSERT INTO r_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET ${['calls', 'tokens', 'estimated', 'errors', 'ms', 'prompt', 'completion'].map((k) => `${k}=${k}+excluded.${k}`).join(',')},last_error_at=MAX(last_error_at,excluded.last_error_at)`,
      [...acc.values()].map((v) => [
        ...v.dims,
        v.calls,
        v.tokens,
        v.estimated,
        v.errors,
        v.ms,
        v.prompt,
        v.completion,
        v.lastError,
      ]),
    );
    batch('INSERT OR IGNORE INTO r_meter VALUES(?,?,?)', meter.values());
    run('INSERT OR REPLACE INTO r_cursor VALUES(?,?,?,?,?,?)', [
      slug,
      rows.at(-1)?.id || 0,
      zone,
      now.toISOString(),
      lastCall,
      lastSuccess,
    ]);
  });
  return rows.length;
}
export async function reconcileTenant(
  slug,
  {
    dir = path.join(process.env.TENANTS_DIR || path.join(process.cwd(), 'tenants'), slug, 'data'),
    now = new Date(),
  } = {},
) {
  let snapshots;
  try {
    snapshots = consumeUsageJournal(dir, (lines) => importReports(slug, lines, now), {
      filename: 'dashboard-v1.jsonl',
    });
  } finally {
    try {
      const result = ingestJournal({ slug, dataDir: dir });
      if (!result.ok) throw new Error('usage_import_deferred');
      while (refreshMeter(slug, now) === 10000) await new Promise((r) => setImmediate(r));
    } finally {
      purgeReports(slug, now);
    }
  }
  return snapshots;
}
let timer,
  first,
  busy = false;
export function startReportImporter() {
  if (timer || !dashboardEnabled()) return;
  const tick = async () => {
    if (busy || !dashboardEnabled()) return;
    busy = true;
    try {
      for (const { slug } of all('SELECT slug FROM tenants')) {
        try {
          await reconcileTenant(slug);
        } catch {
          console.warn('Dashboard import deferred; previous rollups retained.');
        }
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      busy = false;
    }
  };
  first = setTimeout(tick, 100);
  first.unref();
  timer = setInterval(tick, 60000);
  timer.unref();
}
export function stopReportImporter() {
  clearTimeout(first);
  clearInterval(timer);
  timer = null;
}
