// src/services/reactivationAgent.js
// The reactivation agent (features.reactivationAgent).
//
// Once in a while, the people who already paid you deserve a nudge — and the
// leads who went quiet deserve one last chance before you close the file.
//
// The rules that make this safe rather than spam:
//   • three segments only: finished customers, never-bought cold leads, and a
//     date the customer themselves told us (birthday / anniversary)
//   • the offer comes from business.offers, the catalogue and the policies —
//     never from a model, never invented
//   • one message per contact per cycle, at most two cycles, then six months
//     of silence
//   • the owner approves the campaign first (.campaign preview → send), and
//     sending is slow and jittered, because Baileys is not an API
//   • everything goes through growth.js: opt-out, quiet hours, caps, the Cloud
//     window and its template rule

import { config } from '../config/env.js';
import { business, featureOn, offers as offerList, effectiveCatalog, policies, faqList } from './profile.js';
import { sendProactively, canSendProactively } from './growth.js';
import { formatMoney } from './geo.js';
import { partsInTz } from './hours.js';
import {
  all, get, getContact, listLeads, reactivationHistory, logReactivation,
  logEvent, getSetting, setSetting, isOptedOut, orderFor, numbersWithTag,
} from '../utils/db.js';
import { normaliseTag } from './crm.js';

const DAY = 86_400_000;

export function reactivationAgentEnabled() {
  return featureOn('reactivationAgent');
}

function firstName(contact = {}) {
  const raw = contact.name || contact.push_name || '';
  return String(raw).split(' ')[0] || '';
}

// ── the three segments ─────────────────────────────────────
/**
 * Customers whose job finished more than `afterDays` ago.
 * "Finished" means a booking marked done/completed or an order paid/delivered.
 */
export function pastCustomers(now = new Date(), afterDays = config.reactivation.afterDays) {
  const cutoff = new Date(now.getTime() - afterDays * DAY).toISOString().slice(0, 10);
  const rows = all(
    `SELECT chat, MAX(job_at) AS job_at FROM (
        SELECT chat, date AS job_at FROM bookings
         WHERE status IN ('done', 'completed') AND date <= ?
        UNION ALL
        SELECT chat, substr(created_at, 1, 10) AS job_at FROM orders
         WHERE status IN ('paid', 'delivered')
      ) GROUP BY chat`,
    [cutoff]
  );
  return rows
    .map((r) => ({ number: String(r.chat || '').split('@')[0], jobAt: r.job_at, segment: 'past' }))
    .filter((r) => r.number && r.number !== config.owner.number);
}

/** Leads that never bought and have gone quiet. */
export function coldLeads(now = new Date(), afterDays = config.reactivation.afterDays) {
  const cutoff = new Date(now.getTime() - afterDays * DAY).toISOString();
  return listLeads(null, 300)
    .filter((lead) => {
      if (!lead.number) return false;
      if (['won'].includes(lead.status)) return false;
      const bought = orderFor(`${lead.number}@s.whatsapp.net`);
      if (bought && ['paid', 'delivered'].includes(bought.status)) return false;
      const last = lead.updated_at || lead.created_at || '';
      return last && last < cutoff;
    })
    .map((lead) => ({ number: lead.number, segment: 'cold', jobAt: lead.updated_at || lead.created_at }));
}

/**
 * Birthdays and anniversaries the customer told us about. Stored as facts
 * (`birthday` / `anniversary` → MM-DD), never guessed from anything.
 */
export function dateSegment(now = new Date(), windowDays = 7) {
  const out = [];
  const tz = business().timezone || config.timezone || 'UTC';
  const today = partsInTz(now, tz);
  for (const fact of all("SELECT number, key, value FROM facts WHERE key IN ('birthday','anniversary')")) {
    const m = /^(\d{1,2})[-/](\d{1,2})$/.exec(String(fact.value || '').trim());
    if (!m) continue;
    const month = Number(m[1]);
    const day = Number(m[2]);
    const target = Date.UTC(today.year, month - 1, day);
    const startOfToday = Date.UTC(today.year, today.month - 1, today.day);
    const diff = Math.round((target - startOfToday) / DAY);
    if (diff >= 0 && diff <= windowDays) {
      out.push({ number: fact.number, segment: 'date', kind: fact.key, inDays: diff });
    }
  }
  return out;
}

