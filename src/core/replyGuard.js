// src/core/replyGuard.js
// The last gate before a customer sees a word.
//
// Live testing found the expensive failures: the same project quoted at two
// different price ranges (one of them in Dutch), a reply that ended mid-list
// ("1, 2, 3, 4, 5, 6,"), and a voice that switched between "I" and "we" inside
// one message. All three are cheaply detectable *after* generation, which is
// where they are detectable at all — so every outbound customer reply goes
// through this module, whichever pipeline wrote it and whichever provider
// produced it.
//
// The contract: `guardReply` either passes the text or names the problems. The
// caller regenerates once with the problems spelled out, then sends a safe line
// and tells the owner. Nothing here sends anything.

import { profile } from '../services/profile.js';
import { config } from '../config/env.js';
import * as db from '../utils/db.js';
import { detectLanguage } from '../services/language.js';

const DAY_MS = 24 * 3600 * 1000;

/** Short, true, in-voice lines used when a reply cannot be trusted. */
export const SAFE_LINES = {
  en: "Sorry — I don't want to give you a number or a detail I can't stand behind. Let me check and come back to you properly.",
  'roman-ur': 'Sorry — main aap ko koi aisa number ya detail nahi dena chahta jo sahi na ho. Main check karke thori der mein batata hoon.',
  ur: 'معاف کیجیے — میں آپ کو کوئی ایسی بات نہیں بتانا چاہتا جو درست نہ ہو۔ میں تصدیق کر کے تھوڑی دیر میں بتاتا ہوں۔',
};

export function safeLine(lang = 'en') {
  return SAFE_LINES[lang] || SAFE_LINES.en;
}

// ── what a reply is allowed to claim ─────────────────────────

const DIGITS = /(\d+(?:[.,]\d+)?)/g;

function walk(value, visit) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number') visit(String(value));
  else if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
  else if (typeof value === 'object') Object.values(value).forEach((v) => walk(v, visit));
}

/**
 * Every number the business has actually published, plus the ids and totals the
 * customer legitimately sees back, plus anything this chat already established.
 * @returns {{numbers:Set<string>, percents:Set<string>}}
 */
export function allowedFacts({ extra = [], chat = null } = {}) {
  const p = profile() || {};
  const numbers = new Set();
  const percents = new Set();

  const collect = (text) => {
    for (const m of String(text).matchAll(DIGITS)) numbers.add(m[1].replace(/,/g, ''));
    for (const m of String(text).matchAll(/(\d{1,3})\s*%/g)) percents.add(m[1]);
  };

  walk(p.business, collect);
  walk(p.catalog, collect);
  walk(p.policies, collect);
  walk(p.faqs, collect);
  walk(p.owner, collect);
  walk(p.pricing, collect);

  // Ids and totals the customer can be shown.
  try {
    for (const row of db.all('SELECT id, total FROM orders ORDER BY id DESC LIMIT 100')) {
      if (row.id !== null && row.id !== undefined) numbers.add(String(row.id));
      if (row.total !== null && row.total !== undefined) numbers.add(String(row.total));
    }
    for (const row of db.all('SELECT id, rating FROM bookings ORDER BY id DESC LIMIT 100')) {
      if (row.id !== null && row.id !== undefined) numbers.add(String(row.id));
    }
  } catch {
    /* no database yet, or a unit test with a stub */
  }

  if (chat) {
    for (const claim of claimsFor(chat)) {
      if (claim.kind === 'amount' && claim.text) numbers.add(String(claim.text).replace(/\D/g, ''));
    }
  }

  for (const value of extra) {
    for (const m of String(value).matchAll(DIGITS)) numbers.add(m[1].replace(/,/g, ''));
  }

  numbers.delete('');
  return { numbers, percents };
}

// ── ranges, and memory of what was already said ─────────────

const RANGE_PATTERNS = [
  /(\d[\d,]{1,})\s*(?:–|—|-|to|se)\s*(\d[\d,]{1,})/gi, // 2000–3000 / 2000 to 3000
  /between\s+(\d[\d,]{1,})\s+and\s+(\d[\d,]{1,})/gi,
];

