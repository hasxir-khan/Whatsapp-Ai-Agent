import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  demo,
  enable,
  fresh,
  offer,
  buy,
  submit,
  accept,
  jobs,
  subs,
  rules,
  pay,
  get,
} from './fixtures/billing.js';
const { protectTransport, deliverOwnerNotices, handover } = await import('../src/services/billingMeter.js');
const { customerView } = await import('../platform/billing/overview.js');
const { reportPage } = await import('../platform/reportView.js');
const { config } = await import('../src/config/env.js');
const { DAY } = rules,
  start = Date.parse('2027-04-01T00:00:00Z');
const tick = (at) => jobs.billingTick(at, { deliver: false });
enable();

test('trial expiry: 7/3/1 and pause on both channels, live dashboard banner independent of mail and worker', async () => {
  const t = fresh({ now: start }),
    end = Date.parse(t.s.trial_end),
    mail = [],
    sends = [];
  const vars = {
    DATA_DIR: path.join(t.dir, 'data'),
    TENANT: t.slug,
    TENANT_BILLING: '1',
    TENANT_METER_KEY: 'synthetic-meter-key',
  };
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  let open = true;
  const transport = {
    kind: 'cloud',
    windowOpen: () => open,
    send: async (to, p) => sends.push({ to, ...p }),
  };
  protectTransport(transport);
  try {
    for (const days of [7, 3, 1, 0]) {
      const now = end - days * DAY;
      if (days === 3) subs.changeSubscription(t.slug, 'paused_reply', { enabled: true }, now);
      await tick(now);
      await tick(now);
      const exp = days === 7 ? /no automatic replies/ : /one automatic handover per UTC day/;
      const state = customerView(t.slug, true, now);
      assert.match(state.pausedSetting, exp);
      assert.match(state.banner, exp);
      const html = reportPage(
        demo.dashboard(t.slug, 'overview', new URLSearchParams(), { owner: true, now: new Date(now) }),
        new URLSearchParams()
      );
      assert.ok(html.includes(state.banner));
      if (!days) {
        assert.match(state.banner, /assistant is paused/);
        open = false;
        await deliverOwnerNotices(transport, now);
        assert.equal(sends.length, 3);
        open = true;
        await deliverOwnerNotices(transport, now + 13 * 3600000);
        assert.equal(sends.length, 3, 'stale pause lease');
        demo.tenant.optOut(config.owner.number);
        await deliverOwnerNotices(transport, now);
        assert.equal(sends.length, 3);
        demo.tenant.optIn(config.owner.number);
      }
      await deliverOwnerNotices(transport, now);
      await deliverOwnerNotices(transport, now);
      await jobs.deliverBilling(now, async (m) => {
        if (m.billingSid === t.s.sid) mail.push(m.text);
        return { ok: true };
      });
      assert.match(sends.at(-1).text, exp);
      assert.match(mail.at(-1), exp);
      const when = days ? new RegExp('within ' + days + ' day') : /assistant is paused/;
      assert.match(sends.at(-1).text, when);
      assert.match(mail.at(-1), when);
      assert.equal(sends.at(-1).to, config.owner.jid);
    }
    assert.equal(sends.length, 4);
    assert.equal(mail.length, 4);
    await assert.rejects(transport.send('demo@s.whatsapp.net', { text: 'ordinary send' }), /paused/);
    demo.tenant.optOut('blocked');
    await handover(transport, 'blocked@s.whatsapp.net', 'blocked', end);
    open = false;
    await handover(transport, 'closed@s.whatsapp.net', 'closed', end);
    open = true;
    assert.equal(sends.length, 4);
    for (const [day, who] of [
      [0, 'a'],
      [0, 'a'],
      [0, 'b'],
      [1, 'a'],
    ]) {
      await tick(end + day * DAY);
      await handover(transport, who + '@s.whatsapp.net', who, end + day * DAY);
    }
    assert.equal(sends.length, 7);
    assert.ok(sends.slice(4).every((m) => m.text === customerView(t.slug, true, end).handoverLine));
    subs.changeSubscription(t.slug, 'paused_reply', { enabled: false }, end + DAY);
    await tick(end + DAY);
    await handover(transport, 'c@s.whatsapp.net', 'c', end + DAY);
    assert.equal(sends.length, 7);
    await deliverOwnerNotices(transport, end + DAY);
    assert.equal(sends.length, 7);
    fs.unlinkSync(path.join(t.dir, 'data', 'billing-lease.json'));
    await deliverOwnerNotices(transport, end + DAY);
    assert.equal(sends.length, 7);
    assert.match(customerView(t.slug, true, end + DAY).banner, /no automatic replies/);
    const v = offer();
    const renew = async (now) => {
      const i = buy(t, v, 1, now);
      accept(t, submit(t, i, now), i, i.due, now);
      await tick(now);
      return Date.parse(subs.entitlementsFor(t.slug, now).end);
    };
    const first = await renew(end + DAY);
    await tick(first - DAY); // reminder queued, not delivered
    const next = await renew(first - DAY + 1);
    await deliverOwnerNotices(transport, first - DAY + 1);
    assert.equal(sends.length, 7);
    assert.equal(customerView(t.slug, true, first - DAY + 1).banner, null);
    const missed = [];
    await jobs.deliverBilling(first - DAY + 1, async (m) => {
      if (m.billingSid === t.s.sid) missed.push(m.text);
      return { ok: true };
    });
    assert.ok(!missed.some((m) => /within 1 day/.test(m)), 'renewal obsoletes stale email');
    const pause = next + 3 * DAY;
    await tick(pause - 1);
    await deliverOwnerNotices(transport, pause - 1);
    assert.equal(sends.length, 7, 'grace still active');
    await tick(pause);
    await deliverOwnerNotices(transport, pause);
    await deliverOwnerNotices(transport, pause);
    assert.equal(sends.length, 8);
    assert.match(sends.at(-1).text, /assistant is paused/);
  } finally {
    for (const [k, v] of Object.entries(old))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

test('receipt retry backs off across reopen, reuses delivery key; owner PDF and term independent of mail', async () => {
  const t = fresh({ now: start }),
    v = offer(),
    i = buy(t, v, 1, start),
    p = submit(t, i, start);
  accept(t, p, i, i.due, start);
  // Simulate an already-enqueued receipt in a pre-safety-pass installation.
  const legacy = demo.db.currentFile();
  demo.db.run('ALTER TABLE b_delivery DROP COLUMN attempts');
  demo.db.closePlatformDb();
  await demo.db.initPlatformDb({ file: legacy });
  assert.equal(get('SELECT attempts FROM b_delivery WHERE object=?', [p.id]).attempts, 0);
  const waits = [10, 20, 40, 80, 160, 320, 640, 1280, 1440, 1440];
  const keys = [],
    end = subs.entitlementsFor(t.slug, start).end;
  const send = async (m) => {
    if (m.billingSid !== t.s.sid) return { ok: true };
    keys.push(m.idempotencyKey);
    if (keys.length === 2) throw Error('simulated');
    return { ok: keys.length === waits.length + 1 };
  };
  let at = start;
  for (const wait of waits) {
    await jobs.deliverBilling(at, send);
    const d = get("SELECT * FROM b_delivery WHERE object=? AND kind='receipt'", [p.id]);
    assert.equal(Date.parse(d.lease), at + wait * 60000);
    assert.equal(d.attempts, keys.length);
    assert.ok(customerView(t.slug, true, at).invoices[0].payments[0].receipt);
    assert.match((await pay.documentPDF(t.slug, 'receipts', p.id)).data.toString('ascii', 0, 5), /^%PDF-/);
    const file = demo.db.currentFile();
    demo.db.closePlatformDb();
    await demo.db.initPlatformDb({ file });
    at += wait * 60000;
    await jobs.deliverBilling(at - 1, send);
    assert.equal(keys.length, d.attempts);
  }
  await jobs.deliverBilling(at, send);
  await jobs.deliverBilling(at + DAY, send);
  assert.equal(keys.length, waits.length + 1);
  assert.equal(new Set(keys).size, 1);
  assert.equal(get('SELECT state FROM b_delivery WHERE object=?', [p.id]).state, 'sent');
  assert.equal(subs.entitlementsFor(t.slug, at).end, end);
  assert.equal(get('SELECT count(*) n FROM b_payment WHERE id=?', [p.id]).n, 1);
});
