// src/core/pricing.js
// Deterministic quoting. The AI never invents a number: it collects the
// project facts, this module turns them into a price range (from the owner's
// config), and the AI only phrases the result. That keeps quotes consistent
// and stops the bot from promising something the owner never agreed to.

import { config } from '../config/env.js';
import { priceFor, lookupNumber, formatMoney } from '../services/geo.js';
import { effectiveServices, effectiveAddons, maxDiscountPercent } from '../services/profile.js';

// Resolved per call, not at import: the owner can add a service from WhatsApp
// and the next quote must see it. With no catalog configured this returns
// exactly owner.services / owner.addons, so behaviour is unchanged.
const SERVICES = () => {
  const list = effectiveServices();
  return Array.isArray(list) ? list : [];
};
const ADDONS = () => {
  const list = effectiveAddons();
  return Array.isArray(list) ? list : [];
};
const MAX_DISCOUNT = () => maxDiscountPercent();

const slug = (s) => String(s || '').toLowerCase();

function blobOf(fields = {}) {
  return [
    fields.projectType, fields.goal, fields.features, fields.design,
    fields.content, fields.tech, fields.extra, fields.budget, fields.timeline,
  ]
    .filter(Boolean)
    .map((v) => (Array.isArray(v) ? v.join(' ') : String(v)))
    .join(' ')
    .toLowerCase();
}

function keywordScore(blob, keywords = []) {
  let score = 0;
  for (const kw of keywords) {
    const k = slug(kw);
    if (!k) continue;
    if (blob.includes(k)) score += k.includes(' ') ? 3 : 2;
  }
  return score;
}

function pickService(blob) {
  let best = null;
  let bestScore = 0;
  for (const service of SERVICES()) {
    const score = keywordScore(blob, service.keywords || []);
    if (score > bestScore) {
      best = service;
      bestScore = score;
    }
  }
  if (best) return { service: best, score: bestScore, guessed: false };

  // Sensible default when the client hasn't said enough yet
  const fallbackId = /mobile|android|ios|app store|play store/.test(blob)
    ? 'mobile'
    : /\bai\b|bot|automation|gpt|chatbot/.test(blob)
      ? 'ai_bot'
      : /\becommerce|shop|store|product/.test(blob)
        ? 'ecommerce'
        : 'business_site';
  const list = SERVICES();
  const fallback = list.find((s) => s.id === fallbackId) || list[0];
  return { service: fallback, score: 0, guessed: true };
}

function pickAddons(blob) {
  const picked = [];
  for (const addon of ADDONS()) {
    const score = keywordScore(blob, addon.keywords || []);
    if (score > 0) picked.push({ ...addon, score });
  }
  // De-dupe by id, keep strongest matches
  const seen = new Set();
  return picked
    .sort((a, b) => b.score - a.score)
    .filter((a) => (seen.has(a.id) ? false : seen.add(a.id)));
}

function featureCount(fields) {
  const f = fields.features;
  if (Array.isArray(f)) return f.length;
  if (typeof f === 'string') {
    return f.split(/[,;\n•·]|\band\b/i).map((s) => s.trim()).filter((s) => s.length > 2).length;
  }
  return 0;
}

export function complexityOf(fields, addons) {
  const features = featureCount(fields);
  let score = addons.length;
  if (features >= 4) score += 1;
  if (features >= 8) score += 2;
  if (features >= 12) score += 3;
  if (/multi[- ]?language|multilingual|arabic|urdu/i.test(blobOf(fields))) score += 1;
  if (/integration|api|third[- ]party|stripe|shopify|crm|erp/i.test(blobOf(fields))) score += 1;
  if (score <= 2) return { level: 'simple', multiplier: 1 };
  if (score <= 5) return { level: 'medium', multiplier: 1.12 };
  if (score <= 8) return { level: 'complex', multiplier: 1.28 };
  return { level: 'enterprise', multiplier: 1.45 };
}

