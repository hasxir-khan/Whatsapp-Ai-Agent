// Phase 7 Part 2 — Step 0 hardening.
//
// The Step 0 review of `platform/` reproduced nine things that could hurt a
// customer, a browser or the host. Each one has a test here; each test fails on
// the code as it was before this file existed. Nothing else about the platform
// changes: same routes, same responses, same flag.
//
// Everything is fake: 9230… numbers that belong to nobody, a scratch platform
// directory, and no process is ever started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolate } from './helpers.js';

const dataDir = isolate('platform-hardening');
const configDir = path.join(dataDir, 'config');
const tenantsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-hard-tenants-'));
const platformDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-hard-db-'));
fs.mkdirSync(configDir, { recursive: true });

fs.writeFileSync(
  path.join(configDir, 'owner.json'),
  JSON.stringify({
    owner: { name: 'Hardening Owner', timezone: 'Asia/Karachi' },
    business: { name: 'Hardening Cafe', type: 'Cafe', city: 'Islamabad', hours: 'Daily 12:00-23:00' },
  }),
);

process.env.CONFIG_DIR = configDir;
process.env.TENANTS_DIR = tenantsDir;
process.env.PLATFORM_DIR = platformDir;
process.env.PLATFORM_ENABLED = '1';
process.env.PLATFORM_SECRET = 'platform-hardening-secret-0123456789';
process.env.PLATFORM_DEV_SHOW_CODES = '1';
process.env.PLATFORM_TRIAL_DAYS = '14';
process.env.ENABLE_WEB = 'false';
delete process.env.DASHBOARD_TOKEN;

const db = await import('../platform/db.js');
await db.initPlatformDb();
const routes = await import('../platform/routes.js');
const accounts = await import('../platform/accounts.js');
const session = await import('../platform/session.js');
const plans = await import('../platform/plans.js');
const provisioning = await import('../platform/provisioning.js');
const connect = await import('../platform/connect.js');
const audit = await import('../platform/audit.js');
const http = await import('../platform/http.js');
const mailer = await import('../platform/mailer.js');
const adminPanel = await import('../src/services/adminPanel.js');
const webAuth = await import('../src/services/webAuth.js');

plans.seedPlans();
await (await import('../src/utils/db.js')).initDB();
adminPanel.resetRateLimits();
webAuth.resetRateLimits?.();

