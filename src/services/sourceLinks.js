// src/services/sourceLinks.js
// Tracked entry points: a wa.me link, a QR code and a poster that all carry a
// short, invisible-in-conversation marker so the owner can see which channel
// brought a customer.
//
// The rules that shape this file:
//
//   • A source is a name the owner chose ("instagram", "shop-window"), not a
//     sentence. Anything that is not [a-z0-9-] is refused rather than quietly
//     rewritten into something the owner did not ask for.
//
//   • The marker is data, never an instruction. It is stripped from the text
//     before memory, guards, intake or the model can see it, and the rest of
//     the message still goes through the normal injection defences.
//
//   • First touch wins. A customer who scans the poster in March and the flyer
//     in June is a March customer. A referral code from Phase 3 outranks a link,
//     because a human recommended us — that is the stronger claim.
//
//   • Nothing here invents a number. Counts come from rows we already have:
//     who arrived (contact_sources), who became a lead, who paid.
//
//   • A QR or poster that fails is an ordinary error reply, never a crash: the
//     link itself is still in the database and still printable by hand.

import crypto from 'node:crypto';
import QRCode from 'qrcode';

import { config, normalizePhone } from '../config/env.js';
import { business, featureOn } from './profile.js';
import { addContactTag, get, all, run, logEvent } from '../utils/db.js';
// Pure string work, no config, no network: safe to import at module load.
import { neutralise, detectInjection } from '../core/injection.js';

export const MAX_SOURCES = 50;
export const MAX_SOURCE_NAME = 24;
export const MAX_LINK_TEXT = 120;

/** Names that already mean something else in the dashboard. */
const RESERVED = new Set(['direct', 'referral', 'ad', 'ads', 'qr']);

/** The marker: `[s:ab12c]`. Short enough that a customer never notices it. */
const MARKER = /\[\s*s\s*:\s*([^\]\s]{1,40})\s*\]/gi;
const CODE_RE = /^[a-z0-9]{3,24}$/;

export function sourceLinksEnabled() {
  return featureOn('sourceLinks');
}

// ── names and codes ──────────────────────────────────────────

/**
 * `Instagram` → `instagram`, `shop window` → `shop-window`.
 * @returns {string|null} null when nothing usable is left
 */
export function normaliseSource(raw = '') {
  const name = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_SOURCE_NAME)
    .replace(/-$/, '');
  return name || null;
}

/** Why a name cannot be used, or null when it is fine. */
export function sourceProblem(raw = '') {
  const name = normaliseSource(raw);
  if (!name) return 'a source needs a name — try: .link instagram';
  if (name.length < 2) return `"${name}" is too short — use at least two characters`;
  if (RESERVED.has(name)) return `"${name}" is a reserved word (it already means something in the dashboard)`;
  return null;
}

/** Unambiguous, lowercase, no vowels: a code that cannot spell a word. */
function newCode(taken = new Set()) {
  const alphabet = '23456789bcdfghjkmnpqrstvwxyz';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const bytes = crypto.randomBytes(5);
    let code = '';
    for (let i = 0; i < 5; i += 1) code += alphabet[bytes[i] % alphabet.length];
    if (!taken.has(code)) return code;
  }
  // Practically unreachable, but a duplicate code cannot be allowed to happen.
  return `x${Date.now().toString(36).slice(-6)}`;
}

// ── the number we put in the link ────────────────────────────

/** The business's own WhatsApp number: profile override, then MY_NUMBER. */
export function whatsappNumber() {
  const b = business() || {};
  const raw = b.whatsapp || b.whatsappNumber || config.owner.number;
  return normalizePhone(raw || '');
}

/** True when the number is obviously a placeholder rather than a real line. */
export function placeholderNumber(number = whatsappNumber()) {
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits) return false;
  return (
    /^(0?0+|1+|9+|2+)$/.test(digits) || // 000…, 111…, 999…
    /^(\d)\1+$/.test(digits) || // every digit the same
    /123456|654321|5551234|0000000/.test(digits)
  );
}

/**
 * `923001234567` → `+92 300 1234567`.
 *
 * A poster is read by a person: twelve digits in a row get mistyped. This takes
 * the country code off and groups the rest. The four plans below are the
 * numbers this bot actually sees; anything else gets groups of three or four,
 * which is wrong in detail and right in shape — and the digits are printed
 * underneath exactly as dialled, so nothing is lost.
 */