/** Everyone due a nudge, filtered by cycle history, opt-outs and cooldown. */
export function segments(now = new Date(), { tag = null, tenantSlug = null } = {}) {
  const maxCycles = config.reactivation.maxCycles;
  const cooldown = config.reactivation.cooldownDays * DAY;
  const seen = new Set();
  const eligible = [];

  const all_ = [
    ...pastCustomers(now),
    ...coldLeads(now),
    ...dateSegment(now),
  ];

  for (const row of all_) {
    if (seen.has(row.number)) continue;
    seen.add(row.number);

    const history = reactivationHistory(row.number);
    const cycles = history.length;
    if (cycles >= maxCycles) {
      const last = history[0]?.sent_at ? new Date(history[0].sent_at).getTime() : 0;
      if (now.getTime() - last < cooldown) continue; // six months of quiet
    }

    // A reply since the last nudge means they are warm again — leave them be.
    const lastAt = history[0]?.sent_at;
    if (lastAt) {
      const replied = get("SELECT 1 AS c FROM messages WHERE number = ? AND role = 'user' AND created_at > ? LIMIT 1", [
        row.number,
        lastAt,
      ]);
      if (replied) continue;
    }

    if (isOptedOut(row.number)) continue; // "stop" outranks any campaign
    const contact = getContact(row.number);
    if (!contact || contact.is_blocked) continue;
    if (contact.bot_paused_until && new Date(contact.bot_paused_until) > now) continue;

    eligible.push({ ...row, contact, cycle: cycles + 1 });
  }

  // A tag narrows the list; it can never add anyone the rules above excluded.
  // Opt-out, blocked, paused and cycle rules all ran before this line.
  if (tag) {
    const wanted = new Set(numbersWithTag(normaliseTag(tag) || '', { tenant: tenantSlug || config.tenant.slug }));
    return eligible.filter((row) => wanted.has(String(row.number)));
  }

  return eligible;
}

// ── the message ────────────────────────────────────────────
/** The offer line: owner-defined first, then the catalogue, then nothing. */
export function offerLine() {
  const defined = offerList();
  if (defined.length) {
    const first = defined[0];
    return typeof first === 'string' ? first : first.text || first.offer || first.title || null;
  }
  const items = effectiveCatalog().filter((i) => (i.price ?? i.min) > 0);
  if (!items.length) return null;
  const item = items[0];
  return `${item.name} — ${formatMoney(Number(item.price ?? item.min), business().currency || 'PKR')}`;
}

/** A policy line we are allowed to mention (delivery, guarantee), or nothing. */
export function policyLine() {
  const p = policies();
  const written = p.delivery || p.guarantee || p.refund;
  if (written) return String(written);
  const faq = faqList().find((f) => /deliver|guarantee|refund|timing/i.test(String(f.question || f.q || '')));
  return faq ? String(faq.answer || faq.a) : null;
}

/**
 * Build one win-back message. Deterministic, from the profile only.
 */
export function buildReactivation({ contact = {}, segment = 'past', kind = null, lang = null } = {}) {
  const code = lang || contact.language || 'en';
  const name = firstName(contact);
  const offer = offerLine();
  const policy = policyLine();
  const hello = name ? `Hi ${name}` : 'Hi';

  // A date message is about the date, not about selling.
  if (segment === 'date') {
    const occasion = kind === 'anniversary' ? 'anniversary' : 'birthday';
    if (code === 'ur') return `${name ? name + ' صاحب، ' : ''}آپ کو سالگرہ/${occasion === 'anniversary' ? 'شادی کی سالگرہ' : 'پیدائش'} مبارک ہو! 🎉`;
    if (code === 'roman-ur') return `${name ? name + ', ' : ''}aap ko ${occasion === 'anniversary' ? 'anniversary' : 'birthday'} mubarak ho! 🎉`;
    return `Happy ${occasion}${name ? `, ${name}` : ''}! 🎉`;
  }

  const body = offer ? (code === 'ur' ? ` ${offer}` : ` ${offer}`) : '';
  const extra = policy ? ` ${policy}` : '';

  if (code === 'ur') {
    return `${name ? name + ' صاحب، ' : ''}کچھ عرصہ ہو گیا۔${body}${extra} کیا آپ کے لیے کچھ کر سکتا ہوں؟`;
  }
  if (code === 'roman-ur') {
    return `${hello} — kaafi arsa ho gaya.${body}${extra} Kuch kar sakta hoon aap ke liye?`;
  }
  return `${hello} — it's been a while.${body}${extra} Can I set anything up for you?`;
}

