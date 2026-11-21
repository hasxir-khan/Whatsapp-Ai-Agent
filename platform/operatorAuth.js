// A customer session, a Basic header, or a tenant dashboard token cannot open
// either operator surface. Only an explicit operator login mints this cookie.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { safeEqual, rateLimit } from '../src/services/adminPanel.js';
import { keySecretProblem } from './crypto.js';
import { cookies } from './session.js';
import { secureOrigin } from './env.js';
import { get, run, billingTransaction as durable } from './db.js';
import { clientIp, readJsonBody, sendJson, sendHtml } from './http.js';
import { page } from './views.js';
import { recordAudit } from './audit.js';
import { activeMailer, sendMail } from './mailer.js';

const WINDOW = 15 * 60000,
  sessions = new Map();
const cookieName = () => (secureOrigin() ? '__Host-' : '') + 'wa_operator';
const totpKey = () => (process.env.PLATFORM_OPERATOR_TOTP_SECRET || '').trim().toUpperCase();
const recipient = () => process.env.PLATFORM_OPERATOR_EMAIL || process.env.PLATFORM_BILLING_OPERATOR_EMAIL;
export function operatorConfigured() {
  const key = process.env.PLATFORM_OPERATOR_TOKEN;
  return (
    !!key &&
    !keySecretProblem(key) &&
    ![
      process.env.PLATFORM_KEY_SECRET,
      process.env.ADMIN_TOKEN,
      process.env.DASHBOARD_TOKEN,
      process.env.PLATFORM_TENANT_TOKEN,
    ].includes(key) &&
    key.toUpperCase() !== totpKey()
  );
}
// RFC 6238: 160-bit (or longer) unpadded Base32 seed, SHA-1, 30s step, 6 digits.
function decodeSeed(value) {
  if (!/^[A-Z2-7]{32,128}$/.test(value)) return null;
  let bits = 0,
    n = 0;
  const bytes = [];
  for (const c of value) {
    n = (n << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push(n >> bits);
      n &= (1 << bits) - 1;
    }
  }
  return bits > 4 || n ? null : Buffer.from(bytes);
}
function matchesStep(seed, step, code) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', seed).update(counter).digest();
  const value = (mac.readUInt32BE(mac[19] & 15) & 0x7fffffff) % 1000000;
  return safeEqual(String(value).padStart(6, '0'), code);
}
export function operatorSetupProblem() {
  if (
    process.env.PLATFORM_OPERATOR_TOTP_SECRET &&
    (!decodeSeed(totpKey()) ||
      [
        'PLATFORM_KEY_SECRET',
        'PLATFORM_SECRET',
        'DASHBOARD_TOKEN',
        'ADMIN_TOKEN',
        'PLATFORM_TENANT_TOKEN',
      ].some((name) => process.env[name]?.toUpperCase() === totpKey()))
  )
    return 'operator_totp_invalid';
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient() || '') ||
    (process.env.NODE_ENV?.toLowerCase() === 'production' && activeMailer().mode === 'file')
  )
    return 'operator_alert_unavailable';
  return null;
}
const sessionKey = (raw) =>
  createHmac('sha256', process.env.PLATFORM_OPERATOR_TOKEN)
    .update(totpKey() + '\0' + raw)
    .digest('hex');
export function operatorSession(req, now = Date.now()) {
  const raw = cookies(req)[cookieName()];
  if (!operatorConfigured() || !raw || !/^[\w-]{43}$/.test(raw)) return null;
  const id = sessionKey(raw),
    s = sessions.get(id);
  if (s?.expires > now) return s;
  sessions.delete(id);
  return null;
}
const loginForm = () =>
  page({
    title: 'Operator sign in',
    body: `<main><h1>Operator sign in</h1><form id="op-login" method="post" action="/api/platform/operator/login">
<label>Operator credential <input name="credential" type="password" required autocomplete="current-password"></label>
${totpKey() ? '<label>Authenticator code <input name="code" inputmode="numeric" pattern="[0-9]{6}" required autocomplete="one-time-code"></label>' : ''}
<button>Sign in</button></form><p role="status" id="status"></p></main>`,
    script: `<script>
const form = document.getElementById('op-login');
const status = document.getElementById('status');
form.onsubmit = async (event) => {
  event.preventDefault();
  const body = JSON.stringify(Object.fromEntries(new FormData(form)));
  form.reset();
  try {
    const r = await fetch('/api/platform/operator/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operator-Login': '1' }, body
    });
    if (r.ok) location.reload();
    else if (r.status === 429) status.textContent = 'Too many attempts. Try later.';
    else if (r.status === 503) status.textContent = 'Operator login unavailable. Check alert delivery and configuration.';
    else status.textContent = 'Sign in refused.';
  } catch { status.textContent = 'Sign in unavailable.'; }
};
</script>`,
  });
