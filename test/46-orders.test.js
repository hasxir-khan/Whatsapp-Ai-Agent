// test/46-orders.test.js
// The order lifecycle, tested from the two ends that matter:
//
//   • the facts — a status only moves where the table says it may, every move
//     is written down with who did it and when, and money is never confirmed by
//     anyone but the owner;
//   • the words — the customer is told about a status change through growth.js
//     (so opt-out, quiet hours and the Cloud template rule apply), and "where is
//     my order?" is answered from the row, never from the model's imagination.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isolate } from './helpers.js';

const dataDir = isolate('orders');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;

let envModule = null;

function writeProfile(patch = {}) {
  const profile = {
    owner: { name: 'T', number: '923001234567', timezone: 'Asia/Karachi' },
    business: {
      name: 'Test Cafe', type: 'Cafe', city: 'Islamabad',
      hours: 'Daily 00:00-23:59', currency: 'PKR',
      ...(patch.business || {}),
    },
    catalog: { items: [{ id: 'karahi', name: 'Chicken Karahi', price: 1350, stock: 5 }] },
    features: {
      businessProfile: true, catalog: true, toolCalling: true, growthApproval: false,
      orderTracking: true, crm: true, reviewAgent: false,
      ...(patch.features || {}),
    },
  };
  fs.writeFileSync(path.join(configDir, 'owner.json'), JSON.stringify(profile, null, 2));
  envModule?.reloadProfile?.();
}

writeProfile();

const db = await import('../src/utils/db.js');
await db.initDB();
const env = await import('../src/config/env.js');
envModule = env;
env.reloadProfile();

const { mockTransport } = await import('../src/dev/mockLlm.js');
mockTransport();

const orders = await import('../src/services/orders.js');
const growth = await import('../src/services/growth.js');
const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
const { handleIncoming } = await import('../src/handlers/messageHandler.js');
const { incomingMessage, textMessages, waitFor } = await import('./helpers.js');

const CUSTOMER = '923007771122';
const OTHER = '923007773344';
const OWNER = '923001234567';
const OWNER_JID = `${OWNER}@s.whatsapp.net`;

// 13:00 in Karachi (UTC+5) — inside business hours, outside quiet hours.
const NOON = new Date('2026-11-17T08:00:00.000Z');
// 23:00 in Karachi — inside the default 21:00 → 09:00 quiet window.
const NIGHT = new Date('2026-11-17T18:00:00.000Z');

/** A transport that behaves like the Baileys one for growth.js's purposes. */
function fakeTransport() {
  const sent = [];
  return {
    kind: 'baileys',
    sent,
    async sendMessage(jid, payload) {
      sent.push({ jid, payload });
      return { key: { id: `F${sent.length}` } };
    },
  };
}

function jidFor(number) {
  return `${number}@s.whatsapp.net`;
}

let seq = 0;
function makeOrder({
  chat = jidFor(CUSTOMER), status = 'placed', total = 1350,
  createdAgoHours = 0, key = null, name = 'Test Customer',
} = {}) {
  seq += 1;
  const created = new Date(NOON.getTime() - createdAgoHours * 3_600_000).toISOString();
  db.run(
    'INSERT INTO orders (chat, items, total, currency, name, status, key, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [chat, JSON.stringify([{ name: 'Karahi', qty: 1, price: total }]), total, 'PKR', name, status, key || `test-${seq}-${Date.now()}`, created]
  );
  return db.getOrder(db.get('SELECT MAX(id) AS id FROM orders').id);
}

function reset() {
  db.run('DELETE FROM orders');
  db.run('DELETE FROM order_events');
  db.run('DELETE FROM growth_sends');
  db.run('DELETE FROM growth_optouts');
  db.run('DELETE FROM events');
  db.run('DELETE FROM contact_tags');
}

// ── the state machine ───────────────────────────────────────

test('the happy path moves forwards one step at a time', async () => {
  reset();
  const order = makeOrder();
  const path_ = ['awaiting_payment', 'paid', 'preparing', 'ready', 'out_for_delivery', 'delivered'];
  for (const state of path_) {
    const res = await orders.transitionOrder(order.id, state, { actor: 'owner', now: NOON });
    assert.equal(res.ok, true, `${state} should be allowed`);
  }
  assert.equal(db.getOrder(order.id).status, 'delivered');
});

