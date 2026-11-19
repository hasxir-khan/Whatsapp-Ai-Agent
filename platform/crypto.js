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
};
