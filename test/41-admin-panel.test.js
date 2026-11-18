// Phase 4 Part 3 — the tenant control panel.
//
// This file is mostly a security test. The panel can create tenants, delete
// them, read their business profiles and write their keys; if any of that can
// happen without a token, or with a cookie some other site caused the browser
// to send, the rest of the phase does not matter.
//
// Every tenant here is made up: 923001112233 and friends, never a real number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolate } from './helpers.js';

let envModule = null;

const dataDir = isolate('admin-panel');
const configDir = path.join(dataDir, 'config');
const tenantsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-admin-tenants-'));
fs.mkdirSync(configDir, { recursive: true });

const TOKEN = 'test-admin-token-0123456789abcdef';
process.env.CONFIG_DIR = configDir;
process.env.TENANTS_DIR = tenantsDir;
process.env.ADMIN_TOKEN = TOKEN;
process.env.ENABLE_WEB = 'false';
delete process.env.DASHBOARD_TOKEN;
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;

function writeProfile(features = {}) {
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify({
      owner: { name: 'Test Owner', timezone: 'Asia/Karachi' },
      business: {
        name: 'Test Cafe',
        type: 'Cafe',
        city: 'Islamabad',
        hours: 'Daily 12:00-23:00',
        currency: 'PKR',
        payment: { bank: { name: 'Test Bank', number: '0123456789' } },
      },
      catalog: { items: [{ name: 'Chicken Karahi', kind: 'product', price: 1350 }] },
      features: { businessProfile: true, catalog: true, adminPanel: true, ...features },
    }),
    null,
  );
  try {
    envModule?.reloadProfile?.();
  } catch {
    /* before the first import */
  }
}
writeProfile();

const env = await import('../src/config/env.js');
envModule = env;
env.reloadProfile();
await import('../src/utils/db.js').then((m) => m.initDB());

const server = await import('../src/server.js');
const admin = await import('../src/services/adminPanel.js');
const { handleAdminRoute, adminPage } = server;

// ── a fake req/res, so none of this needs a port ─────────────
function fakeReqRes({ method = 'GET', url = '/api/admin/tenants', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost:3000', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, hdrs = {}) {
      this.status = status;
      this.headers = { ...hdrs };
      return this;
    },
    end(chunk = '') {
      this.body += chunk;
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
  const handled = await handleAdminRoute(req, res, new URL(opts.url || '/api/admin/tenants', 'http://localhost'));
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { handled, status: res.status, headers: res.headers, body: json, raw: res.body };
}

const bearer = { authorization: `Bearer ${TOKEN}` };
const auth = { ...bearer };
const json = (body) => ({ 'content-type': 'application/json' });

// A real session, obtained the way the browser gets one.
async function login() {
  const res = await call({
    method: 'POST',
    url: '/api/admin/login',
    headers: json({}),
    body: { token: TOKEN },
  });
  const cookies = [].concat(res.headers['Set-Cookie'] || []);
  const sessionPair = cookies.find((c) => c.startsWith('wa_admin=')).split(';')[0];
  const csrfPair = cookies.find((c) => c.startsWith('wa_admin_csrf=')).split(';')[0];
  const csrf = decodeURIComponent(csrfPair.split('=')[1]);
  return { cookie: `${sessionPair}; ${csrfPair}`, csrf };
}

// ── 1. the flag is the switch ───────────────────────────────
test('off by default: no route exists at all', async () => {
  assert.equal((await import('../src/services/profile.js')).featureOn('adminPanel'), true, 'fixture turns it on');
  writeProfile({ adminPanel: false });
  const page = await call({ url: '/admin' });
  assert.equal(page.status, 404);
  const api = await call({ url: '/api/admin/tenants', headers: auth });
  assert.equal(api.status, 404);
  assert.equal(api.body.error, 'not_found');
  writeProfile();
});

test('the flag on with no ADMIN_TOKEN is still 404 — never open', async () => {
  const saved = env.config.admin.token;
  env.config.admin.token = '';
  const api = await call({ url: '/api/admin/tenants', headers: auth });
  assert.equal(api.status, 404);
  const page = await call({ url: '/admin' });
  assert.equal(page.status, 404);
  assert.match(page.raw, /ADMIN_TOKEN is empty/);
  env.config.admin.token = saved;
});

test('the admin route only claims /admin and /api/admin', async () => {
  const { req, res } = fakeReqRes({ url: '/inbox' });
  const handled = await handleAdminRoute(req, res, new URL('/inbox', 'http://localhost'));
  assert.equal(handled, false);
  assert.equal(res.status, 0);
});

// ── 2. proof of identity ────────────────────────────────────
test('no credentials: 401, and the page is a login form, not the panel', async () => {
  const api = await call({ url: '/api/admin/tenants' });
  assert.equal(api.status, 401);
  assert.equal(api.body.error, 'unauthorised');

  const page = await call({ url: '/admin' });
  assert.equal(page.status, 401);
  assert.match(page.raw, /Admin token/);
  assert.doesNotMatch(page.raw, /New tenant/);
});

test('a wrong bearer token is 401 and never a close call', async () => {
  for (const authorization of ['Bearer nope', `Bearer ${TOKEN}x`, 'Bearer ', 'Basic abc']) {
    const res = await call({ url: '/api/admin/tenants', headers: { authorization } });
    assert.equal(res.status, 401, `${authorization} must not authenticate`);
  }
});

test('a correct bearer token opens the API and the page', async () => {
  const list = await call({ url: '/api/admin/tenants', headers: auth });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.tenants));

  const page = await call({ url: '/admin', headers: auth });
  assert.equal(page.status, 200);
  assert.match(page.raw, /New tenant/);
  assert.equal(page.raw, adminPage());
});

