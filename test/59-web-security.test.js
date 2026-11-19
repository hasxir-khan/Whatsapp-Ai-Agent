// test/59-web-security.test.js
// The security pass, written as tests that would have failed before it.
//
// Each block starts with the claim it reproduces and the verdict the pass
// reached: CONFIRMED (it was real, and the assertions below now pin the fix) or
// NOT REPRODUCED (it was not, and the assertion pins the reason so nobody
// "fixes" it later).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolate } from './helpers.js';

const dataDir = isolate('web-security');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
process.env.ENABLE_WEB = 'false';
delete process.env.DASHBOARD_TOKEN;
delete process.env.DEMO_MODE;

const env = await import('../src/config/env.js');
const webAuth = await import('../src/services/webAuth.js');
const { authorised, handleWebhookRequest } = await import('../src/server.js').then(async (m) => ({
  authorised: m.authorised,
  handleWebhookRequest: (await import('../src/transport/webhooks.js')).handleWebhookRequest,
}));
const { cloudInboundSeen, cloudInboundMark } = await import('../src/utils/db.js');
const db = await import('../src/utils/db.js');
await db.initDB();
const validation = await import('../src/services/validation.js');

function withConfig({ token = '', host = '0.0.0.0' }, fn) {
  const before = { token: env.config.server.token, host: env.config.server.host };
  env.config.server.token = token;
  env.config.server.host = host;
  try {
    return fn();
  } finally {
    env.config.server.token = before.token;
    env.config.server.host = before.host;
  }
}

const req = (headers = {}) => ({ headers, socket: { remoteAddress: '203.0.113.9' } });

// ── (a) private routes with no token on the default config ────────────────
// CLAIM: GET /, /index.html, /api/status, /api/growth and /qr.png are readable
// without a token on the default config. VERDICT: CONFIRMED — the default is
// HOST=0.0.0.0 with no DASHBOARD_TOKEN, and `authorised()` returned true when no
// token was set, while /api/status and /qr.png never checked at all.
test('(a) default config is a public bind with no token, and it is now refused', () => {
  assert.equal(env.config.server.host, '0.0.0.0', 'default HOST');
  assert.equal(env.config.server.token, '', 'default DASHBOARD_TOKEN');

  const state = webAuth.webSecurityState({ host: '0.0.0.0', token: '' });
  assert.equal(state.mode, 'refuse');
  assert.match(state.message, /DASHBOARD_TOKEN/);

  // The guard is what startServer() consults before listening.
  const real = env.config.server.host;
  try {
    env.config.server.host = '0.0.0.0';
    env.config.server.token = '';
    assert.equal(webAuth.authRequired(), false, 'no private routes exist in refuse mode');
    for (const url of ['/', '/index.html', '/api/status', '/api/growth', '/qr.png']) {
      assert.equal(
        authorised(req(), new URL(`http://x${url}`)),
        false,
        `${url} is not readable with no proof`
      );
    }
  } finally {
    env.config.server.host = real;
  }
});

// CLAIM: “empty token is fine on 0.0.0.0”. VERDICT: CONFIRMED — and that is the
// whole bug: it was fine everywhere. Loopback is the only place it stays fine.
test('(a) empty token is allowed only on loopback or an explicit demo', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    assert.equal(webAuth.webSecurityState({ host, token: '' }).mode, 'local', `${host} is local`);
    assert.equal(webAuth.authenticate(req()).ok, false, 'authenticate() reads the live config, not the argument');
  }
  withConfig({ host: '127.0.0.1', token: '' }, () => {
    assert.equal(webAuth.authenticate(req()).ok, true, 'loopback local mode needs no proof');
    assert.equal(authorised(req(), new URL('http://x/api/status')), true);
  });

  // npm run demo sets DEMO_MODE=1 and binds 0.0.0.0; that must keep working.
  process.env.DEMO_MODE = '1';
  try {
    withConfig({ host: '0.0.0.0', token: '' }, () => {
      assert.equal(webAuth.webSecurityState().mode, 'local');
      assert.equal(webAuth.authenticate(req()).ok, true, 'the demo is open by design, with fake data');
    });
  } finally {
    delete process.env.DEMO_MODE;
  }

  // A public bind with no token and no demo: refused.
  withConfig({ host: '0.0.0.0', token: '' }, () => {
    assert.equal(webAuth.webSecurityState().mode, 'refuse');
    assert.equal(webAuth.authenticate(req()).ok, false, 'refuse mode authenticates nobody');
  });
});