export function operatorAuthorised(req, res) {
  if (!operatorConfigured()) {
    sendJson(res, 404, { error: 'not_found' });
    return null;
  }
  const ip = clientIp(req);
  if (!rateLimit('operator-api:' + ip, { max: 240, windowMs: 60000 }).ok) {
    sendJson(res, 429, { error: 'too_many_requests' });
    return null;
  }
  const s = operatorSession(req);
  if (!s) {
    if (req.method === 'GET' && req.url?.startsWith('/platform/')) sendHtml(res, 401, loginForm());
    else sendJson(res, 401, { error: 'operator_auth_required' });
  }
  return s;
}
function authenticate({ credential, code }, now, ip) {
  // Single durable guard for the single operator identity, including attempts
  // across IPs and worker restarts. Check and consume an OTP without yielding.
  const row = get('SELECT * FROM operator_guard WHERE id=1');
  if (row?.locked_until > now) return 429;
  const seed = totpKey();
  let step = -1;
  if (typeof credential === 'string' && safeEqual(credential, process.env.PLATFORM_OPERATOR_TOKEN)) {
    if (seed && typeof code === 'string' && /^\d{6}$/.test(code)) {
      const current = Math.floor(now / 30000);
      step =
        [current, current - 1, current + 1].find(
          (s) => s >= 0 && s > (row?.last_step ?? -1) && matchesStep(decodeSeed(seed), s, code)
        ) ?? -1;
    }
    if (!seed || step >= 0) {
      run('INSERT OR REPLACE INTO operator_guard VALUES(1,0,0,0,?)', [seed ? step : -1]);
      return 200;
    }
  }
  const within = row?.failures > 0 && now - row.since < WINDOW;
  const failures = (within ? row.failures : 0) + 1;
  run('INSERT OR REPLACE INTO operator_guard VALUES(1,?,?,?,?)', [
    within ? row.since : now,
    failures,
    failures >= 5 ? now + WINDOW : 0,
    row?.last_step ?? -1,
  ]);
  recordAudit({ action: failures >= 5 ? 'operator_locked' : 'operator_login_failed', ip, ok: false, now });
  return failures >= 5 ? 429 : 401;
}
export async function operatorLogin(req, res, { clock = Date.now, send = sendMail } = {}) {
  if (!operatorConfigured()) return sendJson(res, 404, { error: 'not_found' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
  // Custom header requires a same-origin caller; no CORS preflight is granted.
  if (req.headers['x-operator-login'] !== '1' || !/^application\/json\b/i.test(req.headers['content-type']))
    return sendJson(res, 403, { error: 'operator_login_required' });
  const ip = clientIp(req);
  if (
    !rateLimit('operator-login:' + ip, { max: 10, windowMs: 60000, now: clock() }).ok ||
    !rateLimit('operator-login-global', { max: 60, windowMs: 60000, now: clock() }).ok
  )
    return sendJson(res, 429, { error: 'too_many_requests' });
  if (operatorSetupProblem()) return sendJson(res, 503, { error: 'operator_login_unavailable' });
  const b = await readJsonBody(req, { limit: 2048 });
  if (!b.ok) return sendJson(res, b.status || 400, { error: 'bad_request' });
  const now = clock();
  const status = durable(() => authenticate(b.body, now, ip));
  if (status !== 200)
    return sendJson(res, status, { error: status === 429 ? 'too_many_requests' : 'operator_auth_required' });
  const raw = randomBytes(32).toString('base64url'),
    id = sessionKey(raw);
  const text = `Operator sign-in to the assistant platform at ${new Date(now).toISOString()}. If this was not you, rotate the operator credential and review the audit.`;
  let delivered;
  try {
    delivered = await send({
      to: recipient(),
      subject: 'Platform operator sign-in',
      text,
      idempotencyKey: createHash('sha256').update(id).digest('hex'),
    });
  } catch {
    /* No alert acceptance, no session. */
  }
  if (!delivered?.ok || !operatorConfigured() || id !== sessionKey(raw) || clock() >= now + WINDOW) {
    recordAudit({ action: 'operator_login_unavailable', ip, ok: false, now });
    return sendJson(res, 503, { error: 'operator_login_unavailable' });
  }
  durable(() => {
    if (!recordAudit({ action: 'operator_login', ip, now }).ok) throw Error('operator_audit_unavailable');
  });
  for (const [k, s] of sessions) if (s.expires <= now) sessions.delete(k);
  const s = { expires: now + WINDOW, csrf: randomBytes(24).toString('base64url') };
  sessions.set(id, s);
  return sendJson(
    res,
    200,
    { expires: s.expires },
    {
      'Set-Cookie': `${cookieName()}=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=900${secureOrigin() ? '; Secure' : ''}`,
    }
  );
}
