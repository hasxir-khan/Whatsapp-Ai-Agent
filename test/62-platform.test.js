// Phase 7 Part 1 — the customer platform (control plane).
//
// This file is the contract for the layer in platform/. It tests the things that
// would hurt if they were wrong: who can prove they own an email, what a session
// is worth, whether one account can see another's assistant, whether a failed
// setup can be retried without duplicating anything, and whether the bot's own
// behaviour changes at all when the platform is switched off.
//
// Everything here is fake data: 92300… numbers that belong to nobody, a fake LLM
// provider that never opens a socket, and a scratch data directory per run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolate } from './helpers.js';

const dataDir = isolate('platform');
const configDir = path.join(dataDir, 'config');
const tenantsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-platform-tenants-'));
const platformDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-platform-db-'));
fs.mkdirSync(configDir, { recursive: true });

fs.writeFileSync(
  path.join(configDir, 'owner.json'),
  JSON.stringify({
    owner: { name: 'Platform Test Owner', timezone: 'Asia/Karachi' },
    business: { name: 'Platform Test Cafe', type: 'Cafe', city: 'Islamabad', hours: 'Daily 12:00-23:00' },
  }),
);

process.env.CONFIG_DIR = configDir;
process.env.TENANTS_DIR = tenantsDir;
process.env.PLATFORM_DIR = platformDir;
process.env.PLATFORM_ENABLED = '1';
process.env.PLATFORM_SECRET = 'platform-test-secret-0123456789abcdef';
process.env.PLATFORM_DEV_SHOW_CODES = '1';
process.env.PLATFORM_TRIAL_DAYS = '14';
process.env.ENABLE_WEB = 'false';
delete process.env.DASHBOARD_TOKEN;

const db = await import('../platform/db.js');
await db.initPlatformDb();
const envModule = await import('../platform/env.js');
const schemaModule = await import('../platform/schema.js');
const routes = await import('../platform/routes.js');
const platforms = await import('../platform/index.js');
const accounts = await import('../platform/accounts.js');
const session = await import('../platform/session.js');
const plans = await import('../platform/plans.js');
const provisioning = await import('../platform/provisioning.js');
const wizard = await import('../platform/wizard.js');
const connect = await import('../platform/connect.js');
const usage = await import('../platform/usage.js');
const audit = await import('../platform/audit.js');
const usageEvents = await import('../src/services/usageEvents.js');
const adminPanel = await import('../src/services/adminPanel.js');
const llm = await import('../src/core/llm.js');

plans.seedPlans();
await (await import('../src/utils/db.js')).initDB();

// ── a fake request/response, so none of this needs a port ────
function fakeReqRes({ method = 'GET', url = '/api/platform/me', headers = {}, body = null, raw = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost:3200', origin: 'http://localhost:3200', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
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
    if (raw !== null) req.emit('data', Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)));
    else if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
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

function setCookies(headers) {
  return [].concat(headers['Set-Cookie'] || []);
}

/** Every signup in this file gets its own address, so the per-IP brake does not
 *  fire in the unrelated tests — it is tested explicitly further down. */
let ipCounter = 0;
function freshIp() {
  ipCounter += 1;
  return `10.${Math.floor(ipCounter / 250)}.${ipCounter % 250}.9`;
}

/** A real session, the way the browser gets one. */
async function signupAndLogin(email, password, { ip = null } = {}) {
  ip = ip || freshIp();
  const start = await call({
    method: 'POST',
    url: '/api/platform/signup',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: { email, terms: true, privacy: true },
  });
  assert.equal(start.status, 200, `signup should start: ${start.raw}`);
  const code = start.body.devCode;
  assert.ok(code, 'dev codes are on in tests');

  const verify = await call({
    method: 'POST',
    url: '/api/platform/signup/verify',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: { email, code, password },
  });
  assert.equal(verify.status, 200, `signup should verify: ${verify.raw}`);

  const cookies = setCookies(verify.headers);
  const sessionPair = cookies.find((c) => c.startsWith('wa_platform=')).split(';')[0];
  const csrfPair = cookies.find((c) => c.startsWith('wa_platform_csrf=')).split(';')[0];
  const csrf = decodeURIComponent(csrfPair.split('=')[1]);
  return {
    cookie: `${sessionPair}; ${csrfPair}`,
    csrf,
    accountId: verify.body.account.id,
    email,
  };
}

const JSON_HEADERS = { 'content-type': 'application/json' };
function authed(auth, extra = {}) {
  return { cookie: auth.cookie, 'x-platform-csrf': auth.csrf, ...extra };
}

/** Provision a tenant for an account, without spawning any process. */
async function provisionFor(auth, { name, number, template = 'restaurant' }) {
  const res = await call({
    method: 'POST',
    url: '/api/platform/tenants',
    headers: { ...JSON_HEADERS, ...authed(auth) },
    body: { name, number, template },
  });
  return res;
}

// ── 1. the flag is the switch ───────────────────────────────
test('off by default: the platform owns no route at all', async () => {
  process.env.PLATFORM_ENABLED = '';
  assert.equal(envModule.platformEnabled(), false);

  for (const url of ['/platform', '/platform/app', '/api/platform/me', '/api/platform/signup']) {
    const res = await call({ url });
    assert.equal(res.handled, false, `${url} must not be claimed`);
    assert.equal(res.status, 0, 'the platform must not answer at all');
  }
  process.env.PLATFORM_ENABLED = '1';
});

test('off by default: usage recording does nothing at the LLM call site', () => {
  usageEvents.setUsageRecorder(null);
  const before = fs.existsSync(usageEvents.journalFile());
  const result = usageEvents.recordUsage({ tenant: 'nobody', kind: 'chat', provider: 'groq', model: 'x', totalTokens: 5 });
  assert.equal(result.mode, 'off');
  assert.equal(fs.existsSync(usageEvents.journalFile()), before, 'no journal file appears behind the owner');
});

test('enabled without a secret refuses to serve — 503, never open', async () => {
  const saved = process.env.PLATFORM_SECRET;
  process.env.PLATFORM_SECRET = '';
  const api = await call({ url: '/api/platform/me' });
  assert.equal(api.status, 503);
  assert.equal(api.body.error, 'platform_not_configured');
  const page = await call({ url: '/platform/login' });
  assert.equal(page.status, 503);
  assert.match(page.raw, /PLATFORM_SECRET/);
  process.env.PLATFORM_SECRET = saved;
});

