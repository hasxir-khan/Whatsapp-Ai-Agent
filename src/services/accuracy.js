// src/services/accuracy.js
// ".accuracy" — what the safety nets actually caught, counted from the event log.
//
// The rule for this file: **only events that already exist**. If a number in the
// spec has no source in the codebase, it is reported as "not instrumented yet"
// rather than invented, because a dashboard that quietly shows 0 for "we do not
// measure this" is worse than no dashboard.
//
// Nothing here writes: it is a read of `events` and `reply_timeline`.

import { guardBucket } from './reportArchive.js';
import { period, localDateString } from './reportCalendar.js';
import { business } from './profile.js';
import { config } from '../config/env.js';
import { all } from '../utils/db.js';

const DAY_MS = 86_400_000;
export const NOT_INSTRUMENTED = 'not instrumented yet';

const iso = (d) => new Date(d).toISOString();

function sinceIso(days, now) {
  return iso(now.getTime() - Math.max(1, Number(days) || 7) * DAY_MS);
}

function events(type, fromIso, to) {
  return all('SELECT type, number, detail, created_at FROM events WHERE type = ? AND created_at >= ? AND created_at < ? ORDER BY id', [
    type,
    fromIso, to,
  ]);
}

function parseDetail(row) {
  try {
    return row?.detail ? JSON.parse(row.detail) : {};
  } catch {
    return {};
  }
}

/** Guard rejections, split by what the guard actually complained about. */
function guardProblems(fromIso, to) {
  const rows = events('reply_guard_rejected', fromIso, to);
  const buckets = { price: [], language: [], cut: [], forbidden: [], other: [] };
  for (const row of rows) {
    buckets[guardBucket(row.detail)].push(row);
  }
  return buckets;
}

/** ISO week key (YYYY-Www) for the weekly trend. */
export function weekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * The whole report.
 * @param {{days?:number, now?:Date, weeks?:number}} opts
 */