export function readableNumber(number = whatsappNumber()) {
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length <= 6) return `+${digits}`;

  const gcc = /^(971|966|965|974|968|973|962|961|967|963|964|972)/;
  let cc = 2;
  let sizes = null;
  if (/^1/.test(digits) && digits.length === 11) {
    cc = 1;
    sizes = [3, 3, 4];
  } else if (/^92/.test(digits)) {
    sizes = [3, 7];
  } else if (/^91/.test(digits)) {
    sizes = [5, 5];
  } else if (/^44/.test(digits)) {
    sizes = [4, 6];
  } else if (gcc.test(digits) && digits.length >= 11) {
    cc = 3;
    sizes = [3, 3, 3];
  }

  const rest = digits.slice(cc);
  if (!rest) return `+${digits}`;
  const fits = Array.isArray(sizes) && sizes.reduce((n, s) => n + s, 0) === rest.length;

  let groups;
  if (fits) {
    const out = [];
    let at = 0;
    for (const size of sizes) {
      out.push(rest.slice(at, at + size));
      at += size;
    }
    groups = out;
  } else if (rest.length <= 4) {
    groups = [rest];
  } else if (rest.length % 4 === 0) {
    groups = rest.match(/.{1,4}/g);
  } else if (rest.length % 3 === 0) {
    groups = rest.match(/.{1,3}/g);
  } else {
    // Groups of three or four, never leaving a one- or two-digit stub: that is
    // the part people get wrong when copying a number off a wall.
    groups = [];
    let left = rest;
    while (left.length > 4) {
      const take = left.length - 4 <= 2 ? 3 : 4;
      groups.push(left.slice(0, take));
      left = left.slice(take);
    }
    if (left) groups.push(left);
  }

  return [`+${digits.slice(0, cc)}`, ...groups].join(' ');
}

// ── the link ─────────────────────────────────────────────────

/** `instagram` → `Instagram`, `google-profile` → `Google profile`. */
export function sourceLabel(raw = '') {
  const name = normaliseSource(raw) || '';
  const words = name.split('-').filter(Boolean);
  if (!words.length) return '';
  const first = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return [first, ...words.slice(1)].join(' ');
}

export function defaultMessage(source) {
  const label = sourceLabel(source);
  return label ? `Hi, I saw you on ${label}` : 'Hi, I would like to know more';
}

/**
 * Owner-supplied link text, made safe to put in front of a customer.
 * Markers are removed (only we add those), instruction-looking sentences are
 * dropped, and the result is one short line.
 */
