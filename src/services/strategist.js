// src/services/strategist.js
// Phase 6 Part 3 — the owner-facing strategist.
//
// `.brain` is three lines before coffee. `.strategy` is the weekly deep review:
// where the funnel leaks, which hours are slow, what people keep asking, which
// channel actually pays, and at most five ranked actions with an effort, an
// estimated effect and a one-tap command.
//
// The numbers are the analyst's numbers. The model, when there is a key, only
// writes the sentences; every figure in its input is already computed here, and
// a suggestion that fails the claims guard is replaced by the plain one.

import { featureOn, business, profile } from './profile.js';
import { config } from '../config/env.js';
import * as db from '../utils/db.js';
import { chat, hasLLM } from '../core/llm.js';
import { fenceUntrusted } from '../core/injection.js';
import { canReason, noteReasoningCall, activeProvider, reasoningConfig } from './reasoning.js';
import { recordDecision } from './reasoning.js';
import { impactNumbers, weekWindow } from './impact.js';
import { listGoals, goalProgress } from './goals.js';
import { sourceCounts } from './sourceLinks.js';

const DAY = 24 * 3600 * 1000;
const MAX_ACTIONS = 5;
const MAX_RATIONALE = 300;

export const ACTION_KINDS = ['campaign', 'faq', 'offer', 'followups', 'reactivation'];

export function strategistEnabled() {
  return featureOn('businessBrain');
}

const tenant = () => config.tenant?.slug || null;

/**
 * Customer snippets reach a model prompt in the rewrite step, so they are
 * stripped of anything identifying first: phone numbers, emails, links, long
 * digit runs, @handles. What is left is the shape of the question, not a person.
 */
function sanitise(text = '') {
  return String(text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/@[A-Za-z0-9_]{3,}/g, '[handle]')
    .replace(/\+?\d[\d\s-]{7,}/g, '[number]')
    .slice(0, 140);
}

// ── the numbers ──────────────────────────────────────────────

function weekBounds(now = new Date()) {
  const w = weekWindow(now);
  return { from: w.from, to: w.to, prevFrom: w.prevFrom, prevTo: w.prevTo };
}