test('every move is logged with the actor and the time', async () => {
  reset();
  const order = makeOrder();
  await orders.transitionOrder(order.id, 'awaiting_payment', { actor: 'owner', now: NOON });
  await orders.transitionOrder(order.id, 'paid', { actor: 'owner', now: NOON });
  await orders.transitionOrder(order.id, 'preparing', { actor: 'bot', now: NOON });

  const events = db.orderEvents(order.id).filter((e) => e.to_status);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.to_status), ['awaiting_payment', 'paid', 'preparing']);
  assert.deepEqual(events.map((e) => e.actor), ['owner', 'owner', 'bot']);
  assert.deepEqual(events.map((e) => e.from_status), ['placed', 'awaiting_payment', 'paid']);
  for (const e of events) assert.ok(e.created_at, 'each move has a timestamp');
});

test('a forward jump is allowed, a backwards step is not', async () => {
  reset();
  const order = makeOrder({ status: 'preparing' });

  const jump = await orders.canTransition('preparing', 'delivered');
  assert.equal(jump.ok, true);
  assert.equal(jump.skip, true);

  const back = await orders.transitionOrder(order.id, 'awaiting_payment', { actor: 'owner' });
  assert.equal(back.ok, false);
  assert.equal(back.reason, 'not_allowed');
  assert.match(back.reply, /cannot go from/i);
  assert.equal(db.getOrder(order.id).status, 'preparing', 'a refused move changes nothing');
});

test('a backwards step succeeds only with the override flag, and says so', async () => {
  reset();
  const order = makeOrder({ status: 'delivered' });
  const res = await orders.transitionOrder(order.id, 'preparing', { actor: 'owner', override: true });
  assert.equal(res.ok, true);
  const last = db.orderEvents(order.id).pop();
  assert.equal(last.actor, 'owner');
  assert.match(String(last.detail), /override/);
});

test('an unknown state and a no-op state are both refused', async () => {
  reset();
  const order = makeOrder({ status: 'paid' });
  const typo = await orders.transitionOrder(order.id, 'pakka', { actor: 'owner' });
  assert.equal(typo.ok, false);
  assert.equal(typo.reason, 'unknown_state');

  const same = await orders.transitionOrder(order.id, 'paid', { actor: 'owner' });
  assert.equal(same.ok, false);
  assert.equal(same.reason, 'same_state');
});

test('paid can never be reached by skipping the payment step', async () => {
  reset();
  const order = makeOrder(); // placed
  const res = await orders.transitionOrder(order.id, 'paid', { actor: 'owner' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'paid_needs_payment_step');
  assert.equal(db.getOrder(order.id).status, 'placed');
});

test('only the owner can say an order is paid', async () => {
  reset();
  const order = makeOrder({ status: 'awaiting_payment' });

  for (const actor of ['bot', 'customer', 'agent']) {
    const res = await orders.transitionOrder(order.id, 'paid', { actor });
    assert.equal(res.ok, false, `${actor} must not confirm payment`);
    assert.equal(res.reason, 'owner_only');
  }
  assert.equal(db.getOrder(order.id).status, 'awaiting_payment');

  const owner = await orders.transitionOrder(order.id, 'paid', { actor: 'owner' });
  assert.equal(owner.ok, true);
  assert.equal(db.getOrder(order.id).status, 'paid');
});

test('.paid writes an owner line into the timeline', async () => {
  reset();
  const order = makeOrder({ status: 'awaiting_payment' });
  const res = await handleOwnerCommand(fakeTransport(), OWNER_JID, `.paid ${order.id}`);
  assert.equal(res.handled, true);
  assert.match(res.reply, /marked paid/i);

  const paid = db.orderEvents(order.id).filter((e) => e.to_status === 'paid');
  assert.equal(paid.length, 1);
  assert.equal(paid[0].actor, 'owner');
});

// ── telling the customer ────────────────────────────────────

test('a ready order is announced to the customer through growth', async () => {
  reset();
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha', push_name: 'Ayesha' });
  const order = makeOrder({ status: 'preparing' });
  const transport = fakeTransport();

  const moved = await orders.transitionOrder(order.id, 'ready', { actor: 'owner', now: NOON });
  const told = await orders.notifyCustomer(transport, moved.order, 'ready', { now: NOON });

  assert.equal(told.sent, true);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].jid, jidFor(CUSTOMER));
  assert.match(transport.sent[0].payload.text, new RegExp(`#${order.id}`));
  assert.match(transport.sent[0].payload.text, /ready/i);

  const logged = db.recentEvents(20).find((e) => e.type === 'order_notified');
  assert.ok(logged, 'the send is in the log');
});

