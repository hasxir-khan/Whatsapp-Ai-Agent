import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {
  demo,
  all,
  get,
  run,
  enable,
  fresh,
  offer,
  buy,
  submit,
  accept,
  catalog,
  subs,
  pay,
  jobs,
  rules,
} from './fixtures/billing.js';
const { startTenant } = await import('../src/services/adminPanel.js');
import { readUsage, publishLease } from '../platform/billing/leases.js';
import { operations } from '../platform/billing/overview.js';
import { exportAccount } from '../platform/accounts.js';
import { setKeyHooks, deliverKeysAtStart, addKey } from '../platform/keys.js';
import { sendMail } from '../platform/mailer.js';
import { workerAccess } from '../src/services/billingLease.js';
import { admit, protectTransport, deliverOwnerNotices } from '../src/services/billingMeter.js';
import { handleIncoming } from '../src/handlers/messageHandler.js';
import { featureOn } from '../src/services/profile.js';
const { DAY, stamp } = rules;
const start = Date.parse('2024-01-31T12:00:00Z');
enable();
setKeyHooks({ stopTenant: async () => ({ ok: true }) });
function paid(now = start) {
  const t = fresh({ now }),
    v = offer(),
    i = buy(t, v, 1, now),
    p = submit(t, i, now);
  accept(t, p, i, i.due, now);
  return { ...t, v, i, p, end: Date.parse(subs.entitlementsFor(t.slug, now).end) };
}
async function reopen() {
  const file = demo.db.currentFile();
  demo.db.closePlatformDb();
  await demo.db.initPlatformDb({ file });
}
const tick = (now) => jobs.billingTick(now, { deliver: false });
test('expiry runner across database reload: 7/3/1 email + worker intents just once, grace cutoff without deleting data', async () => {
  const t = paid();
  for (const n of [7, 3, 1]) {
    await tick(t.end - n * DAY);
    await reopen();
    await tick(t.end - n * DAY);
  }
  assert.equal(get("SELECT count(*) n FROM b_delivery WHERE sid=? AND kind LIKE 'remind_%'", [t.s.sid]).n, 6);
  assert.equal(subs.entitlementsFor(t.slug, t.end).state, 'grace');
  await tick(t.end);
  assert.equal(subs.entitlementsFor(t.slug, t.end + 3 * DAY).canRun, false);
  await tick(t.end + 3 * DAY);
  assert.equal(get('SELECT paused_reason FROM tenants WHERE slug=?', [t.slug]).paused_reason, 'billing');
  await tick(t.end + 300 * DAY);
  assert.ok(fs.existsSync(t.dir));
  assert.equal(subs.entitlementsFor(t.slug, t.end + 300 * DAY).deleteAt, null);
  assert.throws(() => run('DELETE FROM b_transition WHERE sid=?', [t.s.sid]), /immutable/);
});
test('cancel and undo before end, suppress stale queued reminder; early cancellation retains access', async () => {
  const t = paid();
  await tick(t.end - 7 * DAY);
  subs.changeSubscription(t.slug, 'cancel', { reason: 'price' }, t.end - 6 * DAY);
  let e = subs.entitlementsFor(t.slug, t.end - 6 * DAY);
  assert.ok(e.canRun);
  assert.equal(e.state, 'cancel_at_period_end');
  const sent = [];
  await jobs.deliverBilling(t.end - 6 * DAY, async (msg) => {
    sent.push(msg);
    return { ok: true };
  });
  assert.equal(
    get("SELECT state FROM b_delivery WHERE sid=? AND kind='remind_7' AND channel='email'", [t.s.sid]).state,
    'obsolete'
  );
  assert.ok(!sent.find((m) => m.billingSid === t.s.sid && m.text.includes('term ends on')));
  e = subs.changeSubscription(t.slug, 'resume', {}, t.end - 4 * DAY);
  assert.equal(e.state, 'active');
  await tick(t.end - 3 * DAY);
  assert.ok(get("SELECT 1 FROM b_delivery WHERE sid=? AND kind='remind_3'", [t.s.sid]));
});
test('cancellation retention day 0/15/25, pending deletion, timeout forgets only this tenant, anonymised accounting opt-in', async () => {
  const t = paid(),
    other = fresh({ account: t.account, now: start, number: '12025550998' });
  catalog.configure({ retainAccounting: true });
  subs.changeSubscription(t.slug, 'cancel', {}, start + DAY);
  const secret = path.join(t.dir, 'data', 'fixture.txt');
  fs.writeFileSync(secret, 'fake');
  for (const n of [0, 15, 25, 30]) {
    await tick(t.end + n * DAY);
    await reopen();
    await tick(t.end + n * DAY);
  }
  assert.deepEqual(
    all("SELECT kind FROM b_delivery WHERE sid=? AND kind LIKE 'export_%' ORDER BY kind", [t.s.sid]).map(
      (r) => r.kind
    ),
    ['export_0', 'export_15', 'export_25']
  );
  assert.ok(fs.existsSync(secret));
  assert.equal(subs.entitlementsFor(t.slug, t.end + 30 * DAY).state, 'pending_deletion');
  assert.throws(() => subs.changeSubscription(t.slug, 'resume', {}, t.end + 30 * DAY), /ended/);
  const exported = exportAccount(t.account.id, { now: t.end + 30 * DAY }).export;
  assert.ok(exported.billing.find((b) => b.slug === t.slug)?.invoices[0].payments[0].receipt);
  await tick(t.end + 37 * DAY);
  assert.ok(!fs.existsSync(secret));
  assert.ok(fs.existsSync(other.dir));
  assert.equal(subs.subscription(t.slug), null);
  assert.equal(pay.history(t.slug).length, 0);
  assert.equal(get('SELECT count(*) n FROM b_proof WHERE sid=?', [t.s.sid]).n, 0);
  assert.equal(get('SELECT count(*) n FROM b_transition WHERE sid=?', [t.s.sid]).n, 0);
  assert.equal(get('SELECT count(*) n FROM b_event WHERE sid=?', [t.s.sid]).n, 0);
  assert.ok(get("SELECT sum(n) n FROM b_churn WHERE state='deleted'").n >= 1);
  assert.ok(get('SELECT confirmed FROM b_anonymous WHERE currency=?', ['PKR']).confirmed >= t.i.total);
  assert.equal(get('SELECT status FROM accounts WHERE id=?', [t.account.id]).status, 'active');
  catalog.configure({ retainAccounting: false });
});
test('mail failure never regrants; durable retry with stable idempotency key and real generated PDF, file copy private', async () => {
  const t = paid(start + 500 * DAY),
    now = start + 500 * DAY;
  let tries = 0,
    first,
    second;
  const send = async (m) => {
    if (m.billingSid !== t.s.sid) return { ok: true };
    tries++;
    if (!first) {
      first = m;
      return { ok: false };
    }
    second = m;
    return sendMail(m);
  };
  await jobs.deliverBilling(now, send);
  assert.equal(
    get("SELECT state FROM b_delivery WHERE sid=? AND kind='receipt'", [t.s.sid]).state,
    'sending'
  );
  await reopen();
  await jobs.deliverBilling(now + 600001, send);
  await jobs.deliverBilling(now + 600002, send);
  assert.equal(tries, 2);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.match(Buffer.from(second.attachments[0].content, 'base64').subarray(0, 5).toString(), /^%PDF-/);
  assert.equal(pay.history(t.slug)[0].payments.length, 1);
  const folder = path.join(process.env.PLATFORM_DIR, 'billing-mail', t.s.sid);
  assert.equal(fs.statSync(path.join(folder, fs.readdirSync(folder)[0])).mode & 0o777, 0o600);
});
test('operator queue overdue clock, operational filters, reason-required comp/extend/change and accounting is cash-only', async () => {
  const now = Date.now() - 5 * DAY,
    t = fresh({ now }),
    v = offer(),
    i = buy(t, v, 1, now);
  submit(t, i, now);
  assert.ok(operations('all', now + 2 * DAY).cards.find((c) => c.invoice === i.id)?.overdue);
  await tick(now + 2 * DAY);
  assert.ok(get("SELECT 1 FROM b_delivery WHERE sid=? AND kind='review_overdue'", [t.s.sid]));
  assert.ok(
    operations('trial-ending', Date.parse(t.s.trial_end) - DAY).subscriptions.find((s) => s.slug === t.slug)
  );
  assert.throws(
    () => subs.changeSubscription(t.slug, 'comp', { version: v.version, units: 1 }, now),
    /reason_required/
  );
  const p = subs.changeSubscription(
    t.slug,
    'comp',
    { version: v.version, units: 1, reason: 'service_credit' },
    now
  );
  assert.equal(p.plan, v.plan);
  assert.equal(
    subs.changeSubscription(t.slug, 'extend', { units: 2, reason: 'support_correction' }, now + DAY).end,
    stamp(Date.parse(p.end) + 2 * DAY)
  );
  const higher = offer({ plan: 'expanded', rank: 2 });
  assert.equal(
    subs.changeSubscription(
      t.slug,
      'change',
      { version: higher.version, reason: 'customer_request' },
      now + DAY
    ).version,
    higher.version
  );
  assert.equal(pay.invoice(t.slug, i.id).paid, 0);
});
test('worker launch, hot flags/caps, per-contact handover, last-known lease and term cutoff including outage; no new login', async () => {
  const now = Date.now(),
    t = fresh({ now }),
    v = offer({
      limits: { ...catalog.trialLimits, conversations_month: 1, voice_minutes: 1, videos_month: 1 },
      features: ['liveInbox'],
    });
  subs.changeSubscription(t.slug, 'comp', { units: 1, version: v.version, reason: 'service_credit' }, now);
  const key = 'gsk_' + crypto.randomBytes(30).toString('hex');
  assert.ok(addKey({ slug: t.slug, provider: 'groq', key }).ok);
  let childEnv, observed;
  setKeyHooks({
    startTenant: (slug, options) =>
      startTenant(slug, {
        ...options,
        spawnImpl: (bin, _entry, opts) => {
          childEnv = opts.env;
          const result = spawnSync(
            bin,
            [
              '--input-type=module',
              '-e',
              "import {workerAccess} from './src/services/billingLease.js';console.log(JSON.stringify(workerAccess().canRun));",
            ],
            { cwd: opts.cwd, env: childEnv, encoding: 'utf8' }
          );
          observed = result.stdout.trim();
          return { unref() {} };
        },
      }),
  });
  assert.ok((await deliverKeysAtStart(t.slug, { start: true })).ok);
  assert.equal(observed, 'true');
  assert.equal(childEnv.PLATFORM_SECRET, undefined);
  const old = { ...process.env };
  for (const k of ['DATA_DIR', 'TENANT', 'TENANT_BILLING', 'TENANT_METER_KEY']) process.env[k] = childEnv[k];
  try {
    assert.ok(workerAccess().canRun);
    assert.ok(featureOn('liveInbox'));
    assert.equal(featureOn('businessBrain'), false);
    assert.ok(admit('chat', 1, 'demo-a'));
    assert.ok(admit('chat', 1, 'demo-a'));
    assert.equal(admit('chat', 1, 'demo-b'), false);
    assert.ok(admit('video'));
    assert.equal(admit('video'), false);
    assert.ok(admit('voice', 59));
    assert.equal(admit('voice', 2), false);
    assert.deepEqual(
      readUsage(t.slug).limits.sort(),
      ['conversations_month', 'videos_month', 'voice_minutes'].sort()
    );
    const tpt = {
      sends: [],
      async send(j, p) {
        this.sends.push({ j, p });
      },
      async sendMessage(j, p) {
        return this.send(j, p);
      },
    };
    protectTransport(tpt);
    const msg = {
      number: '12025550123',
      chat: '12025550123@s.whatsapp.net',
      kind: 'text',
      text: 'Hello',
      id: crypto.randomUUID(),
    };
    await handleIncoming(tpt, msg);
    assert.match(tpt.sends[0].p.text, /team member/);
    assert.ok(workerAccess(now + 3600000).canRun);
    assert.equal(workerAccess(now + 13 * 3600000).canRun, false);
    const higher = offer({
      plan: 'hot-plan',
      rank: 2,
      features: ['businessBrain'],
      limits: { ...v.limits, conversations_month: 5 },
    });
    subs.changeSubscription(t.slug, 'change', { version: higher.version, reason: 'support_correction' });
    publishLease(t.slug);
    assert.ok(featureOn('businessBrain'));
    assert.equal(featureOn('liveInbox'), false);
    assert.ok(admit('chat', 1, 'demo-b'));
    const end = Date.parse(subs.entitlementsFor(t.slug).end);
    publishLease(t.slug, end - 100);
    assert.equal(workerAccess(end).canRun, false, 'disconnect never extends the paid term');
    const future = end + 4 * DAY;
    publishLease(t.slug, future);
    const silent = tpt.sends.length;
    await handleIncoming(tpt, { ...msg, id: crypto.randomUUID() }, { now: future });
    assert.equal(tpt.sends.length, silent);
    subs.changeSubscription(t.slug, 'paused_reply', { enabled: true }, future);
    publishLease(t.slug, future);
    await handleIncoming(tpt, { ...msg, id: crypto.randomUUID() }, { now: future });
    assert.equal(tpt.sends.length, silent + 1);
    await assert.rejects(tpt.send(msg.chat, { text: 'no' }), /paused/);
  } finally {
    for (const k of ['DATA_DIR', 'TENANT', 'TENANT_BILLING', 'TENANT_METER_KEY'])
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
  }
});
test('worker owner reminder is fixed text and deduplicated across polling (no customer chat or proof)', async () => {
  const t = paid(Date.now()),
    now = t.end - 3 * DAY;
  await tick(now);
  const old = { ...process.env };
  Object.assign(process.env, {
    DATA_DIR: path.join(t.dir, 'data'),
    TENANT: t.slug,
    TENANT_BILLING: '1',
  });
  try {
    const sent = [],
      transport = { send: async (j, p) => sent.push([j, p.text]) };
    protectTransport(transport);
    await deliverOwnerNotices(transport, now);
    await deliverOwnerNotices(transport, now);
    assert.equal(sent.length, 1);
    assert.match(sent[0][1], /term ends/);
    assert.ok(!sent[0][1].includes(t.i.ref));
  } finally {
    for (const k of ['DATA_DIR', 'TENANT', 'TENANT_BILLING'])
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
  }
});