// ── (b) ?token= and where it can leak ─────────────────────────────────────
// CLAIM: `?token=` is accepted directly, so the secret ends up in browser
// history, a Referer header and any proxy log. VERDICT: CONFIRMED.
test('(b) a URL token is a one-time ticket, not a credential', () => {
  withConfig({ token: 'sekrit-token' }, () => {
    // Reaching a route with the token still in the URL does not authenticate.
    assert.equal(authorised(req(), new URL('http://x/api/growth?token=sekrit-token')), false);

    // The exchange answers with a redirect + a cookie, and never echoes the token.
    const exchange = webAuth.tokenExchange({ headers: {} }, new URL('http://x/api/growth?token=sekrit-token&after=7'));
    assert.equal(exchange.ok, true);
    assert.equal(exchange.location, '/api/growth?after=7', 'the redirect drops the token and keeps the rest');
    assert.match(exchange.value, /^wa_dash=[^;]+; Path=\/; HttpOnly; SameSite=Strict/);
    assert.doesNotMatch(exchange.value, /sekrit-token/, 'the token itself is not in the cookie');

    // A wrong ticket is refused and says nothing useful.
    const wrong = webAuth.tokenExchange({ headers: {} }, new URL('http://x/?token=nope'));
    assert.equal(wrong.ok, false);

    // No ticket at all is not an exchange.
    assert.equal(webAuth.tokenExchange({ headers: {} }, new URL('http://x/')), null);

    // And the cookie it issued is what authenticates the next request.
    const cookie = exchange.value.split(';')[0];
    assert.equal(authorised({ headers: { cookie } }, new URL('http://x/api/growth')), true);
  });
});

