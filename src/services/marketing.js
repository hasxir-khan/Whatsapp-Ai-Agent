// src/services/marketing.js
// Phase 6 Part 2 — the marketing team.
//
// Seven owner-facing helpers: a planner, a writer, an offer checker, a promo
// broadcaster, a review-reply drafter, a channel analyst and an ad writer.
//
// Three rules hold everywhere in this file:
//   1. Nothing is sent to a customer without the owner starting it, and every
//      proactive send goes through growth.js (opt-out, quiet hours, caps).
//   2. Every number in a draft comes from the config or from the database.
//      A number the bot cannot point at never reaches a customer.
//   3. The model is an optional extra. Without a key — or with the breaker open
//      or the budget spent — the deterministic draft is still usable.

import { profile, business, featureOn } from './profile.js';
import * as db from '../utils/db.js';
import { chat, hasLLM } from '../core/llm.js';
import { fenceUntrusted, detectInjection } from '../core/injection.js';
import {
  budgetAllows,
  noteAgentTokens,
  noteAgentFailure,
  noteAgentSuccess,
  breakerOpen,
} from './agents.js';
import { canSendProactively, sendProactively, isOptedOut, inQuietHours, quietWindow } from './growth.js';
import { sourceCounts } from './sourceLinks.js';

export const MARKETING_ROLES = ['planner', 'writer', 'offers', 'promo', 'reviews', 'channels', 'ads'];
export const MAX_EVENTS = 40;
export const MAX_AD_VARIANTS = 3;
export const PROMO_BATCH = 5;
export const PROMO_APPROVAL_MINUTES = 30;
export const DEFAULT_MIN_DAYS_BETWEEN_PROMOS = 14;

const str = (v) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());
const arr = (v) => (Array.isArray(v) ? v : []);

/** The flag that turns the marketing team on. Off by default. */
export function marketingEnabled() {
  return featureOn('marketingAgents');
}

