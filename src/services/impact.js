// src/services/impact.js
// Phase 6 Part 3 — the impact dashboard.
//
// The promise this measures is "80–90% handled without you". Every number below
// is one SQL query against rows the bot already wrote; no model is asked to
// count, and no figure is estimated. The definitions are in the README so an
// owner (or an auditor) can recompute them by hand.
//
// Additive: nothing here runs unless features.businessBrain is on, and the
// growth dashboard and weekly report simply skip the section when it is off.

import { featureOn, business, profile } from './profile.js';
import { config } from '../config/env.js';
import * as db from '../utils/db.js';
import { impactTotals, savedHours } from './impactMetrics.js';
import { shiftDay, midnight, localDateString } from './reportCalendar.js';
import { parseHours, isOpen } from './hours.js';

const DAY = 24 * 3600 * 1000;
const str = (v) => (typeof v === 'string' ? v.trim() : '');

export const THIN_DATA_CONVERSATIONS = 20;
export const DEFAULT_MINUTES_PER_CONVERSATION = 6;

export function brainEnabled() {
  return featureOn('businessBrain');
}

export function impactConfig() {
  const b = profile()?.brain || {};
  return {
    minutesPerConversation: clampInt(b.minutesPerConversation, DEFAULT_MINUTES_PER_CONVERSATION, 1, 60),
    thinData: clampInt(b.thinDataConversations, THIN_DATA_CONVERSATIONS, 1, 10000),
    dailyReasoningCalls: clampInt(b.dailyReasoningCalls, 200, 0, 100000),
    autoRun: arr(b.autoRun),
    reasoningProvider: str(b.reasoningProvider) || 'auto',
    reasoningModel: str(b.reasoningModel) || '',
  };
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
const arr = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

/** Monday 00:00 UTC of the week containing `now`. */
export function weekWindow(now = new Date()) {
  if (process.env.TENANT_DASHBOARD === '1') {
    const zone = business()?.timezone || config.timezone || 'UTC';
    const today = localDateString(now, zone),
      monday = shiftDay(today, -((new Date(today).getUTCDay() + 6) % 7));
    const from = midnight(monday, zone);
    return {
      from,
      to: midnight(shiftDay(monday, 7), zone),
      prevFrom: midnight(shiftDay(monday, -7), zone),
      prevTo: from,
      label: `${monday} → ${shiftDay(monday, 6)}`,
    };
  }
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  const from = d.toISOString();
  const to = new Date(d.getTime() + 7 * DAY).toISOString();
  return {
    from,
    to,
    prevFrom: new Date(d.getTime() - 7 * DAY).toISOString(),
    prevTo: from,
    label: `${d.toISOString().slice(0, 10)} → ${new Date(d.getTime() + 6 * DAY).toISOString().slice(0, 10)}`,
  };
}

// One sufficient-statistics row per participant. No message content is read.
export function impactRelation() {
  const hours = parseHours(business()?.hours || '');
  const zone = business()?.timezone || profile()?.owner?.timezone || config.timezone || 'UTC';
  db.getDB().create_function('report_closed', (at) => at && hours.known && !isOpen(new Date(at), {hours,timeZone:zone}).open ? 1 : 0);
  return `WITH span(start,end) AS (VALUES (?,?)), activity AS (
    SELECT number who, MIN(CASE WHEN role='user' THEN created_at END) first_at,
      MAX(role='owner') owner, MAX(role='assistant') bot, 0 bookings,0 orders,0 revenue
      FROM messages,span WHERE created_at>=start AND created_at<end GROUP BY number
    UNION ALL SELECT substr(chat,1,instr(chat || '@','@')-1),NULL,0,0,COUNT(*),0,0 FROM bookings,span
      WHERE created_at>=start AND created_at<end GROUP BY chat
    UNION ALL SELECT substr(chat,1,instr(chat || '@','@')-1),NULL,0,0,0,COUNT(*),SUM(total) FROM orders,span
      WHERE created_at>=start AND created_at<end AND status IN ('paid','delivered','completed') GROUP BY chat
  ), people AS (SELECT who, MIN(first_at) first_at, MAX(owner) owner,MAX(bot) bot,SUM(bookings) bookings,
    SUM(orders) orders,SUM(revenue) revenue FROM activity GROUP BY who), answers AS MATERIALIZED (
    SELECT *, (SELECT MIN(created_at) FROM messages WHERE number=who AND role='assistant' AND created_at>=first_at) reply FROM people
  ) SELECT who, first_at, owner, bot, bookings, orders, revenue, report_closed(reply) outside,
    CASE WHEN julianday(reply)-julianday(first_at)<1 THEN ROUND((julianday(reply)-julianday(first_at))*86400000) END response_ms FROM answers`;
}

/**
 * Everything the dashboard reports, for one window.
 * @param {{from?:string, to?:string, now?:Date}} opts
 */
export function impactNumbers({ now = new Date(), from = null, to = null } = {}) {
  const w = weekWindow(now);
  const start = from || w.from;
  const end = to || w.to;
  const cfg = impactConfig();

  const reports = process.env.TENANT_DASHBOARD === '1';
  const totals = impactTotals(db.get, impactRelation(), [start, end], {
    hoursKnown: !reports || parseHours(business()?.hours || '').known,
    emptyRate: reports ? null : 0,
  });
  const { conversations } = totals;
  const leadCount = db.get('SELECT COUNT(*) AS n FROM leads WHERE created_at>=? AND created_at<?', [start, end]).n;

  return {
    from: start,
    to: end,
    ...totals,
    leads: leadCount,
    hoursSaved: savedHours(conversations, cfg.minutesPerConversation),
    minutesPerConversation: cfg.minutesPerConversation,
    ...impactFollowThrough(start, end),
    thin: conversations < cfg.thinData,
    thinDataThreshold: cfg.thinData,
  };
}

export function impactFollowThrough(start, end) {
  // Follow-ups: a proactive send, and a customer message from the same number
  // within 72 hours of it.
  const followUps = db.all(
    `SELECT number, created_at FROM growth_sends
      WHERE result = 'sent' AND created_at >= ? AND created_at < ?
        AND agent IN ('followup','follow-up','rebook','reactivation','quote')`,
    [start, end]
  );
  let followUpsAnswered = 0;
  for (const row of followUps) {
    const at = Date.parse(row.created_at);
    if (!Number.isFinite(at)) continue;
    const reply = db.get(
      `SELECT id FROM messages WHERE number = ? AND role = 'user' AND created_at > ? AND created_at <= ? LIMIT 1`,
      [row.number, row.created_at, new Date(at + 72 * 3600 * 1000).toISOString()]
    );
    if (reply) followUpsAnswered += 1;
  }

  // Review asks: sent, and a rating recorded after it.
  const asks = db.get(
    `SELECT COUNT(*) AS n FROM review_asks WHERE created_at >= ? AND created_at < ? AND status IN ('asked','rated')`,
    [start, end]
  );
  const ratings = db.get(
    `SELECT COUNT(*) AS n FROM review_asks WHERE created_at >= ? AND created_at < ? AND status = 'rated'`,
    [start, end]
  );

  return {
    followUpsSent: followUps.length,
    followUpsAnswered,
    reviewAsks: asks?.n || 0,
    reviewsReceived: ratings?.n || 0,
  };
}

/** Week-over-week percentage change, or null when there is no base. */
export function delta(current, previous) {
  if (previous === null || previous === undefined || previous === 0) return null;
  if (current === null || current === undefined) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

export function impactReport({ now = new Date() } = {}) {
  const w = weekWindow(now);
  const current = impactNumbers({ from: w.from, to: w.to });
  const previous = impactNumbers({ from: w.prevFrom, to: w.prevTo });

  const arrow = (value) => {
    const d = delta(current[value], previous[value]);
    if (d === null) return '';
    if (d === 0) return ' · no change';
    return ` · ${d > 0 ? '▲' : '▼'} ${Math.abs(d)}%`;
  };

  const lines = [`📈 *Impact — ${w.label}*`, ''];
  if (current.thin) {
    lines.push(
      `Not enough data: ${current.conversations} conversation${current.conversations === 1 ? '' : 's'} this week.`,
      `Under ${current.thinDataThreshold} the percentages swing on one message, so treat these as counts, not rates.`,
      ''
    );
  }

  lines.push(`Automation: *${current.automationRate==null?'—':`${current.automationRate}%`}* — ${current.handledByBot} of ${current.conversations} chats had no message from you${arrow('automationRate')}`);
  lines.push(
    `First response: ${current.firstResponseMinutes === null ? '—' : `${current.firstResponseMinutes} min`}${arrow('firstResponseMinutes')} · after-hours covered: ${current.afterHoursCovered??'—'}`
  );
  lines.push(`Leads: ${current.leads}${arrow('leads')} · bookings: ${current.bookings} (${current.botBookings} by the bot)`);
  lines.push(
    `Orders: ${current.orders} (${current.botOrders} by the bot) · revenue: ${current.revenue} ${business()?.currency || 'PKR'} (${current.botRevenue} attributable)${arrow('revenue')}`
  );
  lines.push(
    `Follow-ups: ${current.followUpsSent} sent · ${current.followUpsAnswered} answered · review asks: ${current.reviewAsks} · reviews: ${current.reviewsReceived}`
  );
  lines.push(`Time saved: ~${current.hoursSaved} h (${current.conversations} chats × ${current.minutesPerConversation} min)`);
  // Conversation Control: how the week's messages were handled. Absent when the
  // feature has never run, so the report reads exactly as before.
  try {
    const rows = db.all('SELECT action, COUNT(*) AS count FROM decisions WHERE created_at >= ? GROUP BY action ORDER BY count DESC', [w.from]);
    if (rows.length) {
      lines.push('');
      lines.push(`Decisions: ${rows.map((r) => `${r.action} ${r.count}`).join(' · ')}`);
    }
  } catch {
    /* the table exists only once the feature has been used */
  }
  // Owner decisions: money questions that needed a person, and how long that
  // took. Absent until the feature has been used, so the report reads exactly as
  // before on a tenant that never turned it on.
  try {
    if (featureOn('ownerDecisions') || featureOn('paymentReview')) {
      const opened = db.get('SELECT COUNT(*) AS n FROM decision_requests WHERE created_at >= ?', [w.from])?.n || 0;
      if (opened) {
        const decided = db.all(
          'SELECT created_at, resolved_at, status FROM decision_requests WHERE created_at >= ? AND resolved_at IS NOT NULL',
          [w.from]
        );
        const accepted = decided.filter((d) => ['accepted', 'partial'].includes(d.status)).length;
        const rejected = decided.filter((d) => d.status === 'rejected').length;
        const avg = decided.length
          ? Math.round(decided.reduce((sum, d) => sum + (Date.parse(d.resolved_at) - Date.parse(d.created_at)) / 60_000, 0) / decided.length)
          : null;
        lines.push('');
        lines.push(
          `Decisions needing a person: ${opened} opened · ${decided.length} answered${avg === null ? '' : ` · ${avg} min average`} · ${accepted} accepted, ${rejected} rejected`
        );
      }
    }
  } catch {
    /* the table exists only once the feature has been used */
  }
  lines.push('');
  lines.push('Every number is a SQL count over this week. Definitions: README › How the Business Brain thinks.');

  return { current, previous, window: w, text: lines.join('\n') };
}