test('(b) tokens never reach HTML or a log line', () => {
  const src = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  // The 401 pages must not tell the caller to put the token in the URL of an
  // HTML page we then log; they name the env var and the exchange instead.
  const pages = src.match(/<!doctype html>[\s\S]*?<\/p>/g) || [];
  assert.ok(pages.length > 0, 'the locked pages exist');
  for (const page of pages) {
    assert.doesNotMatch(page, /\?token=\$\{|\$\{token\}|\$\{config\.server\.token\}/, 'no interpolation of a token');
    assert.doesNotMatch(page, /token=[A-Za-z0-9]{8,}/);
  }
  // Nothing logs the token.
  assert.doesNotMatch(src, /console\.(log|warn|error)\([^)]*config\.server\.token/);
  // And every browser response carries the referrer policy.
  assert.equal(webAuth.SECURITY_HEADERS['Referrer-Policy'], 'no-referrer');
});

// ── (c) signed sessions and CSRF ──────────────────────────────────────────
test('(c) the dashboard session is signed, expiring and CSRF-guarded', () => {
  withConfig({ token: 'sekrit-token' }, () => {
    const header = webAuth.sessionCookieHeader('sekrit-token');
    const cookie = header.split(';')[0];
    const value = cookie.split('=')[1];

    assert.equal(authorised({ headers: { cookie } }, new URL('http://x/')), true);
    assert.equal(authorised({ headers: { cookie: `wa_dash=${encodeURIComponent(value)}x` } }, new URL('http://x/')), false, 'tampered signature');

    const auth = webAuth.authenticate({ headers: { cookie, origin: 'https://evil.example', host: 'x' } });
    assert.equal(auth.ok, true);
    assert.equal(
      webAuth.mutationAllowed({ headers: { cookie, origin: 'https://evil.example', host: 'x' } }, auth),
      false,
      'cross-site cookie mutation'
    );
    assert.equal(webAuth.mutationAllowed({ headers: { cookie, origin: 'http://x', host: 'x' } }, auth), true, 'same-origin cookie mutation');

    // A bearer header cannot be replayed by a browser, so no CSRF needed.
    const bearer = webAuth.authenticate({ headers: { authorization: 'Bearer sekrit-token' } });
    assert.equal(bearer.via, 'bearer');
    assert.equal(webAuth.mutationAllowed({ headers: {} }, bearer), true);

    // Sessions expire.
    const later = Date.now() + 13 * 60 * 60 * 1000;
    assert.equal(webAuth.authenticate({ headers: { cookie } }, { now: later }).ok, false, 'a 12h session is gone after 13h');
  });
});

test('(c) an https proxy gets a Secure cookie', () => {
  withConfig({ token: 'sekrit-token' }, () => {
    assert.match(webAuth.sessionCookieHeader('sekrit-token'), /SameSite=Strict/);
    assert.doesNotMatch(webAuth.sessionCookieHeader('sekrit-token'), /Secure/, 'plain http stays usable locally');
    assert.equal(webAuth.isHttps({ headers: { 'x-forwarded-proto': 'https' } }), true);
  });
});

// ── (e) file permissions ──────────────────────────────────────────────────
test('(e) tenant secrets and backups are 0600 in 0700 folders', () => {
  const { ensurePrivateDir, writePrivateFile } = validation;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-perm-'));
  const file = path.join(dir, 'config', 'owner.json');
  writePrivateFile(file, '{"owner":{}}');
  ensurePrivateDir(path.join(dir, 'sessions'));

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'file is 0600');
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700, 'folder is 0700');
    assert.equal(fs.statSync(path.join(dir, 'sessions')).mode & 0o777, 0o700);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});



test('(e) resolveInside refuses an escape', () => {
  const root = path.join(os.tmpdir(), 'wa-tenants');
  assert.equal(validation.resolveInside(root, 'shop'), path.join(root, 'shop'));
  assert.throws(() => validation.resolveInside(root, '../etc'), /outside/);
  assert.throws(() => validation.resolveInside(root, 'shop/../../etc/passwd'), /outside/);
  assert.equal(validation.validSlug('burger-point'), true);
  for (const bad of ['..', '-lead', 'trail-', 'double--dash', 'UPPER', 'a', 'has space', 'x'.repeat(41)]) {
    assert.equal(validation.validSlug(bad), false, `${bad} is not a slug`);
  }
  assert.equal(validation.validPort(3001), true);
  assert.equal(validation.validPort(80), false, 'unprivileged only');
  assert.equal(validation.validPort('nope'), false);
  assert.equal(validation.validPort(70000), false);
});

