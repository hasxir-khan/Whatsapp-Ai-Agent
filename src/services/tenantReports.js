// Runs inside ONE tenant's worker. Materialise sufficient statistics, not a
// mirror of its DB. Raw text used to categorise questions never leaves here.
import { MEDIA_COUNTERS } from './mediaLimits.js';
import fs from 'node:fs';
import path from 'node:path';
import { tenantBudget, tenantSlug } from '../core/llm.js';
import { config } from '../config/env.js';
import { get, all, run } from '../utils/db.js';
import { parseHours } from './hours.js';
import { business } from './profile.js';
import { questionType } from './reportArchive.js';
import { accuracyReport } from './accuracy.js';
import { impactRelation, impactConfig, impactFollowThrough } from './impact.js';
import { leadActionCode } from './leads.js';
import { growthSummary } from './growth.js';
import { funnel, sourceOf } from './growthDashboard.js';
import { paymentsSummary } from './paymentReview.js';
import { counters } from './transportAudit.js';
import { goalProgress, listGoals } from './goals.js';
import { experimentResult } from './experiments.js';
import { listDrafts } from './reviewQueue.js';
import {
  REPORT_VERSION,
  alias,
  code,
  dimension,
  fact,
  cleanPerson,
  cleanCard,
  cleanCurrent,
  zoneName,
} from './reportContract.js';
import { midnight, shiftDay, localDateString, partsInTz } from './reportCalendar.js';

