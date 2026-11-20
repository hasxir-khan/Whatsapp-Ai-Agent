// platform/session.js
// The customer's browser session.
//
// Shape of the cookie: `<session-id>.<expiry>.<signature>`, signed with
// `hmacWith` from src/services/adminPanel.js — the same primitive the dashboard
// uses, with a different label so a dashboard cookie can never open the
// platform and vice versa. On top of the signature there is a row in `sessions`,
// so logging out (or a password reset) really ends a session instead of waiting
// for an expiry to pass.
//
// CSRF is the double-submit rule: a non-HttpOnly `wa_platform_csrf` cookie the
// page sends back in `x-platform-csrf`. A cross-site form cannot read it, and
// SameSite=Strict means the cookie is not sent at all from another origin.

import { hmacWith, safeEqual, csrfOk as adminCsrfOk } from '../src/services/adminPanel.js';
import { randomId } from './crypto.js';
import { get, run } from './db.js';
import { platformSecret, sessionMinutes, secureOrigin } from './env.js';

export const COOKIE = 'wa_platform';
export const CSRF_COOKIE = 'wa_platform_csrf';
export const LABEL = 'platform';

export function issueCookieValue(sessionId, expiresAt) {
  const secret = platformSecret();
  return `${sessionId}.${expiresAt}.${hmacWith(secret, `${LABEL}.${sessionId}.${expiresAt}`)}`;
}

export function parseCookieValue(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 3) return null;
  const [sessionId, rawExpiry, signature] = parts;
  const expiry = Number(rawExpiry);
  if (!sessionId || !Number.isFinite(expiry)) return null;
  return { sessionId, expiresAt: expiry, signature };
}

export function signatureValid(parsed) {
  if (!parsed) return false;
  const expected = hmacWith(platformSecret(), `${LABEL}.${parsed.sessionId}.${parsed.expiresAt}`);
  return safeEqual(expected, parsed.signature);
}

function cookieName(base) { return secureOrigin() ? `__Host-${base}` : base; }
function cookieLine(base, value, age) {
  return `${cookieName(base)}=${encodeURIComponent(value)}; Path=/; SameSite=Strict; Max-Age=${age}` +
    (base === COOKIE ? '; HttpOnly' : '') + (secureOrigin() ? '; Secure' : '');
}

/** Issue a session for an account: database row + cookies, nothing in a JWT. */
export function issueSession(accountId, { ip = null, userAgent = null, now = Date.now() } = {}) {
  const minutes = sessionMinutes();
  const expiresAt = Number(now) + minutes * 60000;
  const sessionId = randomId(18);
  const csrf = randomId(18);
  run('INSERT INTO sessions (id, account_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)', [
    sessionId,
    accountId,
    new Date(Number(now)).toISOString(),
    new Date(expiresAt).toISOString(),
    ip ? String(ip).slice(0, 60) : null,
    userAgent ? String(userAgent).slice(0, 200) : null,
  ]);
  return { sessionId, csrf, expiresAt, cookies: [cookieLine(COOKIE, issueCookieValue(sessionId, expiresAt), minutes * 60),
    cookieLine(CSRF_COOKIE, csrf, minutes * 60)] };
}

export function clearCookies() {
  return [cookieLine(COOKIE, '', 0), cookieLine(CSRF_COOKIE, '', 0)];
}

/** Cookie parsing lives in adminPanel; this only adds the platform's names. */
export function cookies(req) {
  const out = Object.create(null);
  for (const part of String(req?.headers?.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    try { out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim()); } catch { /* ignore invalid cookie */ }
  }
  return out;
}

/**
 * Who is this request?
 * @returns {{ok:boolean, accountId?:string, sessionId?:string, csrf?:string, reason?:string}}
 */
export function readSession(req, { now = Date.now() } = {}) {
  const jar = cookies(req);
  const raw = jar[cookieName(COOKIE)];
  if (!raw) return { ok: false, reason: 'no_cookie' };
  const parsed = parseCookieValue(raw);
  if (!parsed || !signatureValid(parsed)) return { ok: false, reason: 'bad_signature' };
  if (parsed.expiresAt <= Number(now)) return { ok: false, reason: 'expired' };

  const row = get('SELECT * FROM sessions WHERE id = ?', [parsed.sessionId]);
  if (!row || row.revoked_at) return { ok: false, reason: 'revoked' };
  if (Date.parse(row.expires_at) <= Number(now)) return { ok: false, reason: 'expired' };

  return { ok: true, accountId: row.account_id, sessionId: row.id, csrf: jar[cookieName(CSRF_COOKIE)] || '' };
}

/** Mutations: header must match the CSRF cookie, or the request must be same-origin. */
export function mutationAllowed(req, session, body = null) {
  const header = String(req?.headers?.['x-platform-csrf'] || '');
  if (header && session?.csrf && safeEqual(header, session.csrf)) return true;
  return adminCsrfOk(req, { via: 'cookie', csrf: session?.csrf || '' }, body);
}

export function revokeSession(sessionId, { now = Date.now() } = {}) {
  if (!sessionId) return false;
  run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
    new Date(Number(now)).toISOString(), sessionId,
  ]);
  return true;
}

export function revokeAllSessions(accountId, { now = Date.now() } = {}) {
  run('UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL', [
    new Date(Number(now)).toISOString(), accountId,
  ]);
  return true;
}

export default {
  COOKIE,
  CSRF_COOKIE,
  LABEL,
  issueSession,
  issueCookieValue,
  parseCookieValue,
  signatureValid,
  clearCookies,
  cookies,
  readSession,
  mutationAllowed,
  revokeSession,
  revokeAllSessions,
};