test('an opted-out customer is not told anything', async () => {
  reset();
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha' });
  growth.recordOptOut(CUSTOMER, 'asked us to stop');
  const order = makeOrder({ status: 'preparing' });
  const transport = fakeTransport();

  const told = await orders.notifyCustomer(transport, order, 'ready', { now: NOON });
  assert.equal(told.sent, false);
  assert.equal(told.reason, 'opted_out');
  assert.equal(transport.sent.length, 0, 'nothing left the building');

  const skipped = db.recentEvents(20).find((e) => e.type === 'order_notify_skipped');
  assert.ok(skipped, 'and the reason is on file');
  assert.match(String(skipped.detail), /opted_out/);
});

test('quiet hours hold an order update instead of sending it', async () => {
  reset();
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha' });
  const order = makeOrder({ status: 'ready' });
  const transport = fakeTransport();

  const told = await orders.notifyCustomer(transport, order, 'out_for_delivery', { now: NIGHT });
  assert.equal(told.sent, false);
  assert.equal(told.reason, 'quiet_hours');
  assert.equal(transport.sent.length, 0);

  // The same message at 13:00 goes out, so it was the hour and not the message.
  const later = await orders.notifyCustomer(transport, order, 'out_for_delivery', { now: NOON });
  assert.equal(later.sent, true);
  assert.equal(transport.sent.length, 1);
});

test('the owner\'s own wording wins, and the built-in line is the fallback', async () => {
  reset();
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha' });
  const order = makeOrder({ status: 'ready' });
  const transport = fakeTransport();

  writeProfile({
    business: {
      orderMessages: { ready: 'Salam {first_name}, order {id} taiyar hai — {business}' },
    },
  });

  await orders.notifyCustomer(transport, order, 'ready', { now: NOON });
  assert.match(transport.sent[0].payload.text, /Salam Ayesha, order \d+ taiyar hai — Test Cafe/);

  // delivered has no owner wording in this profile, so the built-in line is used.
  await orders.notifyCustomer(transport, order, 'delivered', { now: NOON });
  assert.match(transport.sent[1].payload.text, /delivered/i);
  writeProfile();
});

test('a Cloud transport outside the 24h window sends nothing and explains why', async () => {
  reset();
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha' });
  const order = makeOrder({ status: 'ready' });
  const sent = [];
  const cloud = {
    kind: 'cloud',
    windowOpen: () => false,
    async sendMessage(jid, payload) {
      sent.push({ jid, payload });
    },
  };

  const told = await orders.notifyCustomer(cloud, order, 'out_for_delivery', { now: NOON });
  assert.equal(told.sent, false);
  assert.equal(told.reason, 'window_closed');
  assert.equal(sent.length, 0);

  const held = db.recentEvents(20).find((e) => e.type === 'order_notify_skipped');
  assert.ok(held);
  assert.match(String(held.detail), /window|template/i);
});

// ── "where is my order?" ────────────────────────────────────

test('the status question is recognised in English, Roman Urdu and Urdu', () => {
  const yes = [
    'where is my order?',
    'order ka status kya hai?',
    'mera order kahan hai',
    'kab aayega mera parcel',
    'آرڈر کہاں ہے',
    'track my delivery please',
  ];
  for (const text of yes) assert.equal(orders.isOrderQuestion(text), true, text);

  const no = ['what is the price of the karahi', 'hello', 'aap kaise hain', 'do you deliver to Rawalpindi?'];
  for (const text of no) assert.equal(orders.isOrderQuestion(text), false, text);
});

test('the answer comes from the row, and changes when the row changes', () => {
  reset();
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha' });
  const order = makeOrder({ status: 'preparing' });

  const first = orders.orderStatusAnswer(CUSTOMER, { lang: 'en' });
  assert.equal(typeof first, 'string');
  assert.match(first, /preparing/i);
  assert.match(first, new RegExp(`#${order.id}`));
  assert.doesNotMatch(first, /ETA/, 'no ETA invented');

  db.setOrderStatus(order.id, 'out_for_delivery');
  const second = orders.orderStatusAnswer(CUSTOMER, { lang: 'en' });
  assert.match(second, /out for delivery/i);
  assert.notEqual(first, second);
});

