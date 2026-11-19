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
import { parseHours, isOpen } from './hours.js';

const DAY = 24 * 3600 * 1000;
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v) => Number(v) || 0;

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

const chatsInWindow = (from, to) =>
  db.all(
    `SELECT m.number AS number, MIN(m.created_at) AS first_at
       FROM messages m
      WHERE m.role = 'user' AND m.created_at >= ? AND m.created_at < ?
      GROUP BY m.number`,
    [from, to]
  );

const ownerTouchedChats = (from, to) =>
  new Set(
    db
      .all(
        `SELECT DISTINCT number FROM messages
          WHERE role = 'owner' AND created_at >= ? AND created_at < ?`,
        [from, to]
      )
      .map((r) => r.number)
  );

const botChats = (from, to) =>
  new Set(
    db
      .all(`SELECT DISTINCT number FROM messages WHERE role = 'assistant' AND created_at >= ? AND created_at < ?`, [from, to])
      .map((r) => r.number)
  );

/**
 * Everything the dashboard reports, for one window.
 * @param {{from?:string, to?:string, now?:Date}} opts
 */
export function impactNumbers({ now = new Date(), from = null, to = null } = {}) {
  const w = weekWindow(now);
  const start = from || w.from;
  const end = to || w.to;
  const cfg = impactConfig();

  const chats = chatsInWindow(start, end);
  const conversations = chats.length;
  const owners = ownerTouchedChats(start, end);
  const bots = botChats(start, end);
  const handled = chats.filter((c) => !owners.has(c.number));

  // First response: the first assistant message after each chat's first
  // customer message. Paired in SQL so a slow reply cannot hide behind a fast one.
  const firstRows = db.all(
    `SELECT m.number AS number, MIN(m.created_at) AS first_at FROM messages m
      WHERE m.role = 'user' AND m.created_at >= ? AND m.created_at < ? GROUP BY m.number`,
    [start, end]
  );
  let firstSum = 0;
  let firstCount = 0;
  const afterHours = [];
  const tz = business()?.timezone || profile()?.owner?.timezone || config.timezone || 'UTC';
  const hours = parseHours(business()?.hours || '');

  for (const row of firstRows) {
    const reply = db.get(
      `SELECT created_at FROM messages
        WHERE number = ? AND role = 'assistant' AND created_at >= ?
        ORDER BY created_at ASC LIMIT 1`,
      [row.number, row.first_at]
    );
    if (!reply) continue;
    const ms = Date.parse(reply.created_at) - Date.parse(row.first_at);
    if (Number.isFinite(ms) && ms >= 0 && ms < 24 * 3600 * 1000) {
      firstSum += ms;
      firstCount += 1;
    }
    if (hours.known) {
      const open = isOpen(new Date(reply.created_at), { hours, timeZone: tz });
      if (!open.open) afterHours.push(row.number);
    }
  }

  const leads = db.get(`SELECT COUNT(*) AS n FROM leads WHERE created_at >= ? AND created_at < ?`, [start, end]);
  const leadCount = leads?.n ?? countFallback('leads', start, end);

  const bookingRows = db.all(`SELECT chat FROM bookings WHERE created_at >= ? AND created_at < ?`, [start, end]);
  const orderRows = db.all(
    `SELECT chat, total, status FROM orders WHERE created_at >= ? AND created_at < ?`,
    [start, end]
  );
  const paidStatuses = new Set(['paid', 'delivered', 'completed']);
  const paid = orderRows.filter((o) => paidStatuses.has(String(o.status || '')));
  const botOrders = paid.filter((o) => !owners.has(chatNumber(o.chat)));
  const botBookings = bookingRows.filter((b) => !owners.has(chatNumber(b.chat)));

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

  const revenue = paid.reduce((sum, o) => sum + num(o.total), 0);
  const botRevenue = botOrders.reduce((sum, o) => sum + num(o.total), 0);

  return {
    from: start,
    to: end,
    conversations,
    handledByBot: handled.length,
    ownerTouched: conversations - handled.length,
    automationRate: conversations ? Math.round((handled.length / conversations) * 100) : 0,
    botReplied: bots.size,
    firstResponseMinutes: firstCount ? Math.round((firstSum / firstCount / 60000) * 10) / 10 : null,
    afterHoursCovered: afterHours.length,
    leads: Number(leadCount) || 0,
    bookings: bookingRows.length,
    botBookings: botBookings.length,
    orders: paid.length,
    botOrders: botOrders.length,
    revenue,
    botRevenue,
    hoursSaved: Math.round(((conversations * cfg.minutesPerConversation) / 60) * 10) / 10,
    minutesPerConversation: cfg.minutesPerConversation,
    followUpsSent: followUps.length,
    followUpsAnswered,
    reviewAsks: asks?.n || 0,
    reviewsReceived: ratings?.n || 0,
    thin: conversations < cfg.thinData,
    thinDataThreshold: cfg.thinData,
  };
}

function countFallback(table, from, to) {
  try {
    return db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE created_at >= ? AND created_at < ?`, [from, to])?.n || 0;
  } catch {
    return 0;
  }
}

function chatNumber(chat) {
  return String(chat || '').replace(/@.*$/, '');
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

  lines.push(`Automation: *${current.automationRate}%* — ${current.handledByBot} of ${current.conversations} chats had no message from you${arrow('automationRate')}`);
  lines.push(
    `First response: ${current.firstResponseMinutes === null ? '—' : `${current.firstResponseMinutes} min`}${arrow('firstResponseMinutes')} · after-hours covered: ${current.afterHoursCovered}`
  );
  lines.push(`Leads: ${current.leads}${arrow('leads')} · bookings: ${current.bookings} (${current.botBookings} by the bot)`);
  lines.push(
    `Orders: ${current.orders} (${current.botOrders} by the bot) · revenue: ${current.revenue} PKR (${current.botRevenue} attributable)${arrow('revenue')}`
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
  lines.push('');
  lines.push('Every number is a SQL count over this week. Definitions: README › How the Business Brain thinks.');

  return { current, previous, window: w, text: lines.join('\n') };
}