// ── the campaign ───────────────────────────────────────────
function campaignState() {
  return getSetting('campaign', null);
}

function saveCampaignState(state) {
  setSetting('campaign', state);
  return state;
}

/** What `.campaign preview` shows: who, how many, and what it would say. */
export function previewCampaign(now = new Date(), { tag = null } = {}) {
  const list = segments(now, { tag });
  const bySegment = {};
  for (const row of list) bySegment[row.segment] = (bySegment[row.segment] || 0) + 1;

  const sample = list.slice(0, 2).map((row) => ({
    number: row.number,
    segment: row.segment,
    text: buildReactivation({ contact: row.contact, segment: row.segment, kind: row.kind }),
  }));

  // How many would actually pass the gates right now. Honest, and usually lower
  // than the list, because quiet hours are quiet.
  let sendable = 0;
  for (const row of list) {
    if (canSendProactively(row.number, { now, agent: 'reactivation' }).ok) sendable += 1;
  }

  return { total: list.length, sendable, bySegment, sample, offers: offerList(), cycleMax: config.reactivation.maxCycles };
}

export function previewText(now = new Date(), { tag = null } = {}) {
  const wanted = tag ? normaliseTag(tag) : null;
  const p = previewCampaign(now, { tag: wanted });
  const scope = wanted ? ` tagged ${wanted}` : '';
  if (!p.total) {
    return wanted
      ? `📣 Nobody tagged ${wanted} is due a message right now — the tag narrows this list; it never adds to it.`
      : '📣 Nothing to reactivate right now — no finished jobs older than ' + config.reactivation.afterDays + ' days, no cold leads, no dates this week.';
  }
  const lines = ['📣 *Reactivation preview*', ''];
  lines.push(`Audience: ${p.total} people${scope} (${p.sendable} sendable right now)`);
  for (const [seg, n] of Object.entries(p.bySegment)) {
    const label = seg === 'past' ? 'past customers' : seg === 'cold' ? 'cold leads' : 'dates they told us';
    lines.push(`• ${label}: ${n}`);
  }
  if (!p.offers.length) {
    lines.push('');
    lines.push('⚠️ No offers configured — messages will mention the catalogue only.');
  }
  if (p.sample.length) {
    lines.push('');
    lines.push('Sample:');
    for (const s of p.sample) lines.push(`  "${s.text}" → +${s.number}`);
  }
  lines.push('');
  lines.push(`Sending is slow (one at a time), max ${p.cycleMax} cycles per person.`);
  lines.push('.campaign send to start · .campaign stop to halt');
  return lines.join('\n');
}

/**
 * Start a campaign. This *is* the owner approval step: nothing goes out until
 * `.campaign send` has been typed.
 */
export function startCampaign({ now = new Date(), tag = null } = {}) {
  if (!reactivationAgentEnabled()) return { ok: false, reason: 'disabled' };
  const list = segments(now, { tag });
  if (!list.length) return { ok: false, reason: 'empty' };

  const state = saveCampaignState({
    status: 'running',
    startedAt: now.toISOString(),
    sentAt: null,
    cursor: 0,
    sent: 0,
    skipped: 0,
    total: list.length,
    numbers: list.map((r) => ({ number: r.number, segment: r.segment, kind: r.kind || null })),
  });
  logEvent('campaign_started', null, { total: list.length });
  return { ok: true, campaign: state };
}