test('the same fact is told in the customer\'s own language', () => {
  reset();
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha' });
  const order = makeOrder({ status: 'ready' });

  assert.match(orders.orderStatusAnswer(CUSTOMER, { lang: 'en' }), /currently/i);
  assert.match(orders.orderStatusAnswer(CUSTOMER, { lang: 'roman-ur' }), /abhi/i);
  assert.match(orders.orderStatusAnswer(CUSTOMER, { lang: 'ur' }), /آرڈر/);
  void order;
});

test('an ETA is quoted only when the owner set one', () => {
  reset();
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha' });
  const order = makeOrder({ status: 'out_for_delivery' });

  const bare = orders.orderStatusAnswer(CUSTOMER, { lang: 'en' });
  assert.doesNotMatch(bare, /ETA/);

  db.setOrderEta(order.id, 'by 7pm tonight');
  assert.equal(db.getOrder(order.id).eta, 'by 7pm tonight');
  const withEta = orders.orderStatusAnswer(CUSTOMER, { lang: 'en' });
  assert.match(withEta, /ETA: by 7pm tonight/);
});

test('with no order on file the bot says so instead of inventing one', () => {
  reset();
  db.upsertContact(OTHER, { jid: jidFor(OTHER), name: 'Bilal' });
  // null is the signal messageHandler turns into "send me the order id, or I
  // will pass you to the owner" — never a made-up status.
  assert.equal(orders.orderStatusAnswer(OTHER, { lang: 'en' }), null);
});

// ── reminders ───────────────────────────────────────────────

test('an unpaid order gets one reminder, then a second, then silence', async () => {
  reset();
  writeProfile({ features: { growthApproval: false } });
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha' });
  const order = makeOrder({ status: 'awaiting_payment', createdAgoHours: 13 });
  const transport = fakeTransport();

  const first = await orders.runPaymentReminders({ transport, now: NOON });
  assert.equal(first.sent, 1);
  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0].payload.text, /payment/i);

  // One hour later: too soon for the second, and the first already went.
  const early = await orders.runPaymentReminders({ transport, now: new Date(NOON.getTime() + 3_600_000) });
  assert.equal(early.sent, 0);
  assert.equal(transport.sent.length, 1);

  // Past the second threshold: exactly one more.
  const second = await orders.runPaymentReminders({ transport, now: new Date(NOON.getTime() + 24 * 3_600_000) });
  assert.equal(second.sent, 1);
  assert.equal(transport.sent.length, 2);
  assert.match(transport.sent[1].payload.text, /payment/i);

  // Past it again: no third reminder, ever.
  const third = await orders.runPaymentReminders({ transport, now: new Date(NOON.getTime() + 72 * 3_600_000) });
  assert.equal(third.sent, 0);
  assert.equal(transport.sent.filter((m) => m.jid === jidFor(CUSTOMER)).length, 2, 'no third reminder');
  assert.equal(db.countOrderReminders(order.id), 2);
});

test('after the second reminder the owner is told, once', async () => {
  reset();
  writeProfile({ features: { growthApproval: false } });
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha' });
  const order = makeOrder({ status: 'awaiting_payment', createdAgoHours: 40 });
  const transport = fakeTransport();

  // Two reminders already went (seeded as events so the clock stays honest).
  db.logOrderEvent({ orderId: order.id, from: 'awaiting_payment', to: 'awaiting_payment', actor: 'bot', detail: 'reminder:1' });
  db.logOrderEvent({ orderId: order.id, from: 'awaiting_payment', to: 'awaiting_payment', actor: 'bot', detail: 'reminder:2' });

  const res = await orders.runPaymentReminders({ transport, now: NOON });
  assert.equal(res.sent, 0);
  assert.equal(res.escalated, 1);

  const toOwner = transport.sent.filter((m) => m.jid.startsWith(OWNER));
  assert.equal(toOwner.length, 1, 'the owner hears about it');
  assert.match(toOwner[0].payload.text, new RegExp(`#${order.id}`));

  // Running again does not nag the owner twice.
  const again = await orders.runPaymentReminders({ transport, now: NOON });
  assert.equal(again.escalated, 0);
  assert.equal(transport.sent.filter((m) => m.jid.startsWith(OWNER)).length, 1);
});