export function sanitiseLinkText(raw = '') {
  let text = String(raw || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(MARKER, ' ')
    .replace(/\[[^\]]{0,60}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  // A prefilled message is text a customer will send us. If it tries to give
  // the bot orders, those sentences do not travel.
  if (detectInjection(text).found) text = neutralise(text).replace(/\[removed:[^\]]*\]/gi, ' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_LINK_TEXT);
}

export function buildMessage({ code, text = '', source = '' }) {
  const base = sanitiseLinkText(text) || defaultMessage(source);
  return `${base} [s:${code}]`;
}

export function linkForNumber(number, message) {
  const digits = String(number || '').replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

// ── storage ──────────────────────────────────────────────────

const tenant = () => config.tenant.slug || null;

export function listTrackedSources() {
  return all('SELECT * FROM tracked_sources WHERE tenant IS ? ORDER BY id', [tenant()]);
}

export function trackedSource(name) {
  const clean = normaliseSource(name);
  if (!clean) return null;
  return get('SELECT * FROM tracked_sources WHERE tenant IS ? AND source = ?', [tenant(), clean]);
}

export function trackedSourceByCode(code) {
  const clean = String(code || '').toLowerCase().trim();
  if (!CODE_RE.test(clean)) return null;
  return get('SELECT * FROM tracked_sources WHERE code = ?', [clean]);
}

/**
 * Create (or return) one source. Never throws for a name the owner can fix.
 * @returns {{ok:boolean, reason?:string, source?:object, url?:string, message?:string, already?:boolean}}
 */
export function createSource({ name, text = '', now = new Date() } = {}) {
  if (!sourceLinksEnabled()) return { ok: false, reason: 'disabled' };

  const problem = sourceProblem(name);
  if (problem) return { ok: false, reason: 'invalid_source', message: problem };
  const clean = normaliseSource(name);

  const number = whatsappNumber();
  if (!number) return { ok: false, reason: 'no_number', message: 'No WhatsApp number is configured (MY_NUMBER).' };

  const existing = trackedSource(clean);
  if (existing) {
    return { ok: true, already: true, source: existing, ...present(existing) };
  }

  const rows = listTrackedSources();
  if (rows.length >= MAX_SOURCES) {
    return {
      ok: false,
      reason: 'too_many',
      message: `That is ${MAX_SOURCES} sources already — the limit. Two or three well-placed ones beat twenty.`,
    };
  }

  const taken = new Set(all('SELECT code FROM tracked_sources').map((r) => r.code));
  const code = newCode(taken);
  const message = buildMessage({ code, text, source: clean });

  try {
    run('INSERT INTO tracked_sources (tenant, source, code, label, message, created_at) VALUES (?,?,?,?,?,?)', [
      tenant(),
      clean,
      code,
      sourceLabel(clean),
      message,
      now.toISOString(),
    ]);
  } catch (err) {
    logEvent('source_link_create_failed', null, err.message);
    return { ok: false, reason: 'db', message: 'Could not save that source — try again.' };
  }

  const row = trackedSource(clean);
  logEvent('source_link_created', null, { source: clean });
  return { ok: true, source: row, created: true, ...present(row) };
}

/** The three things every caller needs: the row, its message and its URL. */
function present(row) {
  if (!row) return {};
  const message = row.message || defaultMessage(row.source);
  return { message, url: linkForNumber(whatsappNumber(), message) };
}

export function sourceLink(name) {
  const row = trackedSource(name);
  if (!row) return null;
  return { source: row.source, code: row.code, label: row.label || sourceLabel(row.source), ...present(row) };
}

// ── the marker in an incoming message ────────────────────────

/**
 * Remove a `[s:code]` marker from message text.
 * A malformed marker is still removed — whatever it was, a customer should
 * never be shown the machinery — but it attributes nothing.
 *
 * @returns {{text:string, code:string|null, found:boolean}}
 */
export function stripSourceMarker(text = '') {
  const raw = String(text || '');
  let code = null;
  let found = false;
  const cleaned = raw.replace(MARKER, (_m, candidate) => {
    found = true;
    const value = String(candidate || '').toLowerCase();
    if (CODE_RE.test(value) && code === null) code = value;
    return ' ';
  });
  return {
    text: found ? cleaned.replace(/\s{2,}/g, ' ').trim() : raw,
    code,
    found,
  };
}

export function contactSource(number) {
  const num = String(number || '').replace(/\D/g, '');
  if (!num) return null;
  return get('SELECT * FROM contact_sources WHERE number = ?', [num]);
}

function referredByCode(number) {
  return Boolean(get("SELECT 1 AS c FROM events WHERE type = 'referral_attributed' AND number = ? LIMIT 1", [number]));
}

/**
 * Record where a newcomer came from. Call this once, on the first message.
 *
 * Order of evidence: a referral code (Phase 3) beats a link, and a Cloud API
 * ad referral beats nothing else. First touch wins: once a row exists, later
 * scans or clicks cannot rewrite it.
 *
 * @returns {{source:string, code:string|null, detail:string|null, first:boolean}|null}
 */
export function attributeSource({ number, code = null, referral = null, firstTouch = true, now = new Date() } = {}) {
  if (!sourceLinksEnabled()) return null;
  const num = String(number || '').replace(/\D/g, '');
  if (!num || !firstTouch) return null;

  // A human recommendation outranks a printed code.
  if (referredByCode(num)) return null;

  let source = null;
  let detail = null;
  let usedCode = null;

  if (referral && (referral.headline || referral.sourceUrl || referral.sourceType)) {
    source = 'ad';
    // The headline is the useful part ("Eid sale"). The click id is a tracking
    // identifier, and it is deliberately not stored or logged at all.
    detail = String(referral.headline || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
  } else if (code) {
    const row = trackedSourceByCode(code);
    if (!row) {
      // Unknown code: silently ignored for counting, but it is already out of
      // the text, so no customer or model ever sees it.
      logEvent('source_link_unknown', num, { code: null });
      return null;
    }
    source = row.source;
    usedCode = row.code;
  }

  if (!source) return null;

  const existing = contactSource(num);
  if (existing) return { source: existing.source, code: existing.code, detail: existing.detail, first: false };

  try {
    run('INSERT OR IGNORE INTO contact_sources (tenant, number, source, code, detail, created_at) VALUES (?,?,?,?,?,?)', [
      tenant(),
      num,
      source,
      usedCode,
      detail,
      now.toISOString(),
    ]);
  } catch (err) {
    logEvent('source_link_failed', num, err.message);
    return null;
  }

  // The same fact in the CRM, so `.find source-instagram` works, when the CRM is
  // on. Its own limits apply; a refusal there does not undo the attribution.
  try {
    addContactTag({ tenant: tenant(), number: num, tag: `source-${source}`.slice(0, 24), source: 'auto' });
  } catch {
    /* the tag is a convenience; contact_sources is the record */
  }

  logEvent('source_link_attributed', num, { source, code: usedCode });
  return { source, code: usedCode, detail, first: true };
}

// ── counting ─────────────────────────────────────────────────

/** The ORDER BY matters: this table is read by humans, not machines. */
const COUNT_SQL = `
  SELECT s.source,
         s.label,
         s.code,
         s.created_at,
         (SELECT COUNT(DISTINCT c.number) FROM contact_sources c WHERE c.source = s.source) AS conversations,
         (SELECT COUNT(DISTINCT c.number) FROM contact_sources c
            JOIN leads l ON l.number = c.number
           WHERE c.source = s.source) AS leads,
         (SELECT COUNT(DISTINCT o.id) FROM contact_sources c
            JOIN orders o ON (o.chat = c.number OR o.chat = c.number || '@s.whatsapp.net')
           WHERE c.source = s.source AND o.status IN ('paid','delivered')) AS orders,
         (SELECT COALESCE(SUM(o.total), 0) FROM contact_sources c
            JOIN orders o ON (o.chat = c.number OR o.chat = c.number || '@s.whatsapp.net')
           WHERE c.source = s.source AND o.status IN ('paid','delivered')) AS revenue
    FROM tracked_sources s`;

const DAY = 86_400_000;

/**
 * Every source with the three numbers that decide whether it was worth printing.
 * `stale` is the honest version of "no conversations yet": after two weeks with
 * nothing, the poster is in the wrong place.
 */
export function sourceCounts({ now = new Date() } = {}) {
  return all(COUNT_SQL).map((row) => {
    const created = Date.parse(row.created_at || '') || now.getTime();
    const ageDays = Math.max(0, Math.floor((now.getTime() - created) / DAY));
    const conversations = Number(row.conversations) || 0;
    return {
      source: row.source,
      label: row.label || sourceLabel(row.source),
      code: row.code,
      createdAt: row.created_at || null,
      ageDays,
      conversations,
      leads: Number(row.leads) || 0,
      orders: Number(row.orders) || 0,
      revenue: Number(row.revenue) || 0,
      stale: conversations === 0 && ageDays >= 14,
    };
  });
}

export function sourceSummary({ now = new Date() } = {}) {
  const rows = sourceCounts({ now });
  return {
    enabled: sourceLinksEnabled(),
    total: rows.length,
    limit: MAX_SOURCES,
    conversations: rows.reduce((n, r) => n + r.conversations, 0),
    revenue: rows.reduce((n, r) => n + r.revenue, 0),
    stale: rows.filter((r) => r.stale).map((r) => r.source),
    sources: rows,
  };
}

/** Slack-style one-liners for `.links` and the weekly report. */
export function sourceLines({ now = new Date(), limit = 12 } = {}) {
  const rows = sourceCounts({ now });
  return rows.slice(0, limit).map((r) => {
    const bits = [`${r.conversations} chat${r.conversations === 1 ? '' : 's'}`];
    if (r.leads) bits.push(`${r.leads} lead${r.leads === 1 ? '' : 's'}`);
    if (r.orders) bits.push(`${r.orders} paid`);
    const flag = r.stale ? ' · ⚠️ nothing after 14 days' : '';
    return `${r.label}: ${bits.join(' · ')}${flag}`;
  });
}

// ── QR ───────────────────────────────────────────────────────

/**
 * A PNG buffer of the link. Error-correction M is the floor: a poster gets
 * rained on, photographed at an angle and printed badly.
 */
export async function qrPng(link, { width = 640, margin = 2, level = 'M' } = {}) {
  const text = String(link || '');
  if (!text) throw new Error('nothing to encode');
  return QRCode.toBuffer(text, {
    type: 'png',
    errorCorrectionLevel: level === 'L' ? 'M' : level,
    margin,
    width,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}

export async function qrSvg(link, { margin = 2, level = 'M', width = 640 } = {}) {
  const text = String(link || '');
  if (!text) throw new Error('nothing to encode');
  return QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: level === 'L' ? 'M' : level,
    margin,
    width,
  });
}

/** Just the module matrix — used by the poster, and by the tests. */
export function qrMatrix(link, { level = 'M' } = {}) {
  const text = String(link || '');
  if (!text) throw new Error('nothing to encode');
  const qr = QRCode.create(text, { errorCorrectionLevel: level === 'L' ? 'M' : level });
  const { size, data } = qr.modules;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = [];
    for (let x = 0; x < size; x += 1) row.push(Boolean(data[y * size + x]));
    rows.push(row);
  }
  return { size, rows, version: qr.version };
}

export default {
  sourceLinksEnabled,
  normaliseSource,
  sourceProblem,
  whatsappNumber,
  placeholderNumber,
  readableNumber,
  sourceLabel,
  defaultMessage,
  sanitiseLinkText,
  buildMessage,
  linkForNumber,
  listTrackedSources,
  trackedSource,
  trackedSourceByCode,
  createSource,
  sourceLink,
  stripSourceMarker,
  contactSource,
  attributeSource,
  sourceCounts,
  sourceSummary,
  sourceLines,
  qrPng,
  qrSvg,
  qrMatrix,
  MAX_SOURCES,
};