export function accuracyReport({ days = 7, now = new Date(), weeks = 4, from = null, to = null, trend = true } = {}) {
  const window =
    process.env.TENANT_DASHBOARD === '1'
      ? period(now, business()?.timezone || config.timezone, Math.max(1, Math.min(3650, Number(days) || 7)))
      : null;
  from ??= window?.from || sinceIso(days, now);
  to ??= window?.to || new Date(now.getTime() + 1).toISOString();
  const guard = guardProblems(from, to);

  const dupBlocked = events('duplicate_reply_blocked', from, to);
  const superseded = events('reply_superseded', from, to);
  const handoffs = [
    ...events('handoff', from, to),
    ...events('closer_handoff', from, to),
    ...events('complaint_handoff', from, to),
    ...events('closer_discount_handoff', from, to),
  ];
  const ownerReplies = events('inbox_reply', from, to);
  const disclosures = events('bot_disclosure', from, to);
  const cuts = [...events(' reply_cut_detected'.trim(), from, to), ...events('reply_clipped_to_sentence', from, to)];
  const timelines = events('reply_timeline', from, to);

  const metric = (key, label, count, { target = null, source = null, status = 'ok', note = null } = {}) => ({
    key,
    label,
    count,
    target,
    red: target === 0 && count > 0,
    status,
    source,
    note,
  });

  const metrics = [
    metric('priceMismatch', 'Price / number claims the guard caught', guard.price.length, {
      target: 0,
      source: 'events.reply_guard_rejected · problems match "price range changed" or "not in the catalogue"',
      note: 'zero is the target; anything above it is a reply the customer never saw',
    }),
    metric('wrongLanguage', 'Replies in the wrong language', guard.language.length, {
      target: 0,
      source: 'events.reply_guard_rejected · problems match "language: expected …"',
    }),
    metric('midSentenceCuts', 'Replies that ended mid-sentence', guard.cut.length + cuts.length, {
      target: 0,
      source: 'events.reply_cut_detected + reply_clipped_to_sentence + guard "cut off:"',
    }),
    metric('forbiddenText', 'Replies with forbidden wording', guard.forbidden.length, {
      target: 0,
      source: 'events.reply_guard_rejected · "forbidden text"',
    }),
    metric('doubleRepliesBlocked', 'Second replies blocked before sending', dupBlocked.length + superseded.length, {
      source: 'events.duplicate_reply_blocked + reply_superseded',
      note: 'blocked means the customer got one reply, not two',
    }),
    metric('handoffs', 'Hand-offs to you', handoffs.length, {
      source: 'events.handoff · closer_handoff · complaint_handoff · closer_discount_handoff',
    }),
    metric('ownerReplies', 'Replies you sent from the inbox', ownerReplies.length, {
      source: 'events.inbox_reply',
    }),
    metric('botHonesty', 'Asked "are you a bot?" — answered honestly', disclosures.length, {
      source: 'events.bot_disclosure',
    }),
    metric('ownerEdits', 'Replies you rewrote before sending', 0, {
      status: 'not_instrumented',
      note: NOT_INSTRUMENTED,
      source: 'no event records an edited draft — inbox replies are sent, not edited',
    }),
    metric('ownerCorrections', 'Replies you marked wrong afterwards', 0, {
      status: 'not_instrumented',
      note: `.review collects these now (reply_reviews), but nothing counts them yet`,
      source: 'table reply_reviews (new)',
    }),
  ];

  if (process.env.TENANT_DASHBOARD === '1') {
    for (const row of all(
      "SELECT a,SUM(n) n FROM report_signals WHERE metric='accuracy' AND at>=? AND at<? GROUP BY a",
      [from, to]
    )) {
      const m = metrics.find((m) => m.key === row.a);
      if (m) {
        m.count += row.n;
        m.red = m.target === 0 && m.count > 0;
      }
    }
  }

  // Per provider, from the reply timeline (the only event that carries one).
  const byProvider = new Map();
  for (const row of timelines) {
    const detail = parseDetail(row);
    const provider = String(detail.provider || 'unknown');
    const entry = byProvider.get(provider) || { provider, replies: 0, totalMs: 0, samples: 0 };
    entry.replies += 1;
    if (Number.isFinite(detail.totalMs)) {
      entry.totalMs += detail.totalMs;
      entry.samples += 1;
    }
    byProvider.set(provider, entry);
  }
  const providers = [...byProvider.values()]
    .map((p) => ({
      provider: p.provider,
      replies: p.replies,
      avgSeconds: p.samples ? Number((p.totalMs / p.samples / 1000).toFixed(2)) : null,
    }))
    .sort((a, b) => b.replies - a.replies);

  // Weekly trend: replies per ISO week, with the same three counters alongside.
  const weeksBack = Math.max(1, Number(weeks) || 4);
  const trendFrom = iso(now.getTime() - weeksBack * 7 * DAY_MS);
  const weekRows = !trend
    ? []
    : all(
        "SELECT type, created_at FROM events WHERE created_at >= ? AND created_at < ? AND type IN ('reply_sent','handoff','duplicate_reply_blocked','reply_guard_rejected') ORDER BY id",
        [trendFrom, to]
      );
  const weekly = new Map();
  for (const row of weekRows) {
    const key = weekKey(
      new Date(
        window ? localDateString(new Date(row.created_at), business()?.timezone || config.timezone) : row.created_at
      )
    );
    const entry = weekly.get(key) || {
      week: key,
      replies: 0,
      handoffs: 0,
      doubleRepliesBlocked: 0,
      guardRejections: 0,
    };
    if (row.type === 'reply_sent') entry.replies += 1;
    if (row.type === 'handoff') entry.handoffs += 1;
    if (row.type === 'duplicate_reply_blocked') entry.doubleRepliesBlocked += 1;
    if (row.type === 'reply_guard_rejected') entry.guardRejections += 1;
    weekly.set(key, entry);
  }

  // Conversation Control: how each message was handled. Only present when the
  // command ran at least once, so an install without the feature sees nothing.
  let decisionRows = [];
  try {
    decisionRows = all(
      'SELECT action, COUNT(*) AS count FROM decisions WHERE created_at >= ? AND created_at < ? GROUP BY action ORDER BY count DESC',
      [from, to]
    );
  } catch {
    decisionRows = [];
  }
  const decisions = decisionRows.map((r) => ({ action: r.action, count: Number(r.count) || 0 }));

  return {
    window: { days, from, to, weeks: weeksBack },
    metrics,
    decisions,
    providers,
    weekly: [...weekly.values()].sort((a, b) => a.week.localeCompare(b.week)),
    instrumented: metrics.filter((m) => m.status === 'ok').length,
    notInstrumented: metrics.filter((m) => m.status !== 'ok').length,
  };
}

