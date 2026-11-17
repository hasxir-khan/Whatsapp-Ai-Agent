// src/services/contentAgent.js
// The content agent (features.contentAgent) — owner-facing, once a week.
//
// A small business does not need a content strategy. It needs five captions it
// can post, three statuses it can put up, and one reel idea it could actually
// film this week. So that is exactly what this produces, and nothing else.
//
// The honesty rules, enforced in code:
//   • every product, price and offer named comes from config/catalog
//   • questions come from the analyst's real unanswered list, sanitised first
//   • no testimonials, no customer names, no invented numbers, no fake reviews
//   • hashtags and posting times are derived from business.type and business.city

import { config } from '../config/env.js';
import { business, featureOn, effectiveCatalog, offers as offerList, policies, faqList, contentSchedule } from './profile.js';
import { sendToOwner } from './growth.js';
import { partsInTz } from './hours.js';
import { formatMoney } from './geo.js';
import { all, getSetting, setSetting, logEvent } from '../utils/db.js';
import { chat, hasLLM } from '../core/llm.js';
import { neutralise } from '../core/injection.js';

const DAY_MS = 86_400_000;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function contentAgentEnabled() {
  return featureOn('contentAgent');
}

// ── facts the pack is allowed to use ───────────────────────
/** Catalogue items with real prices, most-expensive first (the hero product). */
export function catalogFacts(limit = 5) {
  return effectiveCatalog()
    .filter((i) => (i.price ?? i.min) > 0)
    .slice(0, limit)
    .map((i) => ({
      name: String(i.name || '').trim(),
      price: Number(i.price ?? i.min),
      priceText: formatMoney(Number(i.price ?? i.min), business().currency || 'PKR'),
      kind: i.kind || 'product',
    }));
}

/** Owner-defined offers only. Never generated. */
export function offerFacts(limit = 3) {
  return offerList()
    .slice(0, limit)
    .map((o) => (typeof o === 'string' ? o : o.text || o.offer || o.title || String(o)))
    .filter(Boolean);
}

/**
 * The questions customers actually asked and we could not answer, from the
 * analyst's `rag_miss` events. Customer text, so it is neutralised before it
 * can reach a model — and it is capped in length and count.
 */
export function questionFacts(sinceDays = 30, limit = 5) {
  const since = new Date(Date.now() - sinceDays * DAY_MS).toISOString();
  const rows = all(
    `SELECT detail, COUNT(*) AS count FROM events
      WHERE type = 'rag_miss' AND created_at >= ? AND detail IS NOT NULL
      GROUP BY detail ORDER BY count DESC LIMIT ?`,
    [since, limit]
  );
  return rows.map((r) => neutralise(String(r.detail)).slice(0, 100)).filter(Boolean);
}

/** Hashtags from the business type, city and catalogue — not a random pile. */
export function hashtags() {
  const b = business();
  const type = String(b.type || '').toLowerCase();
  const city = String(b.city || '').replace(/[^A-Za-z\s]/g, '').trim();
  const name = String(b.name || '').replace(/[^A-Za-z0-9\s]/g, '').trim();

  const tags = new Set();
  if (name) tags.add(`#${name.replace(/\s+/g, '')}`);
  if (city) {
    tags.add(`#${city.replace(/\s+/g, '')}`);
    if (type) tags.add(`#${city.replace(/\s+/g, '')}${type.replace(/\s+/g, '')}`);
  }
  for (const item of catalogFacts(3)) tags.add(`#${item.name.replace(/[^A-Za-z0-9]/g, '')}`);
  const typeTag = type.includes('restaurant') || type.includes('cafe') || type.includes('food') ? ['#foodie', '#eatlocal'] : [];
  for (const t of typeTag) tags.add(t);
  tags.add('#smallbusiness');
  return [...tags].filter((t) => t.length > 1).slice(0, 10);
}

/**
 * Posting times that fit the business type: a restaurant's audience eats at
 * lunch and dinner, a clinic's checks its phone in the morning.
 */
export function postingTimes() {
  const type = String(business().type || '').toLowerCase();
  if (/restaurant|cafe|food|bakery/.test(type)) return ['12:30', '19:30', '21:00'];
  if (/salon|spa|beauty/.test(type)) return ['10:00', '17:00', '20:00'];
  if (/clinic|doctor|dentist|health/.test(type)) return ['09:30', '13:00', '18:00'];
  return ['10:00', '14:00', '20:00'];
}

