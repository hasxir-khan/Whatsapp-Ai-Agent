// src/services/profile.js
// One universal business profile, readable and writable at runtime.
//
// The profile is the merge of config/owner.example.json (schema defaults) and
// this tenant's config/owner.json (their overrides), assembled by
// loadOwnerProfile(). Everything here reads through that live object, so an
// owner command can change a price and the very next reply uses it.
//
// Nothing in this file invents facts: prices, hours, policies and FAQs come
// from the config files only.

import fs from 'node:fs';
import path from 'node:path';
import { config, reloadProfile } from '../config/env.js';

export { reloadProfile };

/** Every feature flag the bot knows about. Anything else in owner.json is ignored. */
export const FEATURE_KEYS = [
  // phase 1
  'businessProfile',
  'catalog',
  'knowledge',
  'ownerEditing',
  // phase 2
  'toolCalling',
  'rag',
  'managerAgent',
  'manager', // deprecated alias of managerAgent
  'cloudApi',
  // phase 3
  'bookingAgent',
  'followUpAgent',
  'growthApproval', // default ON: drafts wait for the owner until they say otherwise
  'booking', // deprecated alias of bookingAgent
  'followUps', // deprecated alias of followUpAgent
  'closerAgent',
  'reviewAgent',
  'analystAgent',
  'reactivationAgent',
  'contentAgent',
  'closer',    // deprecated alias of closerAgent
  'reviews',   // deprecated alias of reviewAgent
  'analyst',   // deprecated alias of analystAgent
  // phase 4
  'injectionGuard',
];

export const FEATURE_LABELS = {
  businessProfile: 'Business identity, hours, policies, FAQs, tone and goals in the prompt',
  catalog: 'Product catalogue and stock questions',
  knowledge: 'Learned documents (ingested with `tenant learn`)',
  ownerEditing: '.set / .addfaq / .addservice from WhatsApp',
  toolCalling: 'Structured actions (book, stock, order, quote, handoff)',
  rag: 'Vector search over learned documents',
  managerAgent: 'Intent router with specialist agents',
  bookingAgent: 'Books, reminds, reschedules and cancels appointments by chat',
  followUpAgent: 'Personalised nudges for quiet leads, with owner approval',
  growthApproval: 'Growth drafts wait for the owner (.approve / .skip) — on by default',
  manager: 'Deprecated alias of managerAgent',
  cloudApi: 'WhatsApp Cloud API transport',
  booking: 'Appointment slots, reminders, no-show rebooking',
  followUps: 'Automatic nudges for quiet leads',
  closerAgent: 'Objection handling, then quote and payment instructions',
  reviewAgent: 'Feedback asks after a job, review links, referral codes',
  analystAgent: 'Weekly numbers report for the owner, computed not guessed',
  reactivationAgent: 'Monthly win-back campaign for past customers and cold leads',
  contentAgent: 'Weekly pack of posts, statuses and a reel idea for the owner',
  reactivation: 'Deprecated alias of reactivationAgent',
  content: 'Deprecated alias of contentAgent',
  closer: 'Deprecated alias of closerAgent',
  reviews: 'Deprecated alias of reviewAgent',
  analyst: 'Deprecated alias of analystAgent',
  injectionGuard: 'Extra prompt-injection defence',
};

// ── live profile access ─────────────────────────────────────

export function profile() {
  return config.owner.profile || {};
}

export function features() {
  const raw = profile().features || {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('//') || key.startsWith('_')) continue;
    out[key] = value;
  }
  return out;
}

/** Old names keep working; new names are the source of truth. */
export const FEATURE_ALIASES = {
  booking: 'bookingAgent',
  followUps: 'followUpAgent',
  manager: 'managerAgent',
  closer: 'closerAgent',
  reviews: 'reviewAgent',
  analyst: 'analystAgent',
  reactivation: 'reactivationAgent',
  content: 'contentAgent',
};

/** Flags that are ON unless explicitly turned off. */
export const FEATURE_DEFAULT_ON = new Set(['growthApproval']);

export function featureOn(name) {
  const f = features();
  const key = FEATURE_ALIASES[name] || name;
  if (f[key] === true) return true;
  // A tenant may still have only the old key set.
  if (f[name] === true) return true;
  if (FEATURE_DEFAULT_ON.has(key)) return f[key] !== false;
  return false;
}

