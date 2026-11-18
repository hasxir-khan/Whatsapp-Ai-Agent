// src/services/analystAgent.js
// The analyst: a weekly numbers report for the owner, behind features.analystAgent.
//
// The rule that makes this useful rather than decorative: **the numbers are
// computed here, from SQLite, in plain SQL and plain JavaScript.** The model is
// only ever allowed to write three suggestions on top of figures it did not
// produce. If the week was quiet, we say so — inventing insights from four
// messages would be worse than saying nothing.

import { config } from '../config/env.js';
import { business, featureOn, analystSchedule, effectiveCatalog } from './profile.js';
import { partsInTz } from './hours.js';
import { sendToOwner } from './growth.js';
import { formatMoney } from './geo.js';
import { all, get, getSetting, setSetting, logEvent } from '../utils/db.js';
import { chat, hasLLM } from '../core/llm.js';
import { sourceCounts, sourceLinksEnabled } from './sourceLinks.js';

const DAY_MS = 86_400_000;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** Below this many real conversations, a "trend" is noise. */
export const MIN_CONVERSATIONS = 5;

export function analystAgentEnabled() {
  return featureOn('analystAgent');
}

// ── the window ─────────────────────────────────────────────
/**
 * The reporting week: the last seven days, plus the seven before that for the
 * comparison. Both are plain instants so a fake clock in a test works.
 */
export function weekWindow(now = new Date()) {
  const to = new Date(now.getTime());
  const from = new Date(to.getTime() - 7 * DAY_MS);
  const prevFrom = new Date(from.getTime() - 7 * DAY_MS);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    prevFrom: prevFrom.toISOString(),
    prevTo: from.toISOString(),
  };
}

const count = (sql, params = []) => get(sql, params)?.c || 0;
const sum = (sql, params = []) => get(sql, params)?.s || 0;

function conversationStats(from, to) {
  const conversations = count(
    "SELECT COUNT(DISTINCT number) AS c FROM messages WHERE role = 'user' AND created_at >= ? AND created_at < ?",
    [from, to]
  );
  const inbound = count("SELECT COUNT(*) AS c FROM messages WHERE role = 'user' AND created_at >= ? AND created_at < ?", [from, to]);
  const outbound = count("SELECT COUNT(*) AS c FROM messages WHERE role = 'assistant' AND created_at >= ? AND created_at < ?", [from, to]);
  return { conversations, inbound, outbound };
}

/**
 * Average time from a customer's first message to our first answer, in
 * conversations that started inside the window. Reported in minutes.
 */
export function avgFirstResponseMinutes(from, to) {
  const rows = all(
    `SELECT number, MIN(created_at) AS first_at
       FROM messages
      WHERE role = 'user' AND created_at >= ? AND created_at < ?
      GROUP BY number`,
    [from, to]
  );
  const gaps = [];
  for (const row of rows) {
    const answer = get(
      "SELECT created_at FROM messages WHERE number = ? AND role = 'assistant' AND created_at >= ? ORDER BY created_at LIMIT 1",
      [row.number, row.first_at]
    );
    if (!answer) continue;
    const gap = (new Date(answer.created_at).getTime() - new Date(row.first_at).getTime()) / 60000;
    // Anything past a day is not "response time", it's a new conversation.
    if (Number.isFinite(gap) && gap >= 0 && gap <= 1440) gaps.push(gap);
  }
  if (!gaps.length) return null;
  return Math.round(gaps.reduce((a, g) => a + g, 0) / gaps.length);
}

/** New leads, split by where they came from. */
function leadsBySource(from, to) {
  const rows = all('SELECT number FROM leads WHERE created_at >= ? AND created_at < ?', [from, to]);
  const out = {};
  for (const row of rows) {
    const referred = get("SELECT 1 AS c FROM events WHERE type = 'referral_attributed' AND number = ? LIMIT 1", [row.number]);
    const contact = get('SELECT category FROM contacts WHERE number = ?', [row.number]);
    const source = referred ? 'referral' : contact?.category || 'direct';
    out[source] = (out[source] || 0) + 1;
  }
  return { total: rows.length, bySource: out };
}

/**
 * Follow-ups we sent, and how many of those people wrote back afterwards —
 * the only number that says whether the nudge is any good.
 */