/** The text `.accuracy` sends back. Short: this is read on a phone. */
export function accuracyText(report) {
  const lines = [`*Accuracy — last ${report.window.days} days*`];
  for (const m of report.metrics) {
    if (m.status !== 'ok') {
      lines.push(`• ${m.label}: _${NOT_INSTRUMENTED}_`);
      continue;
    }
    const flag = m.red ? ' 🔴' : '';
    const target = m.target === 0 ? ' (target 0)' : '';
    lines.push(`• ${m.label}: *${m.count}*${target}${flag}`);
  }

  if (report.providers.length) {
    lines.push('', '*By provider*');
    for (const p of report.providers) {
      const avg = p.avgSeconds === null ? '' : ` · avg ${p.avgSeconds}s`;
      lines.push(`• ${p.provider}: ${p.replies} repl${p.replies === 1 ? 'y' : 'ies'}${avg}`);
    }
  }

  if (report.decisions?.length) {
    lines.push('', '*Decisions*');
    lines.push(report.decisions.map((d) => `${d.action} ${d.count}`).join(' · '));
  }

  if (report.weekly.length) {
    lines.push('', '*Weekly*');
    for (const w of report.weekly) {
      lines.push(`• ${w.week}: ${w.replies} replies · guard ${w.guardRejections} · double ${w.doubleRepliesBlocked} · hand-off ${w.handoffs}`);
    }
  }

  const red = report.metrics.filter((m) => m.red);
  if (red.length) {
    lines.push('', `🔴 ${red.map((m) => m.label).join(', ')} — above zero.`);
  } else {
    lines.push('', 'Nothing above its target.');
  }
  if (report.notInstrumented) {
    lines.push(`_${report.notInstrumented} metric(s) not instrumented yet — not zero, unknown._`);
  }
  return lines.join('\n');
}

/** The dashboard card. Same numbers, no chart library. */
export function accuracySection(report) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = report.metrics
    .map((m) => {
      if (m.status !== 'ok') {
        return `<tr><td>${esc(m.label)}</td><td class="msg" colspan="2">${esc(NOT_INSTRUMENTED)}</td></tr>`;
      }
      const cls = m.red ? ' style="color:#c0392b;font-weight:600"' : '';
      return `<tr><td${cls}>${esc(m.label)}</td><td${cls}>${m.count}</td><td class="msg">${esc(m.target === 0 ? 'target 0' : '')}</td></tr>`;
    })
    .join('');

  const providers = report.providers
    .map((p) => `<tr><td>${esc(p.provider)}</td><td>${p.replies}</td><td class="msg">${p.avgSeconds === null ? '' : `avg ${p.avgSeconds}s`}</td></tr>`)
    .join('');

  const weekly = report.weekly
    .map((w) => `<tr><td>${esc(w.week)}</td><td>${w.replies}</td><td>${w.guardRejections}</td><td>${w.doubleRepliesBlocked}</td><td>${w.handoffs}</td></tr>`)
    .join('');

  return `<section>
  <h2>Accuracy</h2>
  <div class="msg">What the safety nets caught in the last ${report.window.days} days, from the event log. Zero is the target for the red lines.</div>
  <table><thead><tr><th>check</th><th>count</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="msg">no data</td></tr>'}</tbody></table>
  ${
    providers
      ? `<table style="margin-top:8px"><thead><tr><th>provider</th><th>replies</th><th></th></tr></thead><tbody>${providers}</tbody></table>`
      : ''
  }
  ${
    weekly
      ? `<table style="margin-top:8px"><thead><tr><th>week</th><th>replies</th><th>guard</th><th>double</th><th>hand-off</th></tr></thead><tbody>${weekly}</tbody></table>`
      : ''
  }
</section>`;
}

export default { accuracyReport, accuracyText, accuracySection, weekKey, NOT_INSTRUMENTED };
