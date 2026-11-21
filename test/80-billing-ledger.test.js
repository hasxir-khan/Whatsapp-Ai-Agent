import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
  proof,
  rules,
  FakeProvider,
} from './fixtures/billing.js';
import { operations } from '../platform/billing/overview.js';
import { exportAccount } from '../platform/accounts.js';
const { stamp, DAY, monthsAfter, money, fromDecimal, totals } = rules;
const at = Date.parse('2024-01-31T18:45:59.001Z');
enable();
test('calendar table: leap/non-leap end of month, multi-month, year boundary, DST display not duration', () => {
  for (const [start, n, end] of [
    ['2024-01-31', 1, '2024-02-29'],
    ['2025-01-31', 1, '2025-02-28'],
    ['2024-02-29', 12, '2025-02-28'],
    ['2026-12-31', 2, '2027-02-28'],
    ['2026-03-31', 6, '2026-09-30'],
    ['2024-02-15', 1, '2024-03-15'],
  ])
    assert.equal(monthsAfter(start + 'T18:45:59.001Z', n), end + 'T18:45:59.001Z');
  const display = (t) =>
    new Intl.DateTimeFormat('en', { hour: 'numeric', timeZone: 'America/New_York' }).format(new Date(t));
  assert.notEqual(display('2024-02-15T17:00Z'), display(monthsAfter('2024-02-15T17:00Z', 1)));
});
test('one integer totals path: half-up, partial balance, zero- and three-decimal currencies, reject floats/oversize', () => {
  assert.deepEqual(totals(101, 5000, 1), { subtotal: 101, tax: 51, total: 152, paid: 1, due: 151 });
  assert.equal(money(199, 'KWD'), 'KWD 0.199');
  assert.equal(fromDecimal('9.001', 'KWD'), 9001);
  assert.equal(money(199, 'JPY'), 'JPY 199');
  assert.equal(fromDecimal('0.001', 'PKR'), null);
  assert.throws(() => totals(10.9));
  assert.throws(() => totals(1e12, 10000));
  assert.throws(() => totals(100, 0.5));
});
test('trial is once per account AND salted number; retry keeps end; expiry has no deletion deadline', () => {
  const a = fresh({ now: at }),
    b = fresh({ account: a.account, now: at + DAY }),
    c = fresh({ number: a.number, now: at + DAY });
  assert.equal(subs.openSubscription(a.slug, { now: at + DAY }).trial_end, a.s.trial_end);
  for (const t of [b, c]) assert.equal(subs.entitlementsFor(t.slug, at + DAY).state, 'paused');
  assert.equal(subs.entitlementsFor(a.slug, at).state, 'trialing');
  const old = subs.entitlementsFor(a.slug, at + 1000 * DAY);
  assert.equal(old.state, 'paused');
  assert.equal(old.deleteAt, null);
  assert.ok(!JSON.stringify(all('SELECT * FROM trial_numbers')).includes(a.number));
});
test('no seeded paid price; immutable catalogue; terms are sticky; later version takes effect at renewal boundary', () => {
  const t = fresh({ now: at }),
    v = offer(),
    i = buy(t, v, 1, at);
  accept(t, submit(t, i, at), i, i.due, at);
  const v2 = offer({ offers: { 1: 9999 } });
  assert.throws(() => run('UPDATE b_plan SET revision=4 WHERE version=?', [v.version]), /immutable/);
  assert.throws(() => buy(t, v, 1, at), /not_offered/);
  assert.equal(subs.entitlementsFor(t.slug, at).version, v.version);
  const second = buy(t, v2, 1, at + DAY);
  accept(t, submit(t, second, at + DAY), second, second.due, at + DAY);
  assert.equal(subs.entitlementsFor(t.slug, at + 2 * DAY).version, v.version);
  assert.equal(subs.entitlementsFor(t.slug, i.at).end, monthsAfter(at, 1));
  const e = subs.entitlementsFor(t.slug, Date.parse(monthsAfter(at, 1)));
  assert.equal(e.version, v2.version);
  assert.equal(e.end, monthsAfter(monthsAfter(at, 1), 1));
});
test('operator quote is not an invoice; upgrade difference changes flags immediately not end; paid downgrade waits', async () => {
  const t = fresh({ now: at }),
    v = offer(),
    higher = offer({ plan: 'expanded', rank: 2, features: ['visualSearch'] });
  const first = buy(t, v, 1, at);
  accept(t, submit(t, first, at), first, first.due, at);
  const end = subs.entitlementsFor(t.slug, at).end,
    q = buy(t, higher, 1, at + DAY);
  assert.ok(q.quote_no && !q.invoice_no);
  assert.throws(() => submit(t, q, at + DAY), /no_balance/);
  await assert.rejects(pay.documentPDF(t.slug, 'invoices', q.id), /not_found/);
  assert.ok((await pay.documentPDF(t.slug, 'quotes', q.id)).data.subarray(0, 4).equals(Buffer.from('%PDF')));
  const inv = pay.priceUpgrade(t.slug, q.id, { difference: 225 }, at + DAY);
  assert.ok(inv.invoice_no);
  accept(t, submit(t, inv, at + DAY), inv, 225, at + DAY);
  assert.equal(subs.entitlementsFor(t.slug, at + DAY).end, end);
  assert.deepEqual(subs.entitlementsFor(t.slug, at + DAY).features, ['visualSearch']);
  assert.throws(() => buy(t, v, 1, at + DAY), /schedule_downgrade/);
  subs.changeSubscription(t.slug, 'downgrade', { version: v.version }, at + DAY);
  const next = buy(t, v, 2, at + 2 * DAY);
  accept(t, submit(t, next, at + 2 * DAY), next, next.due, at + 2 * DAY);
  assert.equal(subs.entitlementsFor(t.slug, Date.parse(end) - 1).version, higher.version);
  assert.equal(subs.entitlementsFor(t.slug, Date.parse(end)).version, v.version);
});
test('partial confirmation, double click, reversal and re-grant do not duplicate money, receipt or time', async () => {
  const t = fresh({ now: at }),
    v = offer(),
    i = buy(t, v, 1, at),
    p = submit(t, i, at);
  assert.throws(() => accept(t, p, { ...i, currency: 'USD' }, 4000, at));
  accept(t, p, i, 4000, at);
  assert.equal(pay.invoice(t.slug, i.id).due, 8000);
  assert.equal(subs.entitlementsFor(t.slug, at).state, 'trialing');
  const p2 = submit(t, i, at);
  await Promise.all(
    Array.from({ length: 8 }, () => Promise.resolve().then(() => accept(t, p2, i, 8000, at)))
  );
  assert.equal(pay.invoice(t.slug, i.id).due, 0);
  assert.equal(get('SELECT count(*) n FROM b_event WHERE sid=? AND op=?', [t.s.sid, 'term']).n, 1);
  assert.equal(get("SELECT count(*) n FROM b_delivery WHERE sid=? AND kind='receipt'", [t.s.sid]).n, 2);
  assert.throws(() => pay.reviewPayment(t.slug, p.id, 'reverse', {}, at), /reason_required/);
  for (let n = 0; n < 2; n++)
    pay.reviewPayment(t.slug, p.id, 'reverse', { reason: 'bank_reversal', explanation: 'Bank returned the transfer.' }, at + DAY);
  assert.equal(subs.entitlementsFor(t.slug, at + DAY).state, 'trialing');
  assert.equal(pay.invoice(t.slug, i.id).due, 4000);
  const p3 = submit(t, i, at + DAY);
  accept(t, p3, i, 4000, at + DAY);
  assert.equal(subs.entitlementsFor(t.slug, at + DAY).end, monthsAfter(at + DAY, 1));
  const params = { amount: 300, currency: 'PKR', reason: 'customer_request', requestId: randomUUID() };
  const provider = new pay.ManualProvider();
  provider.refund(t.slug, p2.id, params, at + DAY);
  provider.refund(t.slug, p2.id, params, at + DAY);
  assert.equal(get('SELECT COUNT(*) n FROM b_refund WHERE payment=?', [p2.id]).n, 1);
  assert.ok(!provider.verifyWebhook('anything', 'anything'));
});
test('reversing a previous stacked grant replays later terms rather than subtracting a fixed month', () => {
  const t = fresh({ now: at }),
    v = offer(),
    i = buy(t, v, 1, at),
    p = submit(t, i, at);
  accept(t, p, i, i.due, at);
  const j = buy(t, v, 2, at + 5 * DAY);
  accept(t, submit(t, j, at + 5 * DAY), j, j.due, at + 5 * DAY);
  pay.reviewPayment(t.slug, p.id, 'reverse', { reason: 'support_correction', explanation: 'Duplicate reconciliation entry.' }, at + 6 * DAY);
  assert.equal(subs.entitlementsFor(t.slug, at + 6 * DAY).end, monthsAfter(at + 5 * DAY, 2));
});
test('numbering per year by document kind; unpaid and rejected do not add revenue; refunds are records only', () => {
  const v = offer({ plan: 'dated' }),
    t = fresh({ now: at });
  let year = Date.parse('2034-12-31T23:59:59Z');
  for (const [add, no] of [
    [0, '2034-000001'],
    [1, '2034-000002'],
    [1000, '2035-000001'],
  ]) {
    const i = buy(t, v, 1, year + add);
    assert.equal(i.invoice_no, 'INV-' + no);
  }
  const i = buy(t, v, 1, year + 2000),
    p = submit(t, i, year + 2000);
  pay.reviewPayment(t.slug, p.id, 'reject', { reason: 'not_verified' }, year + 2000);
  assert.equal(
    operations('all', year + 2000).revenue.find((r) => r.month === '2035-01'),
    undefined
  );
  const p2 = submit(t, i, year + 3000);
  const rec = accept(t, p2, i, i.due, year + 3000);
  assert.equal(rec.receipt, 'RCT-2035-000001');
  assert.equal(operations('all', year + 3000).revenue.find((r) => r.month === '2035-01').confirmed, i.total);
});
test('checks reuse bot rules for amount, receiver, date, currency and duplicate text/file/reference; bounded masked private evidence', () => {
  const t = fresh({ now: at }),
    v = offer(),
    i = buy(t, v, 1, at),
    pdf = Buffer.from('%PDF-1.4\nfake private metadata NEVER_PERSIST\n%%EOF').toString('base64');
  let text = 'PKR 120.00 to Example Shop ***0123 ref DEMO-ONCE 2024-01-31 18:45';
  const p = submit(t, i, at, { text, file: pdf });
  let f = get('SELECT * FROM b_proof WHERE payment=?', [p.id]);
  assert.equal(f.kind, 'pdf');
  assert.equal(f.risk, 'consistent');
  const file = path.join(process.env.PLATFORM_DIR, 'billing-proofs', f.id + '.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('NEVER_PERSIST'));
  const other = fresh({ now: at }),
    j = buy(other, v, 1, at),
    p2 = submit(other, j, at, {
      text: text
        .replace('120.00', '1.23')
        .replace('Example Shop', 'Different Name')
        .replace('0123', '1111')
        .replace('2024-01', '2034-01'),
      file: pdf,
    });
  const dup = get('SELECT * FROM b_proof WHERE payment=?', [p2.id]),
    failed = JSON.parse(dup.checks)
      .filter((x) => x.status === 'fail')
      .map((x) => x.id);
  for (const k of ['receiver', 'amount', 'date', 'reference', 'image']) assert.ok(failed.includes(k), k);
  assert.equal(dup.risk, 'inconsistent');
  assert.equal(proof.recheck(t.slug, f.id, at).risk, 'inconsistent');
  assert.throws(() => proof.readProof(other.slug, f.id, at), /not_found/);
  assert.throws(() => submit(t, i, at, { text: 'CVV is private' }), /card/);
  assert.throws(() => submit(t, i, at, { text: 'account ' + '4' + '1'.repeat(15) }), /card/);
  assert.throws(() => submit(t, i, at, { file: Buffer.from('<script>').toString('base64') }), /expected_png/);
  assert.throws(() => submit(t, i, at, { file: 'A'.repeat(3000000) }), /invalid_file/);
  assert.ok(!JSON.stringify(exportAccount(t.account.id, { now: at })).includes('NEVER_PERSIST'));
  proof.purgeProofs(at + 400 * DAY);
  assert.ok(!fs.existsSync(file));
  assert.throws(() => proof.readProof(t.slug, f.id, at + 400 * DAY), /expired/);
});
test('durable proof rate ceiling and neutral more/reject messages; no auto-verdict', () => {
  const t = fresh({ now: at }),
    i = buy(t, offer(), 1, at);
  for (let n = 0; n < 5; n++) {
    const p = submit(t, i, at);
    assert.equal(pay.paymentCard(t.slug, p.id).state, 'review');
    assert.equal(get('SELECT 1 FROM b_payment WHERE id=?', [p.id]), null);
    pay.reviewPayment(t.slug, p.id, 'more', { reason: 'unclear_proof' }, at);
    pay.reviewPayment(t.slug, p.id, 'reject', { reason: 'not_verified' }, at);
  }
  assert.throws(() => submit(t, i, at), /daily_proof_limit/);
  assert.equal(pay.invoice(t.slug, i.id).paid, 0);
  assert.match(pay.history(t.slug)[0].payments[0].message, /verify/);
});
test('FakeProvider contract: verify raw signature first, unknown ignored, currency AND exact balance, signed replay + same transaction', () => {
  const t = fresh({ now: at }),
    v = offer(),
    f = new FakeProvider(),
    i = f.createCheckout(t.slug, { version: v.version, months: 1, requestId: randomUUID() }, at);
  const ev = {
    id: randomUUID(),
    transaction: randomUUID(),
    type: 'payment.confirmed',
    invoice: i.id,
    slug: t.slug,
    currency: i.currency,
    amount: i.due,
  };
  const fire = (patch = {}, bad = false) => {
    const raw = Buffer.from(JSON.stringify({ ...ev, ...patch }));
    return pay.verifiedEvent(f, raw, bad ? 'bad' : f.sign(raw), at);
  };
  assert.throws(() => fire({}, true), /signature/);
  assert.ok(fire({ type: 'not.used' }).ignored);
  assert.throws(() => fire({ amount: 1 }), /mismatch/);
  assert.throws(() => fire({ currency: 'USD' }), /mismatch/);
  assert.equal(subs.entitlementsFor(t.slug, at).hasTerm, false);
  assert.ok(fire().accepted);
  assert.ok(fire().duplicate);
  assert.ok(fire({ id: randomUUID() }).duplicate);
  assert.equal(pay.history(t.slug)[0].payments.length, 1);
});
test('withdrawing a plan affects checkout only; paused owner can cancel without backdating the deletion clock', () => {
  const t = fresh({ now: at }),
    v = offer({ plan: 'withdrawn' }),
    i = buy(t, v, 1, at);
  accept(t, submit(t, i, at), i, i.due, at);
  const withdrawn = offer({ plan: 'withdrawn', offered: false, offers: {} });
  assert.equal(subs.entitlementsFor(t.slug, at).version, v.version);
  assert.throws(() => buy(t, withdrawn, 1, at), /plan_not_offered/);
  const late = at + 500 * DAY,
    e = subs.changeSubscription(t.slug, 'cancel', {}, late);
  assert.equal(e.state, 'canceled');
  assert.equal(e.pendingAt, stamp(late + 30 * DAY));
});
test('image submission retains a masked private proof, not raw pixels; excess dimensions refused', async () => {
  const { PNG } = await import('pngjs');
  const t = fresh(),
    v = offer(),
    i = buy(t, v);
  const img = PNG.sync.write(new PNG({ width: 3, height: 3 }));
  const p = submit(t, i, Date.now(), { file: img.toString('base64') });
  const row = get('SELECT id FROM b_proof WHERE payment=?', [p.id]);
  assert.equal(proof.readProof(t.slug, row.id).kind, 'png');
  img.writeUInt32BE(8000, 16);
  assert.throws(() => submit(t, i, Date.now(), { file: img.toString('base64') }), /dimensions/);
});