test('a bank-confirmed new term while the expiry runner waits on the worker lock wins over timeout deletion', async () => {
  const { withWorker } = await import('../platform/keys.js');
  const t = paid(),
    before = t.end + 40 * DAY,
    after = before + 5;
  subs.changeSubscription(t.slug, 'cancel', {}, start + DAY);
  let clock = before;
  let unlock;
  const first = withWorker(t.slug, () => new Promise((r) => (unlock = r)));
  await new Promise((r) => setImmediate(r));
  const sweep = jobs.billingTick(() => clock, { deliver: false });
  const renewed = buy(t, t.v, 1, after);
  accept(t, submit(t, renewed, after), renewed, renewed.due, after);
  clock = after;
  unlock();
  await first;
  await sweep;
  assert.ok(fs.existsSync(t.dir));
  assert.equal(subs.entitlementsFor(t.slug, clock).state, 'active');
});

test('paused raw-socket call rescue and Baileys retry lookup do not emit/replay a customer message', async () => {
  const { handleMissedCall } = await import('../src/services/calls.js'),
    { buildSocketOptions } = await import('../src/transport/baileys.js');
  const old = process.env.TENANT_BILLING;
  process.env.TENANT_BILLING = '1';
  try {
    assert.equal(workerAccess().canRun, false);
    assert.equal(
      (await handleMissedCall({ sendMessage: () => assert.fail('sent') }, '12025550199')).sent,
      false
    );
    const opts = buildSocketOptions({
      baileys: { Browsers: { ubuntu: () => [] }, makeCacheableSignalKeyStore: () => ({}) },
      state: { creds: {}, keys: {} },
      getMessage: () => assert.fail('unwrapped retry'),
    });
    assert.equal(opts.getMessage({ id: 'private' }), undefined);
  } finally {
    if (old === undefined) delete process.env.TENANT_BILLING;
    else process.env.TENANT_BILLING = old;
  }
});