function followUpOutcomes(from, to) {
  const sends = all(
    "SELECT number, created_at FROM growth_sends WHERE agent = 'followup' AND result = 'sent' AND created_at >= ? AND created_at < ?",
    [from, to]
  );
  let answered = 0;
  for (const send of sends) {
    const reply = get(
      "SELECT 1 AS c FROM messages WHERE number = ? AND role = 'user' AND created_at > ? LIMIT 1",
      [send.number, send.created_at]
    );
    if (reply) answered += 1;
  }
  return { sent: sends.length, answered };
}

/** The hours of the day the phone actually rings, in the business timezone. */
export function busiestHours(from, to, limit = 3) {
  const tz = business().timezone || config.timezone || 'UTC';
  const rows = all("SELECT created_at FROM messages WHERE role = 'user' AND created_at >= ? AND created_at < ?", [from, to]);
  const buckets = new Map();
  for (const row of rows) {
    const at = new Date(row.created_at);
    if (Number.isNaN(at.getTime())) continue;
    const { hour } = partsInTz(at, tz);
    buckets.set(hour, (buckets.get(hour) || 0) + 1);
  }
  return [...buckets.entries()]
    .map(([hour, n]) => ({ hour, count: n, label: `${String(hour).padStart(2, '0')}:00` }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** Questions we could not answer from the knowledge base. */
export function unansweredQuestions(from, to, limit = 5) {
  return all(
    `SELECT detail AS question, COUNT(*) AS count
       FROM events
      WHERE type = 'rag_miss' AND created_at >= ? AND created_at < ? AND detail IS NOT NULL
      GROUP BY detail
      ORDER BY count DESC
      LIMIT ?`,
    [from, to, limit]
  );
}

/**
 * Everything the report is built from. Pure database reads — no model, no
 * network, no guessing.
 */
export function weeklyNumbers({ from, to } = weekWindow()) {
  const conv = conversationStats(from, to);
  const leads = leadsBySource(from, to);
  const orders = all("SELECT total, status FROM orders WHERE created_at >= ? AND created_at < ?", [from, to]);
  const billable = orders.filter((o) => o.status !== 'cancelled');
  const revenue = billable.reduce((a, o) => a + (Number(o.total) || 0), 0);
  const followups = followUpOutcomes(from, to);
  const intents = all(
    `SELECT intent, COUNT(*) AS count FROM message_intents
      WHERE created_at >= ? AND created_at < ?
      GROUP BY intent ORDER BY count DESC`,
    [from, to]
  ).map((r) => ({ intent: r.intent, count: r.count }));

  const bookings = count('SELECT COUNT(*) AS c FROM bookings WHERE created_at >= ? AND created_at < ?', [from, to]);
  const bookingsDone = count(
    "SELECT COUNT(*) AS c FROM bookings WHERE created_at >= ? AND created_at < ? AND status IN ('done','completed')",
    [from, to]
  );
  const optOuts = count('SELECT COUNT(*) AS c FROM growth_optouts WHERE created_at >= ? AND created_at < ?', [from, to]);
  const complaints = count(
    "SELECT COUNT(*) AS c FROM message_intents WHERE intent = 'complaint' AND created_at >= ? AND created_at < ?",
    [from, to]
  );
  const reviewsAsked = count('SELECT COUNT(*) AS c FROM review_asks WHERE created_at >= ? AND created_at < ?', [from, to]);
  const reviewsRated = all(
    'SELECT rating FROM review_asks WHERE rating IS NOT NULL AND created_at >= ? AND created_at < ?',
    [from, to]
  );
  const referrals = count('SELECT COUNT(*) AS c FROM events WHERE type = ? AND created_at >= ? AND created_at < ?', [
    'referral_attributed',
    from,
    to,
  ]);

  return {
    from,
    to,
    currency: business().currency || 'PKR',
    ...conv,
    newLeads: leads.total,
    leadsBySource: leads.bySource,
    replies: conv.outbound,
    avgFirstResponseMinutes: avgFirstResponseMinutes(from, to),
    bookings,
    bookingsDone,
    orders: billable.length,
    revenue,
    followUpsSent: followups.sent,
    followUpsAnswered: followups.answered,
    optOuts,
    complaints,
    intents,
    busiestHours: busiestHours(from, to),
    unanswered: unansweredQuestions(from, to),
    reviewsAsked,
    reviewsRated: reviewsRated.length,
    avgRating: reviewsRated.length
      ? Math.round((reviewsRated.reduce((a, r) => a + Number(r.rating || 0), 0) / reviewsRated.length) * 10) / 10
      : null,
    referrals,
    sources: sourceLinksEnabled() ? sourceCounts() : [],
    low: conv.conversations < MIN_CONVERSATIONS,
  };
}

// ── comparisons ────────────────────────────────────────────
const COMPARE_FIELDS = [
  ['conversations', 'conversations'],
  ['replies', 'replies'],
  ['newLeads', 'new leads'],
  ['bookings', 'bookings'],
  ['orders', 'orders'],
  ['revenue', 'revenue'],
];

export function deltas(current, previous) {
  const out = {};
  for (const [key] of COMPARE_FIELDS) {
    const a = Number(current?.[key] || 0);
    const b = Number(previous?.[key] || 0);
    out[key] = { current: a, previous: b, diff: a - b, pct: b > 0 ? Math.round(((a - b) / b) * 100) : null };
  }
  return out;
}

function arrow(delta) {
  if (!delta || delta.diff === 0) return '→';
  return delta.diff > 0 ? '↑' : '↓';
}

function deltaText(delta, { money = false } = {}) {
  if (!delta || delta.diff === 0) return 'same as last week';
  const amount = Math.abs(delta.diff);
  const shown = money ? formatMoney(amount, business().currency || 'PKR') : String(amount);
  const pct = delta.pct == null ? '' : ` (${delta.pct > 0 ? '+' : ''}${delta.pct}%)`;
  return `${delta.diff > 0 ? 'up' : 'down'} ${shown}${pct}`;
}

// ── suggestions ────────────────────────────────────────────
/**
 * Three short suggestions, from the numbers only. When there is no model, or
 * the model fails, a deterministic fallback keeps the report useful.
 */
export async function suggestions(numbers, previous = null) {
  const fallback = fallbackSuggestions(numbers, previous);
  if (!hasLLM() || numbers.low) return fallback;

  const facts = [
    `conversations: ${numbers.conversations}`,
    `new leads: ${numbers.newLeads} (${Object.entries(numbers.leadsBySource).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`,
    `average first response: ${numbers.avgFirstResponseMinutes == null ? 'unknown' : `${numbers.avgFirstResponseMinutes} min`}`,
    `bookings: ${numbers.bookings} (${numbers.bookingsDone} completed)`,
    `orders: ${numbers.orders}, revenue: ${formatMoney(numbers.revenue, numbers.currency)}`,
    `follow-ups sent: ${numbers.followUpsSent}, answered: ${numbers.followUpsAnswered}`,
    `opt-outs: ${numbers.optOuts}, complaints: ${numbers.complaints}`,
    `busiest hours: ${numbers.busiestHours.map((b) => b.label).join(', ') || 'none'}`,
    `unanswered questions: ${numbers.unanswered.map((u) => `${u.question} (x${u.count})`).join('; ') || 'none'}`,
  ];

  try {
    const out = await chat({
      system:
        'You are a business analyst for a small business. You get real numbers for the last week. ' +
        'Write EXACTLY three suggestions, one per line, each starting with "- ", each under 15 words, ' +
        'each pointing at one concrete action. Use only the numbers given. Never invent figures, ' +
        'never mention tools the business does not have, no preamble, no closing line.',
      messages: [{ role: 'user', content: facts.join('\n') }],
      temperature: 0.2,
      maxTokens: 220,
    });
    const text = String(out?.text || '').trim();
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .slice(0, 3);
    return lines.length === 3 ? lines : fallback;
  } catch (err) {
    logEvent('analyst_llm_failed', null, err.message);
    return fallback;
  }
}

/** Deterministic suggestions: always true, never clever. */
export function fallbackSuggestions(numbers) {
  const out = [];
  if (numbers.avgFirstResponseMinutes != null && numbers.avgFirstResponseMinutes > 10) {
    out.push(`- Answer faster: the average first reply took ${numbers.avgFirstResponseMinutes} minutes.`);
  }
  if (numbers.unanswered?.length) {
    out.push(`- Add "${numbers.unanswered[0].question}" to the knowledge base — it came up ${numbers.unanswered[0].count}x unanswered.`);
  }
  const topIntent = numbers.intents?.[0];
  if (topIntent) out.push(`- Most messages were about "${topIntent.intent}" (${topIntent.count}) — make sure the answers are current.`);
  if (numbers.followUpsSent > 0 && numbers.followUpsAnswered === 0) {
    out.push('- Follow-ups are going out but nobody answers — try a shorter, more specific question.');
  }
  if (numbers.optOuts > 0) out.push(`- ${numbers.optOuts} people asked to stop — check the timing of what we send.`);
  if (numbers.bookings > 0 && numbers.bookingsDone === 0) {
    out.push('- Bookings were made but none marked done — use .done <id> so reviews can go out.');
  }
  while (out.length < 3) out.push('- Keep answering the same day; the week is too quiet to draw conclusions.');
  return out.slice(0, 3);
}

// ── the report ─────────────────────────────────────────────
export function reportHeader(now = new Date(), numbers = null) {
  const tz = business().timezone || config.timezone || 'UTC';
  const p = partsInTz(now, tz);
  const fmt = (iso) => {
    const q = partsInTz(new Date(iso), tz);
    return `${q.day}/${q.month}`;
  };
  const range = numbers ? `${fmt(numbers.from)}–${fmt(numbers.to)}` : '';
  return `📊 *Weekly report*${range ? ` — ${range}` : ''}`;
}

/**
 * Build the whole report: numbers, comparison, and (optionally) suggestions.
 * The numbers are always included; suggestions are best-effort.
 */
export async function buildWeeklyReport({ now = new Date(), withSuggestions = true } = {}) {
  const window = weekWindow(now);
  const numbers = weeklyNumbers({ from: window.from, to: window.to });
  const previous = weeklyNumbers({ from: window.prevFrom, to: window.prevTo });
  const delta = deltas(numbers, previous);
  const tips = withSuggestions ? await suggestions(numbers, previous) : [];

  const lines = [reportHeader(now, numbers), ''];

  if (numbers.low) {
    lines.push(
      `Quiet week: only ${numbers.conversations} conversation${numbers.conversations === 1 ? '' : 's'}. ` +
        'Too small to call a trend, so here are the raw numbers and nothing else.'
    );
    lines.push('');
  }

  lines.push(`💬 ${numbers.conversations} conversations ${arrow(delta.conversations)} ${deltaText(delta.conversations)}`);
  lines.push(`↩️ ${numbers.replies} replies sent · ⏱️ ${numbers.avgFirstResponseMinutes == null ? 'no first-reply data' : `${numbers.avgFirstResponseMinutes} min average first reply`}`);
  const sources = Object.entries(numbers.leadsBySource).map(([k, v]) => `${k} ${v}`).join(', ');
  lines.push(`🆕 ${numbers.newLeads} new leads ${arrow(delta.newLeads)}${sources ? ` (${sources})` : ''}`);
  lines.push(`📅 ${numbers.bookings} bookings ${arrow(delta.bookings)} · ${numbers.bookingsDone} completed`);
  lines.push(
    `🛒 ${numbers.orders} orders ${arrow(delta.orders)} · ${formatMoney(numbers.revenue, numbers.currency)} ${arrow(delta.revenue)} ${deltaText(delta.revenue, { money: true })}`
  );
  lines.push(`✍️ follow-ups ${numbers.followUpsSent} sent, ${numbers.followUpsAnswered} answered`);
  lines.push(`🚫 ${numbers.optOuts} opt-outs · 😠 ${numbers.complaints} complaints`);
  if (numbers.reviewsAsked) {
    lines.push(`⭐ ${numbers.reviewsAsked} reviews asked, ${numbers.reviewsRated} rated${numbers.avgRating ? ` (avg ${numbers.avgRating}/5)` : ''}`);
  }
  if (numbers.referrals) lines.push(`🤝 ${numbers.referrals} referral${numbers.referrals === 1 ? '' : 's'} arrived`);
  // Tracked links: which printed thing actually brought people, and which one
  // has been hanging on a wall for a fortnight without a single scan.
  if (numbers.sources?.length) {
    lines.push('🔗 Where they came from:');
    for (const row of numbers.sources) {
      const bits = [`${row.conversations} chat${row.conversations === 1 ? '' : 's'}`];
      if (row.leads) bits.push(`${row.leads} lead${row.leads === 1 ? '' : 's'}`);
      if (row.orders) bits.push(`${row.orders} paid`);
      const money = row.revenue ? ` (${formatMoney(row.revenue, numbers.currency)})` : '';
      const flag = row.stale ? ` — ⚠️ nothing in ${row.ageDays} days` : '';
      lines.push(`  ${row.label}: ${bits.join(' → ')}${money}${flag}`);
    }
  }
  if (numbers.busiestHours.length) {
    lines.push(`🕒 busiest: ${numbers.busiestHours.map((b) => b.label).join(', ')}`);
  }

  if (numbers.intents.length) {
    lines.push('');
    lines.push(
      `Intent mix: ${numbers.intents
        .slice(0, 4)
        .map((i) => `${i.intent} ${i.count}`)
        .join(' · ')}`
    );
  }

  if (numbers.unanswered.length) {
    lines.push('');
    lines.push('❓ Asked but not answered from your knowledge base:');
    for (const q of numbers.unanswered) lines.push(`  · "${q.question}" (${q.count}x)`);
  }

  if (tips.length) {
    lines.push('');
    lines.push(numbers.low ? 'What I would do next week:' : 'Three things worth doing:');
    for (const tip of tips) lines.push(tip.startsWith('- ') ? tip : `- ${tip}`);
  }

  lines.push('');
  lines.push(numbers.low ? 'A week like this is normal. Nothing is broken.' : 'Reply .report week any time for this again.');

  return { numbers, previous, delta, suggestions: tips, text: lines.join('\n'), low: numbers.low };
}

/** Plain text for `.report week`. Never throws. */
export async function weeklyReportText(now = new Date()) {
  try {
    const report = await buildWeeklyReport({ now });
    return report.text;
  } catch (err) {
    logEvent('analyst_error', null, err.message);
    return 'Could not build the weekly report — the numbers are in .report and .leads.';
  }
}

// ── weekly delivery ────────────────────────────────────────
function parseClock(spec = '09:00') {
  const m = /^(\d{1,2}):?(\d{2})?$/.exec(String(spec).trim());
  if (!m) return 9 * 60;
  return Number(m[1]) * 60 + Number(m[2] || 0);
}

/** Is this the right day and hour for the weekly report? */
export function dueNow(now = new Date()) {
  const { day, time } = analystSchedule();
  const tz = business().timezone || config.timezone || 'UTC';
  const p = partsInTz(now, tz);
  if (DAY_NAMES[p.weekday] !== day) return false;
  const minutes = p.hour * 60 + p.minute;
  const target = parseClock(time);
  // From the scheduled hour until midnight: if the laptop was shut at 09:00 we
  // still send at 14:00 rather than skipping the week. `alreadySentThisWeek`
  // is what stops it repeating.
  return minutes >= target && minutes < 24 * 60;
}

export function alreadySentThisWeek(now = new Date(), key = 'analyst_last_report') {
  const last = getSetting(key, null);
  if (!last) return false;
  const at = new Date(last);
  if (Number.isNaN(at.getTime())) return false;
  return now.getTime() - at.getTime() < 6 * DAY_MS;
}

/**
 * Send the weekly report to the owner, once. Respects the flag, the schedule
 * and the quiet-hours gate (a report at 03:00 is a bug, not a feature).
 */
export async function runWeeklyReport({ transport, now = new Date(), force = false } = {}) {
  if (!analystAgentEnabled()) return { sent: false, reason: 'disabled' };
  if (!force && !dueNow(now)) return { sent: false, reason: 'not_due' };
  if (!force && alreadySentThisWeek(now)) return { sent: false, reason: 'already_sent' };

  const report = await buildWeeklyReport({ now });
  const outcome = await sendToOwner({
    transport,
    text: report.text,
    agent: 'analyst',
    reason: 'weekly report',
    now,
  });

  if (outcome.sent) {
    setSetting('analyst_last_report', now.toISOString());
    logEvent('analyst_report_sent', null, { conversations: report.numbers.conversations });
  }
  return { ...outcome, report };
}

export function startAnalystLoop({ transport, intervalMs = 30 * 60_000 } = {}) {
  if (!analystAgentEnabled()) return null;

  const tick = async () => {
    try {
      await runWeeklyReport({ transport });
    } catch (err) {
      logEvent('analyst_error', null, err.message);
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 45_000).unref?.();
  console.log(`📊 Analyst: weekly report on ${analystSchedule().day} at ${analystSchedule().time}`);
  return timer;
}

export default {
  analystAgentEnabled, weekWindow, weeklyNumbers, avgFirstResponseMinutes, busiestHours,
  unansweredQuestions, deltas, suggestions, fallbackSuggestions, buildWeeklyReport,
  weeklyReportText, dueNow, alreadySentThisWeek, runWeeklyReport, startAnalystLoop,
};