export function stopCampaign(reason = 'owner stopped it') {
  const state = campaignState();
  if (!state || state.status !== 'running') return { ok: false, reason: 'not_running' };
  saveCampaignState({ ...state, status: 'stopped', stoppedAt: new Date().toISOString(), reason });
  logEvent('campaign_stopped', null, { reason });
  return { ok: true, campaign: campaignState() };
}

export function campaignStatus() {
  const state = campaignState();
  if (!state) return null;
  return state;
}

/** Random gap between sends, so a burst never looks like a burst. */
export function nextGapMs(random = Math.random) {
  const { minGapMs, maxGapMs } = config.reactivation;
  const lo = Math.max(1000, Math.min(minGapMs, maxGapMs));
  const hi = Math.max(lo, maxGapMs);
  return Math.round(lo + random() * (hi - lo));
}

/**
 * One tick of the campaign: send at most `max` messages, then wait.
 * Returns what happened, so the tests (and the logs) can be precise.
 */
export async function runCampaignTick({ transport, now = new Date(), max = 1, force = false } = {}) {
  if (!reactivationAgentEnabled()) return { sent: 0, skipped: 0, done: true, reason: 'disabled' };
  const state = campaignState();
  if (!state || state.status !== 'running') return { sent: 0, skipped: 0, done: true, reason: 'not_running' };

  // The gap is between messages, not before every tick.
  if (!force && state.sentAt) {
    const elapsed = now.getTime() - new Date(state.sentAt).getTime();
    if (elapsed < (state.gapMs ?? nextGapMs())) {
      return { sent: 0, skipped: 0, done: false, reason: 'waiting', waitMs: (state.gapMs ?? 0) - elapsed };
    }
  }

  const results = [];
  let sent = 0;
  let skipped = 0;

  while (state.cursor < state.numbers.length && sent + skipped < max) {
    const row = state.numbers[state.cursor];
    state.cursor += 1;

    const contact = getContact(row.number) || {};
    const text = buildReactivation({ contact, segment: row.segment, kind: row.kind });
    const outcome = await sendProactively({
      transport,
      number: row.number,
      text,
      agent: 'reactivation',
      reason: `campaign · ${row.segment} · cycle ${reactivationHistory(row.number).length + 1}`,
      now,
    });

    if (outcome.sent) {
      logReactivation({
        number: row.number,
        segment: row.segment,
        cycle: reactivationHistory(row.number).length + 1,
        campaign: state.startedAt,
        at: now.toISOString(),
      });
      sent += 1;
    } else {
      // sendProactively already recorded why; logging twice would double-count.
      skipped += 1;
    }
    results.push({ number: row.number, sent: !!outcome.sent, reason: outcome.reason });
  }

  const done = state.cursor >= state.numbers.length;
  saveCampaignState({
    ...state,
    sent: (state.sent || 0) + sent,
    skipped: (state.skipped || 0) + skipped,
    sentAt: sent ? now.toISOString() : state.sentAt,
    gapMs: nextGapMs(),
    status: done ? 'finished' : 'running',
    finishedAt: done ? now.toISOString() : state.finishedAt,
  });

  if (done) logEvent('campaign_finished', null, { sent: state.sent + sent, skipped: state.skipped + skipped });
  return { sent, skipped, done, results, campaign: campaignState() };
}

export function startReactivationLoop({ transport, intervalMs = 5 * 60_000 } = {}) {
  if (!reactivationAgentEnabled()) return null;

  const tick = async () => {
    try {
      await runCampaignTick({ transport, max: 1 });
    } catch (err) {
      logEvent('campaign_error', null, err.message);
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  console.log('🔁 Reactivation: campaigns wait for .campaign send');
  return timer;
}

export default {
  reactivationAgentEnabled, pastCustomers, coldLeads, dateSegment, segments,
  offerLine, policyLine, buildReactivation, previewCampaign, previewText,
  startCampaign, stopCampaign, campaignStatus, runCampaignTick, nextGapMs,
  startReactivationLoop,
};