test('login sets an HttpOnly, SameSite=Strict session and its CSRF pair', async () => {
  const res = await call({ method: 'POST', url: '/api/admin/login', headers: json({}), body: { token: TOKEN } });
  assert.equal(res.status, 200);
  assert.ok(res.body.csrf);
  const cookies = [].concat(res.headers['Set-Cookie']).join(' | ');
  assert.match(cookies, /wa_admin=[^;]+; Path=\/; HttpOnly; SameSite=Strict/);
  assert.match(cookies, /wa_admin_csrf=/);
});

test('login is rate limited: the sixth bad guess waits', async () => {
  admin.resetRateLimits();
  for (let i = 0; i < 5; i += 1) {
    const res = await call({ method: 'POST', url: '/api/admin/login', headers: json({}), body: { token: 'wrong-' + i } });
    assert.equal(res.status, 401);
  }
  const blocked = await call({ method: 'POST', url: '/api/admin/login', headers: json({}), body: { token: TOKEN } });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.body.retryAfter >= 1);
  admin.resetRateLimits();
});

test('doctor refuses to be quiet about a panel with no token or an open port', async () => {
  const { growthSettingsWarnings } = await import('../scripts/doctor.js');
  const profile = { features: { adminPanel: true }, business: {} };

  const noToken = growthSettingsWarnings(profile, { HOST: '127.0.0.1' });
  assert.ok(noToken.some((w) => /ADMIN_TOKEN is empty/i.test(w)), noToken.join('\n'));

  const short = growthSettingsWarnings(profile, { ADMIN_TOKEN: 'short', HOST: '127.0.0.1' });
  assert.ok(short.some((w) => /shorter than 16/i.test(w)), short.join('\n'));

  const openPort = growthSettingsWarnings(profile, { ADMIN_TOKEN: 'a'.repeat(32), HOST: '0.0.0.0' });
  assert.ok(openPort.some((w) => /tunnel|127\.0\.0\.1/i.test(w)), openPort.join('\n'));

  const shared = growthSettingsWarnings(profile, {
    ADMIN_TOKEN: 'a'.repeat(32),
    DASHBOARD_TOKEN: 'a'.repeat(32),
    HOST: '127.0.0.1',
  });
  assert.ok(shared.some((w) => /same as DASHBOARD_TOKEN/i.test(w)), shared.join('\n'));

  const careful = growthSettingsWarnings(profile, {
    ADMIN_TOKEN: 'a'.repeat(32),
    DASHBOARD_TOKEN: 'b'.repeat(32),
    HOST: '127.0.0.1',
    PUBLIC_URL: 'https://bot.example.com',
  });
  assert.deepEqual(careful, []);

  const off = growthSettingsWarnings({ features: {}, business: {} }, { HOST: '0.0.0.0' });
  assert.deepEqual(off, []);
});