const json = (s) => {
  try {
    return JSON.parse(s) || {};
  } catch {
    return {};
  }
};
const span = 'created_at>=? AND created_at<?';
export function reportIndexes() {
  for (const table of [
    'messages',
    'orders',
    'leads',
    'events',
    'bookings',
    'growth_sends',
    'review_asks',
    'decision_events',
    'decision_requests',
    'reply_reviews',
    'objection_attempts',
    'order_events',
    'experiments',
  ]) {
    run(`CREATE INDEX IF NOT EXISTS rpt_${table}_at ON ${table}(created_at)`);
  }
  run('CREATE INDEX IF NOT EXISTS rpt_messages_reply ON messages(number,role,created_at)');
  run('CREATE INDEX IF NOT EXISTS rpt_source_number ON events(type,number,id)');
  run('CREATE INDEX IF NOT EXISTS rpt_order_chat ON orders(chat,status)');
  run('CREATE INDEX IF NOT EXISTS rpt_tag_contact ON contact_tags(number,id)');
  run('CREATE INDEX IF NOT EXISTS rpt_source_contacts ON contact_sources(number)');
}
export function tenantDay(
  day,
  {
    sources = new Map(),
    now = new Date(),
    zone = zoneName(business()?.timezone || config.timezone),
    secret = process.env.PLATFORM_TENANT_TOKEN,
  } = {},
) {
  const from = midnight(day, zone),
    to = midnight(shiftDay(day, 1), zone),
    p = [from, to];
  const currentDay = localDateString(now, zone) === day;
  const facts = new Map(),
    activity = new Map(),
    cards = [],
    hours = new Map();
  function hour(at) {
    const key = at.slice(0, 16);
    if (!hours.has(key)) hours.set(key, partsInTz(new Date(at), zone).hour);
    return hours.get(key);
  }
  const mask = (n) => alias(String(n || '').split('@')[0], secret);
  const agent = (s) => dimension('agent', s || 'unknown', secret);
  const source = (n) => {
    if (!sources.has(n)) sources.set(n, dimension('source', sourceOf(n), secret));
    return sources.get(n);
  };
  function add(metric, h, a = '', b = '', n = 1, value = 0) {
    const r = fact({ metric, hour: h, a, b, n, value }),
      k = JSON.stringify([metric, h, r.a, r.b]);
    if (!facts.has(k)) facts.set(k, r);
    else {
      facts.get(k).n += r.n;
      facts.get(k).value += r.value;
    }
  }
  function item(kind, row) {
    cards.push(cleanCard(kind, row));
  }
  function note(type, ag, contact, outcome, at) {
    // Collapse repeats in the same clock hour; at = last occurrence.
    const k = JSON.stringify([hour(at), type, ag, contact, outcome]);
    const r = activity.get(k) || { hour: hour(at), type, agent: ag, contact, outcome, count: 0, at };
    r.count++;
    if (at > r.at) r.at = at;
    activity.set(k, r);
  }
  const people = all(impactRelation(), p).map((r) =>
    cleanPerson({ ...r, who: mask(r.who), source: source(r.who) }),
  );
  for (const p of people) if (p.first_at) add('source', hour(p.first_at), p.source, 'inbound');
  for (const r of all(
    `SELECT role,created_at,CASE WHEN role='user' AND (instr(content,'?') OR instr(content,'؟')) THEN substr(content,1,240) END question FROM messages WHERE ${span}`,
    p,
  )) {
    if (['user', 'owner', 'assistant'].includes(r.role)) add('messages', hour(r.created_at), r.role);
    if (r.question) add('question', hour(r.created_at), questionType(r.question));
  }
  for (const r of all(`SELECT created_at,detail FROM events WHERE type='rag_miss' AND ${span}`, p))
    add('unanswered', hour(r.created_at), questionType(r.detail));
  for (const r of all(`SELECT kind,created_at FROM objection_attempts WHERE ${span}`, p))
    add('objection', hour(r.created_at), r.kind);
  for (const r of all(`SELECT intent,created_at FROM message_intents WHERE ${span}`, p))
    add('intent', hour(r.created_at), r.intent);
  for (const r of all(`SELECT vote,created_at FROM reply_reviews WHERE ${span}`, p))
    add('review', hour(r.created_at), r.vote);
  for (const r of all(`SELECT agent,kind,detail,chat,created_at FROM agent_events WHERE ${span}`, p)) {
    const ag = agent(r.agent),
      ms = json(r.detail).ms;
    if (r.kind !== 'first_reply' || Number.isFinite(ms))
      add('agent', hour(r.created_at), ag, r.kind, 1, r.kind === 'first_reply' ? ms : 0);
    note(r.kind, ag, mask(r.chat), r.kind, r.created_at);
  }
  for (const r of all(`SELECT action,reason,number,created_at FROM decisions WHERE ${span}`, p)) {
    add('decision', hour(r.created_at), r.action, r.reason);
    note('decision', 'manager', mask(r.number), r.action, r.created_at);
  }
  for (const r of all(`SELECT agent,result,number,created_at FROM growth_sends WHERE ${span}`, p)) {
    add('growth', hour(r.created_at), agent(r.agent), r.result);
    note('growth', agent(r.agent), mask(r.number), r.result, r.created_at);
  }
  for (const r of activity.values()) item('activity', r);
  for (const [key, n] of Object.entries(impactFollowThrough(from, to))) add('impact', -1, key, '', n);
  for (const r of funnel({ from, to })) if (r.key !== 'conversations') add('funnel', -1, r.key, '', r.value);
  for (const r of accuracyReport({ from, to, trend: false, now }).metrics)
    if (r.status !== 'not_instrumented') add('accuracy', -1, r.key, '', r.count);
  for (const r of all(
    `SELECT chat,total,created_at FROM orders WHERE ${span} AND status IN ('paid','delivered','completed')`,
    p,
  ))
    add('source', hour(r.created_at), source(r.chat?.split('@')[0]), 'paid', 1, r.total);
  for (const r of all(
    `SELECT l.number,l.status,l.next_action,l.priority,l.score,l.created_at,c.assigned_to,
    EXISTS(SELECT 1 FROM orders o WHERE o.chat IN (l.number,l.number||'@s.whatsapp.net') AND o.status!='cancelled') ordered,
    EXISTS(SELECT 1 FROM orders o WHERE o.chat IN (l.number,l.number||'@s.whatsapp.net') AND o.status IN ('paid','completed','delivered')) paid
    FROM leads l LEFT JOIN contacts c ON c.number=l.number WHERE l.created_at>=? AND l.created_at<?`,
    p,
  )) {
    const stage = r.paid
      ? 'paid'
      : r.ordered
        ? 'ordered'
        : r.status === 'lost' || r.priority === 'cold'
          ? 'cold'
          : r.status === 'quoted'
            ? 'quoted'
            : ['qualified', 'negotiating', 'won'].includes(r.status)
              ? 'engaged'
              : 'new';
    const contact = mask(r.number);
    run(
      'INSERT INTO report_lead_index VALUES(?,?) ON CONFLICT(number) DO UPDATE SET who=excluded.who WHERE who!=excluded.who',
      [contact, r.number],
    );
    item('leads', {
      at: r.created_at,
      contact,
      score: r.score,
      stage,
      ...leadActionCode(r.next_action),
      source: source(r.number),
      assigned: dimension('member', r.assigned_to || 'unassigned', secret),
      tags: all('SELECT tag FROM contact_tags WHERE number=? ORDER BY id LIMIT 16', [r.number]).map((t) =>
        dimension('tag', t.tag, secret),
      ),
    });
    add('source', hour(r.created_at), source(r.number), 'leads');
  }
  for (const r of all(
    `SELECT d.type,d.status,d.order_id,d.created_at,d.resolved_at,d.deadline_at,d.reason_code,d.payload,o.total,o.paid_amount FROM decision_requests d LEFT JOIN orders o ON o.id=d.order_id WHERE d.created_at>=? AND d.created_at<?`,
    p,
  )) {
    item('payments', {
      type: r.type,
      order: r.order_id,
      at: r.created_at,
      state: r.status,
      deadline: r.deadline_at,
      claimed: json(r.payload).claimed,
      reason: r.reason_code,
      amount: Math.max(0, r.total == null ? Number(json(r.payload).due) || 0 : r.total - r.paid_amount),
      minutes: r.resolved_at ? (Date.parse(r.resolved_at) - Date.parse(r.created_at)) / 60000 : null,
    });
    add('payment', hour(r.created_at), r.status, r.reason_code);
  }
  for (const r of all(
    `SELECT d.type,d.order_id,e.created_at,e.kind,e.to_status,e.reason_code FROM decision_events e JOIN decision_requests d ON d.id=e.request_id WHERE e.created_at>=? AND e.created_at<?`,
    p,
  )) {
    item('history', {
      order: r.order_id,
      at: r.created_at,
      type: r.kind,
      state: r.to_status,
      reason: r.reason_code,
    });
    if (r.type === 'payment' && ['opened', 'decided', 'expired', 'reversed', 'escalated'].includes(r.kind))
      add('transition', hour(r.created_at), r.to_status, r.reason_code);
  }
  for (const r of all(`SELECT order_id,created_at,to_status FROM order_events WHERE ${span}`, p))
    item('history', { order: r.order_id, at: r.created_at, type: 'order_status', state: r.to_status });
  for (const r of all(
    'SELECT kind,severity,status,opened_at FROM incidents WHERE opened_at>=? AND opened_at<?',
    p,
  ))
    item('incidents', { at: r.opened_at, type: r.kind, severity: r.severity, state: r.status });
  for (const r of all(`SELECT created_at,detail FROM events WHERE type='analyst_report_sent' AND ${span}`, p))
    item('analyst', { ...json(r.detail), at: r.created_at });
  for (const r of all(`SELECT id,created_at FROM experiments WHERE ${span}`, p)) {
    const e = experimentResult(r.id);
    if (e.ok)
      item('experiments', {
        at: r.created_at,
        type: e.experiment.kind,
        verdict: e.verdict.replaceAll(' ', '_'),
        aSent: e.arms.a.sent,
        aReplied: e.arms.a.replied,
        bSent: e.arms.b.sent,
        bReplied: e.arms.b.replied,
        minSample: e.experiment.minSample,
      });
  }
  // Historic STT counters were recorded per UTC date, not per call. Use local
  // timestamped seconds when instrumented; never shift a UTC day's total.
  const mediaDay = get('SELECT * FROM media_daily WHERE tenant=? AND day=?', [config.tenant.slug, day]);
  if (mediaDay) for (const key of MEDIA_COUNTERS) if (mediaDay[key]) add('media', -1, key, '', mediaDay[key]);
  for (const r of all(`SELECT created_at,detail FROM events WHERE type='report_voice_seconds' AND ${span}`, p))
    add('voice', hour(r.created_at), '', '', 1, json(r.detail).seconds);
  for (const e of all(
    "SELECT at,metric,a,n,value FROM report_signals WHERE at>=? AND at<? AND metric IN ('voice','unanswered')",
    p,
  ))
    add(e.metric, hour(e.at), e.a, '', e.n, e.value);
  for (const r of all('SELECT data FROM report_archive WHERE at>=? AND at<?', p)) item('analyst', json(r.data));
  const archivedFrom = get('SELECT safe_from FROM report_coverage WHERE id=1')?.safe_from;
  let current = null;
  if (currentDay) {
    for (const g of listGoals({ status: 'active' }))
      item('goals', { ...goalProgress(g, { now }), at: g.created_at });
    current = cleanCurrent({
      currency: business()?.currency || 'PKR',
      minutesPerChat: impactConfig().minutesPerConversation,
      payments: paymentsSummary({ now }),
      growth: growthSummary(now),
      budget: tenantBudget(tenantSlug(), now.toISOString().slice(0, 10)),
      hoursKnown: parseHours(business()?.hours || '').known,
      drafts: listDrafts().length,
      health: {
        ...counters(),
        lastMessage: get('SELECT MAX(created_at) at FROM messages').at,
        incidents: get("SELECT COUNT(*) n FROM incidents WHERE status='open'").n,
      },
    });
  }
  return {
    v: REPORT_VERSION,
    at: now.toISOString(),
    day,
    zone,
    eventsComplete: !!archivedFrom && from >= archivedFrom,
    people,
    facts: [...facts.values()],
    cards,
    current,
  };
}