export function business() {
  return profile().business || {};
}

/** Catalog items, tolerant of `catalog: [...]` and `catalog: { items: [...] }`. */
export function catalogItems() {
  const c = profile().catalog;
  if (Array.isArray(c)) return c;
  if (Array.isArray(c?.items)) return c.items;
  return [];
}

export function faqList() {
  return Array.isArray(profile().faqs) ? profile().faqs : [];
}

export function policies() {
  return profile().policies || {};
}

export function tone() {
  return profile().tone || {};
}

export function goals() {
  return profile().goals || {};
}

export function escalation() {
  return profile().escalation || {};
}

/** How payments are taken, as configured. Empty object = not set up yet. */
export function payment() {
  return business().payment || {};
}

/** Where happy customers should be sent to leave a review, if the owner has one. */
export function reviewLink() {
  const b = business();
  return b.reviewLink || b.review?.link || null;
}

/** What the owner is willing to offer in a win-back message. Nothing else is allowed. */
export function offers() {
  const raw = business().offers;
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (raw && typeof raw === 'object') return Object.values(raw).filter(Boolean);
  return [];
}

/** Weekly content pack schedule: {day: 'wed', time: '10:00'}. */
export function contentSchedule() {
  const raw = business().content || {};
  return {
    day: String(raw.day || config.content.day || 'wed').toLowerCase().slice(0, 3),
    time: raw.time || config.content.time || '10:00',
  };
}

/** Referral programme config: {reward, message}. Absent = tracking only. */
export function referral() {
  return business().referral || {};
}

/** Weekly report schedule: {day: 'mon', time: '09:00'}. */
export function analystSchedule() {
  const b = business();
  const raw = b.analyst || b.report || {};
  return {
    day: String(raw.day || config.analyst.day || 'mon').toLowerCase().slice(0, 3),
    time: raw.time || config.analyst.time || '09:00',
  };
}

export function maxDiscountPercent() {
  return profile().owner?.maxDiscountPercent ?? 10;
}

// ── normalising catalog entries ─────────────────────────────

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function toNumber(v) {
  if (isNum(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) && v.trim() !== '' ? n : null;
  }
  return null;
}