export function recommendStack(serviceId, fields) {
  const tech = slug(fields.tech);
  const api = /python|django|flask/.test(tech) ? 'Django/FastAPI' : 'Node.js + Express';
  const table = {
    landing: ['Next.js + Tailwind', 'Vercel hosting', 'Formspree/Resend for the contact form'],
    business_site: ['Next.js + Tailwind', 'Headless CMS (Sanity or Notion)', 'Vercel + Cloudflare'],
    ecommerce: ['Next.js (or Shopify if you prefer)', `${api}`, 'PostgreSQL', 'Stripe / JazzCash / Easypaisa'],
    webapp: ['React + Tailwind', api, 'PostgreSQL', 'Docker + Railway/VPS'],
    mobile: ['Flutter or React Native', api, 'PostgreSQL / Firebase', 'Play Store + App Store builds'],
    ai_bot: ['Node.js worker', 'Groq / OpenAI / Gemini', 'SQLite or Postgres for memory', 'WhatsApp Cloud API or Baileys'],
    automation: ['n8n or custom Node worker', 'Webhooks + cron', 'Google Sheets / Airtable', 'Error alerting'],
  };
  return table[serviceId] || table.business_site;
}

/** Parses "around 50k", "$1,500", "1.5 lakh", "80,000 PKR" into PKR. */
export function parseBudget(text) {
  if (!text) return null;
  const raw = String(text).toLowerCase();
  const match = raw.match(/(\d[\d,.\s]*)\s*(k|thousand|lakh|lac|million|m)?/);
  if (!match) return null;

  let n = parseFloat(match[1].replace(/[,\s]/g, ''));
  if (!Number.isFinite(n)) return null;

  const unit = match[2];
  if (unit === 'k' || unit === 'thousand') n *= 1000;
  if (unit === 'lakh' || unit === 'lac') n *= 100000;
  if (unit === 'million' || unit === 'm') n *= 1000000;

  // Currency hint
  const currency = /\$|usd|dollar/.test(raw)
    ? 'USD'
    : /£|gbp|pound/.test(raw)
      ? 'GBP'
      : /€|eur/.test(raw)
        ? 'EUR'
        : /aed|dirham/.test(raw)
          ? 'AED'
          : /sar|riyal/.test(raw)
            ? 'SAR'
            : 'PKR';

  const fx = config.owner.profile?.currency?.fxToPkr || { USD: 280, GBP: 355, EUR: 305, AED: 76, SAR: 75, PKR: 1 };
  const rate = fx[currency] || 1;
  return { text: String(text), amount: Math.round(n * rate), currency, rawAmount: Math.round(n) };
}

/**
 * Build the quote.
 * @param {object} fields intake fields
 * @param {string} number client number (drives currency + locale)
 */
export function buildQuote(fields = {}, number = '') {
  const blob = blobOf(fields);
  const { service, guessed } = pickService(blob);
  const addons = pickAddons(blob);
  const complexity = complexityOf(fields, addons);

  let pkrMin = service?.min || 15000;
  let pkrMax = service?.max || 35000;

  const breakdown = [
    {
      label: service?.name || 'Website',
      pkrMin,
      pkrMax,
      detail: service?.includes || [],
    },
  ];

  for (const addon of addons) {
    const min = addon.min || 0;
    const max = addon.max || 0;
    pkrMin += min;
    pkrMax += max;
    breakdown.push({
      id: addon.id,
      name: addon.name,
      label: addon.name,
      pkrMin: min,
      pkrMax: max,
      monthly: !!addon.monthly,
    });
  }

  pkrMin = Math.round(pkrMin * complexity.multiplier);
  pkrMax = Math.round(pkrMax * complexity.multiplier);

  // If the client volunteered a budget far below the range, trim the scope
  // rather than pretending the same work costs less.
  const budget = parseBudget(fields.budget);
  let scopeNote = null;
  if (budget && budget.amount > 0 && budget.amount < pkrMin * 0.75) {
    const cut = Math.round((pkrMin - budget.amount) / pkrMin * 100);
    scopeNote = `The stated budget is about ${Math.min(60, cut)}% below this scope — worth offering a smaller first version.`;
  }

  // Round to friendly numbers
  const roundTo = (n) => (n >= 100000 ? Math.round(n / 5000) * 5000 : n >= 20000 ? Math.round(n / 1000) * 1000 : Math.round(n / 500) * 500);
  pkrMin = roundTo(pkrMin);
  pkrMax = roundTo(pkrMax);

  // Timeline — services store "2–4" (days) or "3–7 weeks"
  const rawDays = String(service?.days || '1–2 weeks');
  const serviceDays = /day|week|month|hour|min/i.test(rawDays) ? rawDays : `${rawDays} days`;
  const addonDays = addons.length;
  const timeline =
    addonDays <= 2 ? serviceDays : `${serviceDays} (a little longer with the extra features)`;

  const stack = recommendStack(service?.id, fields);
  const client = lookupNumber(number);
  const localMin = priceFor(number, pkrMin);
  const localMax = priceFor(number, pkrMax);

  return {
    serviceId: service?.id || 'business_site',
    serviceName: service?.name || 'Website',
    guessed,
    breakdown,
    complexity: complexity.level,
    pkrMin,
    pkrMax,
    local: {
      currency: localMin.currency,
      min: localMin.amount,
      max: localMax.amount,
      minText: localMin.text,
      maxText: localMax.text,
    },
    timeline,
    stack,
    scopeNote,
    budget,
    country: client.country,
    ownerCurrency: config.owner.profile?.currency?.base || 'PKR',
  };
}