test('the platform only claims /platform and /api/platform', async () => {
  for (const url of ['/admin', '/api/status', '/inbox', '/health', '/webhook/x', '/']) {
    const res = await call({ url });
    assert.equal(res.handled, false, `${url} belongs to the bot`);
  }
});

// ── 2. accounts: codes, passwords, consent ──────────────────
test('signup needs consent, then sends a six-digit code that is stored hashed', async () => {
  const refused = await call({
    method: 'POST',
    url: '/api/platform/signup',
    headers: { ...JSON_HEADERS, 'x-forwarded-for': '198.51.100.1' },
    body: { email: 'noconsent@example.com' },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'consent_required');

  const ok = await call({
    method: 'POST',
    url: '/api/platform/signup',
    headers: { ...JSON_HEADERS, 'x-forwarded-for': '198.51.100.2' },
    body: { email: 'Owner@Example.com', terms: true, privacy: true },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.email, 'owner@example.com', 'addresses are normalised');
  assert.match(ok.body.devCode, /^\d{6}$/);

  const row = db.get('SELECT * FROM otp_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1', ['owner@example.com']);
  assert.ok(row, 'the code exists');
  assert.notEqual(row.code_hash, ok.body.devCode, 'never the digits themselves');
  assert.ok(row.code_hash.length > 20);

  // The outbox is the delivery, not a log line: a real mailer replaces it.
  const outbox = (await import('../platform/mailer.js')).readOutbox(5);
  assert.ok(outbox.some((line) => line.to === 'owner@example.com' && line.text.includes(ok.body.devCode)));

  const account = accounts.findByEmail('owner@example.com');
  const consents = db.all('SELECT kind, version FROM consents WHERE account_id = ?', [account.id]);
  assert.equal(consents.length, 2, 'both terms and privacy are recorded with a version');
  assert.deepEqual(consents.map((c) => c.kind).sort(), ['privacy', 'terms']);
});

test('a code expires after ten minutes and after five wrong attempts', async () => {
  const base = Date.now();
  const made = accounts.createOtp({ email: 'expiry@example.com', purpose: 'signup', now: base });
  assert.equal(made.ok, true);

  const late = accounts.verifyOtp({ email: 'expiry@example.com', purpose: 'signup', code: made.code, now: base + 11 * 60000 });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'expired');

  const second = accounts.createOtp({ email: 'attempts@example.com', purpose: 'signup', now: base });
  let last = null;
  for (let i = 0; i < 5; i += 1) {
    last = accounts.verifyOtp({ email: 'attempts@example.com', purpose: 'signup', code: '000000', now: base + i });
  }
  assert.equal(last.ok, false);
  assert.ok(['too_many_attempts', 'wrong_code'].includes(last.reason));
  const after = accounts.verifyOtp({ email: 'attempts@example.com', purpose: 'signup', code: second.code, now: base + 6000 });
  assert.equal(after.ok, false, 'the right code cannot rescue a burned row');
});

test('codes are rate limited per address', () => {
  const results = [];
  // Five sends inside the window are allowed; the sixth is refused.
  for (let i = 0; i < 6; i += 1) results.push(accounts.createOtp({ email: 'flood@example.com', purpose: 'signup' }));
  assert.deepEqual(results.slice(0, 5).map((r) => r.ok), [true, true, true, true, true]);
  const sixth = results[5];
  assert.equal(sixth.ok, false);
  assert.equal(sixth.reason, 'too_many_codes');
  assert.ok(sixth.retryAfter > 0);
});

test('passwords are scrypt with a salt, and weak ones are refused', async () => {
  const weak = await call({
    method: 'POST',
    url: '/api/platform/signup/verify',
    headers: { ...JSON_HEADERS, 'x-forwarded-for': '198.51.100.3' },
    body: { email: 'owner@example.com', code: '123456', password: 'short' },
  });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error, 'weak_password');

  const start = await call({
    method: 'POST',
    url: '/api/platform/signup',
    headers: { ...JSON_HEADERS, 'x-forwarded-for': '198.51.100.4' },
    body: { email: 'hash@example.com', terms: true, privacy: true },
  });
  const verify = await call({
    method: 'POST',
    url: '/api/platform/signup/verify',
    headers: { ...JSON_HEADERS, 'x-forwarded-for': '198.51.100.4' },
    body: { email: 'hash@example.com', code: start.body.devCode, password: 'correct horse battery' },
  });
  assert.equal(verify.status, 200);
  const stored = accounts.findByEmail('hash@example.com').password_hash;
  assert.match(stored, /^scrypt\$/);
  assert.ok(!stored.includes('correct horse battery'));
  const crypto = await import('../platform/crypto.js');
  assert.equal(crypto.verifyPassword('correct horse battery', stored), true);
  assert.equal(crypto.verifyPassword('correct horse batteru', stored), false);
});

