// src/services/webAuth.js
// One set of rules for every browser surface: the dashboard, the growth API,
// the QR image and the live inbox.
//
// There is deliberately no second implementation here. The signed cookie, the
// CSRF check and the rate limiter are the ones adminPanel.js already ships
// (`issueSessionFor` / `sessionValidFor` / `csrfOk` / `rateLimit`); this file
// only decides *who needs them* and *how a browser proves itself once*.
//
// The rules:
//   • a token (`DASHBOARD_TOKEN`) is the root of trust; no token means no
//     private routes at all unless the server is provably local;
//   • `?token=` is accepted once, exchanged for an HttpOnly cookie, and then
//     redirected away — it never reaches HTML, a log line or a Referer;
//   • a cookie cannot be sent cross-site, so cookie-authenticated mutations
//     also need CSRF (see csrfOk), while a Bearer header needs nothing extra.

import { config } from '../config/env.js';
import {
  COOKIE as ADMIN_COOKIE,
  csrfOk,
  clientIp,
  parseCookies,
  rateLimit,
  safeEqual,
  sessionValidFor,
  issueSessionFor,
} from './adminPanel.js';

export const COOKIE = 'wa_dash';
export const CSRF_COOKIE = 'wa_dash_csrf';
export const SESSION_LABEL = 'dashboard';
export const SESSION_MINUTES = 720;

/** The shared secret for the browser surfaces. */
export function dashboardToken() {
  return String(config.server?.token || '');
}

/** Is this bind address reachable from another machine? */
export function isLoopbackHost(host = '') {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0:0:0:0:0:0:0:1' || h.startsWith('127.');
}

/** An explicit "this box is fake data" switch (npm run demo sets it). */
export function explicitLocalMode() {
  return process.env.DEMO_MODE === '1';
}

/**
 * What the server is allowed to be.
 *
 * `private`  — a token is configured: every private route needs it.
 * `local`    — no token, bound to loopback, and an explicit local/demo mode is
 *              on: private routes are open, but only to this machine.
 * `refuse`   — no token and reachable from outside: the web UI must not start.
 */
export function webSecurityState({ host = config.server?.host, token = dashboardToken(), demo = explicitLocalMode() } = {}) {
  const hasToken = !!String(token || '');
  if (hasToken) return { mode: 'private', ok: true };
  if (isLoopbackHost(host)) return { mode: 'local', ok: true, demo, loopback: true };
  if (demo) return { mode: 'local', ok: true, demo: true, loopback: false };
  return {
    mode: 'refuse',
    ok: false,
    reason: 'no_token_on_public_bind',
    message:
      `The web UI is listening on ${host} with no DASHBOARD_TOKEN. ` +
      'Set DASHBOARD_TOKEN, or bind to 127.0.0.1 (HOST=127.0.0.1) for local use. ' +
      'Refusing to expose the dashboard, growth figures and QR code without auth.',
  };
}

/** Do private routes exist for this configuration at all? */
export function authRequired() {
  return webSecurityState().mode === 'private';
}

/** Set a cookie on `res`, HttpOnly and SameSite=Strict; Secure behind HTTPS. */
export function sessionCookieHeader(token, { maxAge = SESSION_MINUTES * 60 } = {}) {
  const { value } = issueSessionFor(token, { label: SESSION_LABEL, minutes: SESSION_MINUTES / 60 });
  const parts = [
    `${COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (isHttps()) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookieHeader() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Behind cloudflared/nginx the original scheme arrives in this header. */
export function isHttps(req = null) {
  if (req) {
    const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (proto) return proto === 'https';
    if (req.socket?.encrypted) return true;
  }
  return String(config.server?.publicUrl || '').startsWith('https://');
}

/**
 * Who is this? Bearer for scripts, the signed cookie for a browser, and — when
 * the server is in local mode — no proof needed at all.
 * @returns {{ok:boolean, via:'local'|'bearer'|'cookie'|null, csrf?:string, reason?:string}}
 */
export function authenticate(req, { now = Date.now() } = {}) {
  const state = webSecurityState();
  if (state.mode === 'local') return { ok: true, via: 'local' };

  const token = dashboardToken();
  if (!token) return { ok: false, via: null, reason: 'refuse' };

  const header = String(req?.headers?.authorization || '');
  if (header.startsWith('Bearer ') && safeEqual(header.slice(7).trim(), token)) {
    return { ok: true, via: 'bearer' };
  }

  const cookies = parseCookies(req);
  if (cookies[COOKIE] && sessionValidFor(token, cookies[COOKIE], { label: SESSION_LABEL, now })) {
    return { ok: true, via: 'cookie', csrf: cookies[CSRF_COOKIE] || '' };
  }
  return { ok: false, via: null, reason: 'unauthorised' };
}

/** True when a mutation may proceed: same rules as the admin panel's. */
export function mutationAllowed(req, auth, body = null) {
  return csrfOk(req, auth, body);
}

/**
 * A `?token=` on the URL is a one-time ticket, not a credential.
 *
 * Returns the URL to redirect to when the token was valid (the caller sets the
 * cookie and sends a 302), `false` when the token was wrong, and `null` when
 * there was no token in the URL at all. The token is never echoed back.
 */
export function tokenExchange(req, url, { now = Date.now() } = {}) {
  const sent = url.searchParams.get('token');
  if (sent === null) return null;

  const token = dashboardToken();
  if (!token || !safeEqual(sent, token)) {
    // A wrong ticket is just a bad request: no hint about the real one.
    return { ok: false };
  }

  const clean = new URL(url.href);
  clean.searchParams.delete('token');
  return { ok: true, location: `${clean.pathname}${clean.search}`, value: sessionCookieHeader(token) };
}

/**
 * Headers every browser-facing response carries.
 * `no-referrer` is the belt to the cookie-exchange braces: nothing of ours
 * should ever travel in a Referer to another origin.
 */
export const SECURITY_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

export { csrfOk, clientIp, parseCookies, rateLimit, safeEqual };

export default {
  COOKIE,
  authenticate,
  authRequired,
  clearCookieHeader,
  dashboardToken,
  isLoopbackHost,
  isHttps,
  mutationAllowed,
  SECURITY_HEADERS,
  sessionCookieHeader,
  tokenExchange,
  webSecurityState,
};