export function marketingConfig() {
  const p = profile() || {};
  const m = p.marketing || business()?.marketing || {};
  return {
    approvalMode: m.approvalMode !== false,
    minDaysBetweenPromos: clampInt(m.minDaysBetweenPromos, DEFAULT_MIN_DAYS_BETWEEN_PROMOS, 1, 365),
    events: arr(m.events).slice(0, MAX_EVENTS),
    channels: arr(m.channels).map(str).filter(Boolean).slice(0, 20),
    batchSize: clampInt(m.batchSize, PROMO_BATCH, 1, 25),
    delayMs: clampInt(m.delayMs, 1500, 0, 10000),
    templateName: str(m.templateName),
    promoOffer: str(m.promoOffer),
  };
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// ── events calendar ──────────────────────────────────────────
//
// Fixed dates are fixed. Lunar dates are marked `verify` because they move
// with the moon, and this bot must never tell an owner that Eid is "certainly"
// on a given day.

const FIXED_EVENTS = [
  { name: 'New Year', month: 1, day: 1 },
  { name: "Valentine's Day", month: 2, day: 14 },
  { name: 'Pakistan Day', month: 3, day: 23 },
  { name: 'Labour Day', month: 5, day: 1 },
  { name: 'Independence Day', month: 8, day: 14 },
  { name: 'Defence Day', month: 9, day: 6 },
  { name: 'Christmas', month: 12, day: 25 },
];

// Approximate Gregorian dates. Always shown with "verify": a shop owner acting
// on a guessed Eid date is worse than one told to check the moon.
const LUNAR_EVENTS = {
  Ramadan: { 2026: '2026-02-18', 2027: '2027-02-08', 2028: '2028-01-28' },
  'Eid al-Fitr': { 2026: '2026-03-20', 2027: '2027-03-10', 2028: '2028-02-27' },
  'Eid al-Adha': { 2026: '2026-05-27', 2027: '2027-05-17', 2028: '2028-05-05' },
  'Ashura': { 2026: '2026-06-25', 2027: '2027-06-15', 2028: '2028-06-03' },
  'Eid Milad-un-Nabi': { 2026: '2026-08-26', 2027: '2027-08-15', 2028: '2028-08-04' },
};

const DAY = 24 * 3600 * 1000;
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function nthWeekday(year, month, weekday, nth) {
  // month is 1-based; weekday 0=Sunday.
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + offset + (nth - 1) * 7;
  return new Date(Date.UTC(year, month - 1, day));
}

function fixedDatesFor(year) {
  const out = FIXED_EVENTS.map((e) => ({ name: e.name, date: `${year}-${String(e.month).padStart(2, '0')}-${String(e.day).padStart(2, '0')}`, verify: false }));
  // Black Friday: the day after the fourth Thursday of November.
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  out.push({ name: 'Black Friday', date: new Date(thanksgiving.getTime() + DAY).toISOString().slice(0, 10), verify: false });
  out.push({ name: "Mother's Day", date: nthWeekday(year, 5, 0, 2).toISOString().slice(0, 10), verify: false });
  out.push({ name: "Father's Day", date: nthWeekday(year, 6, 0, 3).toISOString().slice(0, 10), verify: false });
  return out;
}

/**
 * Upcoming dates: the owner's own events (certain, they set them) plus the
 * regional list. Lunar entries carry `verify: true` and a note — never a claim.
 */
export function eventsCalendar({ now = new Date(), days = 120 } = {}) {
  const cfg = marketingConfig();
  const from = new Date(now.getTime() - DAY);
  const until = new Date(now.getTime() + days * DAY);
  const out = [];

  for (const e of cfg.events) {
    const date = str(e?.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const at = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(at.getTime()) || at < from) continue;
    out.push({
      name: str(e.name) || 'Your event',
      date,
      verify: false,
      owner: true,
      daysAway: Math.round((at - new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z')) / DAY),
      note: '',
    });
  }

  const years = new Set([now.getUTCFullYear(), now.getUTCFullYear() + 1]);
  for (const year of years) {
    for (const e of fixedDatesFor(year)) {
      const at = new Date(`${e.date}T00:00:00Z`);
      if (at < from || at > until) continue;
      out.push({ ...e, owner: false, daysAway: Math.round((at - new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z')) / DAY), note: '' });
    }
    for (const [name, table] of Object.entries(LUNAR_EVENTS)) {
      const date = table[year];
      if (!date) continue;
      const at = new Date(`${date}T00:00:00Z`);
      if (at < from || at > until) continue;
      out.push({
        name,
        date,
        verify: true,
        owner: false,
        daysAway: Math.round((at - new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z')) / DAY),
        note: 'lunar date — verify with the local moon sighting',
      });
    }
  }

  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** The next event worth planning around, or null. */
export function nextEvent({ now = new Date(), days = 120 } = {}) {
  const list = eventsCalendar({ now, days }).filter((e) => e.daysAway >= 0);
  return list[0] || null;
}

// ── the claims guard ─────────────────────────────────────────

const CLAIM_PATTERNS = [
  { re: /(?:\b(?:best|no\.? ?1|number one|world[- ]class|unbeatable|cheapest|top[- ]rated)\b|#\s?1\b)/i, why: 'unverifiable ranking claim' },
  { re: /\b(guaranteed|100%|risk[- ]free|miracle|cure[sd]?|instant results?|permanent results?)\b/i, why: 'a promise nobody can keep' },
  { re: /\b(only \d+ (?:left|seats?|items?)|today only|last chance|hurry|few (?:left|remaining)|limited (?:stock|time))\b/i, why: 'invented urgency or scarcity' },
  { re: /\b(testimonial|trusted by (?:thousands|hundreds|all)|customers say we)\b/i, why: 'a made-up testimonial' },
  { re: /\b(free|discount|voucher)\b.{0,30}\b(review|rating|5 stars?)\b/i, why: 'paying for reviews is against every platform rule' },
];

const MEDICAL_CLAIMS = /\b(cure[sd]?|treat(s|ed|ment)?|heal(s|ed)?|diagnos\w*|prescrib\w*|dosage|mg\b|medicine|medical advice|% success|results? guaranteed)\b/i;

/** Numbers the config actually contains — the only digits a draft may use. */
export function configNumbers() {
  const p = profile() || {};
  const texts = [];
  const walk = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'number') texts.push(String(value));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(p.catalog);
  walk(p.policies);
  walk(p.business);
  walk(p.marketing);
  const set = new Set();
  for (const text of texts) {
    for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) set.add(m[0].replace(/,/g, ''));
  }
  return set;
}

/**
 * Every marketing output passes through here before it is shown.
 * @returns {{ok:boolean, problems:string[]}}
 */
export function guard(text = '', { industry = industryOf() } = {}) {
  const body = str(text);
  const problems = [];
  if (!body) return { ok: false, problems: ['nothing to check'] };

  for (const { re, why } of CLAIM_PATTERNS) {
    const m = body.match(re);
    if (m) problems.push(`"${m[0]}" — ${why}`);
  }
  if (industry === 'clinic' || industry === 'health') {
    const m = body.match(MEDICAL_CLAIMS);
    if (m) problems.push(`"${m[0]}" — a health claim, which clinics may not make`);
  }
  const known = configNumbers();
  for (const m of body.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const n = m[0].replace(/,/g, '');
    if (/^(19|20)\d{2}$/.test(n)) continue; // a year is a date, not a claim
    if (n.replace(/\D/g, '').length < 3) continue; // list numbers and "3 days" are not claims
    if (!known.has(n)) problems.push(`"${n}" — not in the catalogue or policies`);
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

export function industryOf() {
  const b = business() || {};
  const p = profile() || {};
  const raw = `${p.industry || p.template || b.type || ''}`.toLowerCase();
  if (/clinic|hospital|doctor|dental|medical|health/.test(raw)) return 'clinic';
  if (/shop|store|retail/.test(raw)) return 'shop';
  if (/salon|spa|beauty/.test(raw)) return 'salon';
  if (/school|academy|institute/.test(raw)) return 'school';
  if (/restaurant|cafe|food/.test(raw)) return 'restaurant';
  if (/real.?estate|property/.test(raw)) return 'real-estate';
  if (/agency|studio|software/.test(raw)) return 'agency';
  return 'generic';
}

// ── the model, on a leash ────────────────────────────────────

async function ask({ role, system, prompt, maxTokens = 220 }) {
  if (!marketingEnabled() || !hasLLM() || breakerOpen('marketing')) return null;
  if (!budgetAllows('marketing')) return null;
  try {
    const res = await chat({
      system: `${system}\n\nRules: no invented numbers, no testimonials, no "best", no urgency, no medical claims. Write only what the facts support.`,
      messages: [{ role: 'user', content: prompt }],
      maxTokens,
      temperature: 0.6,
    });
    noteAgentSuccess('marketing');
    noteAgentTokens('marketing', Math.ceil(String(res?.text || '').length / 4) + Math.ceil(prompt.length / 4));
    const text = str(res?.text);
    if (!text) return null;
    const verdict = guard(text);
    if (!verdict.ok) return null; // a draft that breaks a rule is no draft
    return text;
  } catch {
    noteAgentFailure('marketing');
    return null;
  }
}

// ── facts the drafts are allowed to use ──────────────────────

function catalogItems(limit = 6) {
  const items = arr(profile()?.catalog?.items);
  return items
    .map((i) => ({ name: str(i.name), price: Number(i.price) || 0, kind: str(i.kind) || 'product', cost: Number(i.cost) || 0 }))
    .filter((i) => i.name)
    .slice(0, limit);
}

function offerList(limit = 6) {
  const b = business() || {};
  return [...arr(b.offers), ...arr(profile()?.offers)]
    .map((o) => (typeof o === 'string' ? o : str(o?.text || o?.title)))
    .map(str)
    .filter(Boolean)
    .slice(0, limit);
}

function businessName() {
  return str(business()?.name) || 'the business';
}

export function discountCap() {
  const p = profile() || {};
  const raw = p.policies?.maxDiscountPercent ?? p.marketing?.maxDiscountPercent ?? business()?.maxDiscountPercent;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Highest percentage the catalogue can afford, from real cost data. */
export function marginCeiling() {
  const items = catalogItems(20).filter((i) => i.price > 0 && i.cost > 0);
  if (!items.length) return null;
  const margins = items.map((i) => ((i.price - i.cost) / i.price) * 100);
  const lowest = Math.min(...margins);
  // Keep a third of the thinnest margin as headroom: a discount should not
  // make the cheapest item sell at cost.
  return Math.max(0, Math.floor(lowest * 0.66));
}

// ── 1. campaign planner ──────────────────────────────────────

export function planMonth({ now = new Date() } = {}) {
  const events = eventsCalendar({ now, days: 45 });
  const offers = offerList();
  const items = catalogItems(4);
  const channels = channelRanking({ now });
  const theme = events[0];
  const month = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;

  const lines = [`📅 *${month} plan — ${businessName()}*`, ''];

  if (theme) {
    lines.push(`*Theme:* ${theme.name} (${theme.date}${theme.verify ? ` — ⚠️ ${theme.note}` : ''})`);
  } else {
    lines.push(`*Theme:* your best sellers${offers.length ? ` and ${offers[0]}` : ''}`);
  }
  lines.push('');

  lines.push('*Dates*');
  if (events.length) {
    for (const e of events.slice(0, 4)) {
      lines.push(`  • ${e.date} — ${e.name}${e.verify ? ' (verify the date)' : ''}${e.daysAway >= 0 ? ` · in ${e.daysAway}d` : ''}`);
    }
  } else {
    lines.push('  • none configured — add your own in marketing.events');
  }
  lines.push('');

  lines.push('*Offers*');
  if (offers.length) {
    for (const o of offers.slice(0, 3)) lines.push(`  • ${o}`);
  } else {
    lines.push('  • none configured — nothing will be promoted until you add one');
  }
  lines.push('');

  lines.push('*Content*');
  const first = items[0];
  lines.push(`  • Week 1: ${first ? `${first.name} spotlight` : 'menu/brand post'}`);
  lines.push(`  • Week 2: ${theme ? `${theme.name} announcement` : 'behind the counter'}`);
  lines.push('  • Week 3: a customer question, answered (no names)');
  lines.push(`  • Week 4: ${offers[0] ? `the offer: ${offers[0]}` : 'a quiet week — one status, no selling'}`);
  lines.push('');

  lines.push('*Channels*');
  if (channels.best) {
    lines.push(`  • Double down on ${channels.best.label} (${channels.best.conversations} chats, ${channels.best.revenue} PKR)`);
    if (channels.next) lines.push(`  • Test ${channels.next.label} next — it is close behind`);
  } else {
    lines.push('  • No tracked links yet: print one QR (.qr) and put it where customers already look.');
  }

  const text = lines.join('\n');
  const verdict = guard(text);
  return {
    ok: true,
    month,
    theme: theme || null,
    events,
    offers,
    items,
    channels,
    text,
    warnings: verdict.problems,
  };
}

// ── 2. content writer ────────────────────────────────────────

/**
 * Ads, reel scripts, a Status series and a bilingual version — all from facts.
 * @param {{kind?:'ad'|'reel'|'status'|'bilingual', topic?:string, lang?:string, now?:Date}} opts
 */
export async function contentKit({ kind = 'ad', topic = '', lang = 'en', now = new Date() } = {}) {
  const items = catalogItems(3);
  const offers = offerList(3);
  const item = items.find((i) => topic && i.name.toLowerCase().includes(topic.toLowerCase())) || items[0] || null;
  const offer = offers[0] || '';
  const shop = businessName();
  const topicLine = str(topic) || item?.name || 'what we do';

  const deterministic = buildContent({ kind, shop, item, offer, topicLine, lang, now });
  // The topic can be anything the owner typed, so it is fenced, not trusted.
  const safeTopic = fenceUntrusted(topicLine);
  const model = await ask({
    role: 'writer',
    system: 'You write short WhatsApp marketing copy for a small business.',
    prompt: `Business: ${shop}. Product: ${item ? `${item.name} at ${item.price} PKR` : 'not specified'}. Offer: ${offer || 'none'}. Topic: ${safeTopic}. Write a ${kind} in ${lang === 'ur' ? 'Urdu script' : lang === 'roman-ur' ? 'Roman Urdu' : 'English'}. At most 60 words.`,
    maxTokens: 200,
  });

  const text = model || deterministic;
  const variant = { kind, text, source: model ? 'model' : 'template', warnings: [] };
  const verdict = guard(text);
  if (!verdict.ok && model) {
    variant.text = deterministic;
    variant.source = 'template';
    variant.warnings = verdict.problems;
  } else if (!verdict.ok) {
    variant.warnings = verdict.problems;
  }
  return variant;
}

function buildContent({ kind, shop, item, offer, topicLine, lang, now }) {
  const facts = item ? `${item.name}${item.price ? ` — ${item.price} PKR` : ''}` : topicLine;
  const bilingual = lang === 'roman-ur';

  if (kind === 'reel') {
    return [
      `🎬 *Reel script — ${topicLine}*`,
      '',
      '0–3s (hook): the thing they always ask about, on screen.',
      item ? `3–10s: show the ${item.name} being made or handed over.` : '3–10s: show the product in use.',
      `10–18s: say the name and the price: ${facts}.`,
      offer ? `18–24s: the offer, once: ${offer}.` : '18–24s: one reason to come today.',
      '24–30s: "Message us on WhatsApp" — on screen, not just spoken.',
      '',
      'Caption: ' + captionFor({ shop, facts, offer, bilingual }),
    ].join('\n');
  }

  if (kind === 'status') {
    return [
      `📱 *Status series — ${shop}*`,
      '',
      `1. ${item ? `${item.name}, fresh today.` : 'Open today.'}`,
      `2. ${offer || 'Ask us what is new — we answer in minutes.'}`,
      `3. ${item && item.price ? `${item.name} ${item.price} PKR.` : 'Message us and we will tell you the price.'} Reply here.`,
    ].join('\n');
  }

  if (kind === 'bilingual') {
    return [
      `*English*`,
      captionFor({ shop, facts, offer, bilingual: false }),
      '',
      `*Roman Urdu*`,
      captionFor({ shop, facts, offer, bilingual: true }),
    ].join('\n');
  }

  return [
    `✍️ *Ad copy — ${topicLine}*`,
    '',
    captionFor({ shop, facts, offer, bilingual }),
    '',
    `CTA: Message ${shop} on WhatsApp for today's price and availability.`,
  ].join('\n');
}

function captionFor({ shop, facts, offer, bilingual }) {
  if (bilingual) {
    return `${shop} se ${facts}${offer ? ` — ${offer}` : ''}. Order karne ke liye message karein, hum foran reply karte hain.`;
  }
  return `${shop}: ${facts}.${offer ? ` ${offer}.` : ''} Message us on WhatsApp and we will confirm availability.`;
}

// ── 3. offer builder ─────────────────────────────────────────

/**
 * Is this offer inside the owner's own rules?
 * @returns {{allowed:boolean, needsOwner:boolean, percent:number, cap:number, reasons:string[], text:string}}
 */
export function evaluateOffer({ idea = '', percent = null, now = new Date() } = {}) {
  const given = percent === null || percent === undefined || percent === '' ? null : Number(percent);
  const pct = given !== null && Number.isFinite(given) ? given : parsePercent(idea);
  const cap = discountCap();
  const ceiling = marginCeiling();
  const reasons = [];
  let verdict = 'owner';

  if (!idea && given === null) {
    return {
      allowed: false,
      needsOwner: false,
      percent: 0,
      cap,
      reasons: ['say what the offer is: .offer 10% off this weekend'],
      text: 'Usage: .offer <idea> — e.g. .offer 10% off Friday dinner',
    };
  }
  if (!cap) reasons.push('no policies.maxDiscountPercent configured — only the owner can set a discount');
  if (pct > 0 && cap && pct > cap) reasons.push(`${pct}% is above your ${cap}% ceiling`);
  if (pct > 0 && ceiling !== null && pct > ceiling) reasons.push(`${pct}% is above the ${ceiling}% your margins can carry`);
  if (pct <= 0) reasons.push('no percentage in the idea — an owner decides what it is worth');

  if (pct > 0 && cap && pct <= cap && (ceiling === null || pct <= ceiling)) {
    verdict = 'allowed';
    reasons.length = 0;
    reasons.push(`inside your ${cap}% ceiling${ceiling !== null ? ` and your ${ceiling}% margin` : ''}`);
  }

  const allowed = verdict === 'allowed';
  const lines = [
    allowed ? `✅ *Offer fits your rules* — ${pct}%` : `🟡 *Owner decision* — ${pct > 0 ? `${pct}%` : idea}`,
    '',
    ...reasons.map((r) => `• ${r}`),
  ];
  if (offerList().length) lines.push('', `Existing offers: ${offerList(2).join(' · ')}`);
  lines.push('', allowed ? 'Nothing is sent until you say so: .promo preview' : 'I will not use it in a promo until you approve it.');

  return { allowed, needsOwner: !allowed, percent: pct, cap, ceiling, reasons, text: lines.join('\n') };
}

function parsePercent(text) {
  const m = String(text || '').match(/(\d{1,2})\s*%/);
  return m ? Number(m[1]) : 0;
}

// ── 4. promo broadcaster ─────────────────────────────────────

export function promoSegments() {
  const m = marketingConfig();
  const rows = db.all('SELECT number, is_blocked FROM contacts');
  const opted = rows.filter((r) => isOptedOut(r.number)).length;
  const blocked = rows.filter((r) => r.is_blocked).length;
  const tags = db.all('SELECT tag, COUNT(*) AS n FROM contact_tags GROUP BY tag ORDER BY n DESC').map((r) => ({ tag: r.tag, count: Number(r.n) || 0 }));
  return {
    all: rows.length,
    reachable: Math.max(0, rows.length - opted - blocked),
    optedOut: opted,
    blocked,
    tags,
    minDays: m.minDaysBetweenPromos,
    approvalMode: m.approvalMode,
  };
}

function lastPromoAt(number) {
  const row = db.get(
    "SELECT MAX(created_at) AS at FROM growth_sends WHERE number = ? AND agent = 'promo' AND result = 'sent'",
    [number]
  );
  return row?.at ? Date.parse(row.at) : 0;
}

/**
 * Who would actually receive this, and who is held back — with the reason.
 */
export function audienceFor(segment = 'all', { now = new Date() } = {}) {
  const cfg = marketingConfig();
  const tag = String(segment || 'all').toLowerCase();
  let rows;
  if (tag === 'all') {
    rows = db.all('SELECT number, name, push_name, is_blocked, bot_paused_until FROM contacts');
  } else {
    rows = db.all(
      `SELECT c.number, c.name, c.push_name, c.is_blocked, c.bot_paused_until
         FROM contacts c
         JOIN contact_tags t ON t.number = c.number
        WHERE t.tag = ?`,
      [tag]
    );
  }

  const since = now.getTime() - cfg.minDaysBetweenPromos * DAY;
  const held = { opted_out: 0, blocked: 0, recent_promo: 0, paused: 0 };
  const sendable = [];

  for (const row of rows) {
    if (!row.number) continue;
    if (isOptedOut(row.number)) { held.opted_out += 1; continue; }
    if (row.is_blocked) { held.blocked += 1; continue; }
    if (row.bot_paused_until && Date.parse(row.bot_paused_until) > now.getTime()) { held.paused += 1; continue; }
    const last = lastPromoAt(row.number);
    if (last && last > since) { held.recent_promo += 1; continue; }
    sendable.push(row);
  }

  const samples = sendable.slice(0, 3).map((r) => ({
    label: r.name || r.push_name || maskNumber(r.number),
  }));

  return {
    ok: rows.length > 0,
    segment: tag,
    total: rows.length,
    count: sendable.length,
    sendable: sendable.map((r) => r.number),
    held,
    samples,
    quietNow: inQuietHours(now),
    minDays: cfg.minDaysBetweenPromos,
  };
}

function maskNumber(number) {
  const digits = String(number || '').replace(/\D/g, '');
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : '••••';
}

const PREVIEW_KEY = 'marketing_promo_preview';
const CAMPAIGN_KEY = 'marketing_promo_campaign';

export function promoState() {
  return {
    campaign: readJson(CAMPAIGN_KEY),
    preview: readPreview(),
    config: marketingConfig(),
  };
}

/**
 * The settings layer may hand back the object it stored or the JSON string it
 * was given (depending on how the row was written), so accept both.
 */
function readJson(key) {
  const raw = db.getSetting(key, null);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readPreview() {
  return readJson(PREVIEW_KEY);
}

/**
 * Show the owner exactly what would go out, to how many people, and who is
 * excluded — before anything is queued.
 */
export function promoPreview({ segment = 'all', message = '', now = new Date() } = {}) {
  const cfg = marketingConfig();
  const body = str(message) || cfg.promoOffer || offerList(1)[0] || '';
  if (!body) {
    return { ok: false, reason: 'empty_message', text: 'Give me the message first: .promo preview all "Friday: 10% off, message us"' };
  }
  // A message pasted into a command is untrusted text like any other: it is
  // checked for injection before it is treated as copy, and fenced for a model.
  const hostile = detectInjection(body);
  if (hostile?.found) {
    return {
      ok: false,
      reason: 'injection',
      text: ['🚫 *Not sending that*', '', `That reads like an instruction to me, not a message to a customer (${hostile.hits?.[0] || 'suspicious'}).`].join('\n'),
    };
  }
  fenceUntrusted(body);
  const verdict = guard(body);
  if (!verdict.ok) {
    return {
      ok: false,
      reason: 'guard',
      text: ['🚫 *Not sending that*', '', ...verdict.problems.map((p) => `• ${p}`), '', 'Fix the wording and preview again.'].join('\n'),
    };
  }
  const audience = audienceFor(segment, { now });
  const preview = { segment: audience.segment, message: body, count: audience.count, at: now.toISOString() };
  db.setSetting(PREVIEW_KEY, JSON.stringify(preview));

  const lines = [
    `👀 *Promo preview — ${audience.segment}*`,
    '',
    body,
    '',
    `Audience: ${audience.count} of ${audience.total} contacts`,
    `Held: ${audience.held.opted_out} opted out · ${audience.held.blocked} blocked · ${audience.held.recent_promo} had a promo in the last ${cfg.minDaysBetweenPromos} days`,
  ];
  if (audience.samples.length) lines.push(`Samples: ${audience.samples.map((s) => s.label).join(' · ')}`);
  if (audience.quietNow) lines.push('', `⏰ Quiet hours now (${quietLabel()}) — sends will wait.`);
  if (!cfg.approvalMode) lines.push('', '⚠️ approvalMode is off — I will send as soon as you say .promo send.');
  lines.push('', audience.count ? 'Nothing has been sent. Say .promo send to start.' : 'Nobody is eligible right now — nothing to send.');

  return { ok: true, preview, audience, text: lines.join('\n') };
}

function quietLabel() {
  const w = quietWindow();
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${fmt(w.start)}–${fmt(w.end)} ${w.timeZone}`;
}

/** Start a promo. Requires a fresh preview: that is the owner's approval. */
export function promoStart({ now = new Date() } = {}) {
  const cfg = marketingConfig();
  if (!cfg.approvalMode) {
    return { ok: false, reason: 'approval_off', text: '🟡 Promo sending needs approvalMode on. Turn it on, preview, then send.' };
  }
  const preview = readPreview();
  if (!preview) return { ok: false, reason: 'no_preview', text: 'Preview first: .promo preview all "your message"' };

  const ageMinutes = (now.getTime() - Date.parse(preview.at || 0)) / 60000;
  if (!(ageMinutes <= PROMO_APPROVAL_MINUTES)) {
    return { ok: false, reason: 'stale_preview', text: 'That preview is old. Run .promo preview again so you are approving today\'s list.' };
  }

  const audience = audienceFor(preview.segment, { now });
  const campaign = {
    status: 'running',
    segment: preview.segment,
    message: preview.message,
    queue: audience.sendable,
    cursor: 0,
    sent: 0,
    held: 0,
    startedAt: now.toISOString(),
  };
  db.setSetting(CAMPAIGN_KEY, JSON.stringify(campaign));
  db.logEvent('marketing_promo_start', null, { segment: campaign.segment, count: campaign.queue.length });
  return {
    ok: true,
    campaign,
    text: `📣 Promo started for ${campaign.queue.length} contacts${audience.quietNow ? ' — held until quiet hours end' : ''}.\nSent slowly, ${cfg.batchSize} at a time. .promo stop halts it.`,
  };
}

/**
 * Send one slow batch. Every message goes through growth.sendProactively, so
 * opt-out, quiet hours, the per-contact cap and the Cloud template rule all
 * apply exactly as they do everywhere else.
 */
export async function promoSendBatch({ transport = null, now = new Date(), delayMs = null } = {}) {
  const campaign = promoState().campaign;
  if (!campaign || campaign.status !== 'running') {
    return { ok: false, reason: 'not_running', sent: 0, text: 'No promo is running.' };
  }
  const cfg = marketingConfig();
  const pause = delayMs === null ? cfg.delayMs : delayMs;
  const batch = campaign.queue.slice(campaign.cursor, campaign.cursor + cfg.batchSize);
  let sent = 0;
  let held = 0;
  const failures = [];

  for (const number of batch) {
    const check = canSendProactively(number, { now, agent: 'promo' });
    if (!check.ok) {
      held += 1;
      failures.push(`${maskNumber(number)}: ${check.reason}`);
      campaign.cursor += 1;
      continue;
    }
    const outcome = transport
      ? await sendProactively({ transport, number, text: campaign.message, agent: 'promo', reason: `promo:${campaign.segment}`, now })
      : { sent: false, reason: 'no_transport' };
    if (outcome.sent) sent += 1;
    else {
      held += 1;
      failures.push(`${maskNumber(number)}: ${outcome.reason || 'not sent'}`);
    }
    campaign.cursor += 1;
    if (pause > 0 && transport) await new Promise((r) => setTimeout(r, pause));
  }

  campaign.sent += sent;
  campaign.held += held;
  if (campaign.cursor >= campaign.queue.length) campaign.status = 'done';
  db.setSetting(CAMPAIGN_KEY, JSON.stringify(campaign));

  const remaining = Math.max(0, campaign.queue.length - campaign.cursor);
  const lines = [
    sent ? `📤 Sent ${sent}${held ? `, held ${held}` : ''}.` : `📤 Nothing sent this round${held ? ` (${held} held)` : ''}.`,
    `Progress: ${campaign.cursor}/${campaign.queue.length}${campaign.status === 'done' ? ' — finished' : ` · ${remaining} left`}`,
  ];
  for (const f of failures.slice(0, 3)) lines.push(`  • ${f}`);

  return { ok: true, sent, held, remaining, done: campaign.status === 'done', text: lines.join('\n') };
}

export function promoStop() {
  const campaign = promoState().campaign;
  if (!campaign) return { ok: false, text: 'No promo is running.' };
  campaign.status = 'stopped';
  db.setSetting(CAMPAIGN_KEY, JSON.stringify(campaign));
  db.logEvent('marketing_promo_stop', null, { sent: campaign.sent, cursor: campaign.cursor });
  return { ok: true, text: `⏹ Promo stopped after ${campaign.sent} message${campaign.sent === 1 ? '' : 's'}.` };
}

// ── 5. reputation ────────────────────────────────────────────

/**
 * A draft reply to a review the owner pasted. Tone follows the stars; nothing
 * is ever offered in exchange for a rating.
 */
export function reviewReply({ stars = 5, text = '', lang = 'en' } = {}) {
  const n = Math.max(1, Math.min(5, Math.round(Number(stars) || 0) || 5));
  const shop = businessName();
  const owner = str(profile()?.owner?.name) || 'the owner';
  const contact = str(business()?.emergency?.number || profile()?.escalation?.number || '');
  const quoted = str(text).slice(0, 80);

  const drafts = {
    5: [
      `Thank you so much — this made our day at ${shop}. We will pass it on to the team.`,
      'If anything could have been better, tell us here; it genuinely helps.',
    ],
    4: [
      `Thank you for taking the time to write this, and for choosing ${shop}.`,
      'We would love to know what would have made it a five — a line here is enough.',
    ],
    3: [
      `Thank you for the honest feedback, and sorry it was not quite what you expected.`,
      `We would like to understand what happened. Please message us${contact ? ` on ${contact}` : ''} and ${owner} will look into it personally.`,
    ],
    2: [
      `We are sorry — this is not the experience we want anyone to have at ${shop}.`,
      `Please contact us${contact ? ` on ${contact}` : ''} so ${owner} can put it right. We would rather hear it than lose your trust.`,
    ],
    1: [
      `We are genuinely sorry. What you describe is not how we want to work, and we are taking it seriously.`,
      `Please message us${contact ? ` on ${contact}` : ''} — ${owner} will read it personally and respond.`,
    ],
  };

  const lines = [`⭐ *Draft reply — ${n} star${n === 1 ? '' : 's'}*`, ''];
  if (quoted) lines.push(`Review: "${quoted}${str(text).length > 80 ? '…' : ''}"`, '');
  lines.push(...drafts[n]);
  lines.push('', 'Nothing published anywhere — copy it when you are happy with it.');
  if (n <= 3) lines.push('No discount or freebie is offered in exchange for a review.');
  void lang;

  const body = lines.join('\n');
  return { ok: true, stars: n, text: body, draft: drafts[n].join(' ') };
}

// ── 6. channel analyst ───────────────────────────────────────

/**
 * Rank the places customers come from. The arithmetic is here; the model is
 * never asked to count.
 */
export function channelRanking({ now = new Date() } = {}) {
  const rows = sourceCounts({ now }).map((r) => ({
    source: r.source,
    label: r.label,
    code: r.code,
    conversations: r.conversations,
    orders: r.orders,
    revenue: r.revenue,
    perChat: r.conversations ? Math.round(r.revenue / r.conversations) : 0,
    stale: r.stale,
  }));
  return rankChannels(rows, now);
}

function rankChannels(rows, now) {
  const ranked = [...rows].sort((a, b) => b.revenue - a.revenue || b.orders - a.orders || b.conversations - a.conversations);
  const totalRevenue = ranked.reduce((n, r) => n + r.revenue, 0);
  const totalChats = ranked.reduce((n, r) => n + r.conversations, 0);

  const lines = ['📡 *Where your customers come from*', ''];
  if (!ranked.length) {
    lines.push('No tracked links yet.');
    lines.push('Print one with .qr and put it where people already look — the counter, the bag, the poster.');
  } else {
    for (const r of ranked.slice(0, 6)) {
      const share = totalRevenue ? Math.round((r.revenue / totalRevenue) * 100) : 0;
      lines.push(`  • ${r.label}: ${r.conversations} chats · ${r.orders} paid · ${r.revenue} PKR${totalRevenue ? ` (${share}%)` : ''}`);
    }
    lines.push('');
    const best = ranked[0];
    if (best.orders > 0) {
      lines.push(`*Put the next poster/QR behind ${best.label}* — it already pays ${best.perChat} PKR per chat.`);
    } else {
      lines.push(`*Nothing has paid yet.* ${ranked[0].label} brings the most chats — ask those customers what they came for.`);
    }
  }
  if (now) lines.push('', 'Counted from tracked links, orders and messages. No estimate, no rounding up.');

  return {
    ok: true,
    totalRevenue,
    totalChats,
    rows: ranked,
    best: ranked[0] || null,
    next: ranked[1] || null,
    text: lines.join('\n'),
  };
}

// ── 7. ad writer ─────────────────────────────────────────────

export async function adCopy({ topic = '', now = new Date(), link = null } = {}) {
  const items = catalogItems(3);
  const offers = offerList(2);
  const item = items.find((i) => topic && i.name.toLowerCase().includes(topic.toLowerCase())) || items[0] || null;
  const offer = offers[0] || '';
  const shop = businessName();
  const tracked = link || (offerList().length ? '' : '');

  const base = buildContent({ kind: 'ad', shop, item, offer, topicLine: str(topic) || item?.name || 'our menu', lang: 'en', now });
  const variants = [
    `*A — direct*\n${captionFor({ shop, facts: item ? `${item.name}${item.price ? ` — ${item.price} PKR` : ''}` : str(topic) || 'our best sellers', offer, bilingual: false })}`,
    `*B — question*\n${item ? `Craving ${item.name.toLowerCase()}?` : 'Looking for something good today?'} ${shop} has it${item?.price ? ` at ${item.price} PKR` : ''}.${offer ? ` ${offer}.` : ''} Message us.`,
    `*C — Roman Urdu*\n${captionFor({ shop, facts: item ? `${item.name}${item.price ? ` — ${item.price} PKR` : ''}` : str(topic) || 'hamari services', offer, bilingual: true })}`,
  ].slice(0, MAX_AD_VARIANTS);

  const audience = [
    'Audience outline (you choose in Ads Manager):',
    `  • Location: ${str(business()?.city) || 'your city'} + 10 km`,
    `  • Age: 22–45${industryOf() === 'school' ? ' — parents' : ''}`,
    '  • Interests: the category, not a competitor\'s name',
    '  • Budget: start small, one week, one variant',
  ];

  const prefill = `Salam! I saw your ad${item ? ` about ${item.name}` : ''}. Is it available?`;
  const linkLine = tracked ? `Tracked link: ${tracked}` : 'Tracked link: create one with .link <name> first, then paste it here.';

  const text = [
    `📢 *Ad copy — ${item?.name || str(topic) || shop}*`,
    '',
    ...variants,
    '',
    ...audience,
    '',
    `Prefilled opening message: "${prefill}"`,
    linkLine,
  ].join('\n');

  const verdict = guard(text);
  const assembled = verdict.ok
    ? text
    : text + '\n\n⚠️ Check before using:\n' + verdict.problems.map((p) => `• ${p}`).join('\n');

  return { ok: true, variants, prefill, link: tracked, text: assembled, warnings: verdict.problems };
}

// ── the weekly brief ─────────────────────────────────────────

/**
 * A short section for the analyst's weekly report. Returns null when the
 * marketing team is off, so the report is unchanged for everyone else.
 */
export function marketingBrief({ now = new Date() } = {}) {
  if (!marketingEnabled()) return null;
  const cfg = marketingConfig();
  const event = nextEvent({ now, days: 60 });
  const channels = channelRanking({ now });
  const offers = offerList(1);
  const state = promoState().campaign;
  const audience = promoSegments();

  const lines = ['📣 *Marketing*'];
  lines.push(
    event
      ? `• Next: ${event.name} on ${event.date}${event.verify ? ' (verify the date)' : ''}${event.daysAway >= 0 ? ` — ${event.daysAway} days` : ''}`
      : '• No dates configured — add one in marketing.events'
  );
  lines.push(
    channels.best
      ? `• Best channel: ${channels.best.label} — ${channels.best.conversations} chats, ${channels.best.orders} paid, ${channels.best.revenue} PKR`
      : '• No tracked links yet — one QR is the cheapest next step'
  );
  lines.push(offers.length ? `• Offer on file: ${offers[0]}` : '• No offers configured — nothing to promote');
  lines.push(
    state
      ? `• Promo: ${state.status} — ${state.cursor}/${state.queue.length}`
      : `• Reachable contacts: ${audience.reachable} (${audience.optedOut} opted out, ${audience.blocked} blocked)`
  );
  if (!cfg.approvalMode) lines.push('• ⚠️ approvalMode is off — promos send without a second look');

  return { text: lines.join('\n'), event, channels, offers, state };
}

// ── the menu ─────────────────────────────────────────────────

export function marketingMenu({ now = new Date() } = {}) {
  const on = marketingEnabled();
  const cfg = marketingConfig();
  const lines = [
    '🧠 *Marketing team*',
    '',
    on ? 'Status: on' : 'Status: off — turn it on with .marketing on',
    '',
    '.plan — this month: theme, dates, offers, channels',
    '.content now ["ad|reel|status|bilingual"] [topic] — copy you can paste',
    '.offer <idea> — check a discount against your own rules',
    '.promo preview <tag|all> "message" — who gets it, who is held back',
    '.promo send / .promo stop — send slowly, through the same gates as everything else',
    '.reply-review 4 "what they wrote" — a draft in the right tone',
    '.channels — chats, orders and revenue per source',
    '.adcopy [topic] — click-to-WhatsApp variants and a prefilled message',
    '',
    `Approval mode: ${cfg.approvalMode ? 'on (you approve every promo)' : 'OFF'}`,
    `One promo per contact every ${cfg.minDaysBetweenPromos} days.`,
  ];
  if (!on) lines.push('', 'Nothing here sends anything until you turn it on and run .promo send.');
  void now;
  return lines.join('\n');
}

export default {
  marketingEnabled,
  marketingConfig,
  eventsCalendar,
  nextEvent,
  guard,
  industryOf,
  configNumbers,
  planMonth,
  contentKit,
  evaluateOffer,
  promoSegments,
  audienceFor,
  promoPreview,
  promoStart,
  promoSendBatch,
  promoStop,
  promoState,
  reviewReply,
  channelRanking,
  adCopy,
  marketingBrief,
  marketingMenu,
  discountCap,
  marginCeiling,
};
