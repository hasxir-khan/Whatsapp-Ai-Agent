import {billingExport} from './billing/privacy.js';
import {numberId} from './numberIdentity.js';
// platform/accounts.js
// Who a customer of the platform is.
//
// Two steps, on purpose: an email gets a six-digit code, and only that code can
// turn into a password. This is what keeps a typo'd address from becoming an
// account nobody can recover, and it is the only proof of email ownership the
// platform has.
//
// Rules that are easy to state and are all tested:
//   • the code lives 10 minutes, allows 5 attempts, is single-use, and is
//     stored as an HMAC (never the digits themselves);
//   • passwords are scrypt with a per-user salt;
//   • signup is rate limited per email and per IP, resets the same way;
//   • consent is recorded with its version and the time it was given;
//   • deletion exports first, then scrubs — nothing lingers in a "deleted but
//     readable" state.

import {
  hashPassword, verifyPassword, passwordProblem, randomId, sixDigitCode, hashOtp, otpMatches,
} from './crypto.js';
import { ensureOpen, get, all, run } from './db.js';
import { OTP, CONSENT, platformSecret, trialDays, dashboardEnabled } from './env.js';
import { recordAudit } from './audit.js';
import { rateLimit } from '../src/services/adminPanel.js';
import { sendMail, showCodesInResponse } from './mailer.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

// A short, honest list. Anything here is a *flag*, and only refused outright
// when PLATFORM_BLOCK_DISPOSABLE=1 — the owner decides, the code does not.
const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'yopmail.com', 'sharklasers.com', 'trashmail.com', 'getnada.com', 'dispostable.com',
  'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'emailondeck.com', 'mohmal.com',
]);

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function emailProblem(email) {
  const value = normalizeEmail(email);
  if (!value) return 'Enter an email address.';
  if (value.length > 200) return 'That email address is too long.';
  if (!EMAIL_RE.test(value)) return 'That does not look like an email address.';
  return null;
}

export function emailDomain(email) {
  return normalizeEmail(email).split('@')[1] || '';
}

export function isDisposable(email) {
  return DISPOSABLE.has(emailDomain(email));
}

export function findByEmail(email) {
  return get('SELECT * FROM accounts WHERE email_norm = ?', [normalizeEmail(email)]);
}

export function getAccount(id) {
  if (!id) return null;
  return get('SELECT * FROM accounts WHERE id = ?', [String(id)]) || null;
}

/** Terms and privacy accepted at signup, with the versions that applied. */
export function recordConsent(accountId, { ip = null, now = new Date() } = {}) {
  const at = new Date(now).toISOString();
  for (const [kind, version] of [['terms', CONSENT.terms], ['privacy', CONSENT.privacy]]) {
    run('INSERT INTO consents (id, account_id, kind, version, accepted_at, ip) VALUES (?, ?, ?, ?, ?, ?)', [
      randomId(12), accountId, kind, version, at, ip,
    ]);
  }
  return { terms: CONSENT.terms, privacy: CONSENT.privacy, at };
}

export function consentStatus(account) {
  if (!account) return { ok: false, missing: ['terms', 'privacy'] };
  const latest = all(
    "SELECT kind, version FROM consents WHERE account_id = ? AND kind IN ('terms','privacy') ORDER BY accepted_at DESC",
    [account.id],
  );
  const seen = Object.fromEntries(latest.map((row) => [row.kind, row.version]));
  const missing = [];
  if (seen.terms !== CONSENT.terms) missing.push('terms');
  if (seen.privacy !== CONSENT.privacy) missing.push('privacy');
  return { ok: missing.length === 0, missing, versions: seen };
}

// ── one-time codes ───────────────────────────────────────────
/**
 * Create a code for `email`. Rate limited per address (not per account, so an
 * attacker cannot spray codes at someone by making accounts).
 */
