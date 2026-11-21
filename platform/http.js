// platform/http.js
// Small HTTP helpers, so no route handler has to remember the boring rules:
// JSON in with a size limit, JSON out with `no-store`, cookies the way the rest
// of the app sets them, and the same security headers as the dashboard plus a
// CSP that forbids every external origin (there is no CDN in this product).

import { isIP } from 'node:net';
import { SECURITY_HEADERS } from '../src/services/webAuth.js';

export const PLATFORM_HEADERS = {
  ...SECURITY_HEADERS,
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; " +
    "base-uri 'none'; form-action 'self'",
};

export const JSON_LIMIT = 64 * 1024;

export function sendJson(res, status, body, extra = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    ...PLATFORM_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(JSON.stringify(body));
}

export function sendHtml(res, status, html, extra = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    ...PLATFORM_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(html);
}

export function redirect(res, location, cookies = []) {
  const headers = { ...PLATFORM_HEADERS, Location: location, 'Cache-Control': 'no-store' };
  if (cookies.length) headers['Set-Cookie'] = cookies;
  res.writeHead(302, headers);
  res.end();
}

export function sendText(res, status, text, extra = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    ...PLATFORM_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(text);
}

/** Read a small JSON body. Refuses anything bigger instead of buffering it. */
export function readJsonBody(req, { limit = JSON_LIMIT, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let raw = '';
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
    timer.unref?.();

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, error: 'too_large', status: 413 });
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw.trim()) return finish({ ok: true, body: {} });
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return finish({ ok: false, error: 'bad_body', status: 400 });
        }
        finish({ ok: true, body: parsed });
      } catch {
        finish({ ok: false, error: 'bad_json', status: 400 });
      }
    });
    req.on('error', () => finish({ ok: false, error: 'read_failed', status: 400 }));
  });
}

/** Raw bytes, for an uploaded document. Same size ceiling as the admin panel. */
export function readRawBody(req, { limit = 5 * 1024 * 1024, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout', status: 408 }), timeoutMs);
    timer.unref?.();
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, error: 'too_large', status: 413 });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, buffer: Buffer.concat(chunks) }));
    req.on('error', () => finish({ ok: false, error: 'read_failed', status: 400 }));
  });
}

const LOOPBACK_OR_PRIVATE = /^(::1|::ffff:127\.|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:)/i;

/** `::ffff:10.0.0.1` → `10.0.0.1`, so one host cannot look like two. */
export function normalizeIp(value) {
  const text = String(value || '').trim().replace(/^\[|\]$/g, '');
  return text.replace(/^::ffff:/i, '') || 'unknown';
}

/** The address that actually opened the socket — not something a header claims. */
export function socketIp(req) {
  return normalizeIp(req?.socket?.remoteAddress || '');
}

/** Resolve only the declared ingress hop. A public client-supplied header is
 * never an identity. Keep Step 0's implicit private hop only in development. */
export function clientIp(req) {
  const peer = socketIp(req);
  const rule = String(process.env.PLATFORM_TRUST_PROXY || '').trim().toLowerCase();
  if (!isIP(peer)) return peer;
  // For installations with multiple clients on the private network, name the
  // immediate ingress peer explicitly (xff:IP or cf:IP). Never walk through
  // user-supplied entries to the left of the hop the ingress appended.
  const local = LOOPBACK_OR_PRIVATE.test(peer);
  const mode = rule.split(',').map((v) => v.trim()).find((v) =>
    v === `xff:${peer}` || v === `cf:${peer}` || v === peer);
  const xff = () => normalizeIp(String(req?.headers?.['x-forwarded-for'] || '').split(',').pop());
  const cf = () => normalizeIp(req?.headers?.['cf-connecting-ip']);
  let candidate = null;
  if (mode) candidate = mode.startsWith('cf:') ? cf() : xff();
  else if (rule === 'cloudflared' && (peer === '127.0.0.1' || peer === '::1')) candidate = cf();
  else if (rule === '1') candidate = xff(); // legacy explicit all-peers XFF trust, never CF
  else if (!rule && local && process.env.NODE_ENV !== 'production') candidate = xff(); // Step 0 local development
  return candidate && isIP(candidate) ? candidate : peer;
}

export function userAgent(req) {
  return String(req?.headers?.['user-agent'] || '').slice(0, 200);
}

/** Only these paths belong to the platform; everything else is not ours. */
export function isPlatformPath(pathname) {
  const value = String(pathname || '');
  if (value === '/platform' || value.startsWith('/platform/')) return true;
  if (value === '/api/health') return true;
  if (value === '/api/platform' || value.startsWith('/api/platform/')) return true;
  return false;
}

export default {
  PLATFORM_HEADERS,
  sendJson,
  sendHtml,
  sendText,
  redirect,
  readJsonBody,
  readRawBody,
  clientIp,
  userAgent,
  isPlatformPath,
};