/** Price/timeline ranges in one piece of text. */
export function extractRanges(text = '') {
  const out = [];
  for (const pattern of RANGE_PATTERNS) {
    for (const m of String(text).matchAll(pattern)) {
      const lo = Number(String(m[1]).replace(/,/g, ''));
      const hi = Number(String(m[2]).replace(/,/g, ''));
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
      if (lo === hi) continue;
      out.push({ lo: Math.min(lo, hi), hi: Math.max(lo, hi), raw: m[0] });
    }
  }
  return out;
}

function ensureTable() {
  try {
    db.run(
      `CREATE TABLE IF NOT EXISTS chat_claims (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         tenant TEXT, chat TEXT, kind TEXT, low INTEGER, high INTEGER, text TEXT, created_at TEXT
       )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_chat_claims_chat ON chat_claims (chat)');
  } catch {
    /* a read-only database is not a reason to lose a reply */
  }
}

export function claimsFor(chat, { days = 30 } = {}) {
  if (!chat) return [];
  ensureTable();
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  try {
    return db.all('SELECT kind, low, high, text, created_at FROM chat_claims WHERE chat = ? AND created_at >= ? ORDER BY id', [
      chat,
      since,
    ]);
  } catch {
    return [];
  }
}

/**
 * Remember what went out, so the next reply cannot contradict it.
 * Ranges are stored as kind 'range'; single amounts as kind 'amount'.
 */
export function rememberClaims(chat, text, { now = new Date() } = {}) {
  if (!chat || !text) return;
  ensureTable();
  const tenant = config.tenant?.slug || null;
  const stamp = now.toISOString();
  try {
    for (const range of extractRanges(text)) {
      db.run('INSERT INTO chat_claims (tenant, chat, kind, low, high, text, created_at) VALUES (?,?,?,?,?,?,?)', [
        tenant,
        chat,
        'range',
        range.lo,
        range.hi,
        range.raw,
        stamp,
      ]);
    }
    // A single quoted figure is a claim as well ("3,200 for the platter").
    for (const m of String(text).matchAll(/(\d{3,}(?:[.,]\d+)?)/g)) {
      const value = Number(m[1].replace(/,/g, ''));
      if (!Number.isFinite(value)) continue;
      db.run('INSERT INTO chat_claims (tenant, chat, kind, low, high, text, created_at) VALUES (?,?,?,?,?,?,?)', [
        tenant,
        chat,
        'amount',
        value,
        value,
        String(value),
        stamp,
      ]);
    }
  } catch {
    /* remembering is best-effort */
  }
}

export function clearClaims(chat) {
  ensureTable();
  try {
    db.run('DELETE FROM chat_claims WHERE chat = ?', [chat]);
  } catch {
    /* ignore */
  }
}

/** Ranges that were already sent in this chat. */
export function rangesFor(chat) {
  return claimsFor(chat).filter((c) => c.kind === 'range');
}

// ── the checks ───────────────────────────────────────────────

const TIMELINE_UNITS = /^\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|working days?|seconds?)\b/i;

/**
 * Every number and range in a reply must already exist in the business facts.
 * @returns {string[]} problems
 */
export function checkClaims(text = '', { allowed = null, chat = null } = {}) {
  const body = String(text || '');
  const facts = allowed || allowedFacts({ chat });
  const problems = [];

  // Numbers and amounts.
  for (const m of body.matchAll(/\d[\d,]*(?:[.,]\d+)?/g)) {
    const raw = m[0];
    const value = raw.replace(/,/g, '');
    const digits = value.replace(/\D/g, '');
    const after = body.slice(m.index + raw.length);
    const before = body.slice(Math.max(0, m.index - 12), m.index);

    if (digits.length < 3) continue; // "2 people", "7 days"
    if (/^(19|20)\d{2}$/.test(digits)) continue; // a year is not a claim
    if (/^0\d/.test(digits) && digits.length >= 4) continue; // 0300..., a local dialling prefix
    if (TIMELINE_UNITS.test(after)) continue; // "45 minutes", "2–4 working days" is checked as a number
    if (/:\d{2}/.test(body.slice(m.index, m.index + raw.length + 3))) continue; // 19:30
    if (/%$/.test(body.slice(m.index, m.index + raw.length + 2).trimEnd().replace(/\s+/g, ''))) {
      if (facts.percents.has(digits) || Number(digits) <= 100) continue; // a percentage inside 0–100
    }

    if (!facts.numbers.has(value) && !facts.numbers.has(digits)) {
      problems.push(`number "${raw}" is not in the catalogue, policies, orders or this chat`);
    }
  }

  // Ranges must not contradict what this chat already said.
  const seen = rangesFor(chat);
  for (const range of extractRanges(body)) {
    const known = seen[seen.length - 1];
    if (known && (known.low !== range.lo || known.high !== range.hi)) {
      problems.push(`price range changed from ${known.low}–${known.high} to ${range.lo}–${range.hi}`);
    }
  }

  return problems;
}

const ROMAN_MARKERS = /\b(hai|hain|kya|nahi|nahin|aap|yaar|bhai|chahiye|karo|mujhe|kitna|kitne|theek|acha|bilkul|zaroor|karein|hoga|karwaya|batata|bata)\b/i;

/**
 * The reply is in the conversation's language — compared by script first,
 * because that is the mismatch a customer notices.
 */
export function checkLanguage(text = '', langInfo = null) {
  const want = String(langInfo?.code || '');
  if (!want || want === 'unknown') return [];
  const body = String(text || '').trim();
  if (!body) return [];

  // Only the mismatches a customer actually notices: the wrong script (an
  // English answer to an Urdu question), or Roman Urdu answered in plain
  // English. Guessing between two Latin-script languages with a statistical
  // detector is how English got labelled Albanian, so it is not done.
  const got = detectLanguage(body);
  const wantArabic = want === 'ur' || want === 'ar';
  const gotArabic = /arabic/i.test(String(got.script || '')) || got.code === 'ur';

  if (wantArabic !== gotArabic) return [`language: expected ${want}, got ${got.code}`];
  if (wantArabic && gotArabic) return [];

  if (want === 'roman-ur' && ROMAN_MARKERS.test(String(langInfo?.sample || '')) && !ROMAN_MARKERS.test(body)) {
    return ['language: expected roman-ur, got en'];
  }
  return [];
}

export function voiceOf(profileObj = null) {
  const p = profileObj || profile() || {};
  // `firstPerson`, not `voice`: `bot.voice` is the text-to-speech voice, and
  // reusing that key would make one of the two silently win.
  const raw = String(p?.bot?.firstPerson || p?.owner?.firstPerson || 'we').toLowerCase();
  return raw === 'i' || raw === 'me' ? 'i' : 'we';
}

const FIRST_SINGULAR = /\b(i|i'm|i'll|i've|i'd|me|my|mine)\b/gi;
const FIRST_PLURAL = /\b(we|we're|we'll|we've|we'd|us|our|ours)\b/gi;

export function checkPersona(text = '', { voice = null, strict = false } = {}) {
  const body = String(text || '');
  const configured = (voice || voiceOf()).toLowerCase();
  const singular = (body.match(FIRST_SINGULAR) || []).length;
  const plural = (body.match(FIRST_PLURAL) || []).length;

  // Quoting the customer ("you said you'll call me") is not the bot's voice.
  const quoted = (body.match(/"[^"]*"|“[^”]*”/g) || []).join(' ');
  const singularNet = singular - (quoted.match(FIRST_SINGULAR) || []).length;
  const pluralNet = plural - (quoted.match(FIRST_PLURAL) || []).length;

  // Mixed voice is the failure the customers saw: one message, two companies.
  // That is always wrong, in every agent and language.
  if (singularNet > 0 && pluralNet > 0) {
    return [`voice: mixes "I" (${singularNet}) and "we" (${pluralNet}) in one reply`];
  }
  // Drift from the configured voice is only checked when asked (the voice
  // report), because a single "I'll check" in a short reply is normal English,
  // and a fixed hand-off line must never be rewritten by a style rule.
  if (strict) {
    if (configured === 'we' && singularNet > 0) {
      return [`voice: the business speaks as "we", this reply uses "I"`];
    }
    if (configured === 'i' && pluralNet > 0) {
      return [`voice: the business speaks as "I", this reply uses "we"`];
    }
  }
  return [];
}

const DANGLING = new Set([
  'and', 'or', 'but', 'the', 'a', 'an', 'to', 'of', 'for', 'with', 'in', 'on', 'at', 'by', 'from',
  'is', 'are', 'was', 'were', 'be', 'will', 'would', 'can', 'could', 'we', 'i', 'you', 'your', 'our',
  'that', 'this', 'these', 'those', 'as', 'if', 'so', 'than', 'then', 'plus', 'also',
]);

/**
 * A reply that stops mid-sentence is a truncation, not a style: it must be
 * regenerated, never sent.
 */
export function endsMidSentence(text = '') {
  const body = String(text || '').trim();
  if (!body) return { cut: true, reason: 'empty' };

  const opens = (body.match(/[([{]/g) || []).length;
  const closes = (body.match(/[)\]}]/g) || []).length;
  const quotes = (body.match(/"/g) || []).length;
  if (opens !== closes) return { cut: true, reason: 'unbalanced brackets' };
  if (quotes % 2 === 1) return { cut: true, reason: 'unbalanced quotes' };

  const lastChar = body.slice(-1);
  if (/[,;:–—-]$/.test(lastChar)) return { cut: true, reason: `ends with "${lastChar}"` };
  if (!/[.!?…)\]*_"'”]$/.test(lastChar)) {
    // No terminal punctuation. Plenty of real WhatsApp messages end without a
    // full stop, so only a sentence that visibly ran out of words is a cut: it
    // ends on a conjunction, an article or a preposition.
    const words = body.split(/\s+/).filter(Boolean);
    const last = (words[words.length - 1] || '').toLowerCase().replace(/[^a-zà-ÿ\u0600-\u06FF]/gi, '');
    if (DANGLING.has(last)) return { cut: true, reason: `ends on "${last}"` };
  }

  const lastLine = body.split('\n').filter((l) => l.trim()).pop() || '';
  const lastWord = lastLine.split(/\s+/).pop() || '';
  if (/,+$/.test(lastWord)) return { cut: true, reason: 'trailing comma in a list' };
  if (/^•\s*$/.test(lastLine.trim())) return { cut: true, reason: 'empty bullet' };

  return { cut: false, reason: null };
}

const FORBIDDEN = [
  /you are a helpful/i,
  /system prompt/i,
  /<\/?(untrusted|system|instructions?)>/i,
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bgsk_[A-Za-z0-9]{8,}\b/,
  /\bAIza[0-9A-Za-z_-]{10,}\b/,
];

export function checkForbidden(text = '') {
  const problems = [];
  for (const re of FORBIDDEN) {
    const hit = String(text || '').match(re);
    if (hit) problems.push(`forbidden text: "${String(hit[0]).slice(0, 24)}"`);
  }
  return problems;
}

/**
 * The whole gate.
 * @returns {{ok:boolean, problems:string[]}}
 */
export function guardReply({
  text = '',
  langInfo = null,
  chat = null,
  extra = [],
  voice = null,
  allowCut = false,
  scope = true,
  voiceHard = false,
} = {}) {
  const body = String(text || '').trim();
  const problems = [];
  const notes = [];
  if (!body) return { ok: false, problems: ['empty reply'], notes };

  problems.push(...checkForbidden(body));

  // A short refusal from the scope guard has no claims of its own; still check
  // its language, but not its punctuation.
  if (!allowCut) {
    const cut = endsMidSentence(body);
    if (cut.cut) problems.push(`cut off: ${cut.reason}`);
  }

  problems.push(...checkLanguage(body, langInfo));

  if (scope) problems.push(...checkClaims(body, { allowed: allowedFacts({ extra, chat }), chat }));

  // Mixed voice is reported, and only blocks the send when the caller asks for
  // strict persona enforcement: rewriting a natural "I'll check with our team"
  // costs more than it fixes.
  const voiceProblems = checkPersona(body, { voice, strict: false });
  if (voiceHard) problems.push(...voiceProblems);
  else notes.push(...voiceProblems);

  return { ok: problems.length === 0, problems: [...new Set(problems)], notes: [...new Set(notes)] };
}

export default {
  SAFE_LINES,
  safeLine,
  allowedFacts,
  extractRanges,
  checkClaims,
  checkLanguage,
  checkPersona,
  endsMidSentence,
  checkForbidden,
  guardReply,
  rememberClaims,
  claimsFor,
  clearClaims,
  rangesFor,
  voiceOf,
};