function slugId(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * Turn any catalog entry into one shape the rest of the bot understands:
 * { id, name, kind, min, max, price, duration, stock, keywords, includes, days }
 *
 * `price` is a single fixed amount (restaurant dish, haircut, consultation);
 * `min`/`max` is a range (agency project). Both normalise to min/max so the
 * quote engine never has to care which style the owner used.
 */
export function normalizeItem(raw = {}, index = 0) {
  const name = String(raw.name || raw.title || `Item ${index + 1}`).trim();
  const fixed = toNumber(raw.price ?? raw.amount ?? raw.fee);
  const min = toNumber(raw.min ?? raw.priceMin ?? raw.from);
  const max = toNumber(raw.max ?? raw.priceMax ?? raw.to);

  let lo = fixed ?? min ?? null;
  let hi = fixed ?? max ?? null;
  if (lo === null && hi !== null) lo = hi;
  if (hi === null && lo !== null) hi = lo;
  if (lo !== null && hi !== null && hi < lo) [lo, hi] = [hi, lo];

  const durationRaw = raw.duration ?? raw.minutes ?? raw.length;
  let duration = null;
  if (isNum(durationRaw)) duration = durationRaw;
  else if (typeof durationRaw === 'string') {
    const hours = durationRaw.match(/([\d.]+)\s*h/i);
    const mins = durationRaw.match(/([\d.]+)\s*m/i);
    if (hours) duration = Math.round(parseFloat(hours[1]) * 60);
    else if (mins) duration = Math.round(parseFloat(mins[1]));
    else {
      const n = toNumber(durationRaw);
      if (n !== null) duration = n;
    }
  }

  const kind = String(raw.kind || raw.type || 'service').toLowerCase().includes('prod')
    ? 'product'
    : 'service';

  return {
    id: raw.id || slugId(name) || `item_${index + 1}`,
    name,
    kind,
    price: fixed,
    min: lo,
    max: hi,
    currency: raw.currency || null,
    duration,
    days:
      raw.days ??
      (duration
        ? duration < 240
          ? `${duration} min`
          : `${Math.round((duration / 60) * 10) / 10} hours`
        : undefined),
    stock: isNum(raw.stock) ? raw.stock : null,
    keywords: Array.isArray(raw.keywords) ? raw.keywords : [name, ...(raw.aliases || [])].filter(Boolean),
    includes: Array.isArray(raw.includes) ? raw.includes : [],
    description: raw.description || raw.desc || '',
  };
}

/** Catalog prices are in the owner's base currency; quotes need PKR. */
export function toPkrAmount(amount) {
  if (!isNum(amount)) return null;
  const cur = profile().currency || {};
  const base = cur.base || 'PKR';
  if (base === 'PKR') return amount;
  const rate = cur.fxToPkr?.[base];
  return isNum(rate) && rate > 0 ? Math.round(amount * rate) : amount;
}

/**
 * The services the quote engine should use.
 *
 * Catalog entries come first (they are the owner's newest, canonical list),
 * then any legacy `owner.services` entries that are not already covered — so
 * an existing tenant with no catalog behaves exactly as before, and a
 * restaurant with only catalog works just as well.
 */
export function effectiveServices() {
  const seen = new Set();
  const out = [];

  for (const raw of catalogItems()) {
    const item = normalizeItem(raw);
    // Products are quotable too (a burger, a lawn suit) — only free or
    // price-less entries stay out of the quote engine.
    if (item.min === null || item.min <= 0) continue;
    const key = item.id || item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: item.id,
      name: item.name,
      keywords: item.keywords,
      min: toPkrAmount(item.min),
      max: toPkrAmount(item.max ?? item.min),
      days: item.days,
      includes: item.includes,
      currency: item.currency || profile().currency?.base || 'PKR',
      fromCatalog: true,
    });
  }

  for (const raw of profile().owner?.services || []) {
    const id = raw.id || slugId(raw.name);
    const key = id || String(raw.name || '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }

  return out;
}

/** Everything sellable, for prompts and `.services`. */
export function effectiveCatalog() {
  return catalogItems().map((raw, i) => normalizeItem(raw, i));
}

export function effectiveAddons() {
  return profile().owner?.addons || [];
}

// ── writing ─────────────────────────────────────────────────

export function configDir() {
  return config.tenant.configDir || path.join(config.root, 'config');
}

export function ownerFile() {
  return path.join(configDir(), 'owner.json');
}

/** The tenant's own overrides, exactly as stored (no defaults merged in). */
export function readOverrides() {
  try {
    return JSON.parse(fs.readFileSync(ownerFile(), 'utf8'));
  } catch {
    return {};
  }
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** Writes atomically so a crash can never leave a half-written config. */
export function savePatch(patch) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = ownerFile();
  const merged = deepMerge(readOverrides(), patch);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
  fs.renameSync(tmp, file);
  reloadProfile();
  return merged;
}

/** `.set business.hours "Mon–Sat 10:00–22:00"` style edits. */
export function setPath(dotted, value) {
  const parts = String(dotted || '')
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error('Nothing to set');
  if (parts[0] === 'features' && parts[1] && !FEATURE_KEYS.includes(parts[1])) {
    throw new Error(`Unknown flag "${parts[1]}". Known: ${FEATURE_KEYS.join(', ')}`);
  }
  let patch = value;
  for (let i = parts.length - 1; i >= 0; i -= 1) patch = { [parts[i]]: patch };
  return savePatch(patch);
}

/** Coerce a WhatsApp argument into a number/boolean where it obviously is one. */
export function coerceValue(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^(true|on|yes|enable)$/i.test(s)) return true;
  if (/^(false|off|no|disable)$/i.test(s)) return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/**
 * Adds a service or product to the catalog. Written to catalog.items so the
 * universal profile stays the single source of truth; the quote engine picks
 * it up through effectiveServices().
 */
export function addService({ name, price, min, max, duration, stock, kind = 'service', description, keywords }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('A service needs a name. Example: .addservice Logo design | 15000');
  const entry = {
    id: slugId(clean),
    name: clean,
    kind,
  };
  const fixed = toNumber(price);
  const lo = toNumber(min);
  const hi = toNumber(max);
  if (fixed !== null) entry.price = fixed;
  else if (lo !== null || hi !== null) {
    entry.min = lo ?? hi;
    entry.max = hi ?? lo;
  } else {
    throw new Error('Give a price (or a range). Example: .addservice Logo design | 15000');
  }
  if (duration !== undefined && duration !== null && duration !== '') entry.duration = toNumber(duration) ?? duration;
  if (stock !== undefined && stock !== null && stock !== '') entry.stock = toNumber(stock);
  if (description) entry.description = String(description);
  if (keywords?.length) entry.keywords = keywords;

  const items = catalogItems().filter((i) => (i.id || slugId(i.name)) !== entry.id);
  items.push(entry);
  savePatch({ catalog: { items } });
  return normalizeItem(entry);
}

export function addFaq(q, a) {
  const question = String(q || '').trim();
  const answer = String(a || '').trim();
  if (!question || !answer) throw new Error('Usage: .addfaq Do you deliver? | Yes, all over Islamabad');
  const faqs = faqList().filter((f) => String(f.q || '').toLowerCase() !== question.toLowerCase());
  faqs.push({ q: question, a: answer });
  savePatch({ faqs });
  return { q: question, a: answer, count: faqs.length };
}

// ── validation (doctor + every write) ───────────────────────

export function validateProfile(p = profile()) {
  const errors = [];
  const warnings = [];
  const push = (list, msg) => list.push(msg);

  const b = p.business || {};
  for (const key of ['name', 'type', 'city', 'hours']) {
    if (!b[key]) push(warnings, `business.${key} is empty — the bot will stay vague about it`);
  }
  if (b.languages && !Array.isArray(b.languages)) push(errors, 'business.languages must be a list');

  const items = Array.isArray(p.catalog?.items) ? p.catalog.items : Array.isArray(p.catalog) ? p.catalog : [];
  const ids = new Set();
  for (const [i, raw] of items.entries()) {
    const item = normalizeItem(raw, i);
    if (!raw.name) push(errors, `catalog item ${i + 1} has no name`);
    if (item.min === null) push(errors, `catalog item "${item.name}" has no price`);
    else if (item.min < 0) push(errors, `catalog item "${item.name}" has a negative price`);
    // Check the raw order: normalizeItem sorts the pair, so a swapped
    // min/max would otherwise slip through as valid.
    const rawMin = toNumber(raw.min ?? raw.priceMin ?? raw.from);
    const rawMax = toNumber(raw.max ?? raw.priceMax ?? raw.to);
    if (rawMin !== null && rawMax !== null && rawMax < rawMin) {
      push(errors, `catalog item "${item.name}" has max below min`);
    }
    if (ids.has(item.id)) push(warnings, `catalog id "${item.id}" is used twice`);
    ids.add(item.id);
  }

  const faqs = p.faqs;
  if (faqs && !Array.isArray(faqs)) push(errors, 'faqs must be a list of {q, a}');
  for (const [i, f] of (faqs || []).entries()) {
    if (!f?.q || !f?.a) push(errors, `faq ${i + 1} needs both q and a`);
  }

  const esc = p.escalation || {};
  for (const key of ['number', 'whatsapp', 'email']) {
    const v = esc[key];
    if (v && typeof v === 'string' && /phone|number|whatsapp/i.test(key) && !/^\+?\d{8,15}$/.test(v.replace(/[\s-]/g, ''))) {
      push(warnings, `escalation.${key} does not look like a phone number`);
    }
  }
  if (esc.topics && !Array.isArray(esc.topics)) push(errors, 'escalation.topics must be a list');

  for (const key of Object.keys(p.features || {})) {
    if (key.startsWith('//') || key.startsWith('_')) continue;
    if (!FEATURE_KEYS.includes(key)) push(warnings, `unknown feature flag "${key}" (ignored)`);
  }

  return { errors, warnings };
}

export default {
  profile,
  features,
  featureOn,
  business,
  catalogItems,
  faqList,
  policies,
  tone,
  goals,
  escalation,
  normalizeItem,
  effectiveServices,
  effectiveCatalog,
  effectiveAddons,
  setPath,
  addService,
  addFaq,
  savePatch,
  readOverrides,
  reloadProfile,
  validateProfile,
  coerceValue,
};