// ── the pack ───────────────────────────────────────────────
/** The language the owner actually writes in. */
export function defaultLang() {
  const first = String(business().languages?.[0] || 'en').toLowerCase();
  if (first.startsWith('ur') || first === 'ur') return 'ur';
  if (first.startsWith('roman')) return 'roman-ur';
  return 'en';
}

/** Deterministic pack, used when there is no model and as the fallback. */
export function fallbackPack({ items = catalogFacts(), offers = offerFacts(), questions = questionFacts(), lang = null } = {}) {
  const code = lang || defaultLang();
  const name = business().name || 'us';
  const hero = items[0];
  const second = items[1];
  const city = business().city || '';
  const offer = offers[0];

  const caption = (i) => {
    if (code === 'ur') {
      return i
        ? [`${i.name} — ${i.priceText}، آج ہی آرڈر کریں۔`, `${i.name} اب دستیاب ہے — ${i.priceText}.`][0]
        : `${name} — آج کیا پسند کریں گے؟`;
    }
    if (code === 'roman-ur') {
      return i ? `${i.name} sirf ${i.priceText} — aaj try karein!` : `${name} — aaj kya pasand karenge?`;
    }
    return i ? `${i.name}, freshly made — ${i.priceText}.` : `Fresh today at ${name}.`;
  };

  const captions = [];
  if (hero) captions.push(caption(hero));
  if (second) captions.push(caption(second));
  if (offer) captions.push(code === 'ur' ? `${offer} — یہ آفر اس ہفتے دستیاب ہے۔` : `${offer} — available this week.`);
  if (questions[0]) {
    captions.push(
      code === 'ur'
        ? `آپ نے پوچھا: ${questions[0]} — جواب ہمارے پاس ہے، میسج کریں۔`
        : `You asked: "${questions[0]}" — message us and we'll answer it properly.`
    );
  }
  captions.push(
    code === 'ur'
      ? `${city || name} میں ${hero ? hero.name : 'ہماری چیزیں'} — آج آرڈر کریں۔`
      : `${hero ? hero.name : 'Fresh food'} in ${city || 'town'}, made today.`
  );

  const statuses = [
    hero ? `${hero.name} — ${hero.priceText}` : `${name} is open`,
    offer || (code === 'ur' ? 'آج کیا پسند ہے؟' : 'What are you having today?'),
    code === 'ur' ? 'ابھی میسج کریں — فوری جواب۔' : 'Message us — we reply fast.',
  ];

  const reel = hero
    ? `30-second reel: hands plating one ${hero.name}, one line on screen — "${hero.priceText}". No talking, no music trend, just the food and the price.`
    : `30-second reel: 3 quick cuts of the shop in the morning, one line on screen — "open today".`;

  return {
    captions: captions.filter(Boolean).slice(0, 5),
    statuses: statuses.filter(Boolean).slice(0, 3),
    reel,
    hashtags: hashtags(),
    times: postingTimes(),
    generated: false,
  };
}

/** Ask the model, with every fact supplied and every invention forbidden. */
export async function modelPack({ items, offers, questions, lang }) {
  const facts = [
    `business: ${business().name || 'the business'} (${business().type || 'shop'}), ${business().city || 'unknown city'}`,
    `language for the copy: ${lang}`,
    `products: ${items.map((i) => `${i.name} @ ${i.priceText}`).join('; ') || 'none'}`,
    offers.length ? `offers (exact words from the owner): ${offers.join('; ')}` : 'offers: none',
    questions.length ? `real customer questions: ${questions.join(' | ')}` : 'customer questions: none',
    policies.delivery ? `delivery policy: ${policies().delivery}` : '',
  ].filter(Boolean);

  const out = await chat({
    system:
      'You write social media copy for one small business. Use ONLY the facts given. ' +
      'Never invent a price, a discount, a testimonial, a customer name, a review or a statistic. ' +
      'If a fact is missing, write around it. Return strict JSON: ' +
      '{"captions":[5 short post captions],"statuses":[3 lines],"reel":"one reel idea in 2 sentences"}. ' +
      'Captions must be under 30 words each and in the requested language.',
    messages: [{ role: 'user', content: facts.join('\n') }],
    temperature: 0.7,
    maxTokens: 700,
    json: true,
  });

  const parsed = typeof out === 'object' && out?.json ? out.json : null;
  const data = parsed || safeJson(out?.text);
  if (!data) return null;

  const captions = (data.captions || []).map((c) => neutralise(String(c)).slice(0, 220)).filter(Boolean).slice(0, 5);
  const statuses = (data.statuses || []).map((c) => neutralise(String(c)).slice(0, 140)).filter(Boolean).slice(0, 3);
  const reel = data.reel ? neutralise(String(data.reel)).slice(0, 300) : null;
  if (captions.length < 3 || !reel) return null;

  return { captions, statuses, reel, generated: true };
}

