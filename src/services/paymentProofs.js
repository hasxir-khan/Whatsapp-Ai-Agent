/**
 * Payment proofs: the file, the reading, and the checks that need no judgement.
 *
 * A screenshot is a claim, not a payment. This module never decides whether a
 * proof is "real" — it reports what it could read, what the deterministic
 * checks say (pass / fail / unknown), and a risk level. A person decides.
 *
 * Three rules are enforced here, in code:
 *   • the file lives in the tenant folder only, mode 0600;
 *   • account and card numbers are masked to the last four before they reach a
 *     log, a prompt, a card or the database;
 *   • text inside an image is DATA. Anything that looks like an instruction is
 *     neutralised before it is shown or used.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { run, get, all } from '../utils/db.js';
import { neutralise } from '../core/injection.js';
import { decisionSettings } from './decisionTeam.js';

const iso = (d) => (d instanceof Date ? d : new Date(d || Date.now())).toISOString();
const safeJson = (raw, fallback = null) => {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

/** Where proofs live: inside the tenant's own folder, never a shared one. */
export function proofDir() {
  return path.resolve(config.paths.data, 'proofs');
}

function ensureDir() {
  const dir = proofDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// ── masking ─────────────────────────────────────────────────
/** `••••1234` — the only way an account number leaves this module. */
export function maskAccount(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 4) return String(value || '');
  return `••••${digits.slice(-4)}`;
}

const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

/** Detect a card-shaped number by its prefix; masking alone is not enough. */
export function looksLikeCard(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  // Visa/Mastercard/Amex/UnionPay ranges. A run of digits with no such prefix
  // is an account number or a transaction id, both of which we mask too.
  return /^(4|5[1-5]|2[2-7]|3[47]|62|6[0-9])/.test(d);
}

/**
 * Everything a person (or a model) reads from a proof goes through here: card
 * numbers and long account numbers become their last four, and text that tries
 * to give instructions is neutralised.
 */
export function maskProofText(text) {
  let out = String(text || '');
  let cardSeen = false;
  out = out.replace(CARD_RE, (match) => {
    const digits = match.replace(/\D/g, '');
    if (!looksLikeCard(digits)) return match;
    cardSeen = true;
    return maskAccount(digits);
  });
  // Account numbers (10–18 digits) and IBAN-ish tails: keep the last four.
  out = out.replace(/\b\d{10,18}\b/g, (digits) => {
    if (looksLikeCard(digits)) return digits; // already replaced above
    return maskAccount(digits);
  });
  return { text: out, cardSeen };
}

// ── extraction ──────────────────────────────────────────────
const AMOUNT_PATTERNS = [
  /(?:rs\.?|pkr|inr|aed|usd|\$|₹|₨)\s*([\d,]+(?:\.\d{1,2})?)/i,
  /([\d,]+(?:\.\d{1,2})?)\s*(?:rs\.?|pkr|rupees|only)\b/i,
  /amount[:\s]+([\d,]+(?:\.\d{1,2})?)/i,
];