test('login says the same thing whether the password or the account is wrong', async () => {
  const wrongPassword = await call({
    method: 'POST',
    url: '/api/platform/login',
    headers: { ...JSON_HEADERS, 'x-forwarded-for': '198.51.100.5' },
    body: { email: 'hash@example.com', password: 'nope nope nope' },
  });
  const noAccount = await call({
    method: 'POST',
    url: '/api/platform/login',
    headers: { ...JSON_HEADERS, 'x-forwarded-for': '198.51.100.5' },
    body: { email: 'ghost@example.com', password: 'nope nope nope' },
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(noAccount.status, 401);
  assert.equal(wrongPassword.body.message, noAccount.body.message);
});

test('login is rate limited per address', () => {
  accounts.login({ email: 'ratelimit@example.com', password: 'whatever', ip: '192.0.2.9' });
  for (let i = 0; i < 7; i += 1) accounts.login({ email: 'ratelimit@example.com', password: 'whatever', ip: '192.0.2.9' });
  const blocked = accounts.login({ email: 'ratelimit@example.com', password: 'whatever', ip: '192.0.2.9' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 429);
});

// ── 3. sessions and CSRF ────────────────────────────────────
test('a signed cookie opens the account; a tampered one does not', async () => {
  const auth = await signupAndLogin('session@example.com', 'a long enough password');
  const me = await call({ url: '/api/platform/me', headers: { cookie: auth.cookie } });
  assert.equal(me.status, 200);
  assert.equal(me.body.account.email, 'session@example.com');

  const cookieValue = decodeURIComponent(auth.cookie.split('wa_platform=')[1].split(';')[0]);
  const parts = cookieValue.split('.');
  const forged = `${parts[0]}.${Number(parts[1]) + 60000}.${parts[2]}`;
  const bad = await call({
    url: '/api/platform/me',
    headers: { cookie: `wa_platform=${encodeURIComponent(forged)}` },
  });
  assert.equal(bad.status, 401, 'a longer expiry cannot be invented');

  // Another origin cannot send the cookie *and* cannot fake Origin.
  const noCsrf = await call({
    method: 'POST',
    url: '/api/platform/logout',
    headers: { cookie: auth.cookie, origin: 'https://evil.example' },
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error, 'csrf');

  const withCsrf = await call({
    method: 'POST',
    url: '/api/platform/logout',
    headers: authed(auth),
  });
  assert.equal(withCsrf.status, 200);

  const after = await call({ url: '/api/platform/me', headers: { cookie: auth.cookie } });
  assert.equal(after.status, 401, 'logout really ends the session');
});

test('a password reset kills every other session', async () => {
  const auth = await signupAndLogin('reset@example.com', 'the first good password');
  const forgot = await call({
    method: 'POST',
    url: '/api/platform/password/forgot',
    headers: { ...JSON_HEADERS, 'x-forwarded-for': '198.51.100.10' },
    body: { email: 'reset@example.com' },
  });
  assert.equal(forgot.status, 200);
  assert.match(forgot.body.devCode, /^\d{6}$/);

  const wrong = await call({
    method: 'POST',
    url: '/api/platform/password/reset',
    headers: JSON_HEADERS,
    body: { email: 'reset@example.com', code: '999999', password: 'the second good password' },
  });
  assert.equal(wrong.status, 400);

  const done = await call({
    method: 'POST',
    url: '/api/platform/password/reset',
    headers: JSON_HEADERS,
    body: { email: 'reset@example.com', code: forgot.body.devCode, password: 'the second good password' },
  });
  assert.equal(done.status, 200);

  const oldSession = await call({ url: '/api/platform/me', headers: { cookie: auth.cookie } });
  assert.equal(oldSession.status, 401);

  const oldPassword = await call({
    method: 'POST',
    url: '/api/platform/login',
    headers: { ...JSON_HEADERS, 'x-forwarded-for': '198.51.100.11' },
    body: { email: 'reset@example.com', password: 'the first good password' },
  });
  assert.equal(oldPassword.status, 401);
});

// ── 4. provisioning ────────────────────────────────────────
test('creating an assistant provisions a real tenant, once', async () => {
  const auth = await signupAndLogin('provision@example.com', 'a long enough password');
  const created = await provisionFor(auth, { name: 'Cha Cha Chai', number: '923001112233' });
  assert.equal(created.status, 201, created.raw);
  assert.equal(created.body.slug, 'cha-cha-chai');
  assert.ok(Array.isArray(created.body.secrets));
  assert.ok(created.body.secrets.some((s) => s.name === 'DASHBOARD_TOKEN'), 'the dashboard token is shown once');

  const dir = path.join(tenantsDir, 'cha-cha-chai');
  for (const sub of ['config', 'data', 'sessions', 'tmp']) {
    assert.ok(fs.existsSync(path.join(dir, sub)), `${sub} exists`);
  }
  const stat = fs.statSync(path.join(dir, '.env'));
  assert.equal(stat.mode & 0o077, 0, 'the .env is 0600');

  const env = adminPanel.readTenantEnv('cha-cha-chai');
  assert.ok(env.DASHBOARD_TOKEN, 'a dashboard token is generated');
  assert.equal(env.TENANT_DAILY_LLM_CALLS, '100', 'the free plan writes the bot’s own daily cap');
  assert.equal(env.VOICE_REPLY_MODE, 'off', 'no voice minutes means no voice replies');
  assert.equal(env.PLATFORM_USAGE_JOURNAL, '1');

  const profile = adminPanel.readTenantProfile('cha-cha-chai');
  assert.equal(profile.features.bookingAgent, false, 'a premium flag outside the plan is off');
  assert.ok(profile.business.name);

  const row = provisioning.getTenant('cha-cha-chai');
  assert.equal(row.status, 'provisioned');
  assert.equal(row.account_id, auth.accountId);
  assert.equal(row.link_status, 'unlinked');
  assert.ok(row.trial_ends_at, 'a trial window is set');

  assert.ok(audit.auditCount('tenant_provisioned') >= 1);
});

test('provisioning is idempotent: a second run creates nothing and reveals nothing', async () => {
  const auth = await signupAndLogin('idempotent@example.com', 'a long enough password');
  const first = await provisionFor(auth, { name: 'Idem Cafe', number: '923001112234' });
  assert.equal(first.status, 201);
  assert.ok(first.body.secrets.length > 0);

  const second = await provisioning.provisionTenant({
    accountId: auth.accountId,
    name: 'Idem Cafe',
    number: '923001112234',
    slug: first.body.slug,
  });
  assert.equal(second.ok, true);
  assert.equal(second.alreadyProvisioned, true);
  assert.equal(second.secrets.length, 0, 'secrets are never shown twice');

  const secrets = provisioning.listTenantSecrets(first.body.slug);
  assert.equal(secrets.filter((s) => s.name === 'DASHBOARD_TOKEN').length, 1);
});

test('a failed step leaves a clear state and a retry finishes the job', async () => {
  const auth = await signupAndLogin('retry@example.com', 'a long enough password');
  const slug = 'retry-cafe';

  provisioning.setProvisionHooks({
    writeProfile: async () => ({ ok: false, errors: ['simulated write failure'] }),
  });
  const failed = await provisioning.provisionTenant({
    accountId: auth.accountId,
    name: 'Retry Cafe',
    number: '923001112235',
    slug,
    template: 'restaurant',
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.step, 'profile');
  const row = provisioning.getTenant(slug);
  assert.equal(row.status, 'failed');
  assert.match(row.provision_error, /profile/);
  assert.ok(audit.auditCount('tenant_provision_failed') >= 1);

  provisioning.resetProvisionHooks();
  const retried = await provisioning.retryProvisioning(slug, { accountId: auth.accountId });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(provisioning.getTenant(slug).status, 'provisioned');
  assert.equal(provisioning.getTenant(slug).provision_error, null);
});

test('a failed setup does not burn the number’s free trial', async () => {
  const auth = await signupAndLogin('burn@example.com', 'a long enough password');
  provisioning.setProvisionHooks({ writeProfile: async () => ({ ok: false, errors: ['nope'] }) });
  let failed;
  try {
    failed = await provisionFor(auth, { name: 'Burn Cafe', number: '923001112237' });
  } finally {
    provisioning.resetProvisionHooks();
  }
  assert.equal(failed.status, 400);
  assert.equal(failed.body.error, 'provision_failed');
  assert.equal(db.get('SELECT * FROM trial_numbers WHERE number = ?', ['923001112237']), null, 'no claim was made');

  const slug = failed.body.slug;
  const retried = await call({
    method: 'POST',
    url: `/api/platform/tenants/${slug}/provision`,
    headers: { ...JSON_HEADERS, ...authed(auth) },
    body: {},
  });
  assert.equal(retried.status, 200, retried.raw);
  assert.ok(provisioning.getTenant(slug).trial_ends_at, 'the retry still gets the trial');
});

test('one WhatsApp number belongs to one account', async () => {
  const first = await signupAndLogin('number-a@example.com', 'a long enough password');
  const second = await signupAndLogin('number-b@example.com', 'a long enough password');
  const created = await provisionFor(first, { name: 'Number Cafe', number: '923001112236' });
  assert.equal(created.status, 201);

  const clash = await provisionFor(second, { name: 'Copy Cat', number: '923001112236' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, 'number_in_use');
});

test('one trial per WhatsApp number, even after the first account walks away', async () => {
  const first = await signupAndLogin('trial-a@example.com', 'a long enough password');
  const second = await signupAndLogin('trial-b@example.com', 'a long enough password');
  const a = await provisionFor(first, { name: 'Trial One', number: '923001112240' });
  assert.equal(a.status, 201);
  assert.ok(provisioning.getTenant(a.body.slug).trial_ends_at, 'the first number gets a trial');

  // The first account cancels: the number is free again, the trial is not.
  await provisioning.destroyTenant(a.body.slug, { accountId: first.accountId });
  const b = await provisionFor(second, { name: 'Trial Two', number: '923001112240' });
  assert.equal(b.status, 201, b.raw);
  assert.equal(
    provisioning.getTenant(b.body.slug).trial_ends_at ?? null,
    null,
    'the second account gets no second trial on that number',
  );
});

// ── 5. isolation ───────────────────────────────────────────
test('one account cannot see, read or link another account’s assistant', async () => {
  const owner = await signupAndLogin('owner-a@example.com', 'a long enough password');
  const other = await signupAndLogin('owner-b@example.com', 'a long enough password');
  const created = await provisionFor(owner, { name: 'Private Cafe', number: '923001112250' });
  const slug = created.body.slug;

  assert.equal(provisioning.tenantForAccount(other.accountId, slug), null);

  for (const url of [
    `/api/platform/tenants/${slug}`,
    `/api/platform/tenants/${slug}/qr`,
    `/api/platform/tenants/${slug}/usage`,
    `/api/platform/tenants/${slug}/status`,
  ]) {
    const res = await call({ url, headers: { cookie: other.cookie } });
    assert.equal(res.status, 404, `${url} must not leak existence`);
  }

  const write = await call({
    method: 'POST',
    url: `/api/platform/tenants/${slug}/wizard/2`,
    headers: { ...JSON_HEADERS, ...authed(other) },
    body: { patch: { business: { name: 'Hijacked' } } },
  });
  assert.equal(write.status, 404);

  const ownerRead = await call({ url: `/api/platform/tenants/${slug}`, headers: { cookie: owner.cookie } });
  assert.equal(ownerRead.status, 200);
  assert.notEqual(ownerRead.body.tenant.name, 'Hijacked');
});

test('staff accounts can view but not change anything', async () => {
  const owner = await signupAndLogin('staff-owner@example.com', 'a long enough password');
  const staff = await signupAndLogin('staff-member@example.com', 'a long enough password');
  const created = await provisionFor(owner, { name: 'Staff Cafe', number: '923001112251' });
  const slug = created.body.slug;

  const added = await call({
    method: 'POST',
    url: `/api/platform/tenants/${slug}/members`,
    headers: { ...JSON_HEADERS, ...authed(owner) },
    body: { email: 'staff-member@example.com', role: 'staff' },
  });
  assert.equal(added.status, 200);
  assert.equal(added.body.role, 'staff');

  const view = await call({ url: `/api/platform/tenants/${slug}`, headers: { cookie: staff.cookie } });
  assert.equal(view.status, 200);
  assert.equal(view.body.role, 'staff');
  assert.equal(view.body.canEdit, false);

  const edit = await call({
    method: 'POST',
    url: `/api/platform/tenants/${slug}/wizard/2`,
    headers: { ...JSON_HEADERS, ...authed(staff) },
    body: { patch: { business: { name: 'Staff Was Here' } } },
  });
  assert.equal(edit.status, 403);
  assert.equal(edit.body.error, 'owner_only');
});

test('tenant paths cannot escape their folder', async () => {
  for (const bad of ['../etc', 'a/../b', 'Cha-Cha', 'x'.repeat(60), '']) {
    assert.throws(() => adminPanel.tenantDir(bad), /invalid_slug/);
  }
});

test('per-tenant secrets are per tenant', async () => {
  const a = provisioning.getTenantSecret('cha-cha-chai', 'DASHBOARD_TOKEN');
  const b = provisioning.getTenantSecret('idem-cafe', 'DASHBOARD_TOKEN');
  assert.ok(a && b);
  assert.notEqual(a, b);
  assert.equal(provisioning.getTenantSecret('does-not-exist', 'DASHBOARD_TOKEN'), null);
});

// ── 6. the wizard ─────────────────────────────────────────
test('every wizard step validates through profile.js and saves a draft', async () => {
  const auth = await signupAndLogin('wizard@example.com', 'a long enough password');
  const created = await provisionFor(auth, { name: 'Wizard Cafe', number: '923001112260' });
  const slug = created.body.slug;

  const step1 = await call({
    method: 'POST',
    url: `/api/platform/tenants/${slug}/wizard/1`,
    headers: { ...JSON_HEADERS, ...authed(auth) },
    body: { patch: { template: 'restaurant' } },
  });
  assert.equal(step1.status, 200);
  assert.equal(step1.body.saved, true);

  const step2 = await call({
    method: 'POST',
    url: `/api/platform/tenants/${slug}/wizard/2`,
    headers: { ...JSON_HEADERS, ...authed(auth) },
    body: {
      patch: {
        business: {
          name: 'Wizard Cafe',
          city: 'Islamabad',
          hours: 'Daily 11:00-23:00',
          languages: ['English', 'Urdu'],
          tone: { style: 'warm and brief' },
        },
      },
    },
  });
  assert.equal(step2.status, 200, step2.raw);
  assert.equal(wizard.readDraft(slug).step >= 2, true);

  const profile = adminPanel.readTenantProfile(slug);
  assert.equal(profile.business.city, 'Islamabad');
  assert.deepEqual(profile.business.languages, ['English', 'Urdu']);

  // profile.js refuses this, so the wizard must too — and save nothing.
  const before = adminPanel.readTenantProfile(slug).business.name;
  const bad = await call({
    method: 'POST',
    url: `/api/platform/tenants/${slug}/wizard/2`,
    headers: { ...JSON_HEADERS, ...authed(auth) },
    body: { patch: { business: { languages: 'English' } } },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.saved, false);
  assert.ok(bad.body.errors.length > 0);
  assert.equal(adminPanel.readTenantProfile(slug).business.name, before, 'a refused step changes nothing');
});

test('wizard documents go through the existing upload and learn rules', async () => {
  const auth = await signupAndLogin('docs@example.com', 'a long enough password');
  const created = await provisionFor(auth, { name: 'Docs Cafe', number: '923001112261' });
  const slug = created.body.slug;

  wizard.setWizardHooks({ ingest: async () => ({ ok: true, mode: 'inline', chunks: 3, chars: 900 }) });
  const upload = await call({
    method: 'POST',
    url: `/api/platform/tenants/${slug}/documents`,
    headers: { ...authed(auth), 'x-file-name': 'menu.txt' },
    raw: 'Flat white 450\nLatte 480\n',
  });
  assert.equal(upload.status, 200, upload.raw);
  assert.equal(upload.body.document.name, 'menu.txt');
  assert.equal(upload.body.documents, 1);

  const blocked = await call({
    method: 'POST',
    url: `/api/platform/tenants/${slug}/documents`,
    headers: { ...authed(auth), 'x-file-name': 'virus.exe' },
    raw: 'MZ',
  });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error, 'type_not_allowed');
  wizard.resetWizardHooks();
});

test('the test chat runs a sandbox and never a real number', async () => {
  const auth = await signupAndLogin('sandbox@example.com', 'a long enough password');
  const created = await provisionFor(auth, { name: 'Sandbox Cafe', number: '923001112262' });
  const slug = created.body.slug;

  wizard.setWizardHooks({ sandboxChat: async (s, text) => ({ replies: ['Sure — that’s Rs 450.', 'Anything else?'], number: '900000000000', echo: text }) });
  try {
    const res = await call({
      method: 'POST',
      url: `/api/platform/tenants/${slug}/test-chat`,
      headers: { ...JSON_HEADERS, ...authed(auth) },
      body: { text: 'how much is a flat white?' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.sandbox, true);
    assert.equal(res.body.replies.length, 2);
  } finally {
    wizard.resetWizardHooks();
  }

  const unauthorised = await call({
    method: 'POST',
    url: `/api/platform/tenants/${slug}/test-chat`,
    headers: JSON_HEADERS,
    body: { text: 'hello' },
  });
  assert.equal(unauthorised.status, 401);
});

// ── 7. connecting WhatsApp ────────────────────────────────
test('the QR is owner-only, rate limited, never cached — and not a session guess', async () => {
  const auth = await signupAndLogin('qr@example.com', 'a long enough password');
  const staff = await signupAndLogin('qr-staff@example.com', 'a long enough password');
  const created = await provisionFor(auth, { name: 'QR Cafe', number: '923001112270' });
  const slug = created.body.slug;

  await call({
    method: 'POST',
    url: `/api/platform/tenants/${slug}/members`,
    headers: { ...JSON_HEADERS, ...authed(auth) },
    body: { email: 'qr-staff@example.com', role: 'staff' },
  });

  connect.setConnectHooks({
    qr: async () => ({ ok: true, transport: 'baileys', qr: 'data:image/png;base64,AAAA', status: 'waiting_for_qr' }),
    probeStatus: async () => ({ status: 'waiting_for_qr', pairingCode: null }),
  });

  const asStaff = await call({ url: `/api/platform/tenants/${slug}/qr`, headers: { cookie: staff.cookie } });
  assert.equal(asStaff.status, 403);
  assert.equal(asStaff.body.error, 'owner_only');

  const asOwner = await call({ url: `/api/platform/tenants/${slug}/qr`, headers: { cookie: auth.cookie } });
  assert.equal(asOwner.status, 200);
  assert.match(asOwner.body.qr, /^data:image\/png/);
  assert.match(asOwner.headers['Cache-Control'], /no-store/);
  assert.equal(asOwner.body.expiresInSeconds, 60);

  // Twenty a minute, then the brake.
  let last = null;
  for (let i = 0; i < 25; i += 1) {
    last = await call({ url: `/api/platform/tenants/${slug}/qr`, headers: { cookie: auth.cookie } });
  }
  assert.equal(last.status, 429);
  assert.ok(last.body.retryAfter > 0);
  connect.resetConnectHooks();
});

test('the phone-number pairing code is the library’s code, shown as-is', async () => {
  const auth = await signupAndLogin('pair@example.com', 'a long enough password');
  const created = await provisionFor(auth, { name: 'Pair Cafe', number: '923001112271' });
  const slug = created.body.slug;

  let restarted = null;
  connect.setConnectHooks({
    restart: async (s) => {
      restarted = s;
    },
    probeStatus: async () => ({ status: 'pairing', pairingCode: 'ABCD-1234' }),
  });

  const requested = await call({
    method: 'POST',
    url: `/api/platform/tenants/${slug}/pairing`,
    headers: { ...JSON_HEADERS, ...authed(auth) },
    body: {},
  });
  assert.equal(requested.status, 200, requested.raw);
  assert.equal(restarted, slug, 'the bot is the thing that asks WhatsApp');
  assert.equal(adminPanel.readTenantEnv(slug).PAIRING_NUMBER, '923001112271');

  const code = await call({ url: `/api/platform/tenants/${slug}/pairing/code`, headers: { cookie: auth.cookie } });
  assert.equal(code.status, 200);
  assert.equal(code.body.code, 'ABCD-1234', 'verbatim: no reformatting, no padding');
  assert.equal(connect.looksLikePairingCode(code.body.code), true);
  connect.resetConnectHooks();
});

test('linking status moves waiting → connected, and disconnect says so', async () => {
  const auth = await signupAndLogin('link@example.com', 'a long enough password');
  const created = await provisionFor(auth, { name: 'Link Cafe', number: '923001112272' });
  const slug = created.body.slug;

  connect.setConnectHooks({ probeStatus: async () => ({ status: 'online' }) });
  const connected = await call({ url: `/api/platform/tenants/${slug}/status`, headers: { cookie: auth.cookie } });
  assert.equal(connected.status, 200);
  assert.equal(connected.body.status, 'connected');
  assert.equal(provisioning.getTenant(slug).link_status, 'connected');

  connect.setConnectHooks({ stop: async () => ({ ok: true }) });
  const off = await call({
    method: 'POST',
    url: `/api/platform/tenants/${slug}/disconnect`,
    headers: { ...JSON_HEADERS, ...authed(auth) },
    body: {},
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.status, 'unlinked');
  assert.equal(provisioning.getTenant(slug).link_status, 'unlinked');
  connect.resetConnectHooks();
});

test('Cloud API tenants get a webhook URL, never a QR', async () => {
  const auth = await signupAndLogin('cloud@example.com', 'a long enough password');
  const created = await provisionFor(auth, { name: 'Cloud Cafe', number: '923001112273' });
  const slug = created.body.slug;
  adminPanel.writeTenantEnvValue(slug, 'TRANSPORT', 'cloud');
  adminPanel.writeTenantEnvValue(slug, 'CLOUD_VERIFY_TOKEN', 'verify-this-is-a-test-token');

  const res = await call({ url: `/api/platform/tenants/${slug}/qr`, headers: { cookie: auth.cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.body.transport, 'cloud');
  assert.equal(res.body.qr, null);
  assert.equal(res.body.webhookPath, `/webhook/${slug}`);
  assert.equal(res.body.verifyTokenSet, true);
  assert.ok(!res.raw.includes('verify-this-is-a-test-token'), 'the token itself never leaves the server');
});

test('the number of assistants an account may run is the plan’s limit', async () => {
  const auth = await signupAndLogin('numbers@example.com', 'a long enough password');
  const first = await provisionFor(auth, { name: 'Number One', number: '923001112295' });
  assert.equal(first.status, 201);

  const second = await provisionFor(auth, { name: 'Number Two', number: '923001112296' });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'plan_limit');
  assert.equal(second.body.entitlement, 'numbers');
  assert.match(second.body.message, /plan covers/);

  // Growth allows two, so the same request now succeeds.
  db.run("UPDATE tenants SET plan_id = 'growth' WHERE slug = ?", [first.body.slug]);
  const third = await provisionFor(auth, { name: 'Number Two', number: '923001112296' });
  assert.equal(third.status, 201, third.raw);
});

// ── 8. plans ───────────────────────────────────────────────
test('plan limits are checked where a change is requested', () => {
  const free = plans.getPlan('free');
  assert.ok(free);
  const check = plans.checkEntitlement('cha-cha-chai', 'agents', { used: 2, add: 1 });
  assert.equal(check.ok, false);
  assert.equal(check.limit, free.limits.agents);
  assert.equal(plans.checkEntitlement('cha-cha-chai', 'agents', { used: 1, add: 1 }).ok, true);
});

test('assigning a plan moves the caps and the premium flags, nothing else', async () => {
  const auth = await signupAndLogin('plan@example.com', 'a long enough password');
  const created = await provisionFor(auth, { name: 'Plan Cafe', number: '923001112274' });
  const slug = created.body.slug;

  const applied = plans.assignPlan({ slug, planId: 'growth', accountId: auth.accountId });
  assert.equal(applied.ok, true);

  const env = adminPanel.readTenantEnv(slug);
  assert.equal(env.TENANT_DAILY_LLM_CALLS, '2000');
  assert.equal(env.TENANT_VOICE_MINUTES, '300');
  assert.notEqual(env.VOICE_REPLY_MODE, 'off');

  const profile = adminPanel.readTenantProfile(slug);
  assert.equal(profile.features.bookingAgent, true);
  assert.equal(profile.features.multiAgent, true);
  assert.equal(profile.features.adminPanel ?? false, false, 'core flags are left alone');

  // Owners cannot self-assign: only a platform admin can.
  const other = await signupAndLogin('plan-user@example.com', 'a long enough password');
  const denied = await call({
    method: 'POST',
    url: `/api/platform/tenants/${slug}/plan`,
    headers: { ...JSON_HEADERS, ...authed(other) },
    body: { planId: 'growth' },
  });
  assert.equal(denied.status, 404, 'a stranger cannot even see the tenant');
});

test('trial expiry pauses the bot, keeps the files, and tells the owner', async () => {
  const auth = await signupAndLogin('expired@example.com', 'a long enough password');
  const created = await provisionFor(auth, { name: 'Expired Cafe', number: '923001112275' });
  const slug = created.body.slug;
  db.run('UPDATE tenants SET trial_ends_at = ? WHERE slug = ?', [new Date(Date.now() - 86400000).toISOString(), slug]);
  db.run("UPDATE tenants SET status = 'active' WHERE slug = ?", [slug]);

  const stopped = [];
  const result = await plans.expireTrials({ stop: async (s) => stopped.push(s) });
  assert.ok(result.paused.some((p) => p.slug === slug));
  assert.deepEqual(stopped, [slug]);

  const row = provisioning.getTenant(slug);
  assert.equal(row.status, 'paused');
  assert.equal(row.paused_reason, 'trial_expired');
  assert.ok(fs.existsSync(path.join(tenantsDir, slug, 'config', 'owner.json')), 'paused is not deleted');

  const notes = audit.notificationsFor(auth.accountId);
  assert.ok(notes.some((n) => n.kind === 'trial_expired' && n.tenant === slug));
  assert.ok(audit.auditCount('trial_expired') >= 1);

  // Running it again changes nothing.
  const again = await plans.expireTrials({ stop: async () => {} });
  assert.equal(again.paused.some((p) => p.slug === slug), false);
});

test('a paused tenant cannot go live, and a plan change brings it back', async () => {
  const auth = await signupAndLogin('paused@example.com', 'a long enough password');
  const created = await provisionFor(auth, { name: 'Paused Cafe', number: '923001112276' });
  const slug = created.body.slug;
  db.run("UPDATE tenants SET status = 'paused', paused_reason = 'trial_expired' WHERE slug = ?", [slug]);

  const blocked = await call({
    method: 'POST',
    url: `/api/platform/tenants/${slug}/go-live`,
    headers: { ...JSON_HEADERS, ...authed(auth) },
    body: {},
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'paused');

  plans.assignPlan({ slug, planId: 'starter', accountId: auth.accountId });
  assert.equal(provisioning.getTenant(slug).status, 'provisioned', 'upgrade unlocks onboarding; it cannot bypass the live checklist');
});

// ── 9. usage ───────────────────────────────────────────────
test('usage events keep token counts when the provider reports them', () => {
  const ok = usage.record({
    tenant: 'usage-cafe',
    kind: 'chat',
    provider: 'groq',
    model: 'llama-test',
    promptTokens: 120,
    completionTokens: 45,
    latencyMs: 800,
    conversation: 'abc123',
  });
  assert.equal(ok.ok, true);

  const row = db.get('SELECT * FROM usage_events WHERE tenant = ? ORDER BY id DESC LIMIT 1', ['usage-cafe']);
  assert.equal(Number(row.prompt_tokens), 120);
  assert.equal(Number(row.completion_tokens), 45);
  assert.equal(Number(row.total_tokens), 165);
  assert.equal(Number(row.estimated), 0);
  assert.equal(row.kind, 'chat');
  assert.ok(row.day && row.month, 'day and month are materialised for rollups');
});

test('a provider that reports nothing gets a flagged estimate, never a silent zero', () => {
  usage.record({ tenant: 'usage-cafe', kind: 'router', provider: 'gemini', model: 'x', promptTokens: 80, completionTokens: 20, totalTokens: 100, estimated: true });
  const row = db.get("SELECT * FROM usage_events WHERE tenant = 'usage-cafe' AND kind = 'router' ORDER BY id DESC LIMIT 1");
  assert.equal(Number(row.estimated), 1);
  assert.equal(Number(row.total_tokens), 100);
});

test('rollups give days, months, kinds and distinct conversations', () => {
  const day = Date.now();
  for (const [kind, tokens, conv] of [['chat', 100, 'c1'], ['chat', 50, 'c1'], ['reasoning', 25, 'c2']]) {
    usage.record({ tenant: 'rollup-cafe', kind, totalTokens: tokens, promptTokens: tokens, at: day, conversation: conv, provider: 'groq', model: 'm' });
  }
  const summary = usage.summary('rollup-cafe');
  assert.equal(summary.totals.calls, 3);
  assert.equal(summary.totals.total_tokens, 175);
  assert.equal(summary.conversations, 2, 'two distinct conversations, not three calls');
  assert.ok(summary.kinds.some((k) => k.kind === 'chat' && Number(k.calls) === 2));
  assert.ok(summary.daily.length >= 1);
  assert.ok(summary.monthly.length >= 1);
});

test('the LLM call site is what records usage, with or without provider numbers', async () => {
  usageEvents._resetUsageEvents();
  usage.attachUsageSink();

  const body = (payload) => {
    const raw = JSON.stringify(payload);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => raw,
      json: async () => payload,
    };
  };
  const replies = [
    body({ choices: [{ message: { content: 'Hello there.' } }], usage: { prompt_tokens: 210, completion_tokens: 30, total_tokens: 240 } }),
    body({ choices: [{ message: { content: 'Sure, we open at nine.' } }] }),
  ];
  let n = 0;
  llm.__setFetch(async () => replies[n++ % replies.length]);
  try {
    const first = await llm.chat({ system: 'be helpful', messages: [{ role: 'user', content: 'hi' }], chatKey: 'sandbox-chat-1', kind: 'chat' });
    assert.equal(first.provider, 'groq');
    const reported = db.get("SELECT * FROM usage_events WHERE tenant = ? ORDER BY id DESC LIMIT 1", [first.tenant || 'default']);
    assert.ok(reported, 'the sink received the event');
    assert.equal(Number(reported.prompt_tokens), 210);
    assert.equal(Number(reported.estimated), 0);
    assert.ok(reported.conversation && reported.conversation.length <= 32, 'the conversation is a hash, not a number');

    const second = await llm.chat({ system: 'be helpful', messages: [{ role: 'user', content: 'when do you open?' }], chatKey: 'sandbox-chat-2' });
    const estimated = db.get('SELECT * FROM usage_events ORDER BY id DESC LIMIT 1');
    assert.equal(Number(estimated.estimated), 1, 'no usage block → flagged estimate');
    assert.ok(Number(estimated.prompt_tokens) > 0);
    assert.ok(second.text.length > 0);
  } finally {
    llm.__setFetch(null);
    usage.detachUsageSink();
    usageEvents._resetUsageEvents();
  }
});

test('worker journals are imported once, and never twice', () => {
  const slug = 'cha-cha-chai';
  const dir = path.join(tenantsDir, slug, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'usage-events.jsonl');
  const line = (uid, tokens) => `${JSON.stringify({ uid, tenant: slug, kind: 'chat', provider: 'groq', model: 'm', totalTokens: tokens, promptTokens: tokens, conversation: 'hash1', at: new Date().toISOString() })}\n`;
  fs.writeFileSync(file, line('evt-1', 10) + line('evt-2', 20));

  const first = usage.ingestJournal({ slug });
  assert.equal(first.imported, 2);
  assert.equal(fs.existsSync(file), false, 'imported lines are removed, so the next import is cheap');

  fs.writeFileSync(file, line('evt-2', 20));
  const second = usage.ingestJournal({ slug });
  assert.equal(second.imported, 0);
  assert.equal(second.duplicates, 1, 'a replayed uid is not counted twice');
});

// ── 10. privacy ───────────────────────────────────────────
test('no customer message content reaches the platform log', () => {
  const marker = 'MY CUSTOMER SAID SOMETHING PRIVATE 9911';
  audit.recordAudit({
    action: 'note_test',
    accountId: 'acct-privacy',
    tenant: 'cha-cha-chai',
    detail: { text: marker, message: marker, nested: { body: marker }, kept: 'plan: free' },
  });
  const rows = audit.recentAudit({ accountId: 'acct-privacy' });
  const dumped = JSON.stringify(rows);
  assert.ok(!dumped.includes(marker), 'message-like fields are dropped before they are stored');
  assert.match(dumped, /plan: free/, 'useful fields survive');
});

test('usage rows contain no phone numbers', () => {
  usage.record({ tenant: 'cha-cha-chai', kind: 'chat', chatKey: '923001112233@s.whatsapp.net', promptTokens: 5 });
  const rows = JSON.stringify(db.all("SELECT * FROM usage_events WHERE tenant = 'cha-cha-chai'"));
  assert.ok(!rows.includes('923001112233'));
});

test('deleting an account needs a fresh export first, then removes the assistants', async () => {
  const auth = await signupAndLogin('delete@example.com', 'a long enough password');
  const created = await provisionFor(auth, { name: 'Delete Cafe', number: '923001112280' });
  const slug = created.body.slug;

  const tooEarly = await call({
    method: 'POST',
    url: '/api/platform/account/delete',
    headers: { ...JSON_HEADERS, ...authed(auth) },
    body: { confirm: 'DELETE' },
  });
  assert.equal(tooEarly.status, 409);
  assert.equal(tooEarly.body.error, 'export_first');

  const exported = await call({
    method: 'POST',
    url: '/api/platform/account/export',
    headers: { ...JSON_HEADERS, ...authed(auth) },
    body: {},
  });
  assert.equal(exported.status, 200);
  assert.equal(exported.body.export.tenants[0].slug, slug);
  assert.ok(!JSON.stringify(exported.body.export).includes('password_hash'));

  const deleted = await call({
    method: 'POST',
    url: '/api/platform/account/delete',
    headers: { ...JSON_HEADERS, ...authed(auth) },
    body: { confirm: 'DELETE' },
  });
  assert.equal(deleted.status, 200);
  assert.equal(provisioning.getTenant(slug), null);
  assert.equal(fs.existsSync(path.join(tenantsDir, slug)), false, 'the tenant folder is gone too');

  const row = accounts.getAccount(auth.accountId);
  assert.equal(row.status, 'deleted');
  assert.match(row.email, /deleted\.invalid$/);

  const after = await call({ url: '/api/platform/me', headers: { cookie: auth.cookie } });
  assert.equal(after.status, 401);
});

// ── 11. the browser surface ───────────────────────────────
test('pages carry the security headers and load nothing from another origin', async () => {
  const login = await call({ url: '/platform/login' });
  assert.equal(login.status, 200);
  assert.match(login.headers['Content-Security-Policy'], /default-src 'self'/);
  assert.equal(login.headers['X-Frame-Options'], 'DENY');
  assert.equal(login.headers['Referrer-Policy'], 'no-referrer');
  assert.ok(!/https?:\/\/(?!localhost)/.test(login.raw), 'no external URL anywhere in the page');
  assert.ok(!login.raw.includes('cdn.'));

  const app = await call({ url: '/platform/app' });
  assert.equal(app.status, 302);
  assert.equal(app.headers.Location, '/platform/login');

  const css = await call({ url: '/platform/app.css' });
  assert.equal(css.status, 200);
  assert.match(css.headers['Content-Type'], /text\/css/);

  // Only the three assets are served, and only from platform/public.
  const script = await call({ url: '/platform/app.js' });
  assert.equal(script.status, 200);
  assert.match(script.headers['Content-Type'], /javascript/);

  for (const attempt of ['/platform/%2e%2e%2fpackage.json', '/platform/..%2Fpackage.json', '/platform/app.js.bak']) {
    const res = await call({ url: attempt });
    assert.ok(res.status === 404 || res.status === 400, `${attempt} must not be served (${res.status})`);
    assert.ok(!res.raw.includes('"name": "whatsapp-self-knowledge-assistant"'));
  }
});

test('the dashboard hides other accounts’ assistants from its own list', async () => {
  const a = await signupAndLogin('list-a@example.com', 'a long enough password');
  const b = await signupAndLogin('list-b@example.com', 'a long enough password');
  await provisionFor(a, { name: 'List A Cafe', number: '923001112290' });
  await provisionFor(b, { name: 'List B Cafe', number: '923001112291' });

  const meA = await call({ url: '/api/platform/me', headers: { cookie: a.cookie } });
  const meB = await call({ url: '/api/platform/me', headers: { cookie: b.cookie } });
  assert.deepEqual(meA.body.tenants.map((t) => t.name), ['List A Cafe']);
  assert.deepEqual(meB.body.tenants.map((t) => t.name), ['List B Cafe']);
});

// ── 12. the layer, mounted ────────────────────────────────
test('initPlatform is a no-op when the flag is off', async () => {
  process.env.PLATFORM_ENABLED = '';
  const result = await platforms.initPlatform();
  assert.equal(result.ok, false);
  assert.equal(result.enabled, false);
  process.env.PLATFORM_ENABLED = '1';
});

test('the help texts the wizard shows come from owner.example.json', () => {
  const help = envModule.helpTexts();
  assert.ok(help['business.hours'], 'hours has a help line');
  assert.ok(help['catalog']);
  assert.match(help['business.hours'], /hours|Daily/i);
});

test('the platform database is 0600 and lives outside every tenant folder', () => {
  db.flush();
  const file = db.currentFile();
  assert.ok(file.startsWith(platformDir), 'its own directory');
  assert.ok(!file.startsWith(tenantsDir), 'never inside a tenant');
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('the sql is written once and can be re-targeted at Postgres', () => {
  const sql = 'SELECT * FROM accounts WHERE id = ? AND status = ?';
  assert.equal(db.toDialect(sql, 'sqlite'), sql);
  assert.equal(db.toDialect(sql, 'postgres'), 'SELECT * FROM accounts WHERE id = $1 AND status = $2');

  const pg = schemaModule.schemaStatements('postgres').join('\n');
  assert.match(pg, /BIGSERIAL PRIMARY KEY/);
  assert.ok(!pg.includes('AUTOINCREMENT'), 'the Postgres schema has no SQLite-only id type');
  assert.match(schemaModule.schemaStatements('sqlite').join('\n'), /AUTOINCREMENT/);
});