// One bounded, atomically replaced batch. An offline importer only needs the
// newest generation; a failed/restarted worker republishes the entire window.
export async function publishReports({
  dir = config.paths.data,
  now = new Date(),
  days = Number(process.env.TENANT_REPORT_DAYS) || 31,
  secret = process.env.PLATFORM_TENANT_TOKEN,
  zone = zoneName(business()?.timezone || config.timezone),
} = {}) {
  reportIndexes();
  const file = path.join(dir, 'dashboard-v1.jsonl'),
    tmp = file + '.tmp',
    fd = fs.openSync(tmp, 'w', 0o600),
    today = localDateString(now, zone),
    sources = new Map();
  try {
    const oldest = midnight(shiftDay(today, 1 - Math.min(90, days)), zone);
    for (const t of ['report_signals', 'report_sources', 'report_archive'])
      run(`DELETE FROM ${t} WHERE at<?`, [oldest]);
    for (let i = 0; i < Math.max(1, Math.min(90, days)); i++) {
      fs.writeFileSync(fd, JSON.stringify(tenantDay(shiftDay(today, -i), { now, zone, secret, sources })) + '\n');
      await new Promise((resolve) => setImmediate(resolve)); // yield between indexed day reads
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
export function startReportLoop() {
  if (
    process.env.TENANT_DASHBOARD !== '1' ||
    !process.env.PLATFORM_TENANT_TOKEN ||
    process.env.TENANT_WORKER_MODE !== 'live'
  )
    return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await publishReports();
    } catch {
      console.warn('Dashboard snapshot deferred; will retry.');
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(tick, 1000),
    timer = setInterval(tick, 5 * 60000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
