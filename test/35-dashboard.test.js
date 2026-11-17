// Phase 3 Part 3 — the growth dashboard and the per-tenant budget guard.
//
// The dashboard is business data on a public port: the tests check that the
// numbers are right, that nothing sensitive leaks into the payload, and that a
// token actually keeps people out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, fakeSock } from './helpers.js';

const dataDir = isolate('growth-dashboard');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
process.env.GROQ_API_KEY = 'test-groq-key';

fs.writeFileSync(
  path.join(configDir, 'owner.json'),
  JSON.stringify(
    {
      business: { name: 'Burger Point', timezone: 'Asia/Karachi', hours: 'Daily 12:00–23:00' },
      catalog: { items: [{ name: 'Zinger Burger', kind: 'product', price: 650 }] },
      features: { businessProfile: true, catalog: true, bookingAgent: true, closerAgent: true },
      currency: { base: 'PKR' },
    },
    null,
    2
  )
);

const db = await import('../src/utils/db.js');
await db.initDB();
const P = await import('../src/services/profile.js');
P.reloadProfile();
const G = await import('../src/services/growthDashboard.js');
const { config } = await import('../src/config/env.js');
const { config: env } = await import('../src/config/env.js');

function clean() {
  for (const t of ['messages', 'contacts', 'leads', 'orders', 'bookings', 'events', 'growth_sends', 'growth_optouts', 'review_asks', 'message_intents']) {
    db.run(`DELETE FROM ${t}`);
  }
}

const JID = (n) => `${n}@s.whatsapp.net`;

function seedFunnel() {
  // A conversation that became a lead, a quote, an order, a payment, a review.
  db.upsertContact('923001112223', { name: 'Ali' });
  db.saveMessage('923001112223', 'user', 'I want a zinger burger', 'text');
  db.saveLead({ number: '923001112223', status: 'won', project_type: 'Zinger Burger' });
  db.logEvent('quote_sent', '923001112223', { total: 650 });
  const { order } = db.createOrder({ chat: JID('923001112223'), items: [{ name: 'Zinger Burger', qty: 1 }], total: 650 });
  db.setOrderStatus(order.id, 'paid');
  db.scheduleReviewAsk({ number: '923001112223', kind: 'order', refId: order.id, dueAt: '2030-06-01T00:00:00.000Z' });
  db.setReviewAsk(db.all('SELECT * FROM review_asks')[0].id, { status: 'rated', rating: 5 });

  // Someone who only talked.
  db.upsertContact('923004445556', { name: 'Sara' });
  db.saveMessage('923004445556', 'user', 'what are your timings?', 'text');
}

// ── funnel ─────────────────────────────────────────────────
test('the funnel counts each step of a real customer journey', () => {
  clean();
  seedFunnel();
  const funnel = G.funnel();

  const byKey = Object.fromEntries(funnel.map((f) => [f.key, f.value]));
  assert.equal(byKey.conversations, 2);
  assert.equal(byKey.leads, 1);
  assert.equal(byKey.quotes, 1);
  assert.equal(byKey.orders, 1);
  assert.equal(byKey.paid, 1);
  assert.equal(byKey.reviewed, 1);

  const orders = funnel.find((f) => f.key === 'orders');
  assert.equal(orders.fromPrevious, 100, 'every quote became an order');
  assert.equal(Math.round(orders.fromTop), 50, 'one of two conversations');
});

test('an empty database is a funnel of zeros, not an error', () => {
  clean();
  const funnel = G.funnel();
  assert.equal(funnel.length, 6);
  assert.equal(funnel.every((f) => f.value === 0), true);
  assert.equal(funnel[0].fromTop, null);
});

// ── per agent ──────────────────────────────────────────────
test('each agent gets sent / replied / converted / opt-outs', () => {
  clean();
  db.upsertContact('923001112223', { name: 'Ali' });
  db.logGrowthSend({ agent: 'followup', number: '923001112223', reason: 'quiet 24h', result: 'sent', at: '2030-06-01T07:00:00.000Z' });
  db.saveMessage('923001112223', 'user', 'yes please', 'text');
  db.run("UPDATE messages SET created_at = '2030-06-01T08:00:00.000Z' WHERE number = '923001112223'");
  const { order } = db.createOrder({ chat: JID('923001112223'), items: [{ name: 'Zinger Burger', qty: 1 }], total: 650 });
  db.setOrderStatus(order.id, 'paid');
  db.optOut('923009990000', { reason: 'stop' });

  const followup = G.agentStats().find((a) => a.agent === 'followup');
  assert.equal(followup.sent, 1);
  assert.equal(followup.replied, 1);
  assert.equal(followup.converted, 1);

  // Agents that have never run still appear, so zero does not look like broken.
  const idle = G.agentStats().find((a) => a.agent === 'analyst');
  assert.equal(idle.idle, true);
  assert.equal(idle.sent, 0);
});

test('a skipped send is counted as skipped, not as sent', () => {
  clean();
  db.logGrowthSend({ agent: 'reactivation', number: '923001112223', reason: 'campaign', result: 'skipped', detail: 'quiet_hours', at: '2030-06-01T17:00:00.000Z' });
  db.logGrowthSend({ agent: 'reactivation', number: '923001112224', reason: 'campaign', result: 'held', detail: 'no template', at: '2030-06-01T17:00:00.000Z' });
  const row = G.agentStats().find((a) => a.agent === 'reactivation');
  assert.equal(row.sent, 0);
  assert.equal(row.skipped, 1);
  assert.equal(row.held, 1);
});

