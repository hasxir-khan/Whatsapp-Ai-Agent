import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { demo, enable, fresh, offer, buy, submit, jobs, all, get } from './fixtures/billing.js';
const { operatorLogin, operatorSession } = await import('../platform/operatorAuth.js');
const { exportAccount } = await import('../platform/accounts.js');
const credential = process.env.PLATFORM_OPERATOR_TOKEN;
// The RFC 6238 SHA1 test vector; no real authenticator/seed or mailbox.
const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const messages = [];
async function login(at, body, ip = '127.0.0.1', ok = true) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.headers = { 'x-operator-login': '1', 'content-type': 'application/json' };
  Object.defineProperty(req, 'socket', { value: { remoteAddress: ip } });
  const res = {
    writeHead(status, h) {
      this.status = status;
      this.h = h;
    },
    end(raw) {
      this.body = JSON.parse(raw);
    },
  };
  await operatorLogin(req, res, {
    clock: () => at,
    send: async (m) => {
      messages.push(m);
      return { ok };
    },
  });
  return res;
}
test('operator login is an explicit second credential domain; RFC TOTP consumed once, absolute expiry, alert before access', async () => {
  process.env.PLATFORM_OPERATOR_TOTP_SECRET = seed;
  const at = 59000;
  try {
    assert.equal((await login(at, { credential })).status, 401);
    const r = await login(at, { credential, code: '287082' });
    assert.equal(r.status, 200);
    const cookie = r.h['Set-Cookie'].split(';')[0];
    assert.match(r.h['Set-Cookie'], /HttpOnly; SameSite=Strict/);
    assert.ok(operatorSession({ headers: { cookie } }, at + 899999));
    assert.equal(operatorSession({ headers: { cookie } }, at + 900000), null);
    const file = demo.db.currentFile();
    demo.db.closePlatformDb();
    await demo.db.initPlatformDb({ file });
    assert.equal((await login(at, { credential, code: '287082' }, '127.0.0.2')).status, 401);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, process.env.PLATFORM_OPERATOR_EMAIL);
    assert.ok(!JSON.stringify(messages).includes(credential));
    assert.ok(!JSON.stringify(messages).includes(seed));
    assert.equal(get("SELECT count(*) n FROM platform_audit WHERE action='operator_login'").n, 1);
    process.env.PLATFORM_OPERATOR_TOTP_SECRET = 'invalid';
    assert.equal((await login(at, { credential })).status, 503);
    delete process.env.PLATFORM_OPERATOR_TOTP_SECRET;
    const failed = await login(at, { credential }, '127.0.0.3', false);
    assert.equal(failed.status, 503);
    assert.ok(!failed.h['Set-Cookie']);
    const plain = await login(at, { credential });
    assert.equal(plain.status, 200);
    const jar = { headers: { cookie: plain.h['Set-Cookie'].split(';')[0] } };
    process.env.PLATFORM_OPERATOR_TOTP_SECRET = seed;
    assert.equal(operatorSession(jar, at), null);
  } finally {
    delete process.env.PLATFORM_OPERATOR_TOTP_SECRET;
  }
});
test('sustained failed logins lock even valid credentials across IPs and DB reopen; cools down; separate request-rate cap', async () => {
  let now = 2000000;
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await login(now, { credential: 'not-the-fixture' }, '127.0.0.4')).status,
      i === 4 ? 429 : 401
    );
  const file = demo.db.currentFile();
  demo.db.closePlatformDb();
  await demo.db.initPlatformDb({ file });
  assert.equal((await login(now + 899999, { credential }, '127.0.0.5')).status, 429);
  now += 900000;
  const count = messages.length;
  for (let i = 0; i < 10; i++) assert.equal((await login(now, { credential }, '127.0.0.6')).status, 200);
  assert.equal(messages.length - count, 10);
  assert.equal((await login(now, { credential }, '127.0.0.6')).status, 429);
});
test('actual console and ledger: no Basic shortcut, session-bound anti-CSRF, reasoned adjust/review audit; notes not exported', async () => {
  enable();
  const t = fresh(),
    v = offer(),
    i = buy(t, v),
    a = submit(t, i),
    b = submit(t, i);
  const { http, origin } = await demo.serve();
  try {
    const ops = '/api/platform/operator/billing',
      admin = await demo.operatorHeaders(origin),
      another = await demo.operatorHeaders(origin);
    const staleBasic = { authorization: 'Basic ' + Buffer.from('operator:' + credential).toString('base64') };
    for (const headers of [staleBasic, { cookie: t.account.cookie }])
      assert.equal((await fetch(origin + ops, { headers })).status, 401);
    const view = async (headers) => await (await fetch(origin + ops, { headers })).json();
    const csrf = (await view(admin)).csrf,
      other = (await view(another)).csrf;
    assert.notEqual(csrf, other);
    const post = async (path, body, token = csrf) =>
      fetch(origin + ops + '/' + t.slug + '/' + path, {
        method: 'POST',
        headers: { ...admin, 'x-operator-csrf': token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await post('payments/' + a.id + '/accept', { amount: i.total, currency: i.currency }, other)).status,
      403
    );
    assert.equal(
      (await post('payments/' + a.id + '/accept', { amount: i.total, currency: i.currency })).status,
      200
    );
    assert.equal((await post('payments/' + b.id + '/reject', { reason: 'unclear_proof' })).status, 200);
    const explanation = 'Time lost during maintenance.',
      reverse = 'Duplicate manual confirmation.';
    for (const [path, data, why] of [
      ['subscriptions/extend', { units: 1, reason: 'service_credit' }, explanation],
      ['payments/' + a.id + '/reverse', { reason: 'support_correction' }, reverse],
    ]) {
      for (const invalid of ['', '  ', 'tiny'])
        assert.equal((await post(path, { ...data, explanation: invalid })).status, 400);
      assert.equal((await post(path, { ...data, explanation: why })).status, 200);
    }
    for (const [action, why, detail] of [
      ['billing_payment_confirmed', 'operator_confirmed_funds_received'],
      ['billing_payment_reject', 'unclear_proof'],
      ['billing_extend', 'service_credit', explanation],
      ['billing_payment_reverse', 'support_correction', reverse],
    ]) {
      const rows = all('SELECT detail FROM platform_audit WHERE action=? AND tenant=?', [action, t.slug]);
      assert.equal(rows.length, 1, action);
      const d = JSON.parse(rows[0].detail);
      assert.equal(d.actor, 'operator');
      assert.equal(d.reason, why);
      if (detail) assert.equal(d.explanation, detail);
    }
    assert.ok(!JSON.stringify(exportAccount(t.account.id).export).includes(explanation));
  } finally {
    jobs.stopBilling();
    await new Promise((r) => http.close(r));
  }
});