const CURRENCY_RE = /\b(PKR|INR|AED|USD|EUR|SAR)\b|rs\.?|₨|₹|\$|rupees/i;
const REFERENCE_RE = /\b(?:tid|trx|txn|ref(?:erence)?|transaction(?:\s*id)?)\b[:\s#-]*([A-Z0-9-]{4,24})/i;
const PROVIDER_RE = /\b(jazzcash|easypaisa|easypay|sadapay|ubl|hbl|mcb|meezan|bank\s*alfalah|habib\s*bank|raast|nayapay|sbi|paytm|gpay|google\s*pay|phonepe)\b/i;
const STATUS_RE = /\b(successful|success|completed|complete|paid|sent|received|pending|processing|failed|declined|reversed)\b/i;
const DATE_PATTERNS = [
  /\b(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})\b/,
  /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ ,]+(\d{1,2}):(\d{2}))?\b/,
  /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i,
];
const RECEIVER_RE = /\b(?:to|paid\s*to|receiver|beneficiary|account\s*title)[:\s]+([A-Za-z][A-Za-z .'-]{2,40})/i;
const ACCOUNT_TAIL_RE = /(?:\*{2,}|x{2,}|•{2,}|\.{3})\s*(\d{4})\b/i;
const RECEIPT_WORDS = /receipt|payment|paid|transfer|transaction|screenshot|deposit|sent|رسید|ادائیگی|بھیج|transfer\s*kiya|paisa|payment\s*kar/i;

const cleanNumber = (raw) => {
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Is this text (or caption) plausibly about a payment? */
export function looksLikePaymentProof(text) {
  return RECEIPT_WORDS.test(String(text || ''));
}

/**
 * Read the fields out of text we already have (a caption, an OCR/vision
 * description, or a typed message). Every field carries a confidence, because
 * "unknown" is a legitimate answer and must not be dressed up as "yes".
 */
export function extractFields(text) {
  const raw = String(text || '');
  const { text: masked, cardSeen } = maskProofText(neutralise(raw));

  let amount = null;
  let amountConfidence = 0;
  for (const re of AMOUNT_PATTERNS) {
    const m = re.exec(masked);
    if (m) {
      const n = cleanNumber(m[1]);
      if (n && n > 0) {
        amount = n;
        amountConfidence = 0.9;
        break;
      }
    }
  }

  const currencyMatch = CURRENCY_RE.exec(masked);
  const currency = currencyMatch ? normalizeCurrency(currencyMatch[0]) : null;

  const refMatch = REFERENCE_RE.exec(masked);
  const providerMatch = PROVIDER_RE.exec(masked);
  const statusMatch = STATUS_RE.exec(masked);
  const receiverMatch = RECEIVER_RE.exec(masked);
  const tailMatch = ACCOUNT_TAIL_RE.exec(masked);

  let occurredAt = null;
  let dateConfidence = 0;
  for (const re of DATE_PATTERNS) {
    const m = re.exec(masked);
    if (!m) continue;
    const parsed = parseDateMatch(m);
    if (parsed) {
      occurredAt = parsed.toISOString();
      dateConfidence = 0.7;
      break;
    }
  }

  return {
    amount,
    amountConfidence,
    currency,
    currencyConfidence: currency ? 0.8 : 0,
    reference: refMatch ? refMatch[1].toUpperCase() : null,
    referenceConfidence: refMatch ? 0.8 : 0,
    provider: providerMatch ? titleCase(providerMatch[1]) : null,
    providerConfidence: providerMatch ? 0.7 : 0,
    status: statusMatch ? statusMatch[1].toLowerCase() : null,
    statusConfidence: statusMatch ? 0.6 : 0,
    receiver: receiverMatch ? receiverMatch[1].trim() : null,
    receiverConfidence: receiverMatch ? 0.5 : 0,
    accountTail: tailMatch ? tailMatch[1] : null,
    occurredAt,
    dateConfidence,
    cardSeen,
    text: masked.slice(0, 600),
    read: Boolean(amount || refMatch || providerMatch || statusMatch || dateConfidence),
  };
}

function normalizeCurrency(raw) {
  const s = String(raw || '').toUpperCase();
  if (s.includes('PKR') || s.includes('RS') || s.includes('₨') || s.includes('RUPEE')) return 'PKR';
  if (s.includes('INR') || s.includes('₹')) return 'INR';
  if (s === 'AED' || s === 'USD' || s === 'EUR' || s === 'SAR') return s;
  if (s.includes('$')) return 'USD';
  return null;
}

function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function parseDateMatch(m) {
  try {
    if (m.length >= 5 && m[1] && m[1].length === 4) {
      return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`);
    }
    if (m.length >= 3 && m[3] && m[3].length === 4) {
      const day = Number(m[1]);
      const month = Number(m[2]);
      const year = Number(m[3]);
      const hour = m[4] ? Number(m[4]) : 12;
      const minute = m[5] ? Number(m[5]) : 0;
      if (day < 1 || day > 31 || month < 1 || month > 12) return null;
      return new Date(Date.UTC(year, month - 1, day, hour, minute));
    }
  } catch {
    return null;
  }
  return null;
}

// ── deterministic checks ────────────────────────────────────
/**
 * The checks a computer can make without an opinion. Each one is pass, fail or
 * unknown — "unknown" is not a soft fail, it is an honest "we could not read
 * this", and the risk level treats the two differently.
 */
export function runChecks({ extracted = {}, order = null, proofs = [], now = new Date(), settings = null, context = null } = {}) {
  const s = settings || decisionSettings();
  const checks = [];
  const push = (id, label, status, detail) => checks.push({ id, label, status, detail });

  const profileBusiness = context?.business ?? config.owner?.profile?.business ?? {};
  const currency = order?.currency || profileBusiness.currency || 'PKR';
  const due = order ? Math.max(0, (Number(order.total) || 0) - (Number(order.paid_amount) || 0)) : null;

  // amount vs what is actually due
  if (extracted.amount === null || extracted.amount === undefined) {
    push('amount', 'Amount matches what is due', 'unknown', 'No amount could be read from the proof.');
  } else if (due === null) {
    push('amount', 'Amount matches what is due', 'unknown', 'No open order to compare against.');
  } else if (extracted.amount === due) {
    push('amount', 'Amount matches what is due', 'pass', `Proof says ${extracted.amount}; the order due is ${due}.`);
  } else if (extracted.amount < due) {
    push('amount', 'Amount matches what is due', 'fail', `Proof says ${extracted.amount}, which is short of ${due} (partial).`);
  } else {
    push('amount', 'Amount matches what is due', 'fail', `Proof says ${extracted.amount}, more than the ${due} due.`);
  }

  // currency
  if (!extracted.currency) push('currency', 'Currency matches the order', 'unknown', 'Currency was not readable.');
  else if (String(extracted.currency).toUpperCase() === String(currency).toUpperCase()) {
    push('currency', 'Currency matches the order', 'pass', `Both say ${currency}.`);
  } else push('currency', 'Currency matches the order', 'fail', `Proof says ${extracted.currency}; the order is in ${currency}.`);

  // receiver: the last four of the shop's account, or its name
  const configured = profileBusiness.payment || {};
  const tail = String(configured.accountTail || configured.account || '').replace(/\D/g, '').slice(-4);
  const name = String(configured.accountName || configured.name || '').toLowerCase();
  const receiverText = `${extracted.receiver || ''} ${extracted.text || ''}`.toLowerCase();
  if ((tail && extracted.accountTail) || name) {
    const tailOk = tail && extracted.accountTail && String(extracted.accountTail).slice(-4) === tail;
    const nameOk = name && name.split(/\s+/).some((w) => w.length > 2 && receiverText.includes(w));
    if (tailOk || nameOk) push('receiver', 'Receiver looks like this business', 'pass', tailOk ? `Account tail matches ••••${tail}.` : 'Receiver name matches the configured account name.');
    else if (extracted.accountTail || extracted.receiver) push('receiver', 'Receiver looks like this business', 'fail', 'The receiver does not match the configured account.');
    else push('receiver', 'Receiver looks like this business', 'unknown', 'No receiver name or account tail could be read.');
  } else {
    push('receiver', 'Receiver looks like this business', 'unknown', 'No business payment account is configured to compare with.');
  }

  // date: after the order was created, and not in the future
  const created = order?.created_at ? new Date(order.created_at) : null;
  const occurred = extracted.occurredAt ? new Date(extracted.occurredAt) : null;
  if (!occurred || Number.isNaN(occurred.getTime())) {
    push('date', 'Payment date is plausible', 'unknown', 'No date could be read from the proof.');
  } else if (occurred.getTime() > new Date(now).getTime() + 10 * 60_000) {
    push('date', 'Payment date is plausible', 'fail', `The proof is dated ${occurred.toISOString()}, which is in the future.`);
  } else if (created && occurred.getTime() < created.getTime() - 24 * 3600_000) {
    push('date', 'Payment date is plausible', 'fail', `The proof is dated before the order was placed (${order.created_at}).`);
  } else {
    push('date', 'Payment date is plausible', 'pass', `Dated ${occurred.toISOString()}.`);
  }

  // duplicate reference, any order, any customer
  if (extracted.reference) {
    const dup = proofs.find((p) => p.extracted?.reference && String(p.extracted.reference).toUpperCase() === String(extracted.reference).toUpperCase());
    if (dup) push('reference', 'Transaction reference is new', 'fail', `Reference ${extracted.reference} was already used (${dup.id}).`);
    else push('reference', 'Transaction reference is new', 'pass', `Reference ${extracted.reference} has not been seen before.`);
  } else {
    push('reference', 'Transaction reference is new', 'unknown', 'No transaction reference could be read.');
  }

  // duplicate image, by hash
  if (extracted.sha256) {
    const dup = proofs.find((p) => p.sha256 && p.sha256 === extracted.sha256);
    if (dup) push('image', 'This exact image is new', 'fail', `The same image was already submitted (${dup.id}).`);
    else push('image', 'This exact image is new', 'pass', 'This exact image has not been submitted before.');
  }

  // the order must still be waiting
  if (order) {
    if (order.status === 'paid') push('order', 'The order is still waiting for payment', 'fail', 'This order is already marked paid.');
    else if (order.status === 'awaiting_payment') push('order', 'The order is still waiting for payment', 'pass', 'The order is awaiting payment.');
    else push('order', 'The order is still waiting for payment', 'unknown', `The order is ${order.status}.`);
  }

  // submission rate: five proofs a customer a day is plenty
  const today = context?.submitted ?? (all(
    "SELECT COUNT(*) AS n FROM payment_proofs WHERE contact = ? AND created_at >= ?",
    [String(order?.chat || '').split('@')[0].replace(/\D/g, '') || null, iso(new Date(new Date(now).getTime() - 24 * 3600_000))]
  )[0]?.n || 0);
  if (Number(today) >= s.maxProofsPerDay) {
    push('rate', 'Not too many proofs today', 'fail', `${today} proofs in the last 24 hours (limit ${s.maxProofsPerDay}).`);
  } else {
    push('rate', 'Not too many proofs today', 'pass', `${today} proof${Number(today) === 1 ? '' : 's'} in the last 24 hours.`);
  }

  // image metadata: a low-weight hint, labelled as such and never decisive
  if (extracted.metadata?.edited) {
    push('metadata', 'Image has no edit traces', 'unknown', 'The image carries metadata that can appear after editing. This is a heuristic only and does not decide anything.');
  }

  return checks;
}

const FAIL_HEAVY = ['reference', 'image', 'order'];
const FAIL_SOFT = ['amount', 'currency', 'receiver', 'date', 'rate'];

/**
 * Risk is a summary of the checks, never a verdict. `inconsistent` means a
 * check that cannot be explained away failed; `needs_attention` means a person
 * should look; `consistent` means nothing contradicted the claim.
 */
export function riskFromChecks(checks = []) {
  const failed = checks.filter((c) => c.status === 'fail');
  const heavy = failed.filter((c) => FAIL_HEAVY.includes(c.id));
  const soft = failed.filter((c) => FAIL_SOFT.includes(c.id));
  const reasons = failed.map((c) => c.detail);
  if (heavy.length) return { risk: 'inconsistent', reasons, failed: failed.length };
  if (soft.length >= 2) return { risk: 'inconsistent', reasons, failed: failed.length };
  if (soft.length === 1) return { risk: 'needs_attention', reasons, failed: failed.length };
  const unknown = checks.filter((c) => c.status === 'unknown');
  if (unknown.length >= 3) return { risk: 'needs_attention', reasons: unknown.map((c) => c.detail), failed: 0 };
  return { risk: 'consistent', reasons: [], failed: 0 };
}

/** A one-line human summary of the risk, used on the card and in the timeline. */
export function riskLine(risk) {
  if (risk === 'consistent') return 'consistent with the order';
  if (risk === 'inconsistent') return 'inconsistent — please look before confirming';
  return 'needs attention — some things could not be checked';
}

// ── storage ─────────────────────────────────────────────────
/**
 * Keep the proof file. Named by hash so two uploads of the same image are the
 * same file, and mode 0600 because it is a customer's bank screenshot.
 */
export function saveProofFile({ buffer, mimetype = 'image/jpeg', now = new Date() } = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const ext = mimetype.includes('pdf') ? 'pdf' : mimetype.includes('png') ? 'png' : mimetype.includes('text') ? 'txt' : 'jpg';
  const dir = ensureDir();
  const name = `${new Date(now).toISOString().slice(0, 10)}-${sha256.slice(0, 16)}.${ext}`;
  const full = path.join(dir, name);
  if (!fs.existsSync(full)) {
    fs.writeFileSync(full, bytes, { mode: 0o600 });
    try {
      fs.chmodSync(full, 0o600);
    } catch {
      /* a filesystem without modes (tmpfs on some CI images) */
    }
  }
  return { file: path.relative(proofDir(), full), sha256, bytes: bytes.length, mimetype, full };
}

export function recordProof({ id, requestId = null, contact, orderId = null, kind = 'image', saved, extracted = {}, checks = [], risk = 'needs_attention', now = new Date(), retentionDays = 90 }) {
  const created = iso(now);
  const expires = iso(new Date(new Date(now).getTime() + Number(retentionDays) * 24 * 3600_000));
  run(
    `INSERT INTO payment_proofs (id, request_id, contact, order_id, kind, file, sha256, mimetype, bytes, extracted, checks, risk, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, requestId, String(contact || '').replace(/\D/g, ''), orderId, kind, saved?.file || null, saved?.sha256 || null, saved?.mimetype || null, saved?.bytes || 0, JSON.stringify(extracted || {}), JSON.stringify(checks || []), risk, created, expires]
  );
  return getProof(id);
}

export function getProof(id) {
  const row = get('SELECT * FROM payment_proofs WHERE id = ?', [id]);
  return row ? hydrateProof(row) : null;
}

export function hydrateProof(row) {
  return { ...row, extracted: safeJson(row.extracted, {}), checks: safeJson(row.checks, []) };
}

export function proofsForRequest(requestId) {
  return all('SELECT * FROM payment_proofs WHERE request_id = ? ORDER BY created_at ASC', [requestId]).map(hydrateProof);
}

/** Recent proofs, for duplicate checks across orders and customers. */
export function recentProofs({ limit = 500, sinceDays = 120, now = new Date() } = {}) {
  const since = iso(new Date(new Date(now).getTime() - sinceDays * 24 * 3600_000));
  return all('SELECT * FROM payment_proofs WHERE deleted_at IS NULL AND created_at >= ? ORDER BY created_at DESC LIMIT ?', [since, limit]).map(hydrateProof);
}

export function attachProofToRequest(proofId, requestId) {
  run('UPDATE payment_proofs SET request_id = ? WHERE id = ?', [requestId, proofId]);
}

/**
 * Retention: after N days the file is deleted and the row is marked, so the
 * decision history stays (accounting needs it) without the screenshot.
 */
export function purgeExpiredProofs({ now = new Date() } = {}) {
  const rows = all('SELECT * FROM payment_proofs WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?', [iso(now)]);
  let deleted = 0;
  for (const row of rows) {
    try {
      const full = row.file ? path.join(proofDir(), row.file) : null;
      if (full && fs.existsSync(full)) fs.unlinkSync(full);
    } catch {
      /* a file that is already gone counts as purged */
    }
    run('UPDATE payment_proofs SET deleted_at = ? WHERE id = ?', [iso(now), row.id]);
    deleted += 1;
  }
  return { deleted };
}

/** Remove every proof for a customer — used by `.forget`. */
export function forgetProofsFor(contact) {
  const rows = all('SELECT * FROM payment_proofs WHERE contact = ? AND deleted_at IS NULL', [String(contact || '').replace(/\D/g, '')]);
  let deleted = 0;
  for (const row of rows) {
    try {
      const full = row.file ? path.join(proofDir(), row.file) : null;
      if (full && fs.existsSync(full)) fs.unlinkSync(full);
    } catch {
      /* ignore */
    }
    run('UPDATE payment_proofs SET deleted_at = ? WHERE id = ?', [iso(new Date()), row.id]);
    deleted += 1;
  }
  return { deleted };
}

/** What `.export` includes: the reading and the checks, never the image bytes. */
export function proofsForExport(contact) {
  return all('SELECT * FROM payment_proofs WHERE contact = ? ORDER BY created_at ASC', [String(contact || '').replace(/\D/g, '')]).map(hydrateProof);
}

export default {
  proofDir,
  maskAccount,
  maskProofText,
  looksLikeCard,
  looksLikePaymentProof,
  extractFields,
  runChecks,
  riskFromChecks,
  riskLine,
  saveProofFile,
  recordProof,
  getProof,
  proofsForRequest,
  recentProofs,
  attachProofToRequest,
  purgeExpiredProofs,
  forgetProofsFor,
  proofsForExport,
};