// ── sources ────────────────────────────────────────────────
test('source tags, referrals and direct traffic are separated', () => {
  clean();
  db.upsertContact('923001110001', { name: 'QR person' });
  db.saveMessage('923001110001', 'user', 'hi #qr', 'text');
  G.recordSourceTag('923001110001', 'hi #qr');

  db.upsertContact('923001110002', { name: 'Ad person' });
  db.saveMessage('923001110002', 'user', 'saw the ad #ads', 'text');
  G.recordSourceTag('923001110002', 'saw the ad #ads');

  db.upsertContact('923001110003', { name: 'Referral person' });
  db.saveMessage('923001110003', 'user', 'Ali ne bheja', 'text');
  db.logEvent('referral_attributed', '923001110003', { code: 'BP1234' });

  db.upsertContact('923001110004', { name: 'Walk-in' });
  db.saveMessage('923001110004', 'user', 'hello?', 'text');

  const rows = G.sourceBreakdown();
  const by = Object.fromEntries(rows.map((r) => [r.source, r]));
  assert.equal(by.qr.conversations, 1);
  assert.equal(by.ads.conversations, 1);
  assert.equal(by.referral.conversations, 1);
  assert.equal(by.direct.conversations, 1);
});

test('revenue is attributed to the source that brought the customer', () => {
  clean();
  db.upsertContact('923001110001', { name: 'QR person' });
  db.saveMessage('923001110001', 'user', 'hi #qr', 'text');
  G.recordSourceTag('923001110001', 'hi #qr');
  const { order } = db.createOrder({ chat: JID('923001110001'), items: [], total: 1300 });
  db.setOrderStatus(order.id, 'paid');

  const qr = G.sourceBreakdown().find((s) => s.source === 'qr');
  assert.equal(qr.paidOrders, 1);
  assert.equal(qr.revenue, 1300);
});

test('a source tag is written once, so a later message cannot rewrite history', () => {
  clean();
  db.upsertContact('923001110001', { name: 'QR person' });
  assert.equal(G.recordSourceTag('923001110001', 'first #qr'), 'qr');
  assert.equal(G.recordSourceTag('923001110001', 'now #ads'), null);
  assert.equal(G.sourceOf('923001110001'), 'qr');
});

// ── nothing sensitive ──────────────────────────────────────
test('the snapshot carries no keys, tokens or full phone numbers', () => {
  clean();
  seedFunnel();
  const json = JSON.stringify(G.growthSnapshot());
  assert.doesNotMatch(json, /gsk_|AQ\.|sk-|Bearer|api[_-]?key/i);
  assert.doesNotMatch(json, /923001112223/, 'no phone numbers in the payload');
});

// ── auth ───────────────────────────────────────────────────
const fakeReq = (headers = {}) => ({ headers });
const fakeUrl = (search = '') => new URL(`http://localhost/${search}`);

test('DASHBOARD_TOKEN keeps the growth data private', async () => {
  const { authorised } = await import('../src/server.js');
  env.server.token = 'secret-token-123';
  try {
    assert.equal(authorised(fakeReq(), fakeUrl('api/growth')), false, 'no token, no data');
    assert.equal(authorised(fakeReq({ authorization: 'Bearer wrong' }), fakeUrl('api/growth')), false);
    assert.equal(authorised(fakeReq(), fakeUrl('api/growth?token=secret-token-123')), true);
    assert.equal(authorised(fakeReq({ authorization: 'Bearer secret-token-123' }), fakeUrl('api/growth')), true);
    assert.equal(authorised(fakeReq({ cookie: 'wa_dash=secret-token-123' }), fakeUrl('/')), true);
    assert.equal(authorised(fakeReq({ cookie: 'wa_dash=nope' }), fakeUrl('/')), false);
  } finally {
    env.server.token = '';
  }
});

test('with no token configured the dashboard behaves as before', async () => {
  const { authorised, growthSection } = await import('../src/server.js');
  env.server.token = '';
  assert.equal(authorised(fakeReq(), fakeUrl('api/growth')), true);

  const html = growthSection(G.growthSnapshot());
  assert.match(html, /Growth funnel/, 'the funnel is rendered');
  assert.match(html, /Where they came from/, 'and the source table');
  assert.doesNotMatch(html, /923001112223/, 'no phone numbers rendered');
});

// ── per-tenant budget ──────────────────────────────────────
test('one tenant cannot spend the whole free quota', async () => {
  const { tenantBudget, assertTenantBudget, QuotaError, tenantSlug } = await import('../src/core/llm.js');
  const slug = tenantSlug();
  const cap = config.limits.tenantDailyLlmCalls;
  assert.equal(cap > 0, true);

  db.run('DELETE FROM tenant_usage');
  assert.deepEqual(tenantBudget(slug), { used: 0, cap, exceeded: false, tenant: slug });

  db.bumpTenantUsage(slug, cap - 1);
  assert.equal(assertTenantBudget(slug).exceeded, false);

  db.bumpTenantUsage(slug, 1);
  assert.equal(tenantBudget(slug).exceeded, true);
  assert.throws(() => assertTenantBudget(slug), QuotaError);

  // A different tenant is untouched by the first one's spending.
  assert.equal(tenantBudget('someone-else').exceeded, false);

  db.run('DELETE FROM tenant_usage');
});

test('the budget failure is logged, so it is never a silent stop', async () => {
  const { assertTenantBudget } = await import('../src/core/llm.js');
  db.run('DELETE FROM tenant_usage');
  db.run('DELETE FROM events');
  db.bumpTenantUsage('default', config.limits.tenantDailyLlmCalls);
  assert.throws(() => assertTenantBudget());
  assert.equal(db.all("SELECT * FROM events WHERE type = 'tenant_budget_hit'").length, 1);
  db.run('DELETE FROM tenant_usage');
});

void fakeSock;