// ── 3. CSRF ─────────────────────────────────────────────────
test('a cookie-authenticated POST without the CSRF token is refused', async () => {
  const { cookie } = await login();
  const res = await call({
    method: 'POST',
    url: '/api/admin/tenants',
    headers: { ...json({}), cookie },
    body: { name: 'Csrf Co', number: '923001112233' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'csrf_failed');
  // and nothing was created
  assert.equal(fs.existsSync(path.join(tenantsDir, 'csrf-co')), false);
});

test('the same POST succeeds with the CSRF token, or from the same origin', async () => {
  const { cookie, csrf } = await login();
  const withHeader = await call({
    method: 'POST',
    url: '/api/admin/tenants',
    headers: { ...json({}), cookie, 'x-admin-csrf': csrf },
    body: { name: 'Csrf Co', number: '923001112233' },
  });
  assert.equal(withHeader.status, 201);
  assert.equal(withHeader.body.tenant.slug, 'csrf-co');

  const sameOrigin = await call({
    method: 'POST',
    url: '/api/admin/tenants',
    headers: { ...json({}), cookie, origin: 'http://localhost:3000' },
    body: { name: 'Same Origin Co', number: '923001112244' },
  });
  assert.equal(sameOrigin.status, 201);

  const foreignOrigin = await call({
    method: 'POST',
    url: '/api/admin/tenants',
    headers: { ...json({}), cookie, origin: 'https://evil.example' },
    body: { name: 'Evil Co', number: '923001112255' },
  });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(fs.existsSync(path.join(tenantsDir, 'evil-co')), false);

  // a bearer token needs no CSRF: no browser attaches it for you
  const withBearer = await call({
    method: 'POST',
    url: '/api/admin/tenants',
    headers: { ...json({}), ...auth },
    body: { name: 'Script Co', number: '923001112266' },
  });
  assert.equal(withBearer.status, 201);
});

// ── 4. slugs and paths ──────────────────────────────────────
test('bad slugs and traversal attempts are rejected before any file is touched', async () => {
  const bad = ['Admin', 'a', 'has space', 'has_underscore', '..', '../etc', '%2e%2e%2fetc', 'x'.repeat(41), 'admin-/-x'];
  for (const slug of bad) {
    const res = await call({ url: `/api/admin/tenants/${encodeURIComponent(slug)}`, headers: auth });
    assert.ok([400, 404].includes(res.status), `${slug} → ${res.status}`);
    assert.notEqual(res.status, 200);
  }
  assert.equal(admin.validSlug('good-slug-1'), true);
  assert.equal(admin.validSlug('no'), true, 'two characters is the documented minimum');
  assert.equal(admin.validSlug('x'), false);
  assert.throws(() => admin.tenantDir('../escape'), /invalid_slug/);
});

test('an unknown but well-formed slug is a 404, not a crash', async () => {
  const res = await call({ url: '/api/admin/tenants/does-not-exist', headers: auth });
  assert.equal(res.status, 404);
});

test('uploads cannot escape their folder, whatever they are called', () => {
  const saved = admin.saveUpload('csrf-co', { name: '../../etc/passwd.txt', buffer: Buffer.from('hello') });
  assert.equal(saved.ok, true);
  const dir = path.join(tenantsDir, 'csrf-co', 'uploads');
  assert.equal(path.dirname(saved.file), dir);
  assert.match(path.basename(saved.file), /^[0-9]+-passwd\.txt$/);
});

test('uploads are limited by type and by size', () => {
  const exe = admin.saveUpload('csrf-co', { name: 'malware.exe', buffer: Buffer.from('MZ') });
  assert.equal(exe.ok, false);
  assert.equal(exe.reason, 'type_not_allowed');

  const big = admin.saveUpload('csrf-co', { name: 'big.txt', buffer: Buffer.alloc(admin.UPLOAD_MAX_BYTES + 1, 65) });
  assert.equal(big.ok, false);
  assert.equal(big.reason, 'too_large');
  assert.equal(admin.UPLOAD_MAX_BYTES, 5 * 1024 * 1024);

  const empty = admin.saveUpload('csrf-co', { name: 'empty.txt', buffer: Buffer.alloc(0) });
  assert.equal(empty.ok, false);
});

// ── 5. create, same code path as the CLI ────────────────────
test('creating from the panel produces exactly what the CLI produces', async () => {
  const panelRes = await call({
    method: 'POST',
    url: '/api/admin/tenants',
    headers: { ...json({}), ...auth },
    body: { name: 'Panel Cafe', number: '923001112277', template: 'restaurant' },
  });
  assert.equal(panelRes.status, 201);

  const { createTenant } = await import('../scripts/tenant.js');
  const cli = createTenant({ name: 'Cli Cafe', number: '923001112288', template: 'restaurant' });

  const panelDir = path.join(tenantsDir, 'panel-cafe');
  const cliDir = path.join(tenantsDir, cli.slug);
  const shape = (dir) =>
    fs.readdirSync(dir).sort().map((name) => (fs.statSync(path.join(dir, name)).isDirectory() ? name + '/' : name));
  assert.deepEqual(shape(panelDir), shape(cliDir), 'same folders, same files');
  assert.deepEqual(shape(path.join(panelDir, 'config')), ['owner.json']);

  const panelMeta = JSON.parse(fs.readFileSync(path.join(panelDir, 'tenant.json'), 'utf8'));
  const cliMeta = JSON.parse(fs.readFileSync(path.join(cliDir, 'tenant.json'), 'utf8'));
  assert.deepEqual(Object.keys(panelMeta).sort(), Object.keys(cliMeta).sort());
  assert.equal(panelMeta.slug, 'panel-cafe');
  assert.equal(panelMeta.number, '923001112277');
  assert.notEqual(panelMeta.port, cliMeta.port, 'each tenant gets its own port');

  // the panel created it with the same template machinery, so the profile is real
  const panelProfile = JSON.parse(fs.readFileSync(path.join(panelDir, 'config', 'owner.json'), 'utf8'));
  const cliProfile = JSON.parse(fs.readFileSync(path.join(cliDir, 'config', 'owner.json'), 'utf8'));
  assert.deepEqual(Object.keys(panelProfile).sort(), Object.keys(cliProfile).sort());
});

test('creating twice with the same name is refused, and the reason is the CLI’s', async () => {
  const res = await call({
    method: 'POST',
    url: '/api/admin/tenants',
    headers: { ...json({}), ...auth },
    body: { name: 'Panel Cafe', number: '923001112299' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /already exists/i);
});

test('create is rate limited', async () => {
  admin.resetRateLimits();
  let sawLimit = false;
  for (let i = 0; i < 12; i += 1) {
    const res = await call({
      method: 'POST',
      url: '/api/admin/tenants',
      headers: { ...json({}), ...auth },
      body: { name: `Bulk Co ${i}`, number: '9230011122' + String(30 + i) },
    });
    if (res.status === 429) sawLimit = true;
  }
  assert.equal(sawLimit, true, 'the 11th create in an hour must be refused');
  admin.resetRateLimits();
});

// ── 6. delete needs the slug typed ──────────────────────────
test('delete needs the slug typed exactly, then removes only that folder', async () => {
  const without = await call({ method: 'DELETE', url: '/api/admin/tenants/same-origin-co', headers: { ...json({}), ...auth }, body: {} });
  assert.equal(without.status, 400);
  assert.equal(without.body.error, 'confirmation_required');
  assert.equal(fs.existsSync(path.join(tenantsDir, 'same-origin-co')), true);

  const wrong = await call({
    method: 'DELETE',
    url: '/api/admin/tenants/same-origin-co',
    headers: { ...json({}), ...auth },
    body: { confirm: 'same-origin' },
  });
  assert.equal(wrong.status, 400);
  assert.equal(fs.existsSync(path.join(tenantsDir, 'same-origin-co')), true);

  const right = await call({
    method: 'DELETE',
    url: '/api/admin/tenants/same-origin-co',
    headers: { ...json({}), ...auth },
    body: { confirm: 'same-origin-co' },
  });
  assert.equal(right.status, 200);
  assert.equal(fs.existsSync(path.join(tenantsDir, 'same-origin-co')), false);
  assert.equal(fs.existsSync(path.join(tenantsDir, 'csrf-co')), true, 'other tenants untouched');
});

// ── 7. keys are write-only ──────────────────────────────────
test('keys can be written, are masked on the way out, and never come back raw', async () => {
  const secret = 'gsk_testkey_0123456789abcdef';
  const res = await call({
    method: 'POST',
    url: '/api/admin/tenants/csrf-co/keys',
    headers: { ...json({}), ...auth },
    body: { keys: { GROQ_API_KEY: secret } },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.saved, ['GROQ_API_KEY']);
  assert.doesNotMatch(res.raw, new RegExp(secret));
  assert.match(res.body.masked.groq, /^gsk_…/);

  const envFile = fs.readFileSync(path.join(tenantsDir, 'csrf-co', '.env'), 'utf8');
  assert.match(envFile, new RegExp(`GROQ_API_KEY=${secret}`));

  const detail = await call({ url: '/api/admin/tenants/csrf-co', headers: auth });
  assert.doesNotMatch(detail.raw, new RegExp(secret));
  assert.match(detail.raw, /gsk_…/);
});

test('a silly key value or key name is refused', async () => {
  const badName = await call({
    method: 'POST',
    url: '/api/admin/tenants/csrf-co/keys',
    headers: { ...json({}), ...auth },
    body: { keys: { PATH: '/etc/passwd' } },
  });
  assert.equal(badName.status, 400);

  const badValue = await call({
    method: 'POST',
    url: '/api/admin/tenants/csrf-co/keys',
    headers: { ...json({}), ...auth },
    body: { keys: { GROQ_API_KEY: 'has spaces and\nnewlines' } },
  });
  assert.equal(badValue.status, 400);
});

test('test-key probes the provider without ever returning the key', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return { status: 200 };
  };
  const good = await admin.probeKey({ provider: 'groq', key: 'gsk_probe_1234567890', fetchImpl: fakeFetch });
  assert.deepEqual(good, { ok: true, status: 200, reason: 'works' });
  assert.match(calls[0], /api\.groq\.com/);

  const rejected = await admin.probeKey({ provider: 'groq', key: 'gsk_probe_1234567890', fetchImpl: async () => ({ status: 401 }) });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'rejected');

  const gemini = await admin.probeKey({ provider: 'gemini', key: 'AQ.probe-key-123456', fetchImpl: async () => ({ status: 200 }) });
  assert.equal(gemini.ok, true);

  const offline = await admin.probeKey({
    provider: 'groq',
    key: 'gsk_probe_1234567890',
    fetchImpl: async () => {
      throw Object.assign(new Error('boom'), { name: 'TypeError' });
    },
  });
  assert.equal(offline.reason, 'network_error');

  const route = await call({
    method: 'POST',
    url: '/api/admin/tenants/csrf-co/test-key',
    headers: { ...json({}), ...auth },
    body: { provider: 'groq', key: 'gsk_probe_1234567890' },
  });
  assert.equal(route.status, 200);
  assert.doesNotMatch(route.raw, /gsk_probe_1234567890/);
});

// ── 8. profile ──────────────────────────────────────────────
test('the profile editor writes only what profile.js would accept', async () => {
  const read = await call({ url: '/api/admin/tenants/csrf-co/profile', headers: auth });
  assert.equal(read.status, 200);
  assert.equal(typeof read.body.profile, 'object');

  const base = {
    owner: { name: 'Csrf Co', timezone: 'Asia/Karachi' },
    business: {
      name: 'Csrf Co',
      type: 'Cafe',
      city: 'Islamabad',
      hours: 'Daily 12:00-23:00',
      currency: 'PKR',
    },
    catalog: { items: [{ name: 'Chai', kind: 'product', price: 150 }] },
    features: { businessProfile: true, catalog: true, adminPanel: true },
  };

  // A real error: an item with no price. The panel must not save it.
  const broken = JSON.parse(JSON.stringify(base));
  broken.catalog.items.push({ name: 'Mystery Box' });
  const refused = await call({
    method: 'PUT',
    url: '/api/admin/tenants/csrf-co/profile',
    headers: { ...json({}), ...auth },
    body: { profile: broken },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'invalid_profile');
  assert.ok(refused.body.errors.some((e) => /no price/i.test(e)), refused.body.errors.join('; '));

  // A warning, not an error: an empty field saves, and says what it means.
  const thin = JSON.parse(JSON.stringify(base));
  thin.business.hours = '';
  const warned = await call({
    method: 'PUT',
    url: '/api/admin/tenants/csrf-co/profile',
    headers: { ...json({}), ...auth },
    body: { profile: thin },
  });
  assert.equal(warned.status, 200);
  assert.ok(warned.body.warnings.some((w) => /business\.hours/.test(w)), warned.body.warnings.join('; '));

  const good = JSON.parse(JSON.stringify(base));
  good.business.city = 'Rawalpindi';
  const saved = await call({
    method: 'PUT',
    url: '/api/admin/tenants/csrf-co/profile',
    headers: { ...json({}), ...auth },
    body: { profile: good },
  });
  assert.equal(saved.status, 200);
  const onDisk = JSON.parse(fs.readFileSync(path.join(tenantsDir, 'csrf-co', 'config', 'owner.json'), 'utf8'));
  assert.equal(onDisk.business.city, 'Rawalpindi');
});

// ── 9. knowledge upload ─────────────────────────────────────
test('a text file goes through the learn pipeline and reports chunks', async () => {
  const content = Buffer.from('Delivery is free within 5 km.\n\nWe open at noon every day.\n');
  const res = await call({
    method: 'POST',
    url: '/api/admin/tenants/csrf-co/knowledge',
    headers: { ...json({}), ...auth },
    body: { name: 'delivery.txt', contentBase64: content.toString('base64') },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.saved.name, 'delivery.txt');
  assert.ok(res.body.saved.bytes > 0);
  assert.equal(typeof res.body.ingested.chunks, 'number');
});

test('the upload route refuses a disallowed type with a reason', async () => {
  const res = await call({
    method: 'POST',
    url: '/api/admin/tenants/csrf-co/knowledge',
    headers: { ...json({}), ...auth },
    body: { name: 'payload.exe', contentBase64: Buffer.from('MZ').toString('base64') },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'type_not_allowed');
});

// ── 10. QR and cloud ────────────────────────────────────────
test('a cloud tenant is shown its webhook instead of a QR', async () => {
  const dir = path.join(tenantsDir, 'csrf-co');
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8').replace('TRANSPORT=baileys', 'TRANSPORT=cloud') + '\nCLOUD_VERIFY_TOKEN=verify-me\n');
  const res = await call({ url: '/api/admin/tenants/csrf-co/qr', headers: auth });
  assert.equal(res.status, 200);
  assert.equal(res.body.transport, 'cloud');
  assert.equal(res.body.qr, null);
  assert.equal(res.body.webhookPath, '/webhook/csrf-co');
  assert.equal(res.body.verifyTokenSet, true);
  assert.doesNotMatch(res.raw, /verify-me/, 'the verify token itself is never echoed');

  fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8').replace('TRANSPORT=cloud', 'TRANSPORT=baileys'));
});

test('a baileys tenant with no session and no process says so, honestly', async () => {
  const res = await call({ url: '/api/admin/tenants/csrf-co/qr', headers: auth });
  assert.equal(res.status, 200);
  assert.equal(res.body.qr, null);
  assert.match(String(res.body.note), /Start the tenant|already linked/);
});

// ── 11. start / stop / restart, without spawning a bot ──────
test('start, stop and restart go through one hook and are audited', async () => {
  const seen = [];
  admin.setAdminHooks({
    start: async (slug) => {
      seen.push(['start', slug]);
      return { ok: true, pid: 4242 };
    },
    stop: async (slug) => {
      seen.push(['stop', slug]);
      return { ok: true, stopped: true };
    },
    restart: async (slug) => {
      seen.push(['restart', slug]);
      return { ok: true, pid: 4343 };
    },
  });
  try {
    for (const action of ['start', 'stop', 'restart']) {
      const res = await call({ method: 'POST', url: `/api/admin/tenants/csrf-co/${action}`, headers: { ...json({}), ...auth }, body: {} });
      assert.equal(res.status, 200, action);
    }
    assert.deepEqual(seen, [['start', 'csrf-co'], ['stop', 'csrf-co'], ['restart', 'csrf-co']]);
    const rows = admin.recentAudit(50).map((r) => r.action);
    for (const action of ['tenant_start', 'tenant_stop', 'tenant_restart']) assert.ok(rows.includes(action), action);
  } finally {
    admin.resetAdminHooks();
  }
});

// ── 12. audit ───────────────────────────────────────────────
test('every action leaves an audit row, and no row contains a secret', async () => {
  const rows = admin.recentAudit(200);
  const actions = new Set(rows.map((r) => r.action));
  for (const expected of ['login', 'tenant_create', 'tenant_delete', 'profile_saved', 'keys_written', 'knowledge_upload', 'csrf_rejected']) {
    assert.ok(actions.has(expected), `missing audit action: ${expected}`);
  }
  const text = JSON.stringify(rows);
  assert.doesNotMatch(text, /gsk_testkey_0123456789abcdef/);
  assert.doesNotMatch(text, new RegExp(TOKEN));
  for (const row of rows) assert.ok(row.created_at && row.action, 'rows are stamped');
});

test('the audit endpoint is behind the token and returns newest first', async () => {
  const denied = await call({ url: '/api/admin/audit' });
  assert.equal(denied.status, 401);
  const ok = await call({ url: '/api/admin/audit?limit=5', headers: auth });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.entries.length <= 5);
  const ids = ok.body.entries.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
});

// ── 13. no secrets, ever ────────────────────────────────────
test('no response carries the token, a key value or an .env line', async () => {
  const responses = await Promise.all([
    call({ url: '/api/admin/tenants', headers: auth }),
    call({ url: '/api/admin/tenants/csrf-co', headers: auth }),
    call({ url: '/api/admin/tenants/csrf-co/profile', headers: auth }),
    call({ url: '/api/admin/audit?limit=50', headers: auth }),
    call({ url: '/api/admin/session', headers: auth }),
    call({ url: '/admin', headers: auth }),
  ]);
  for (const res of responses) {
    assert.doesNotMatch(res.raw, new RegExp(TOKEN), 'the admin token must never be echoed');
    assert.doesNotMatch(res.raw, /gsk_testkey_0123456789abcdef/);
    assert.doesNotMatch(res.raw, /GROQ_API_KEY=/);
    assert.doesNotMatch(res.raw, /creds\.json"/);
  }
});

// ── 14. headers ─────────────────────────────────────────────
test('every admin response carries the hardening headers', async () => {
  const responses = [
    await call({ url: '/admin', headers: auth }),
    await call({ url: '/api/admin/tenants', headers: auth }),
    await call({ url: '/api/admin/tenants' }),
    await call({ method: 'POST', url: '/api/admin/login', headers: json({}), body: { token: 'nope' } }),
  ];
  for (const res of responses) {
    assert.match(res.headers['Content-Security-Policy'], /default-src 'none'/);
    assert.match(res.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
    assert.equal(res.headers['X-Frame-Options'], 'DENY');
    assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});

test('the page is one file with no external requests', () => {
  const page = adminPage();
  assert.doesNotMatch(page, /https?:\/\/(?!localhost)/, 'no CDN, no remote asset');
  assert.doesNotMatch(page, /<script[^>]+src=/i);
  assert.doesNotMatch(page, /<link[^>]+href=/i);
  assert.match(page, /\/api\/admin\/tenants/);
  assert.match(page, /credentials: 'same-origin'/);
});

test('the rate limiter counts a window and then resets', () => {
  admin.resetRateLimits();
  const opts = { max: 3, windowMs: 1000, now: 1000000 };
  assert.equal(admin.rateLimit('k', opts).ok, true);
  admin.rateLimit('k', opts);
  admin.rateLimit('k', opts);
  const blocked = admin.rateLimit('k', opts);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfter >= 1);
  assert.equal(admin.rateLimit('k', { ...opts, now: 1002000 }).ok, true, 'a new window is a new start');
  admin.resetRateLimits();
});

test('passwords compare in constant time, and lengths do not leak', () => {
  assert.equal(admin.safeEqual('abc', 'abc'), true);
  assert.equal(admin.safeEqual('abc', 'abd'), false);
  assert.equal(admin.safeEqual('abc', 'abcdefghijklmnop'), false);
  const { issueSession, sessionValid } = admin;
  const session = issueSession();
  assert.equal(sessionValid(session.value), true);
  assert.equal(sessionValid(session.value.split('.')[0] + '.forged'), false);
  assert.equal(sessionValid('9999999999999.deadbeef'), false);
});
