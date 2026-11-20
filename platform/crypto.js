// platform/crypto.js
// Hashing for the few things the platform must store: passwords, one-time
// codes, and random tokens.
//
// Nothing here is invented for the occasion — `hmacWith` and `safeEqual` come
// from src/services/adminPanel.js, the same primitives the dashboard uses.
// Passwords are scrypt (memory-hard, in Node core) with a per-password salt.
// Six-digit codes are stored as an HMAC, not a plain hash: six digits is a
// million guesses, so the secret is what makes the stored value useless.

import crypto from 'node:crypto';
import { hmacWith, safeEqual } from '../src/services/adminPanel.js';


const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** `scrypt$N$r$p$salt$hash` — self-describing, so parameters can change later. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  let expected;
  try {
    expected = Buffer.from(hash, 'base64url');
  } catch {
    return false;
  }
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}


// ── values that must not be readable from a database dump ────
//
// A customer's AI key is the one secret the platform stores on somebody's
// behalf. It is encrypted with AES-256-GCM under `PLATFORM_KEY_SECRET`, with a
// random nonce per value and the tenant/key id bound in as additional data, so
// a row copied into another tenant's account does not decrypt. The format is
// self-describing and versioned, because a future rotation needs to tell an old
// row from a new one:
//
//   v1.<nonce base64url>.<tag base64url>.<ciphertext base64url>
//
// What this defends: a leaked platform.db, a stolen backup, a `sqlite3` session
// on a shared box. What it does not defend: a compromised *server* holding
// PLATFORM_KEY_SECRET and the running process. That limit is stated in the
// README rather than papered over.

export const KEY_SECRET_MIN = 32;
export const ENVELOPE_VERSION = 'v1';

/** The master secret for stored key material. Read at call time, like everything else. */
export function keySecret() {
  return String(process.env.PLATFORM_KEY_SECRET || '').trim();
}

/** Is the master secret usable? Returns null when it is, or the reason it is not. */
export function keySecretProblem(secret = keySecret()) {
  if (!secret) return 'PLATFORM_KEY_SECRET is not set — stored AI keys cannot be encrypted.';
  if (secret.length < KEY_SECRET_MIN) return `PLATFORM_KEY_SECRET must be at least ${KEY_SECRET_MIN} characters.`;
  if (secret === process.env.PLATFORM_SECRET) return 'Use a separate secret for BYOK and session signing.';
  if (/^(.)\1+$/.test(secret) || /^(change|secret|password|test|example)[-_ ]/i.test(secret) || /^(test|secret|password|changeme)$/i.test(secret)) {
    return 'PLATFORM_KEY_SECRET looks like a placeholder. Generate one with: openssl rand -base64 48';
  }
  return null;
}

let derived = null;
let derivedFrom = null;
function deriveKey(secret) {
  // A passphrase is not a 32-byte key; scrypt makes the same secret produce the
  // same key on every process without trusting the operator to paste hex.
  if (secret !== derivedFrom) {
    derived?.fill(0);
    derived = crypto.scryptSync(String(secret), 'platform.key.v1', 32, { N: 16384, r: 8, p: 1 });
    derivedFrom = secret;
  }
  return derived;
}

/**
 * @param {string} plaintext
 * @param {{secret?:string, aad?:string}} opts `aad` should be tenant+key id.
 * @returns {string} the envelope, safe to store.
 */
export function encryptValue(plaintext, { secret = keySecret(), aad = '' } = {}) {
  const problem = keySecretProblem(secret);
  if (problem) throw new Error(`key_secret_unusable: ${problem}`);
  const value = String(plaintext ?? '');
  if (!value) throw new Error('nothing_to_encrypt');
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), nonce);
  if (aad) cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_VERSION, nonce.toString('base64url'), tag.toString('base64url'), body.toString('base64url')].join('.');
}

/**
 * @returns {{ok:true, value:string} | {ok:false, reason:string}}
 * `reason` is a short category — never the ciphertext, never the secret.
 */
export function decryptValue(envelope, { secret = keySecret(), aad = '' } = {}) {
  const problem = keySecretProblem(secret);
  if (problem) return { ok: false, reason: 'key_secret_unusable' };
  const parts = String(envelope || '').split('.');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) return { ok: false, reason: 'bad_envelope' };
  const [, nonceB64, tagB64, bodyB64] = parts;
  try {
    if (!/^[A-Za-z0-9_-]{16}$/.test(nonceB64) || !/^[A-Za-z0-9_-]{22}$/.test(tagB64) || !/^[A-Za-z0-9_-]+$/.test(bodyB64)) return { ok: false, reason: 'bad_envelope' };
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(nonceB64, 'base64url'), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    if (aad) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    const value = Buffer.concat([decipher.update(Buffer.from(bodyB64, 'base64url')), decipher.final()]).toString('utf8');
    return { ok: true, value };
  } catch {
    // Wrong master secret, wrong aad, or a tampered row: all the same answer,
    // and all of them fail closed.
    return { ok: false, reason: 'cannot_decrypt' };
  }
}

/** The last four characters of a key — the only part that may be shown. */
export function keyFingerprint(value) {
  return String(value || '').slice(-4);
}

/** A stable, non-reversible id for a value, used to notice a *changed* key. */
export function keyFingerprintHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

/** Password rules the API checks before hashing anything. */
export const PASSWORD_MIN = 10;
export function passwordProblem(password) {
  const value = String(password ?? '');
  if (value.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (value.length > 200) return 'That password is too long.';
  if (/^\d+$/.test(value)) return 'Use letters as well as numbers.';
  if (/^(password|123456|qwerty)/i.test(value)) return 'That password is too easy to guess.';
  return null;
}

export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** A six-digit code with no modulo bias worth caring about, returned as text. */
export function sixDigitCode() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, '0');
}

/** What actually goes in the database. The raw code is never stored. */
export function hashOtp(secret, { email, purpose, code, salt }) {
  return hmacWith(secret, `otp.${purpose}.${String(email).toLowerCase()}.${salt}.${code}`);
}

export function otpMatches(secret, row, code) {
  if (!row) return false;
  const expected = hashOtp(secret, { email: row.email, purpose: row.purpose, code: String(code), salt: row.salt });
  return safeEqual(expected, row.code_hash);
}

export default {
  hashPassword,
  verifyPassword,
  passwordProblem,
  PASSWORD_MIN,
  randomId,
  sixDigitCode,
  hashOtp,
  otpMatches,
  keySecret,
  keySecretProblem,
  encryptValue,
  decryptValue,
  keyFingerprint,
  keyFingerprintHash,
  KEY_SECRET_MIN,
  ENVELOPE_VERSION,
};
