import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { demo, all, get, run, enable, fresh, offer, subs, catalog, jobs, rules } from './fixtures/billing.js';
import { diagnostics } from '../platform/diagnostics.js';
import { setKeyHooks, withWorker } from '../platform/keys.js';
setKeyHooks({ stopTenant: async () => ({ ok: true }) });
const { http, origin } = await demo.serve();
after(async () => {
  jobs.stopBilling();
  await new Promise((r) => http.close(r));
});
const operatorAuth = await demo.operatorHeaders(origin);
const ops = '/api/platform/operator/billing';
const call = async (url, { auth = null, post, headers = {}, operator = false, csrf = true } = {}) => {
  const r = await fetch(origin + url, {
    redirect: 'manual',
    method: post !== undefined ? 'POST' : 'GET',
    headers: {
      ...(auth ? { cookie: auth.cookie, ...(csrf ? { 'x-platform-csrf': auth.csrf } : {}) } : {}),
      ...(operator ? operatorAuth : {}),
      ...(post !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: post !== undefined ? JSON.stringify(post) : undefined,
  });
  const body = r.headers.get('content-type')?.includes('application/json') ? await r.json() : await r.text();
  return { status: r.status, body };
};
const t = fresh(),
  other = fresh(),
  base = '/api/platform/tenants/' + t.slug + '/billing',
  otherBase = '/api/platform/tenants/' + other.slug + '/billing';
test('default off: absent page/API/assets/operator calls, no billing cookie fallback; doctor detects incomplete configuration', async () => {
  delete process.env.PLATFORM_BILLING;
  for (const p of [
    base,
    '/platform/billing/' + t.slug,
    ops,
    '/platform/operator/billing',
    '/platform/billing.js',
    '/platform/billing.css',
    '/platform/billing-money.js',
  ])
    assert.equal((await call(p, { auth: t.account, operator: true })).status, 404, p);
  process.env.PLATFORM_BILLING = '1';
  const report = diagnostics(all);
  for (const id of [
    'billing_paid_plans_missing',
    'billing_instructions_missing',
    'billing_production_mailer_missing',
  ])
    assert.ok(report.warnings.includes(id), id);
  enable();
});
test('separate credentials and CSRF even on same origin; customer cannot publish/comp/review, operator cannot assume customer session', async () => {
  assert.equal((await call(ops, { auth: t.account })).status, 401);
  assert.equal((await call(base, { operator: true })).status, 401);
  assert.equal((await call('/platform/billing/' + t.slug, { auth: demo.outsider })).status, 404);
  assert.equal((await call(base + '/comp', { auth: t.account, post: {} })).status, 404);
  assert.equal(
    (await call(base + '/cancel', { auth: t.account, post: {}, csrf: false, headers: { origin } })).status,
    403
  );
  const op = await call(ops, { operator: true });
  assert.equal(op.status, 200);
  assert.equal(
    (
      await call(ops + '/settings', {
        operator: true,
        post: { taxBps: 500 },
        headers: { origin, 'x-platform-csrf': t.account.csrf },
      })
    ).status,
    403
  );
  const h = { 'x-operator-csrf': op.body.csrf };
  assert.equal(
    (
      await call(ops + '/settings', {
        operator: true,
        post: { methods: [{ method: 'Demo', receiver: 'Example', tail: '01234567' }] },
        headers: h,
      })
    ).status,
    400
  );
  assert.equal(
    (await call(ops + '/settings', { operator: true, post: { taxBps: 0 }, headers: h })).status,
    200
  );
  assert.equal(
    (
      await call(ops + '/' + t.slug + '/subscriptions/extend', {
        operator: true,
        headers: h,
        post: { units: 2 },
      })
    ).status,
    400
  );
  assert.equal(
    (await call('/api/platform/tenants/' + t.slug + '/plan', { auth: t.account, post: { planId: 'growth' } }))
      .status,
    403
  );
});
test('scoped object matrix (owner, staff, outsider, wrong tenant, operator); actual PDFs, concurrent HTTP acceptance and reversal', async () => {
  const v = offer();
  const checkout = await call(base + '/checkout', {
    auth: t.account,
    post: { version: v.version, months: 1, requestId: randomUUID() },
  });
  assert.equal(checkout.status, 200);
  const i = checkout.body,
    u = await call(base + '/invoices/' + i.id + '/proof', {
      auth: t.account,
      post: { text: 'PKR 120.00 receiver Example Shop ***0123 ref DEMO-HTTP' },
    });
  assert.equal(u.status, 200);
  const pid = u.body.id,
    fid = get('SELECT id FROM b_proof WHERE payment=?', [pid]).id;
  const h = { 'x-operator-csrf': (await call(ops, { operator: true })).body.csrf };
  run('INSERT INTO memberships VALUES(?,?,?,?)', [demo.staff.id, t.slug, 'staff', new Date().toISOString()]);
  const staff = await call(base, { auth: demo.staff });
  assert.equal(staff.status, 200);
  assert.equal(staff.body.owner, false);
  assert.ok(!JSON.stringify(staff.body).includes(i.ref));
  for (const p of [
    '/checkout',
    '/cancel',
    '/resume',
    '/paused_reply',
    '/downgrade',
    '/invoices/' + i.id + '/proof',
    '/delete',
  ])
    assert.equal((await call(base + p, { auth: demo.staff, post: {} })).status, 403, p);
  for (const [noun, id] of [
    ['invoices', i.id],
    ['proofs', fid],
  ]) {
    assert.equal((await call(otherBase + '/' + noun + '/' + id, { auth: other.account })).status, 404, noun);
    assert.equal((await call(base + '/' + noun + '/' + id, { auth: demo.staff })).status, 403);
    assert.equal((await call(base + '/' + noun + '/' + id, { auth: demo.outsider })).status, 404);
    assert.equal((await call(base + '/' + noun + '/' + id, { auth: t.account })).status, 200);
  }
  assert.equal(
    (await call(otherBase + '/invoices/' + i.id + '/proof', { auth: other.account, post: { text: 'DEMO' } }))
      .status,
    404
  );
  assert.equal((await call(ops + '/' + other.slug + '/proofs/' + fid, { operator: true })).status, 404);
  for (const [noun, id, act] of [
    ['payments', pid, 'accept'],
    ['proofs', fid, 'recheck'],
    ['invoices', i.id, 'price'],
  ])
    assert.equal(
      (
        await call(ops + '/' + other.slug + '/' + noun + '/' + id + '/' + act, {
          operator: true,
          headers: h,
          post: {},
        })
      ).status,
      404
    );
  const path = ops + '/' + t.slug + '/payments/' + pid;
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      call(path + '/accept', { operator: true, headers: h, post: { amount: i.total, currency: i.currency } })
    )
  );
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(new Set(results.map((r) => r.body.receipt)).size, 1);
  const receipt = await call(base + '/receipts/' + pid, { auth: t.account });
  assert.match(receipt.body, /^%PDF-/);
  assert.equal((await call(otherBase + '/receipts/' + pid, { auth: other.account })).status, 404);
  const state = (await call(ops, { operator: true })).body;
  assert.ok(!JSON.stringify(state).includes(demo.privateText));
  assert.ok(!JSON.stringify(state).includes(demo.fakeKey));
  assert.ok(!JSON.stringify(state).includes(demo.phone));
  assert.equal(
    (await call(path + '/reverse', { operator: true, headers: h, post: { reason: 'bank_reversal', explanation: 'Bank returned the transfer.' } })).status,
    200
  );
  assert.equal((await call(base, { auth: t.account })).body.entitlement.hasTerm, false);
});
test('locked mutation rechecks membership after a role change', async () => {
  const member = demo.account(null);
  run('INSERT INTO memberships VALUES(?,?,?,?)', [member.id, other.slug, 'owner', rules.stamp(Date.now())]);
  let release;
  const held = withWorker(other.slug, () => new Promise((r) => (release = r)));
  await new Promise((r) => setImmediate(r));
  const pending = call(otherBase + '/cancel', { auth: member, post: {} });
  run("UPDATE memberships SET role='staff' WHERE account_id=? AND slug=?", [member.id, other.slug]);
  release();
  await held;
  assert.equal((await pending).status, 403);
});
test('pending deletion needs a recent export and explicit slug; unrelated tenant/account remain, billing data gone', async () => {
  const now = Date.now() - 100 * rules.DAY,
    u = fresh({ now }),
    v = offer();
  subs.changeSubscription(u.slug, 'comp', { version: v.version, units: 1, reason: 'service_credit' }, now);
  const end = Date.parse(subs.entitlementsFor(u.slug, now).end);
  catalog.configure({ retentionDays: 1, deleteWaitDays: 90 });
  subs.changeSubscription(u.slug, 'cancel', {}, now + 1000);
  assert.equal(subs.entitlementsFor(u.slug).state, 'pending_deletion');
  const path = '/api/platform/tenants/' + u.slug + '/billing/delete';
  assert.equal((await call(path, { auth: u.account, post: { confirm: u.slug } })).status, 409);
  const ex = await call('/api/platform/account/export', { auth: u.account, post: {} });
  assert.ok(ex.body.export.billing.some((r) => r.slug === u.slug));
  assert.equal((await call(path, { auth: u.account, post: { confirm: 'other' } })).status, 400);
  assert.equal((await call(path, { auth: u.account, post: { confirm: u.slug } })).status, 200);
  assert.ok(!fs.existsSync(u.dir));
  assert.ok(subs.subscription(t.slug));
  assert.equal((await call('/api/platform/me', { auth: u.account })).status, 200);
});
test('signup provisioning uses one trial claim and both account caps; second assistant does not reset it', async () => {
  const account = demo.account(null),
    post = { name: 'Trial sample', number: '12025550831', template: 'restaurant' };
  const created = await call('/api/platform/tenants', { auth: account, post });
  assert.equal(created.status, 201);
  const slug = created.body.slug,
    e = subs.entitlementsFor(slug);
  assert.equal(e.state, 'trialing');
  assert.equal(get('SELECT trial_seen FROM accounts WHERE id=?', [account.id]).trial_seen, 1);
  const next = { ...post, name: 'Second sample', number: '12025550832' };
  assert.equal((await call('/api/platform/tenants', { auth: account, post: next })).status, 409);
  const v = offer();
  subs.changeSubscription(slug, 'comp', { version: v.version, units: 1, reason: 'service_credit' });
  const second = await call('/api/platform/tenants', { auth: account, post: next });
  assert.equal(second.status, 201);
  assert.equal(subs.entitlementsFor(second.body.slug).state, 'paused');
  assert.ok(subs.entitlementsFor(slug).canRun);
});