// ── fake req/res, same shape as test/62 ──────────────────────
function fakeReqRes({ method = 'GET', url = '/api/platform/me', headers = {}, body = null, peer = '127.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost:3200', origin: 'http://localhost:3200', ...headers };
  req.socket = { remoteAddress: peer };
  const res = {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, hdrs = {}) {
      this.status = status;
      this.headers = { ...hdrs };
      this.headersSent = true;
      return this;
    },
    end(chunk = '') {
      this.body += chunk;
      this.headersSent = true;
    },
  };
  process.nextTick(() => {
    if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return { req, res };
}

async function call(opts = {}) {
  const { req, res } = fakeReqRes(opts);
  const handled = await routes.handlePlatformRoute(req, res, new URL(opts.url || '/api/platform/me', 'http://localhost:3200'));
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { handled, status: res.status, headers: res.headers, body: json, raw: res.body };
}

let ipCounter = 0;
function freshIp() {
  ipCounter += 1;
  return `10.${41 + Math.floor(ipCounter / 250)}.${ipCounter % 250}.7`;
}

async function signupAndLogin(email, password = 'hardening-password-1', { peer = '127.0.0.1' } = {}) {
  const ip = freshIp();
  const start = await call({
    method: 'POST',
    url: '/api/platform/signup',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: { email, terms: true, privacy: true },
    peer,
  });
  assert.equal(start.status, 200, `signup should start: ${start.raw}`);
  const verify = await call({
    method: 'POST',
    url: '/api/platform/signup/verify',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: { email, code: start.body.devCode, password },
    peer,
  });
  assert.equal(verify.status, 200, `signup should verify: ${verify.raw}`);
  const cookies = [].concat(verify.headers['Set-Cookie'] || []);
  const sessionPair = cookies.find((c) => c.startsWith('wa_platform=')).split(';')[0];
  const csrfPair = cookies.find((c) => c.startsWith('wa_platform_csrf=')).split(';')[0];
  return {
    cookie: `${sessionPair}; ${csrfPair}`,
    csrf: decodeURIComponent(csrfPair.split('=')[1]),
    accountId: verify.body.account.id,
    email,
  };
}

const authed = (auth, extra = {}) => ({ 'content-type': 'application/json', cookie: auth.cookie, 'x-platform-csrf': auth.csrf, ...extra });

/** A tenant row with no folder on disk — the state that used to throw. */
function rowOnlyTenant(auth, slug, number) {
  return provisioning.beginProvisioning({ accountId: auth.accountId, slug, name: 'Row Only', number, now: Date.now() });
}

// ── 1. x-forwarded-for is not believed from the open internet ─
test('a spoofed x-forwarded-for cannot rotate past the per-IP signup brake', async () => {
  const peer = '203.0.113.44';
  let allowed = 0;
  let limited = 0;
  for (let i = 0; i < 14; i += 1) {
    const res = await call({
      method: 'POST',
      url: '/api/platform/signup',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i}` },
      body: { email: `spoof-${i}-${Date.now()}@example.com`, terms: true, privacy: true },
      peer,
    });
    if (res.status === 200) allowed += 1;
    if (res.status === 429) limited += 1;
  }
  assert.equal(allowed, 10, 'the per-IP brake is the only thing that can stop the 11th signup');
  assert.equal(limited, 4);
});

test('the same header is believed from a loopback proxy (how a single box runs)', async () => {
  const shared = `10.9.${Date.now() % 200}.1`;
  let allowed = 0;
  // A trusted proxy means the header is the client; different values are
  // different clients here, which is exactly the point.
  for (let i = 0; i < 3; i += 1) {
    const res = await call({
      method: 'POST',
      url: '/api/platform/signup',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `${shared}.${i}` },
      body: { email: `proxy-${i}-${Date.now()}@example.com`, terms: true, privacy: true },
      peer: '127.0.0.1',
    });
    if (res.status === 200) allowed += 1;
  }
  assert.equal(allowed, 3);
});

test('PLATFORM_TRUST_PROXY=1 lets a public peer be a proxy, and the header is used', async () => {
  process.env.PLATFORM_TRUST_PROXY = '1';
  try {
    const req = { socket: { remoteAddress: '203.0.113.90' }, headers: { 'x-forwarded-for': '198.51.100.5' } };
    assert.equal(http.clientIp(req), '198.51.100.5');
  } finally {
    delete process.env.PLATFORM_TRUST_PROXY;
  }
  const req = { socket: { remoteAddress: '203.0.113.90' }, headers: { 'x-forwarded-for': '198.51.100.5' } };
  assert.equal(http.clientIp(req), '203.0.113.90');
  assert.equal(http.normalizeIp('::ffff:10.0.0.4'), '10.0.0.4');
});

// ── 2. OTP failures tell the truth, and do not touch another code ─
test('a wrong signup code reports wrong_code with attempts left, not "no code"', async () => {
  const email = `otp-${Date.now()}@example.com`;
  const start = await accounts.signupStart({ email, terms: true, privacy: true, ip: freshIp() });
  assert.ok(start.ok);

  const first = accounts.signupVerify({ email, code: '000000', password: 'hardening-password-1' });
  assert.equal(first.error, 'wrong_code');
  assert.equal(first.attemptsLeft, 4);

  for (let i = 0; i < 3; i += 1) accounts.signupVerify({ email, code: '111111', password: 'hardening-password-1' });
  const last = accounts.signupVerify({ email, code: '222222', password: 'hardening-password-1' });
  assert.equal(last.error, 'too_many_attempts', 'the fifth wrong guess says what happened');
  assert.equal(last.attemptsLeft, 0);

  const again = accounts.signupVerify({ email, code: '333333', password: 'hardening-password-1' });
  assert.equal(again.error, 'too_many_attempts', 'and it keeps saying it');
  const late = accounts.signupVerify({ email, code: start.devCode, password: 'hardening-password-1' });
  assert.equal(late.ok, false, 'a burned code cannot be used afterwards');
});

test('the "you already have an account" code is the one that is checked once signup is done', async () => {
  const email = `otp-login-${Date.now()}@example.com`;
  const first = await accounts.signupStart({ email, terms: true, privacy: true, ip: freshIp() });
  accounts.signupVerify({ email, code: first.devCode, password: 'hardening-password-1' });

  // Second signup for the same address issues a "you already have an account" code
  // and no signup ticket, so that is the code in play.
  const again = await accounts.signupStart({ email, terms: true, privacy: true, ip: freshIp() });
  assert.ok(again.devCode);
  assert.equal(accounts.pendingPurpose({ email }), 'login');

  const signupRowBefore = db.get("SELECT attempts FROM otp_codes WHERE email = ? AND purpose = 'signup' ORDER BY created_at DESC LIMIT 1", [email]);
  const wrong = accounts.signupVerify({ email, code: '000000', password: 'hardening-password-1' });
  assert.equal(wrong.error, 'wrong_code', 'not a misleading "no code"');
  assert.equal(wrong.attemptsLeft, 4);
  const signupRowAfter = db.get("SELECT attempts FROM otp_codes WHERE email = ? AND purpose = 'signup' ORDER BY created_at DESC LIMIT 1", [email]);
  assert.equal(Number(signupRowAfter.attempts), Number(signupRowBefore.attempts), 'the finished signup ticket is untouched');

  const right = accounts.signupVerify({ email, code: again.devCode, password: 'hardening-password-2' });
  assert.equal(right.ok, true, 'the login code still works');
});

test('a live signup ticket keeps the login code out of it', async () => {
  const email = `otp-both-${Date.now()}@example.com`;
  const first = await accounts.signupStart({ email, terms: true, privacy: true, ip: freshIp() });
  assert.equal(accounts.pendingPurpose({ email }), 'signup');
  const loginRow = db.get("SELECT attempts FROM otp_codes WHERE email = ? AND purpose = 'login' ORDER BY created_at DESC LIMIT 1", [email]);
  const wrong = accounts.signupVerify({ email, code: '000000', password: 'hardening-password-1' });
  assert.equal(wrong.error, 'wrong_code');
  const loginRowAfter = db.get("SELECT attempts FROM otp_codes WHERE email = ? AND purpose = 'login' ORDER BY created_at DESC LIMIT 1", [email]);
  assert.equal(loginRowAfter, null, 'no login code was ever created, let alone charged');
  assert.equal(loginRow, null);
  const right = accounts.signupVerify({ email, code: first.devCode, password: 'hardening-password-1' });
  assert.equal(right.ok, true);
});

// ── 3. changing a password ends the other sessions ──────────
test('setting a password through the "already have an account" path ends older sessions', async () => {
  const email = `session-${Date.now()}@example.com`;
  const auth = await signupAndLogin(email, 'hardening-password-1');
  const stillThere = await call({ method: 'GET', url: '/api/platform/me', headers: { cookie: auth.cookie } });
  assert.equal(stillThere.status, 200);

  const again = await accounts.signupStart({ email, terms: true, privacy: true, ip: freshIp() });
  const changed = accounts.signupVerify({ email, code: again.devCode, password: 'hardening-password-2' });
  assert.equal(changed.ok, true);

  const oldSession = await call({ method: 'GET', url: '/api/platform/me', headers: { cookie: auth.cookie } });
  assert.equal(oldSession.status, 401, 'the session from before the password change is gone');
  const oldPassword = await call({
    method: 'POST',
    url: '/api/platform/login',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
    body: { email, password: 'hardening-password-1' },
  });
  assert.equal(oldPassword.status, 401);
});

// ── 4. no login oracle for "is this address registered?" ───
test('an unknown address costs the same password work as a known one', async () => {
  const auth = await signupAndLogin(`timing-${Date.now()}@example.com`);
  const time = (email) => {
    const started = process.hrtime.bigint();
    accounts.login({ email, password: 'definitely-not-the-password', ip: freshIp() });
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  time(auth.email); // warm the scrypt path
  const known = time(auth.email);
  const unknown = time(`ghost-${Date.now()}@example.com`);
  assert.ok(known > 5, `a real account spends real scrypt work (${known.toFixed(1)}ms)`);
  assert.ok(unknown > 5, `an unknown account spends it too (${unknown.toFixed(1)}ms)`);
});

// ── 5. dev codes never leave a production process ──────────
test('PLATFORM_DEV_SHOW_CODES is ignored when NODE_ENV=production', () => {
  const before = process.env.NODE_ENV;
  try {
    process.env.PLATFORM_DEV_SHOW_CODES = '1';
    process.env.NODE_ENV = 'production';
    assert.equal(mailer.showCodesInResponse(), false);
    process.env.NODE_ENV = 'development';
    assert.equal(mailer.showCodesInResponse(), true);
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
    process.env.PLATFORM_DEV_SHOW_CODES = '1';
  }
});

// ── 6. the audit trail can never hold a credential ─────────
test('audit details drop credential-shaped fields and keep the benign ones', () => {
  const stored = audit.sanitiseDetail({
    apiKey: 'gsk_FIXTURE_KEY_0123456789', api_key: 'gsk_FIXTURE_KEY_2', key: 'gsk_FIXTURE_KEY_3',
    token: 'tok_FIXTURE', secret: 'sec_FIXTURE', password: 'pw_FIXTURE', authorization: 'Bearer FIXTURE',
    otp: '123456', credentials: { nested: 'x' },
    step: 3, plan: 'free', sessionsRemoved: true, before: 'starter',
  });
  assert.equal(/FIXTURE/.test(stored), false, `no fixture string survives: ${stored}`);
  const parsed = JSON.parse(stored);
  assert.equal(parsed.step, 3);
  assert.equal(parsed.plan, 'free');
  assert.equal(parsed.before, 'starter');
  assert.equal(parsed.sessionsRemoved, true);

  // and the row itself, not just the sanitiser
  audit.recordAudit({ action: 'hardening_probe', detail: { apiKey: 'gsk_FIXTURE_KEY_ROW' } });
  const row = db.get("SELECT detail FROM platform_audit WHERE action = 'hardening_probe' ORDER BY id DESC LIMIT 1");
  assert.equal(/FIXTURE/.test(String(row.detail)), false);
});

// ── 7. a tenant with no files answers, it does not throw ───
test('QR and pairing for a tenant with no files refuse honestly instead of throwing', async () => {
  const auth = await signupAndLogin(`nofiles-${Date.now()}@example.com`);
  const slug = `row-only-${Date.now() % 100000}`;
  rowOnlyTenant(auth, slug, `9230${String(Date.now()).slice(-7)}`);

  const qr = await call({ method: 'GET', url: `/api/platform/tenants/${slug}/qr`, headers: { cookie: auth.cookie } });
  assert.equal(qr.status, 409);
  assert.equal(qr.body.error, 'not_ready');
  assert.ok(qr.body.message, 'the message says what to do');

  const pairing = await call({
    method: 'POST',
    url: `/api/platform/tenants/${slug}/pairing`,
    headers: authed(auth),
    body: {},
  });
  assert.equal(pairing.status, 409);
  assert.equal(pairing.body.error, 'not_ready');

  const plan = await call({ method: 'POST', url: `/api/platform/tenants/${slug}/plan`, headers: authed(auth), body: { planId: 'starter' } });
  assert.notEqual(plan.status, 500, 'a plan change on a file-less tenant is a refusal, not a crash');
});

// ── 8. members: one row per person, and a role can change ──
test('adding the same member twice is idempotent and changing a role works', async () => {
  const owner = await signupAndLogin(`mem-owner-${Date.now()}@example.com`);
  const staffEmail = `mem-staff-${Date.now()}@example.com`;
  const staff = await signupAndLogin(staffEmail);
  const slug = `members-${Date.now() % 100000}`;
  rowOnlyTenant(owner, slug, `9231${String(Date.now()).slice(-7)}`);

  const first = await call({ method: 'POST', url: `/api/platform/tenants/${slug}/members`, headers: authed(owner), body: { email: staffEmail, role: 'staff' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.changed, true);

  const twice = await call({ method: 'POST', url: `/api/platform/tenants/${slug}/members`, headers: authed(owner), body: { email: staffEmail, role: 'staff' } });
  assert.equal(twice.status, 200, 'no UNIQUE-constraint 500');
  assert.equal(twice.body.changed, false);

  const promote = await call({ method: 'POST', url: `/api/platform/tenants/${slug}/members`, headers: authed(owner), body: { email: staffEmail, role: 'owner' } });
  assert.equal(promote.status, 200);
  assert.equal(promote.body.before, 'staff');
  const row = db.get('SELECT role FROM memberships WHERE slug = ? AND account_id = ?', [slug, staff.accountId]);
  assert.equal(row.role, 'owner');

  const actions = db.all('SELECT action FROM platform_audit WHERE tenant = ? ORDER BY id ASC', [slug]).map((r) => r.action);
  assert.ok(actions.includes('member_added'));
  assert.ok(actions.includes('member_role_changed'));
});

test('the last owner cannot be demoted into an unmanageable assistant', async () => {
  const owner = await signupAndLogin(`last-owner-${Date.now()}@example.com`);
  const slug = `last-owner-${Date.now() % 100000}`;
  rowOnlyTenant(owner, slug, `9232${String(Date.now()).slice(-7)}`);
  const demote = await call({ method: 'POST', url: `/api/platform/tenants/${slug}/members`, headers: authed(owner), body: { email: owner.email, role: 'staff' } });
  assert.equal(demote.status, 409);
  assert.equal(demote.body.error, 'last_owner');
  const row = db.get('SELECT role FROM memberships WHERE slug = ? AND account_id = ?', [slug, owner.accountId]);
  assert.equal(row.role, 'owner');
});

// ── 9. the rate-limit map has a ceiling ────────────────────
test('a spray of unique rate-limit keys cannot grow the map without a bound', () => {
  adminPanel.resetRateLimits();
  for (let i = 0; i < 20000; i += 1) {
    adminPanel.rateLimit(`spray-${i}`, { max: 5, windowMs: 60000, now: 1000 + i });
  }
  const stats = adminPanel.rateLimitStats();
  assert.ok(stats.buckets <= adminPanel.RATE_LIMIT_MAX_BUCKETS, `bounded at ${stats.max}, saw ${stats.buckets}`);
  // and a real limit still behaves like a limit
  adminPanel.resetRateLimits();
  const results = [1, 2, 3, 4, 5, 6].map(() => adminPanel.rateLimit('one-key', { max: 5, windowMs: 60000, now: 5000 }).ok);
  assert.deepEqual(results, [true, true, true, true, true, false]);
});

// ── 10. nothing above weakened the platform itself ─────────
test('the hardened session still signs, and a forged one is still refused', async () => {
  const auth = await signupAndLogin(`signed-${Date.now()}@example.com`);
  const forged = auth.cookie.replace(/wa_platform=[^;]+/, 'wa_platform=deadbeef.9999999999999.nosignature');
  const res = await call({ method: 'GET', url: '/api/platform/me', headers: { cookie: forged } });
  assert.equal(res.status, 401);
  assert.equal(session.readSession({ headers: { cookie: forged } }).ok, false);
});