const bullet = (s) => `• ${s}`;

/** The quote card we actually send on WhatsApp (plain text, emoji-light). */
export function formatQuote(quote, fields = {}) {
  if (!quote) return '';
  const f = fields;
  const features = Array.isArray(f.features)
    ? f.features
    : String(f.features || '')
      .split(/[,;\n]|\band\b/i)
      .map((s) => s.trim())
      .filter(Boolean);

  const lines = [];
  lines.push('Here’s the scope + price 👇');
  lines.push('');
  lines.push(`*${quote.serviceName}*`);
  if (f.goal) {
    const goal = String(f.goal).replace(/\s+/g, ' ').replace(/^["'“”]+|["'“”]+$/g, '').trim();
    if (goal) lines.push(goal.slice(0, 200));
  }
  lines.push('');

  lines.push('*Included*');
  const baseIncludes = quote.breakdown[0]?.detail?.slice(0, 5) || [];
  for (const item of baseIncludes) lines.push(bullet(item));
  const seen = new Set(baseIncludes.map((i) => String(i).toLowerCase()));
  const addFeature = (feature) => {
    const clean = String(feature).trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) return;
    seen.add(key);
    lines.push(bullet(clean));
  };
  if (features.length) {
    for (const feature of features.slice(0, 6)) addFeature(feature);
  }
  for (const addon of quote.breakdown.slice(1).slice(0, 5)) {
    addFeature(`${addon.label || addon.name}${addon.monthly ? ' (monthly)' : ''}`);
  }
  lines.push('');

  lines.push(`*Price:* ${quote.local.minText} – ${quote.local.maxText}`);
  lines.push(`*Timeline:* ${quote.timeline}`);
  if (quote.stack?.length) lines.push(`*Stack:* ${quote.stack.join(' · ')}`);
  lines.push('');
  lines.push('Payment: 50% to start, 50% on delivery. Two revision rounds included.');
  lines.push('');
  lines.push('If this looks right I can send a proper breakdown and book the slot. Anything you want to add or swap out?');

  return lines.join('\n');
}

/** Short "starting from" line for early price questions. */
export function startingPriceLine(number, fields = {}) {
  const quote = buildQuote(fields, number);
  const service = SERVICES().find((s) => s.id === quote.serviceId);
  const from = priceFor(number, Math.round((service?.min || 15000) * 0.9));
  return `${quote.serviceName} usually starts around ${from.text}`;
}

export function priceBook() {
  return { services: SERVICES(), addons: ADDONS(), maxDiscountPercent: MAX_DISCOUNT() };
}

export function formatMoneyPkr(n) {
  return formatMoney(n, 'PKR');
}

export default { buildQuote, formatQuote, parseBudget, startingPriceLine, priceBook };