/** A deterministic diagnosis of the week, as facts — no prose, no model. */
export function diagnose({ now = new Date() } = {}) {
  const { from, to } = weekBounds(now);
  const current = impactNumbers({ from, to });
  const previous = impactNumbers({ from: weekBounds(new Date(now.getTime() - 7 * DAY)).from, to: from });

  const firstMsg = db.all(
    `SELECT number, MIN(created_at) AS first_at FROM messages WHERE role = 'user' AND created_at >= ? AND created_at < ? GROUP BY number`,
    [from, to]
  );
  let noReply = 0;
  for (const row of firstMsg) {
    const reply = db.get(
      `SELECT id FROM messages WHERE number = ? AND role IN ('assistant','owner') AND created_at >= ? LIMIT 1`,
      [row.number, row.first_at]
    );
    if (!reply) noReply += 1;
  }

  const unanswered = db
    .all(
      `SELECT content, COUNT(*) AS n FROM messages
        WHERE role = 'user' AND created_at >= ? AND created_at < ?
          AND (content LIKE '%?%' OR content LIKE '%؟%')
        GROUP BY content ORDER BY n DESC LIMIT 5`,
      [from, to]
    )
    .map((r) => ({ text: sanitise(r.content).slice(0, 120), count: Number(r.n) || 0 }));

  // "Busiest hours" has to be the owner's clock, not UTC: a shop that closes at
  // 11pm does not want to be told its rush is at 18:00 UTC.
  const tz = business()?.timezone || profile()?.owner?.timezone || config.timezone || 'UTC';
  const hourOf = (iso) => {
    try {
      return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }).format(new Date(iso));
    } catch {
      return iso.slice(11, 13);
    }
  };
  const hourCounts = new Map();
  for (const row of db.all(
    `SELECT created_at FROM messages WHERE role = 'user' AND created_at >= ? AND created_at < ?`,
    [from, to]
  )) {
    const hour = hourOf(row.created_at);
    hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
  }
  const slowHours = [...hourCounts.entries()]
    .map(([hour, count]) => ({ hour: `${hour}:00`, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  const outOfStock = db
    .all(
      `SELECT content, COUNT(*) AS n FROM messages
        WHERE role = 'user' AND created_at >= ? AND created_at < ?
          AND (lower(content) LIKE '%stock%' OR lower(content) LIKE '%available%' OR lower(content) LIKE '%out of%')
        GROUP BY content ORDER BY n DESC LIMIT 5`,
      [from, to]
    )
    .map((r) => ({ text: sanitise(r.content).slice(0, 100), count: Number(r.n) || 0 }));

  const cancellations = Number(
    db.get(
      `SELECT COUNT(*) AS n FROM bookings WHERE created_at >= ? AND created_at < ? AND status IN ('cancelled','no-show','no_show')`,
      [from, to]
    )?.n
  ) || 0;

  const cold = db.all(
    `SELECT c.number FROM contacts c
      WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.number = c.number AND m.created_at >= ?)
      LIMIT 500`,
    [new Date(now.getTime() - 30 * DAY).toISOString()]
  ).length;

  const channels = (() => {
    try {
      return sourceCounts({ now }).map((c) => ({ label: c.label, revenue: c.revenue, orders: c.orders, conversations: c.conversations }));
    } catch {
      return [];
    }
  })();
  channels.sort((a, b) => b.revenue - a.revenue || b.orders - a.orders);

  const objections = db
    .all(
      `SELECT content, COUNT(*) AS n FROM messages
        WHERE role = 'user' AND created_at >= ? AND created_at < ?
          AND (lower(content) LIKE '%expensive%' OR lower(content) LIKE '%mehnga%'
               OR lower(content) LIKE '%discount%' OR lower(content) LIKE '%cheaper%'
               OR lower(content) LIKE '%too much%' OR lower(content) LIKE '%zyada%')
        GROUP BY content ORDER BY n DESC LIMIT 4`,
      [from, to]
    )
    .map((r) => ({ text: sanitise(r.content).slice(0, 100), count: Number(r.n) || 0 }));

  return {
    from,
    to,
    current,
    previous,
    unanswered,
    noReply,
    slowHours,
    outOfStock,
    objections,
    cancellations,
    coldPool: cold,
    channels,
    thin: current.thin,
  };
}

// ── actions ──────────────────────────────────────────────────

/**
 * Turn the diagnosis into at most five ranked actions. Each one has an effort,
 * an effect *range* labelled as an estimate, and a one-tap command.
 */
export function proposeActions({ now = new Date(), persist = true } = {}) {
  const d = diagnose({ now });
  const actions = [];
  const offers = Array.isArray(business()?.offers) ? business().offers : [];

  if (d.unanswered.length) {
    actions.push({
      kind: 'faq',
      title: `Answer the question you were asked ${d.unanswered[0].count}× — "${d.unanswered[0].text.slice(0, 60)}"`,
      why: 'the same question keeps arriving and the knowledge base does not cover it',
      effort: 'low (10 minutes, one `.addfaq`)',
      effect: 'estimated: 5–15% fewer repeat questions',
      score: 60 + d.unanswered[0].count,
      command: '.do 1',
    });
  }

  if (d.current.automationRate < 80 && d.current.conversations >= d.current.thinDataThreshold) {
    actions.push({
      kind: 'followups',
      title: `Automate the ${100 - d.current.automationRate}% of chats that still need you`,
      why: `automation is ${d.current.automationRate}% this week — below your 80% target`,
      effort: 'medium (enable follow-ups, check the drafts for a week)',
      effect: 'estimated: +5–12 points of automation',
      score: 70,
      command: '.do 2',
    });
  }

  if (d.objections.length) {
    actions.push({
      kind: 'offer',
      title: offers.length ? `Put "${offers[0]}" in front of the price objection` : 'Define one small offer to answer the price objection',
      why: `${d.objections[0].count} message(s) hit the same objection this week`,
      effort: 'low (one `.offer` check, then `.promo preview`)',
      effect: 'estimated: +3–8% reply-to-order conversion',
      score: 55 + d.objections[0].count,
      command: '.do 3',
    });
  }

  if (d.coldPool > 20) {
    actions.push({
      kind: 'reactivation',
      title: `Win back the ${d.coldPool} contacts who have not written in 30 days`,
      why: 'a cold pool this size is the cheapest audience you already own',
      effort: 'medium (one campaign, approved by you)',
      effect: 'estimated: 2–6% will reply; 10–20% of those order',
      score: 45 + Math.min(20, Math.round(d.coldPool / 10)),
      command: '.do 4',
    });
  }

  if (d.channels.length && d.channels[0].orders > 0) {
    actions.push({
      kind: 'campaign',
      title: `Put the next poster/QR behind ${d.channels[0].label}`,
      why: `${d.channels[0].label} has paid ${d.channels[0].orders} order(s) for ${d.channels[0].revenue} PKR`,
      effort: 'low (print one QR)',
      effect: 'estimated: +2–5 more chats per week',
      score: 40 + Math.min(15, d.channels[0].orders),
      command: '.do 5',
    });
  }

  if (d.cancellations > 0) {
    actions.push({
      kind: 'followups',
      title: `Add a reminder before bookings (${d.cancellations} cancelled or no-showed)`,
      why: 'reminders are the cheapest fix for a no-show',
      effort: 'low (one setting)',
      effect: 'estimated: recovers 20–40% of no-shows',
      score: 38 + d.cancellations * 2,
      command: '.do 5',
    });
  }

  if (d.current.followUpsSent > 5 && d.current.followUpsAnswered / Math.max(1, d.current.followUpsSent) < 0.2) {
    actions.push({
      kind: 'followups',
      title: 'Rewrite the follow-up wording — fewer than 1 in 5 are answered',
      why: `only ${d.current.followUpsAnswered} of ${d.current.followUpsSent} follow-ups got a reply`,
      effort: 'low (A/B two lines with .experiment)',
      effect: 'estimated: +5–15% replies',
      score: 42,
      command: '.do 3',
    });
  }

  // Goals can outrank a generic action when they are off track.
  const goals = listGoals({ status: 'active' }).map((g) => ({ goal: g, progress: goalProgress(g, { now }) }));
  const behind = goals.find((g) => g.progress.warn);
  if (behind) {
    actions.push({
      kind: 'campaign',
      title: `Push the "${behind.goal.metric}" goal — projected ${behind.progress.projected ?? '—'} against ${behind.goal.target}`,
      why: `the goal ends ${behind.progress.due} and the current pace misses it`,
      effort: 'medium',
      effect: 'estimated: depends on the channel you choose',
      score: 75,
      command: '.goal',
    });
  }

  const ranked = actions
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ACTIONS)
    .map((a, i) => ({ ...a, n: i + 1, command: `.do ${i + 1}` }));

  if (persist) {
    db.run("UPDATE brain_proposals SET status = 'stale' WHERE tenant = ? AND status = 'proposed'", [tenant()]);
    for (const action of ranked) {
      db.run('INSERT INTO brain_proposals (tenant, kind, title, detail, payload, status, created_at) VALUES (?,?,?,?,?,?,?)', [
        tenant(),
        action.kind,
        action.title.slice(0, 200),
        `${action.why}\nEffort: ${action.effort}\nEffect: ${action.effect}`.slice(0, 800),
        JSON.stringify({ kind: action.kind, score: action.score }),
        'proposed',
        now.toISOString(),
      ]);
      const row = db.get('SELECT id FROM brain_proposals WHERE tenant = ? ORDER BY id DESC LIMIT 1', [tenant()]);
      action.id = row?.id || null;
      recordDecision({
        kind: 'strategy',
        action: action.kind,
        rationale: `${action.title} — ${action.why}`.slice(0, MAX_RATIONALE),
        payload: { proposalId: action.id, effort: action.effort, effect: action.effect },
        now,
      });
    }
  }

  return { diagnosis: d, actions: ranked };
}

export function currentProposals() {
  return db.all("SELECT * FROM brain_proposals WHERE tenant = ? AND status = 'proposed' ORDER BY id DESC LIMIT 10", [tenant()]);
}

export function proposalByNumber(n, { now = new Date() } = {}) {
  const list = proposeActions({ now, persist: false }).actions;
  const index = Number(n);
  if (!Number.isInteger(index) || index < 1) return null;
  return list[index - 1] || null;
}

// ── drafts ───────────────────────────────────────────────────

/**
 * Prepare an action as a draft. Nothing here sends: a campaign becomes a promo
 * preview, an FAQ becomes text to save, an offer becomes a verdict and a line,
 * and follow-ups become a list with drafts.
 */
export async function prepareAction(n, { now = new Date() } = {}) {
  // `.do 1` has to work without `.strategy` first: if nothing has been proposed
  // yet, propose now so the owner's decision has something to point at.
  if (!currentProposals().length) proposeActions({ now, persist: true });
  const action = proposalByNumber(n, { now });
  if (!action) return { ok: false, text: `No action ${n}. Try .strategy first.` };

  const draft = await draftFor(action, { now });
  if (!draft.ok) return { ok: false, text: draft.text };

  try {
    db.run(
      "UPDATE brain_proposals SET status = 'drafted', decided_at = ? WHERE tenant = ? AND title = ? AND status = 'proposed'",
      [now.toISOString(), tenant(), action.title.slice(0, 200)]
    );
    recordDecision({
      kind: 'strategy',
      action: `draft:${action.kind}`,
      rationale: `Prepared "${action.title}" as a draft — nothing sent`.slice(0, MAX_RATIONALE),
      payload: { n },
      outcome: 'drafted',
      now,
    });
  } catch {
    /* the draft is still shown */
  }
  return { ok: true, action, text: draft.text };
}

async function draftFor(action, { now }) {
  switch (action.kind) {
    case 'campaign': {
      const M = await import('./marketing.js');
      if (!M.marketingEnabled()) {
        return { ok: true, text: `Campaign draft (marketing team is off, so nothing was prepared):\n${action.title}\n\nTurn it on with .marketing on to get a real preview.` };
      }
      const preview = M.promoPreview({ segment: 'all', message: action.title.slice(0, 300), now });
      return { ok: true, text: `📝 Draft ready — nothing sent.\n\n${preview.text}` };
    }
    case 'faq': {
      const q = action.title.replace(/^Answer the question you were asked [^—]+—\s*/, '').replace(/^"|"$/g, '');
      return {
        ok: true,
        text: [
          '📝 FAQ draft — nothing saved yet:',
          '',
          `.addfaq "${q.slice(0, 80)}" | "<your answer, in your words>"`,
          '',
          'Send that line and it goes into the knowledge base.',
        ].join('\n'),
      };
    }
    case 'offer': {
      const M = await import('./marketing.js');
      const cap = M.discountCap();
      const verdict = M.evaluateOffer({ idea: cap ? `${Math.min(cap, 10)}% off this week` : 'a small offer this week', now });
      return { ok: true, text: `📝 Offer draft — nothing sent.\n\n${verdict.text}` };
    }
    case 'followups':
    case 'reactivation': {
      const { nextBestAction } = await import('./nextBestAction.js');
      const rows = db.all(
        `SELECT c.number, c.name FROM contacts c
          WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.number = c.number AND m.created_at >= ?)
          LIMIT 5`,
        [new Date(now.getTime() - 30 * DAY).toISOString()]
      );
      if (!rows.length) return { ok: true, text: '📝 Nobody in that pool right now — nothing to draft.' };
      const lines = ['📝 Follow-up batch — drafts only, nothing sent:', ''];
      for (const row of rows) {
        const nba = nextBestAction(row.number, { now });
        lines.push(`• ${row.name || row.number}: ${nba.draft || nba.reason}`);
      }
      lines.push('', 'Approve them with .campaign preview once the wording is right.');
      return { ok: true, text: lines.join('\n') };
    }
    default:
      return { ok: false, text: 'That action has no draft yet.' };
  }
}

// ── the two reports ──────────────────────────────────────────

export async function dailyBrief({ now = new Date() } = {}) {
  // The brief is the once-a-day moment: settle the outcomes that never came.
  try {
    const L = await import('./learning.js');
    if (L.learningEnabled()) L.sweepOutcomes({ now });
  } catch {
    /* the brief must not fail because the weights could not settle */
  }
  const d = diagnose({ now });
  const today = impactNumbers({ now, from: new Date(now.getTime() - DAY).toISOString(), to: now.toISOString() });
  const lines = [`🧠 ${business()?.name || 'Today'} — ${now.toISOString().slice(0, 10)}`];

  lines.push(
    `${today.conversations} chat${today.conversations === 1 ? '' : 's'} in 24h · ${today.automationRate}% without you` +
      (today.firstResponseMinutes !== null ? ` · first reply ${today.firstResponseMinutes} min` : '')
  );

  const top = d.unanswered[0];
  if (top) lines.push(`Most asked: "${top.text.slice(0, 70)}"${top.count > 1 ? ` (${top.count}×)` : ''}`);
  else if (d.channels.length) lines.push(`Best channel: ${d.channels[0].label} — ${d.channels[0].revenue} PKR`);
  else lines.push(d.current.conversations ? 'No repeat question yet this week.' : 'Nothing to analyse yet — talk to a few customers first.');

  const { actions } = proposeActions({ now, persist: false });
  lines.push(actions.length ? `Next: ${actions[0].title} (.strategy for the rest)` : 'Nothing urgent. Leave it alone today.');

  const brief = await maybeRewrite(lines.join('\n'), 'a three-line daily brief for a shop owner');
  return { text: brief, diagnosis: d, actions };
}

export async function weeklyReview({ now = new Date() } = {}) {
  const d = diagnose({ now });
  const c = d.current;
  const p = d.previous;
  const pct = (a, b) => (b ? `${a >= b ? '+' : ''}${Math.round(((a - b) / b) * 100)}%` : 'new');

  const lines = [`🧭 *Weekly strategy — ${d.from.slice(0, 10)} → ${d.to.slice(0, 10)}*`, ''];

  if (d.thin) {
    lines.push(
      `⚠️ Thin data: ${c.conversations} conversations. The trends below are counts, not rates — decisions on them are guesses.`,
      ''
    );
  }

  lines.push('*Funnel*');
  lines.push(`  conversations ${c.conversations} (${pct(c.conversations, p.conversations)})`);
  lines.push(`  → handled without you ${c.handledByBot} (${c.automationRate}%)`);
  lines.push(`  → leads ${c.leads} → bookings ${c.bookings} → paid orders ${c.orders}`);
  if (d.noReply) lines.push(`  ⚠️ ${d.noReply} conversation(s) got no reply at all`);

  lines.push('', '*Response*');
  lines.push(`  first reply ${c.firstResponseMinutes ?? '—'} min${p.firstResponseMinutes ? ` (was ${p.firstResponseMinutes})` : ''}`);
  if (d.slowHours.length) lines.push(`  busiest hours: ${d.slowHours.map((h) => `${h.hour} (${h.count})`).join(', ')}`);
  lines.push(`  after-hours covered: ${c.afterHoursCovered}`);

  if (d.unanswered.length) {
    lines.push('', '*Asked but not answered*');
    for (const q of d.unanswered) lines.push(`  • "${q.text.slice(0, 70)}"${q.count > 0 ? ` (${q.count}×)` : ''}`);
  }
  if (d.objections.length) {
    lines.push('', '*Objections that repeat*');
    for (const o of d.objections) lines.push(`  • "${o.text.slice(0, 70)}" (${o.count}×)`);
  }
  if (d.outOfStock.length) {
    lines.push('', '*Stock questions*');
    for (const s of d.outOfStock.slice(0, 3)) lines.push(`  • "${s.text.slice(0, 70)}" (${s.count}×)`);
  }
  if (d.channels.length) {
    lines.push('', '*Channels by revenue*');
    for (const ch of d.channels.slice(0, 4)) lines.push(`  • ${ch.label}: ${ch.orders} paid · ${ch.revenue} PKR`);
  }
  lines.push('', `*Cold pool:* ${d.coldPool} contacts silent for 30 days · *cancellations:* ${d.cancellations}`);

  const { actions } = proposeActions({ now, persist: true });
  lines.push('', '*Do these next*');
  if (!actions.length) {
    lines.push('  Nothing worth doing this week. Keep answering.');
  } else {
    for (const a of actions) {
      lines.push(`  ${a.n}. ${a.title}`);
      lines.push(`     effort: ${a.effort}`);
      lines.push(`     effect: ${a.effect}`);
      lines.push(`     ${a.command} · .why ${a.n} for the reason`);
    }
  }

  lines.push('', 'Effects are estimates, labelled as such. Numbers are counts from your own database.');

  const text = await maybeRewrite(lines.join('\n'), 'a weekly strategy review for a shop owner');
  return { text, diagnosis: d, actions };
}

/**
 * The block appended to `.report week` when the brain is on. It is a separate
 * function (not a rewrite of the analyst's text) so the analyst report stays
 * exactly as it was.
 */
export async function weeklyStrategyAddendum(now = new Date()) {
  const { actions } = proposeActions({ now, persist: false });
  const d = diagnose({ now });
  const lines = ['🧠 *Business brain*', ''];
  const c = d.current;
  lines.push(`Automation: ${c.automationRate}% of ${c.conversations} chats needed nothing from you.`);
  if (c.firstResponseMinutes !== null) lines.push(`First reply: ${c.firstResponseMinutes} min.`);
  if (!actions.length) {
    lines.push('', 'Nothing worth doing this week. Keep answering.');
    return lines.join('\n');
  }
  lines.push('', 'Worth doing (newest first):');
  for (const a of actions.slice(0, 3)) lines.push(`  ${a.n}. ${a.title} — ${a.effort}`);
  lines.push('', '.strategy for the full review · .do <n> prepares a draft, it does not send.');
  return lines.join('\n');
}

export function whyAction(n, { now = new Date() } = {}) {
  const action = proposalByNumber(n, { now });
  if (!action) return { ok: false, text: `No action ${n}. Try .strategy.` };
  const lines = [
    `🤔 *Why ${n}: ${action.title}*`,
    '',
    action.why,
    '',
    `Effort: ${action.effort}`,
    `Effect: ${action.effect} (an estimate, not a promise)`,
    '',
    `Run it as a draft: ${action.command} — it prepares, it does not send.`,
  ];
  return { ok: true, text: lines.join('\n') };
}

// ── the model, if there is one ───────────────────────────────

/**
 * The model may rewrite the sentences, never the figures. It gets no customer
 * text — only the already-aggregated diagnosis — and if its output breaks the
 * claims guard or budget, the plain text is kept.
 */
async function maybeRewrite(text, purpose) {
  if (!hasLLM()) return text;
  const cfg = reasoningConfig();
  if (!canReason(new Date(), cfg).ok) return text;
  const provider = activeProvider(cfg);
  try {
    const res = await chat({
      system: `You rewrite an already-written report for a shop owner. Keep every number exactly as given. Do not add advice, promises or new figures. Purpose: ${fenceUntrusted(purpose)}.`,
      messages: [{ role: 'user', content: fenceUntrusted(text) }],
      maxTokens: 700,
      temperature: 0.3,
      timeoutMs: cfg.planTimeoutMs,
      provider: provider?.provider,
      model: provider?.model,
    });
    noteReasoningCall(new Date());
    const out = String(res?.text || '').trim();
    if (!out) return text;
    // A rewrite may not lose the figures. Every multi-digit number in the plain
    // report has to survive, and the rewrite has to stay roughly the same size —
    // otherwise the shop owner would get a prettier report with no numbers in it,
    // which is exactly the failure this whole module exists to prevent.
    const wanted = [...text.matchAll(/\d[\d,.]*/g)].map((m) => m[0]).filter((n) => n.replace(/\D/g, '').length >= 2);
    const missing = wanted.filter((n) => !out.includes(n));
    if (missing.length) return text;
    if (out.length < Math.floor(text.length * 0.5)) return text;
    const { guard } = await import('./marketing.js');
    const verdict = guard(out, { industry: 'generic' });
    return verdict.ok ? out : text;
  } catch {
    return text;
  }
}

export default { strategistEnabled, diagnose, proposeActions, prepareAction, dailyBrief, weeklyReview, weeklyStrategyAddendum, whyAction, currentProposals, ACTION_KINDS };