function safeJson(text) {
  if (!text) return null;
  const m = /\{[\s\S]*\}/.exec(String(text));
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** The full weekly pack. Never throws: a broken model falls back to copy that is true. */
export async function buildPack({ lang = null, now = new Date() } = {}) {
  const items = catalogFacts();
  const offers = offerFacts();
  const questions = questionFacts();
  const code = lang || defaultLang();

  let pack = null;
  if (hasLLM()) {
    try {
      pack = await modelPack({ items, offers, questions, lang: code });
    } catch (err) {
      logEvent('content_llm_failed', null, err.message);
      pack = null;
    }
  }

  const final = pack || fallbackPack({ items, offers, questions, lang: code });
  return {
    ...final,
    hashtags: hashtags(),
    times: postingTimes(),
    basedOn: { items: items.length, offers: offers.length, questions: questions.length },
    now,
  };
}

/** WhatsApp-friendly text for the pack. */
export function formatPack(pack) {
  const lines = [];
  lines.push('📝 *Content pack*');
  lines.push('');
  lines.push('*5 posts*');
  pack.captions.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  lines.push('');
  lines.push('*3 statuses*');
  pack.statuses.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push('');
  lines.push(`*Reel*: ${pack.reel}`);
  lines.push('');
  lines.push(`Hashtags: ${pack.hashtags.join(' ')}`);
  lines.push(`Best times: ${pack.times.join(', ')}`);
  if (!pack.generated) {
    lines.push('');
    lines.push('_Written from your catalogue and offers. Add an AI key for more varied copy — the facts stay the same either way._');
  }
  return lines.join('\n');
}

export async function contentPackText({ now = new Date(), lang = null } = {}) {
  const pack = await buildPack({ lang, now });
  return formatPack(pack);
}

// ── weekly delivery ────────────────────────────────────────
function parseClock(spec = '10:00') {
  const m = /^(\d{1,2}):?(\d{2})?$/.exec(String(spec).trim());
  if (!m) return 10 * 60;
  return Number(m[1]) * 60 + Number(m[2] || 0);
}

export function dueNow(now = new Date()) {
  const { day, time } = contentSchedule();
  const tz = business().timezone || config.timezone || 'UTC';
  const p = partsInTz(now, tz);
  if (DAY_NAMES[p.weekday] !== day) return false;
  return p.hour * 60 + p.minute >= parseClock(time);
}

export function alreadySentThisWeek(now = new Date()) {
  const last = getSetting('content_last_pack', null);
  if (!last) return false;
  const at = new Date(last);
  if (Number.isNaN(at.getTime())) return false;
  return now.getTime() - at.getTime() < 6 * DAY_MS;
}

export async function runWeeklyContent({ transport, now = new Date(), force = false } = {}) {
  if (!contentAgentEnabled()) return { sent: false, reason: 'disabled' };
  if (!force && !dueNow(now)) return { sent: false, reason: 'not_due' };
  if (!force && alreadySentThisWeek(now)) return { sent: false, reason: 'already_sent' };

  const pack = await buildPack({ now });
  const outcome = await sendToOwner({ transport, text: formatPack(pack), agent: 'content', reason: 'weekly content pack', now });
  if (outcome.sent) {
    setSetting('content_last_pack', now.toISOString());
    logEvent('content_pack_sent', null, { generated: pack.generated });
  }
  return { ...outcome, pack };
}

export function startContentLoop({ transport, intervalMs = 60 * 60_000 } = {}) {
  if (!contentAgentEnabled()) return null;
  const tick = async () => {
    try {
      await runWeeklyContent({ transport });
    } catch (err) {
      logEvent('content_error', null, err.message);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 60_000).unref?.();
  console.log(`🗓  Content: weekly pack on ${contentSchedule().day} at ${contentSchedule().time}`);
  return timer;
}

export default {
  contentAgentEnabled, catalogFacts, offerFacts, questionFacts, hashtags, postingTimes,
  defaultLang, fallbackPack, buildPack, formatPack, contentPackText, dueNow, alreadySentThisWeek,
  runWeeklyContent, startContentLoop,
};