test('HTTPS mail adapter forwards PDF and stable idempotency header to a recording fetch only', async () => {
  const { httpMailer } = await import('../platform/mailer.js');
  const original = { ...process.env };
  try {
    Object.assign(process.env, {
      PLATFORM_MAIL_FROM: 'test@example.invalid',
      PLATFORM_MAIL_TOKEN: crypto.randomUUID(),
      PLATFORM_MAIL_URL: 'https://mail.example.invalid/send',
    });
    const attachments = [
        { filename: 'synthetic.pdf', content: Buffer.from('%PDF-1.4\n%%EOF').toString('base64') },
      ],
      key = crypto.randomUUID();
    let recorded;
    const result = await httpMailer.send(
      { to: 'owner@example.invalid', subject: 'Test', text: 'Test only', attachments, idempotencyKey: key },
      async (url, init) => {
        recorded = init;
        return { ok: true };
      }
    );
    assert.ok(result.ok);
    assert.equal(recorded.redirect, 'error');
    assert.equal(recorded.headers['Idempotency-Key'], key);
    assert.deepEqual(JSON.parse(recorded.body).attachments, attachments);
  } finally {
    for (const k of ['PLATFORM_MAIL_FROM', 'PLATFORM_MAIL_TOKEN', 'PLATFORM_MAIL_URL'])
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
  }
});