test('with approval mode on, reminders wait as drafts', async () => {
  reset();
  writeProfile({ features: { growthApproval: true } });
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha' });
  makeOrder({ status: 'awaiting_payment', createdAgoHours: 13 });
  const transport = fakeTransport();

  const res = await orders.runPaymentReminders({ transport, now: NOON });
  assert.equal(res.drafted, 1);
  assert.equal(res.sent, 0);
  assert.equal(transport.sent.length, 0, 'nothing is sent without a yes');

  const drafts = db.pendingDrafts(10);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].agent, 'order');
  writeProfile({ features: { growthApproval: false } });
});

test('reminders stop as soon as the order is paid', async () => {
  reset();
  writeProfile({ features: { growthApproval: false } });
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha' });
  const order = makeOrder({ status: 'awaiting_payment', createdAgoHours: 13 });
  db.setOrderStatus(order.id, 'paid');
  const transport = fakeTransport();

  const res = await orders.runPaymentReminders({ transport, now: NOON });
  assert.equal(res.sent, 0);
  assert.equal(transport.sent.length, 0);
});

// ── owner commands ──────────────────────────────────────────

test('.status <id> <state> moves an order and notifies the customer', async () => {
  reset();
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha' });
  const order = makeOrder({ status: 'ready' });
  const transport = fakeTransport();

  // A fixed clock, never the wall clock: quiet hours (default 21:00 → 09:00 in
  // the profile's timezone) decide whether the customer is messaged, so the
  // hour this suite happens to run at must not change the answer. NOON is 13:00
  // in Karachi.
  const res = await handleOwnerCommand(transport, OWNER_JID, `.status ${order.id} out_for_delivery`, OWNER, { now: NOON });
  assert.equal(res.handled, true);
  assert.match(res.reply, /Out for delivery/);
  assert.match(res.reply, /Customer notified/);
  assert.equal(db.getOrder(order.id).status, 'out_for_delivery');
  assert.equal(transport.sent.filter((m) => m.jid === jidFor(CUSTOMER)).length, 1);
});

test('.status during quiet hours moves the order and holds the message', async () => {
  reset();
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha' });
  const order = makeOrder({ status: 'ready' });
  const transport = fakeTransport();

  // Same command, same fake clock, moved to 23:00 in Karachi — the move still
  // happens, the customer is not woken up, and the owner is told why.
  const res = await handleOwnerCommand(transport, OWNER_JID, `.status ${order.id} out_for_delivery`, OWNER, { now: NIGHT });
  assert.equal(res.handled, true);
  assert.equal(db.getOrder(order.id).status, 'out_for_delivery');
  assert.equal(transport.sent.filter((m) => m.jid === jidFor(CUSTOMER)).length, 0);
  assert.match(res.reply, /quiet_hours/);
});

test('.status refuses a backwards move without --force', async () => {
  reset();
  const order = makeOrder({ status: 'delivered' });
  const refused = await handleOwnerCommand(fakeTransport(), OWNER_JID, `.status ${order.id} preparing`);
  assert.match(refused.reply, /without an override/);
  assert.equal(db.getOrder(order.id).status, 'delivered');

  const forced = await handleOwnerCommand(fakeTransport(), OWNER_JID, `.status ${order.id} preparing --force`);
  assert.equal(db.getOrder(order.id).status, 'preparing');
  assert.match(forced.reply, /Delivered → \*Preparing\*/);
});

test('.status with no number is still system health', async () => {
  const res = await handleOwnerCommand(fakeTransport(), OWNER_JID, '.status');
  assert.match(res.reply, /System status/);
});