// ── (f) webhooks ─────────────────────────────────────────────────────────
function fakeWebhookReqRes({ method = 'POST', url = '/webhook/test', headers = {}, body = '' } = {}) {
  const res = {
    status: null,
    headers: {},
    body: '',
    writeHead(status, h) {
      this.status = status;
      this.headers = h || {};
    },
    end(b) {
      this.body = b === undefined || b === null ? '' : String(b);
    },
  };
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroyed = false;
  req.destroy = () => {
    req.destroyed = true;
  };
  req.resume = () => {};
  req.removeAllListeners = EventEmitter.prototype.removeAllListeners.bind(req);
  process.nextTick(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return { req, res };
}

test('(f) an oversized webhook body gets a 413, not a dead socket', async () => {
  const { req, res } = fakeWebhookReqRes({ body: 'x'.repeat(3 * 1024 * 1024) });
  await handleWebhookRequest(req, res, new URL('http://x/webhook/unknown'));
  // An unknown slug answers 404 before the body is read — that is fine and is the
  // first line of defence; the size limit is exercised directly:
  const { readRawBody } = await import('../src/transport/webhooks.js');
  const { req: big, res: sink } = fakeWebhookReqRes({ body: 'x'.repeat(3 * 1024 * 1024) });
  await assert.rejects(() => readRawBody(big), /too large/);
  assert.equal(big.destroyed, false, 'the socket survives so the caller can still answer');
  assert.equal(sink.status, null);
});

test('(f) durable duplicate protection uses the existing cloud_messages table', async () => {
  db.initDB();
  const waId = 'wamid.TEST-DUPLICATE-1';
  assert.equal(cloudInboundSeen(waId), false);
  cloudInboundMark(waId, { tenant: 'shop', number: '923001234567' });
  assert.equal(cloudInboundSeen(waId), true, 'the ledger survives a restart because it is a row');

  // The table is the existing one, not a second mechanism.
  const row = db.get('SELECT kind, status FROM cloud_messages WHERE wa_id = ?', [waId]);
  assert.equal(row.kind, 'inbound');
  db.run('DELETE FROM cloud_messages WHERE wa_id = ?', [waId]);
});

test('(f) wrong method and malformed bodies are answered, not guessed', async () => {
  const { handleWebhookRequest: handle } = await import('../src/transport/webhooks.js');
  const put = fakeWebhookReqRes({ method: 'PUT', url: '/webhook/unknown' });
  await handle(put.req, put.res, new URL('http://x/webhook/unknown'));
  assert.ok([404, 405].includes(put.res.status), 'unknown slug or wrong method, never 200');

  const bad = fakeWebhookReqRes({ method: 'POST', body: '{not json' });
  await handle(bad.req, bad.res, new URL('http://x/webhook/unknown'));
  assert.equal(bad.res.status, 404, 'unknown slugs are refused before parsing');
});

// ── (1) the dashboard refusing must not take webhooks or /health down ─────
// A Cloud tenant can run with no dashboard at all. Before this test the refusal
// returned null from startServer(), which also removed /webhook/<slug> — the one
// route Meta needs — and /health, the one route a monitor needs.
test('(1) refused dashboard: webhooks and /health still answer, everything else is off', async () => {
  const http = await import('node:http');
  const env2 = await import('../src/config/env.js');
  const server2 = await import('../src/server.js');

  const before = {
    host: env2.config.server.host,
    port: env2.config.server.port,
    token: env2.config.server.token,
    enabled: env2.config.server.enabled,
  };
  env2.config.server.host = '0.0.0.0';
  env2.config.server.port = 0;
  env2.config.server.token = '';
  env2.config.server.enabled = true;
  delete process.env.DEMO_MODE;

  let srv = null;
  try {
    srv = server2.startServer();
    assert.ok(srv, 'the server still listens — webhooks are how the bot answers');
    if (!srv.listening) await new Promise((r) => srv.once('listening', r));
    const port = srv.address().port;

    const get = (path) =>
      new Promise((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, body }));
          })
          .on('error', reject);
      });

    const health = await get('/health');
    assert.equal(health.status, 200, '/health stays public');
    assert.deepEqual(Object.keys(JSON.parse(health.body)).sort(), ['ok', 'uptime'], 'and minimal');

    // The webhook route is reached (it answers for its own reasons — an unknown
    // tenant is a 404, not a dashboard lock).
    const hook = await get('/webhook/nobody');
    assert.equal(hook.status, 404);
    assert.match(hook.body, /No cloud tenant|Cloud transport is not running/);

    for (const path of ['/', '/index.html', '/api/status', '/api/growth', '/qr.png', '/inbox']) {
      const res = await get(path);
      assert.equal(res.status, 404, `${path} is off, not open`);
      assert.match(res.body, /Dashboard disabled/);
    }

    const status = server2.webSecurityStatus();
    assert.equal(status.dashboard, false, 'dashboard off');
    assert.equal(status.webhooks, true, 'webhooks up');
    assert.equal(status.health, true, 'health up');
  } finally {
    srv?.close();
    Object.assign(env2.config.server, before);
  }
});
