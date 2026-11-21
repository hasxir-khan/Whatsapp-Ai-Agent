// All identities, prices, times and mail are invented. No external requests.
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as demo from './dashboard.js';
export { demo };
process.env.PLATFORM_BILLING = '1';
process.env.PLATFORM_MAILER = 'file';
delete process.env.PLATFORM_BILLING_OPERATOR_EMAIL;
export const { all, get, run } = demo.db;
export const catalog = await import('../../platform/billing/catalog.js'),
  subs = await import('../../platform/billing/subscriptions.js'),
  pay = await import('../../platform/billing/payments.js'),
  proof = await import('../../platform/billing/proofs.js'),
  jobs = await import('../../platform/billing/jobs.js'),
  rules = await import('../../platform/billing/rules.js');
const { businessNumberId } = await import('../../platform/provisioning.js');
export const offer = (over = {}) =>
  catalog.publishPlan({
    plan: 'example',
    name: 'Example',
    rank: 1,
    currency: 'PKR',
    offers: { 1: 12000, 2: 22500, 6: 59000 },
    features: ['voiceLanguagePolicy', 'liveInbox'],
    limits: { ...catalog.trialLimits, voice_minutes: 10, videos_month: 1, tenants: 3, numbers: 3 },
    ...over,
  });
export const enable = () => {
  catalog.initCatalog();
  catalog.configure({
    methods: [{ method: 'Demo transfer', alias: 'sample-shop', receiver: 'Example Shop', tail: '0123' }],
    taxBps: 0,
  });
};
let serial = 1000;
export function fresh({
  account = demo.account(null),
  number = '1202555' + String(++serial).padStart(4, '0'),
  now = Date.now(),
} = {}) {
  const slug = 'demo-' + randomUUID().slice(0, 8),
    at = rules.stamp(now);
  run(
    "INSERT INTO tenants(slug,account_id,name,number,status,created_at,updated_at) VALUES(?,?,?,?,'provisioned',?,?)",
    [slug, account.id, 'Example Shop', businessNumberId(number), at, at]
  );
  run("INSERT INTO memberships VALUES(?,?,'owner',?)", [account.id, slug, at]);
  const dir = path.join(process.env.TENANTS_DIR, slug);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'tenant.json'), JSON.stringify({ slug, platformManaged: true }));
  fs.writeFileSync(
    path.join(dir, 'config', 'owner.json'),
    JSON.stringify({ business: { timezone: 'America/New_York' }, features: { liveInbox: true } })
  );
  const s = subs.openSubscription(slug, { now });
  return { slug, account, dir, s, number };
}
export const buy = (t, v, months = 1, now = Date.now()) =>
  pay.checkout(t.slug, { months, version: v.version, requestId: randomUUID() }, now);
export const submit = (t, i, now = Date.now(), more = {}) =>
  proof.uploadProof(
    t.slug,
    i.id,
    {
      text: `PKR 120.00 to Example Shop ***0123 ref DEMO-${randomUUID().slice(0, 8)} date ${rules.stamp(now).slice(0, 16).replace('T', ' ')}`,
      ...more,
    },
    now
  );
export const accept = (t, p, i, amount = i.due, now = Date.now()) =>
  pay.reviewPayment(t.slug, p.id, 'accept', { amount, currency: i.currency }, now);
export class FakeProvider extends pay.PaymentProvider {
  name = 'fake';
  #key = randomBytes(32);
  sign(bytes) {
    return createHmac('sha256', this.#key).update(bytes).digest('hex');
  }
  verifyWebhook(bytes, sig) {
    const a = Buffer.from(this.sign(bytes)),
      b = Buffer.from(sig || '');
    return a.length === b.length && timingSafeEqual(a, b);
  }
  parseEvent(bytes) {
    return JSON.parse(bytes);
  }
  createCheckout(...args) {
    return pay.checkout(...args);
  }
  refund(...args) {
    return new pay.ManualProvider().refund(...args);
  }
}