test('.orders lists what is open and .order shows the timeline', async () => {
  reset();
  const open = makeOrder({ status: 'preparing' });
  makeOrder({ status: 'delivered' });

  const list = await handleOwnerCommand(fakeTransport(), OWNER_JID, '.orders');
  assert.match(list.reply, new RegExp(`#${open.id}`));
  assert.doesNotMatch(list.reply, /#\d+.*Delivered/);

  await orders.transitionOrder(open.id, 'ready', { actor: 'owner', now: NOON });
  const one = await handleOwnerCommand(fakeTransport(), OWNER_JID, `.order ${open.id}`);
  assert.match(one.reply, /Preparing → Ready/);
});

test('delivering an order hands it to the review agent', async () => {
  reset();
  writeProfile({ features: { reviewAgent: true } });
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha' });
  const order = makeOrder({ status: 'out_for_delivery' });

  const res = await orders.transitionOrder(order.id, 'delivered', { actor: 'owner', now: NOON });
  assert.equal(res.ok, true);
  assert.ok(res.review, 'a review ask was scheduled');
  writeProfile();
});

test('with the flag off, nothing about orders is offered', async () => {
  reset();
  writeProfile({ features: { orderTracking: false } });
  const order = makeOrder({ status: 'preparing' });

  const res = await handleOwnerCommand(fakeTransport(), OWNER_JID, `.status ${order.id} ready`);
  assert.match(res.reply, /Order tracking is off/);
  assert.equal(db.getOrder(order.id).status, 'preparing');

  const list = await handleOwnerCommand(fakeTransport(), OWNER_JID, '.orders');
  assert.match(list.reply, /Order tracking is off/);

  const reminders = await orders.runPaymentReminders({ transport: fakeTransport(), now: NOON });
  assert.equal(reminders.sent, 0);
  assert.equal(typeof orders.startOrderLoop({ transport: fakeTransport() }), 'object'); // null

  writeProfile();
  assert.equal(orders.orderTrackingEnabled(), true);
  orders.stopOrderLoop();
});

test('.growth explains an order message that was held back', async () => {
  reset();
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha' });
  growth.recordOptOut(CUSTOMER, 'asked us to stop');
  const order = makeOrder({ status: 'awaiting_payment', createdAgoHours: 20 });

  await orders.notifyCustomer(fakeTransport(), order, 'ready', { now: NOON });
  await orders.runPaymentReminders({ transport: fakeTransport(), now: NOON });

  const res = await handleOwnerCommand(fakeTransport(), OWNER_JID, '.growth');
  assert.match(res.reply, /\*Orders\*/);
  assert.match(res.reply, /1 awaiting payment/);
  assert.match(res.reply, /Notifications held back/);
  assert.match(res.reply, new RegExp(CUSTOMER));
  assert.match(res.reply, /opted_out/);
  assert.match(res.reply, /template/i, 'and says what a held update would need');
});

// ── through the real message path ───────────────────────────

test('a customer asking about an order is answered from the table, not the model', async () => {
  reset();
  db.upsertContact(CUSTOMER, { jid: jidFor(CUSTOMER), name: 'Ayesha' });
  const order = makeOrder({ status: 'preparing' });

  const sock = fakeTransport();
  await handleIncoming(sock, incomingMessage('order ka status kya hai?', {
    key: { remoteJid: jidFor(CUSTOMER), fromMe: false, id: 'ORDQ1' },
  }));
  await waitFor(() => sock.sent.length > 0);

  const said = textMessages(sock.sent, CUSTOMER).join(' ');
  assert.match(said, new RegExp(`#${order.id}`));
  assert.match(said, /preparing/i);
  assert.equal(
    said.trim(),
    orders.orderStatusAnswer(CUSTOMER, { lang: 'roman-ur' }).trim(),
    'the reply is exactly the row, in the customer\'s language'
  );
  assert.ok(db.recentEvents(20).some((e) => e.type === 'order_question_answered'));
});

test('a customer with no order is asked for details, and nothing is invented', async () => {
  reset();
  db.upsertContact(OTHER, { jid: jidFor(OTHER), name: 'Bilal' });

  const sock = fakeTransport();
  await handleIncoming(sock, incomingMessage('where is my order?', {
    key: { remoteJid: jidFor(OTHER), fromMe: false, id: 'ORDQ2' },
  }));
  await waitFor(() => sock.sent.length > 0);

  const said = textMessages(sock.sent, OTHER).join(' ');
  assert.match(said, /can't see an order/i);
  assert.match(said, /order id|owner/i);
  // The only id in the message is the example; no status is claimed for it.
  assert.doesNotMatch(said, /is currently/);
  assert.doesNotMatch(said, /#\d+ is/);
  assert.ok(db.recentEvents(20).some((e) => e.type === 'order_question_no_match'));
});