export function createOtp({ email, purpose, accountId = null, now = Date.now(), ip = null }) {
  ensureOpen();
  const address = normalizeEmail(email);
  const limited = rateLimit(`otp:${address}`, { max: 5, windowMs: 15 * 60000, now: Number(now) });
  if (!limited.ok) return { ok: false, reason: 'too_many_codes', retryAfter: limited.retryAfter };
  if (ip) {
    const byIp = rateLimit(`otp-ip:${ip}`, { max: 20, windowMs: 15 * 60000, now: Number(now) });
    if (!byIp.ok) return { ok: false, reason: 'too_many_codes', retryAfter: byIp.retryAfter };
  }

  // One live code per purpose: a second request replaces the first, so an old
  // email in an inbox cannot be replayed after a resend.
  run('UPDATE otp_codes SET consumed_at = ? WHERE email = ? AND purpose = ? AND consumed_at IS NULL', [
    new Date(Number(now)).toISOString(), address, purpose,
  ]);

  const code = sixDigitCode();
  const salt = randomId(9);
  const created = new Date(Number(now));
  const expires = new Date(Number(now) + OTP.minutes * 60000);
  run(
    `INSERT INTO otp_codes (id, email, account_id, purpose, code_hash, salt, attempts, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      randomId(12), address, accountId, purpose,
      hashOtp(platformSecret(), { email: address, purpose, code, salt }),
      salt, created.toISOString(), expires.toISOString(),
    ],
  );
  return { ok: true, code, expiresAt: expires.toISOString() };
}

/**
 * Which code is this person trying to type: a signup ticket, or a
 * "you already have an account" login code? Answered by what is live in the
 * table, never by trying both and keeping whichever answer looks nicer.
 */
export function pendingPurpose({ email, purpose = null, now = Date.now() } = {}) {
  const address = normalizeEmail(email);
  const stamp = new Date(Number(now)).toISOString();
  const live = (p) => {
    const row = get(
      'SELECT * FROM otp_codes WHERE email = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1',
      [address, p],
    );
    if (!row || row.consumed_at) return null;
    if (row.expires_at < stamp) return null;
    if (Number(row.attempts) >= OTP.maxAttempts) return null;
    return row;
  };
  if (purpose) return purpose;
  const signup = get(
    'SELECT * FROM otp_codes WHERE email = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1',
    [address, 'signup'],
  );
  // A code that was burned by five wrong guesses is still *this* flow: saying
  // "no code" there would send the customer looking for a mail that never comes.
  const burned = signup && signup.consumed_at && Number(signup.attempts) >= OTP.maxAttempts;
  return live('signup') || burned ? 'signup' : 'login';
}

/** Check and (on success) consume a code. Every failure costs an attempt. */
export function verifyOtp({ email, purpose, code, now = Date.now() }) {
  ensureOpen();
  const address = normalizeEmail(email);
  // The *latest* code, used or not: a row that was burned by five wrong guesses
  // and a row that was used correctly are different answers, and a customer who
  // ran out of attempts deserves to be told that instead of "no code".
  const row = get(
    'SELECT * FROM otp_codes WHERE email = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1',
    [address, purpose],
  );
  const stamp = new Date(Number(now)).toISOString();
  if (!row) return { ok: false, reason: 'no_code' };
  if (row.consumed_at) {
    return {
      ok: false,
      reason: Number(row.attempts) >= OTP.maxAttempts ? 'too_many_attempts' : 'no_code',
      attemptsLeft: Number(row.attempts) >= OTP.maxAttempts ? 0 : undefined,
    };
  }
  if (row.expires_at < stamp) {
    run('UPDATE otp_codes SET consumed_at = ? WHERE id = ?', [stamp, row.id]);
    return { ok: false, reason: 'expired' };
  }
  if (Number(row.attempts) >= OTP.maxAttempts) {
    run('UPDATE otp_codes SET consumed_at = ? WHERE id = ?', [stamp, row.id]);
    return { ok: false, reason: 'too_many_attempts' };
  }
  if (!otpMatches(platformSecret(), row, String(code ?? '').trim())) {
    run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
    const left = OTP.maxAttempts - (Number(row.attempts) + 1);
    if (left <= 0) {
      run('UPDATE otp_codes SET consumed_at = ? WHERE id = ?', [stamp, row.id]);
      return { ok: false, reason: 'too_many_attempts', attemptsLeft: 0 };
    }
    return { ok: false, reason: 'wrong_code', attemptsLeft: Math.max(0, left) };
  }
  run('UPDATE otp_codes SET consumed_at = ? WHERE id = ?', [stamp, row.id]);
  return { ok: true, email: address, accountId: row.account_id || null };
}

async function deliverCode({ email, purpose, code, expiresAt }) {
  const subject = purpose === 'reset' ? 'Reset your assistant password' : 'Your sign-in code';
  const sent = await sendMail({
    to: email,
    subject,
    text: `Your code is ${code}. It expires at ${expiresAt} (UTC). If this was not you, ignore this email.`,
  });
  return sent;
}

function codeEnvelope(result) {
  return showCodesInResponse() && result.ok ? { devCode: result.code, devExpiresAt: result.expiresAt } : {};
}

// ── signup ───────────────────────────────────────────────────
/**
 * Step 1. Creates the account in an unverified state (or reuses an unverified
 * one) and sends the code. Consent is required *before* the code is issued,
 * because "we emailed you" is already processing personal data.
 */
export async function signupStart({ email, terms = false, privacy = false, ip = null, now = Date.now() }) {
  ensureOpen();
  const problem = emailProblem(email);
  if (problem) return { ok: false, status: 400, error: 'bad_email', message: problem };
  if (!terms || !privacy) {
    return {
      ok: false,
      status: 400,
      error: 'consent_required',
      message: 'Please accept the terms and the privacy notice to continue.',
      versions: CONSENT,
    };
  }
  const blocked = rateLimit(`signup:${normalizeEmail(email)}`, { max: 5, windowMs: 60 * 60000, now: Number(now) });
  if (!blocked.ok) return { ok: false, status: 429, error: 'too_many_requests', retryAfter: blocked.retryAfter };
  if (ip) {
    const byIp = rateLimit(`signup-ip:${ip}`, { max: 10, windowMs: 60 * 60000, now: Number(now) });
    if (!byIp.ok) return { ok: false, status: 429, error: 'too_many_requests', retryAfter: byIp.retryAfter };
  }

  const address = normalizeEmail(email);
  const existing = findByEmail(address);
  if (existing && existing.status !== 'active') {
    return { ok: false, status: 409, error: 'account_closed', message: 'That email belongs to a closed account.' };
  }
  if (existing && existing.email_verified) {
    // Do not confirm or deny: the answer is the same as "we sent a code", and
    // the mail says "you already have an account".
    const otp = createOtp({ email: address, purpose: 'login', accountId: existing.id, now, ip });
    if (!otp.ok) return { ok: false, status: 429, error: otp.reason, retryAfter: otp.retryAfter };
    const sent = await deliverCode({ email: address, purpose: 'login', code: otp.code, expiresAt: otp.expiresAt });
    if (!sent.ok) return { ok: false, status: 503, error: 'email_delivery_unavailable' };
    return { ok: true, existing: true, ...codeEnvelope(otp) };
  }

  let account = existing;
  if (!account) {
    account = {
      id: randomId(16),
      email: address,
      created_at: new Date(Number(now)).toISOString(),
    };
    run(
      `INSERT INTO accounts (id, email, email_norm, role, status, email_verified, disposable_domain, created_at)
       VALUES (?, ?, ?, 'owner', 'active', 0, ?, ?)`,
      [account.id, address, address, isDisposable(address) ? 1 : 0, account.created_at],
    );
  }

  const otp = createOtp({ email: address, purpose: 'signup', accountId: account.id, now, ip });
  if (!otp.ok) return { ok: false, status: 429, error: otp.reason, retryAfter: otp.retryAfter };
  const delivery = await deliverCode({ email: address, purpose: 'signup', code: otp.code, expiresAt: otp.expiresAt });
  if (!delivery.ok) return { ok: false, status: 503, error: 'email_delivery_unavailable' };
  return {
    ok: true,
    email: address,
    delivery: delivery.mode,
    consent: recordConsent(account.id, { ip, now }),
    ...codeEnvelope(otp),
  };
}

/** Step 2: the code proves the address, the password opens the account. */
export function signupVerify({ email, code, password, now = Date.now(), ip = null }) {
  ensureOpen();
  const problem = emailProblem(email);
  if (problem) return { ok: false, status: 400, error: 'bad_email', message: problem };
  const pwProblem = passwordProblem(password);
  if (pwProblem) return { ok: false, status: 400, error: 'weak_password', message: pwProblem };

  const address = normalizeEmail(email);
  // A signup code and a "you already have an account" code are both proof of the
  // same thing: this person reads this inbox. Which one is in play is decided
  // *before* a digit is checked — an open signup ticket means this is a signup,
  // otherwise it is the "already registered" flow. Guessing must not spend the
  // attempts of a code the customer is holding, and the reason a guess failed
  // must be the reason of the code that was actually being checked.
  const purpose = pendingPurpose({ email: address, now });
  const checked = verifyOtp({ email: address, purpose, code, now });
  if (!checked.ok) return { ok: false, status: 400, error: checked.reason, attemptsLeft: checked.attemptsLeft };

  const account = findByEmail(address);
  if (!account) return { ok: false, status: 404, error: 'no_account' };
  if (account.status !== 'active') return { ok: false, status: 403, error: 'account_closed' };

  // Setting a password this way is a password *change* for an account that
  // already had one (the "you already have an account" code path), so it gets
  // the same consequence a reset has: every other session ends.
  if (account.password_hash) {
    run('UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL', [
      new Date(Number(now)).toISOString(), account.id,
    ]);
  }
  run('UPDATE accounts SET password_hash = ?, email_verified = 1, last_login_at = ? WHERE id = ?', [
    hashPassword(password), new Date(Number(now)).toISOString(), account.id,
  ]);
  return { ok: true, account: getAccount(account.id), ip };
}

// ── login / logout / reset ───────────────────────────────────
/**
 * A hash to compare against when there is no account, so a login attempt costs
 * the same scrypt work whether the address exists or not. A missing account used
 * to answer in under a millisecond while a real one took tens: a free oracle for
 * "is this email registered?".
 */
let dummyHash = null;
function placeholderHash() {
  if (!dummyHash) dummyHash = hashPassword('login-timing-placeholder-not-a-password');
  return dummyHash;
}

/** Synchronous and side-effect free apart from the rate limiter, so it is easy to reason about. */
export function login({ email, password, ip = null, now = Date.now() }) {
  ensureOpen();
  const address = normalizeEmail(email);
  const byEmail = rateLimit(`login:${address}`, { max: 8, windowMs: 15 * 60000, now: Number(now) });
  const byIp = ip ? rateLimit(`login-ip:${ip}`, { max: 20, windowMs: 15 * 60000, now: Number(now) }) : { ok: true };
  if (!byEmail.ok) return { ok: false, status: 429, error: 'too_many_attempts', retryAfter: byEmail.retryAfter };
  if (!byIp.ok) return { ok: false, status: 429, error: 'too_many_attempts', retryAfter: byIp.retryAfter };

  const account = findByEmail(address);
  // Same answer, same work, whether the account exists or not.
  const valid = verifyPassword(password, account?.password_hash || placeholderHash());
  if (!account || !valid || account.status !== 'active' || !account.email_verified) {
    return { ok: false, status: 401, error: 'bad_credentials', message: 'Email or password is not right.' };
  }
  run('UPDATE accounts SET last_login_at = ? WHERE id = ?', [new Date(Number(now)).toISOString(), account.id]);
  return { ok: true, account: getAccount(account.id) };
}

export async function passwordResetStart({ email, ip = null, now = Date.now() }) {
  ensureOpen();
  const problem = emailProblem(email);
  if (problem) return { ok: false, status: 400, error: 'bad_email', message: problem };
  const address = normalizeEmail(email);
  const limited = rateLimit(`reset:${address}`, { max: 3, windowMs: 60 * 60000, now: Number(now) });
  if (!limited.ok) return { ok: false, status: 429, error: 'too_many_requests', retryAfter: limited.retryAfter };

  const account = findByEmail(address);
  if (!account || account.status !== 'active') {
    // Always the same answer: an attacker learns nothing about who is registered.
    return { ok: true, requested: true };
  }
  const otp = createOtp({ email: address, purpose: 'reset', accountId: account.id, now, ip });
  if (!otp.ok) return { ok: false, status: 429, error: otp.reason, retryAfter: otp.retryAfter };
  const delivery = await deliverCode({ email: address, purpose: 'reset', code: otp.code, expiresAt: otp.expiresAt });
  // Do not turn a mail outage into an account-existence oracle. Externally
  // acknowledge a request, not delivery; operators see failures in the audit.
  if (!delivery.ok) recordAudit({ action: 'reset_email_failed', accountId: account.id, ok: false });
  return { ok: true, requested: true, ...(delivery.ok ? codeEnvelope(otp) : {}) };
}

export function passwordResetComplete({ email, code, password, now = Date.now() }) {
  ensureOpen();
  const problem = passwordProblem(password);
  if (problem) return { ok: false, status: 400, error: 'weak_password', message: problem };
  const checked = verifyOtp({ email, purpose: 'reset', code, now });
  if (!checked.ok) return { ok: false, status: 400, error: checked.reason, attemptsLeft: checked.attemptsLeft };
  const account = findByEmail(email);
  if (!account || account.status !== 'active') return { ok: false, status: 404, error: 'no_account' };
  run('UPDATE accounts SET password_hash = ? WHERE id = ?', [hashPassword(password), account.id]);
  // A reset invalidates every other session: that is the point of a reset.
  run('UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL', [
    new Date(Number(now)).toISOString(), account.id,
  ]);
  return { ok: true, account: getAccount(account.id) };
}

// ── trial abuse ──────────────────────────────────────────────
/**
 * One trial per WhatsApp number. Returns `trialing:false` rather than throwing:
 * the signup still works, the plan simply starts without the free days.
 */
export function claimTrial({ accountId, number, now = Date.now() }) {
  ensureOpen();
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits) return { ok: false, trialing: false, reason: 'no_number' };
  const handle = numberId(digits, get('SELECT salt FROM number_identity_salt').salt);
  const seen = get('SELECT * FROM trial_numbers WHERE number = ?', [handle]);
  if (seen && seen.account_id !== accountId) {
    return { ok: false, trialing: false, reason: 'number_already_trialed' };
  }
  if (!seen) {
    run('INSERT INTO trial_numbers (number, account_id, granted_at) VALUES (?, ?, ?)', [
      handle, accountId, new Date(Number(now)).toISOString(),
    ]);
  }
  run('UPDATE accounts SET trial_seen = 1 WHERE id = ?', [accountId]);
  return { ok: true, trialing: true, days: trialDays() };
}

// ── export / deletion ────────────────────────────────────────
/**
 * Everything the platform holds about an account, as JSON. No password hash, no
 * session values, no one-time codes — an export is data, not credentials.
 */
export function exportAccount(accountId, { now = Date.now() } = {}) {
  ensureOpen();
  const account = getAccount(accountId);
  if (!account) return { ok: false, error: 'no_account' };
  const tenants = all('SELECT * FROM tenants WHERE account_id = ?', [accountId]);
  const data = {
    exported_at: new Date(Number(now)).toISOString(),
    account: {
      id: account.id,
      email: account.email,
      role: account.role,
      status: account.status,
      created_at: account.created_at,
      last_login_at: account.last_login_at,
      email_verified: !!account.email_verified,
    },
    consents: all('SELECT kind, version, accepted_at FROM consents WHERE account_id = ?', [accountId]),
    tenants: tenants.map((t) => ({
      slug: t.slug,
      name: t.name,
      plan_id: t.plan_id,
      status: t.status,
      created_at: t.created_at,
      trial_ends_at: t.trial_ends_at,
    })),
    usage: all(
      dashboardEnabled()
        ? 'SELECT slug tenant,substr(day,1,7) month,kind,SUM(tokens) tokens,SUM(calls) calls FROM r_usage WHERE hour=-1 AND slug IN (SELECT slug FROM tenants WHERE account_id=?) GROUP BY slug,month,kind'
        : 'SELECT tenant, month, kind, SUM(total_tokens) AS tokens, COUNT(*) AS calls FROM usage_events WHERE tenant IN (SELECT slug FROM tenants WHERE account_id = ?) GROUP BY tenant, month, kind',
      [accountId]
    ),
    audit: all('SELECT created_at, action, tenant, ok FROM platform_audit WHERE account_id = ?', [accountId]),
  };
  const billing = tenants.map((t) => billingExport(t.slug, now)).filter(Boolean);
  if (billing.length) data.billing = billing;
  run('UPDATE accounts SET exported_at = ? WHERE id = ?', [data.exported_at, accountId]);
  return { ok: true, export: data };
}

export function exportTokenValid(account, { now = Date.now(), withinMinutes = 60 } = {}) {
  if (!account?.exported_at) return false;
  const at = Date.parse(account.exported_at);
  return Number.isFinite(at) && Number(now) - at <= withinMinutes * 60000;
}

/**
 * Deletion, in the order that protects the customer: an export must exist and be
 * recent, tenants are stopped, their folders removed by the caller, and the
 * account row is scrubbed rather than kept "for records".
 */
export function scrubAccount(accountId, { now = Date.now() } = {}) {
  ensureOpen();
  const account = getAccount(accountId);
  if (!account) return { ok: false, error: 'no_account' };
  const stamp = new Date(Number(now)).toISOString();
  const anonymised = `deleted-${account.id.slice(0, 8)}@deleted.invalid`;
  run(
    `UPDATE accounts SET status = 'deleted', email = ?, email_norm = ?, password_hash = NULL,
       deleted_at = ? WHERE id = ?`,
    [anonymised, anonymised, stamp, accountId],
  );
  run('UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL', [stamp, accountId]);
  run('DELETE FROM memberships WHERE account_id = ?', [accountId]);
  run('DELETE FROM otp_codes WHERE account_id = ? OR email = ?', [accountId, account.email_norm]);
  run('DELETE FROM wizard_drafts WHERE slug IN (SELECT slug FROM tenants WHERE account_id = ?)', [accountId]);
  return { ok: true, deleted_at: stamp };
}

export default {
  normalizeEmail,
  emailProblem,
  isDisposable,
  findByEmail,
  getAccount,
  recordConsent,
  consentStatus,
  createOtp,
  verifyOtp,
  signupStart,
  signupVerify,
  login,
  passwordResetStart,
  passwordResetComplete,
  claimTrial,
  exportAccount,
  exportTokenValid,
  scrubAccount,
};
