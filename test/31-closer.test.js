// Phase 3 Part 2 — the closer.
//
// What is being defended here: no invented prices, no discount the owner did
// not authorise, no third attempt, and a receipt that never marks an order paid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, fakeSock, textMessages, incomingMessage, waitFor, settle, CLIENT } from './helpers.js';

const dataDir = isolate('closer-agent');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
process.env.GROQ_API_KEY = 'test-groq-key';

function writeProfile({ policies = {}, payment = null, features = {} } = {}) {
  const profile = {
    business: {
      name: 'Burger Point',
      timezone: 'Asia/Karachi',
      hours: 'Daily 12:00–23:00',
      ...(payment ? { payment } : {}),
    },
    catalog: { items: [{ name: 'Zinger Burger', kind: 'product', price: 650, stock: 20 }] },
    faqs: [{ question: 'Is there a guarantee?', answer: 'If anything is wrong we replace it, no questions.' }],
    features: { businessProfile: true, catalog: true, closerAgent: true, ...features },
    currency: { base: 'PKR' },
  };
  if (Object.keys(policies).length) profile.policies = policies;
  fs.writeFileSync(path.join(configDir, 'owner.json'), JSON.stringify(profile, null, 2));
}
writeProfile();

const db = await import('../src/utils/db.js');
await db.initDB();
const P = await import('../src/services/profile.js');
P.reloadProfile();
const C = await import('../src/services/closerAgent.js');
const { config } = await import('../src/config/env.js');

const NUMBER = '923007778899';

function fakeTransport() {
  const sock = fakeSock();
  return {
    kind: 'baileys',
    sock,
    toClient: () => textMessages(sock.sent, NUMBER),
    toOwner: () => textMessages(sock.sent, config.owner.number),
    async sendMessage(jid, payload) {
      return sock.sendMessage(jid, payload);
    },
    windowOpen: () => true,
    can: () => true,
  };
}

function clean() {
  for (const t of ['orders', 'contacts', 'leads', 'events', 'objection_attempts', 'intake']) db.run(`DELETE FROM ${t}`);
}

// ── detection ──────────────────────────────────────────────
test('objections are recognised in English, Roman Urdu and Urdu', () => {
  const cases = [
    ['that is too expensive for me', 'price'],
    ['mehnga hai bhai', 'price'],
    ['یہ بہت مہنگا ہے', 'price'],
    ['is this a scam? I need to trust you', 'trust'],
    ['bharosa nahi hota', 'trust'],
    ['بھروسہ کیسے کروں', 'trust'],
    ['sochta hoon phir batata hoon', 'timing'],
    ['maybe later, I need to think about it', 'timing'],
    ['سوچتا ہوں بعد میں بتاؤں گا', 'timing'],
    ['kisi aur se cheaper mil raha hai', 'comparison'],
    ['someone else is cheaper', 'comparison'],
    ['دوسرے سستا دے رہے ہیں', 'comparison'],
  ];
  for (const [text, kind] of cases) assert.equal(C.detectObjection(text), kind, `${text} → ${kind}`);
});

test('an ordinary question is not an objection', () => {
  assert.equal(C.detectObjection('kal 8 baje table chahiye'), null);
  assert.equal(C.detectObjection('assalam o alaikum'), null);
  assert.equal(C.detectObjection('what are your timings?'), null);
});

// ── the reply ──────────────────────────────────────────────
test('the price answer uses the real catalogue price, in all three languages', () => {
  const en = C.buildObjectionReply({ kind: 'price', attempt: 1, lang: 'en' });
  const ru = C.buildObjectionReply({ kind: 'price', attempt: 1, lang: 'roman-ur' });
  const ur = C.buildObjectionReply({ kind: 'price', attempt: 1, lang: 'ur' });

  assert.match(en, /650/);
  assert.match(ru, /650/);
  assert.match(ur, /650|۶۵۰/);
});

test('the trust answer quotes a policy that actually exists', () => {
  const reply = C.buildObjectionReply({ kind: 'trust', attempt: 1, lang: 'en' });
  assert.match(reply, /replace it|guarantee/i);
});

test('no answer pressures, invents urgency or discounts by itself', () => {
  for (const kind of ['price', 'trust', 'timing', 'comparison']) {
    for (const lang of ['en', 'roman-ur', 'ur']) {
      const reply = C.buildObjectionReply({ kind, attempt: 1, lang });
      assert.doesNotMatch(reply, /only today|today only|last chance|hurry|limited time|abhi nahi to|آخری موقع/i, `${kind}/${lang}: ${reply}`);
      assert.doesNotMatch(reply, /\b\d{2}%\b/, `${kind}/${lang} invented a discount: ${reply}`);
    }
  }
});

// ── discounts ──────────────────────────────────────────────
test('without a configured ceiling no discount is offered — a human decides', () => {
  clean();
  writeProfile();
  P.reloadProfile();
  assert.equal(C.discountPolicy().configured, false);

  const turn = C.handleCloserTurn({ number: NUMBER, text: 'mehnga hai, 10% discount do', lang: 'roman-ur' });
  assert.equal(turn.handled, true);
  assert.equal(turn.escalate, true, 'a discount request goes to the owner');
  assert.match(turn.reply, /owner/i);
  assert.equal(turn.discountPercent, undefined);
});

test('a configured ceiling is respected, and anything above it is handed over', () => {
  clean();
  writeProfile({ policies: { maxDiscountPercent: 10 } });
  P.reloadProfile();
  assert.deepEqual(C.discountPolicy(), { configured: true, cap: 10 });

  const within = C.handleCloserTurn({ number: NUMBER, text: 'mehnga hai, 5% kam kar do', lang: 'roman-ur' });
  assert.equal(within.handled, true);
  assert.equal(within.discountPercent, 5);
  assert.match(within.reply, /617|618/); // 650 − 5% = 617.5

  const above = C.handleCloserTurn({ number: '923007700001', text: 'mehnga hai, 25% off karo', lang: 'roman-ur' });
  assert.equal(above.escalate, true);
  assert.equal(above.discountRequest, 25);
  assert.equal(above.discountPercent, undefined);

  writeProfile();
  P.reloadProfile();
});

// ── two attempts, then a human ─────────────────────────────
test('the third objection in a row gets a person, not a pitch', () => {
  clean();
  db.upsertContact(NUMBER, { name: 'Ali' });
  const first = C.handleCloserTurn({ number: NUMBER, text: 'mehnga hai', lang: 'roman-ur' });
  const second = C.handleCloserTurn({ number: NUMBER, text: 'bohot zyada hai', lang: 'roman-ur' });
  const third = C.handleCloserTurn({ number: NUMBER, text: 'phir bhi mehnga lagta hai', lang: 'roman-ur' });

  assert.equal(first.handled, true);
  assert.equal(second.handled, true);
  assert.equal(third.handled, true);
  assert.equal(third.escalate, true);
  assert.match(third.reply, /owner|مالک/i);
  assert.equal(db.getLead(NUMBER).status, 'negotiating');
});

test('two attempts are counted per objection, not per customer', () => {
  clean();
  C.handleCloserTurn({ number: NUMBER, text: 'mehnga hai', lang: 'en' });
  C.handleCloserTurn({ number: NUMBER, text: 'mehnga hai', lang: 'en' });
  // A different kind of objection is a different conversation.
  const trust = C.handleCloserTurn({ number: NUMBER, text: 'is this a scam?', lang: 'en' });
  assert.equal(trust.escalate, undefined);
  assert.equal(trust.handled, true);
});

// ── money ──────────────────────────────────────────────────
test('payment instructions come from the profile, and only from it', () => {
  writeProfile({ payment: { bank: { name: 'Example Bank', title: 'Burger Point', number: '0123456789' }, jazzcash: { number: '03001234567' }, cod: true } });
  P.reloadProfile();

  const text = C.paymentInstructions({ amount: 1300, lang: 'en' });
  assert.match(text, /Example Bank/);
  assert.match(text, /0123456789/);
  assert.match(text, /JazzCash/);
  assert.match(text, /Cash on delivery/);
  assert.match(text, /1,300|1300/);

  writeProfile();
  P.reloadProfile();
  assert.equal(C.paymentInstructions({ lang: 'en' }), null, 'nothing configured, nothing invented');
});

test('"I will take it" produces a quote, payment details and an awaiting-payment order', () => {
  clean();
  writeProfile({ payment: { bank: { name: 'Example Bank', title: 'Burger Point', number: '0123456789' } } });
  P.reloadProfile();
  db.upsertContact(NUMBER, { name: 'Ali' });
  db.saveLead({ number: NUMBER, status: 'negotiating', project_type: 'Zinger Burger', quote_min: 650, quote_max: 650, quote_currency: 'PKR' });

  assert.equal(C.readyToBuy('theek hai order kar do'), true);
  const result = C.startOrder({ number: NUMBER, text: 'order karna hai', lang: 'roman-ur' });

  assert.equal(result.ok, true);
  assert.match(result.reply, /650/);
  assert.match(result.reply, /Example Bank/);
  assert.doesNotMatch(result.reply, /paid/i, 'it is awaiting payment, not paid');

  const order = db.orderFor(`${NUMBER}@s.whatsapp.net`);
  assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.total, 650);
  assert.equal(db.get('SELECT status FROM orders WHERE id = ?', [order.id]).status, 'awaiting_payment');
});

test('a second "yes" does not create a second order', () => {
  const again = C.startOrder({ number: NUMBER, text: 'haan order kar do', lang: 'roman-ur' });
  assert.equal(again.duplicate, true);
  assert.equal(db.all('SELECT * FROM orders').length, 1);
});

test('a receipt is read, forwarded to the owner, and never marked paid', async () => {
  const t = fakeTransport();
  const before = db.orderFor(`${NUMBER}@s.whatsapp.net`);

  const result = await C.handleReceipt({
    number: NUMBER,
    transport: t,
    buffer: Buffer.from('fake-image'),
    reader: async () => ({ description: 'Transfer of PKR 650 to Example Bank 0123456789 on 7 Jun, ref 88213.' }),
  });

  assert.equal(result.handled, true);
  assert.match(result.described, /650/);
  assert.equal(t.toOwner().length, 1, 'the owner is asked to check');
  assert.match(t.toOwner()[0], /Payment proof/);
  assert.match(t.toOwner()[0], /awaiting payment/i);
  assert.match(t.toOwner()[0], /\.paid/);

  const after = db.orderFor(`${NUMBER}@s.whatsapp.net`);
  assert.equal(after.status, before.status, 'still awaiting payment');
  assert.equal(db.all("SELECT * FROM orders WHERE status = 'paid'").length, 0);
});

test('an unreadable receipt still reaches the owner, honestly', async () => {
  const t = fakeTransport();
  await C.handleReceipt({ number: NUMBER, transport: t, buffer: Buffer.from('x'), reader: async () => null });
  assert.match(t.toOwner().slice(-1)[0], /Could not read/i);
});

test('only the owner can mark an order paid', async () => {
  const order = db.orderFor(`${NUMBER}@s.whatsapp.net`);
  const { markOrderPaid } = await import('../src/services/jobFlow.js');
  const res = markOrderPaid(order.id);
  assert.match(res.reply, /marked paid/);
  assert.equal(db.getOrder(order.id).status, 'paid');
});

// ── the flag ───────────────────────────────────────────────
test('with closerAgent off, nothing happens', () => {
  writeProfile({ features: { closerAgent: false } });
  P.reloadProfile();
  assert.equal(C.closerAgentEnabled(), false);
  assert.deepEqual(C.handleCloserTurn({ number: NUMBER, text: 'mehnga hai', lang: 'en' }), { handled: false });

  writeProfile();
  P.reloadProfile();
  assert.equal(C.closerAgentEnabled(), true);
});

// ── through the real handler ───────────────────────────────
test('an objection is answered in chat without spending a token', async () => {
  const { mockTransport } = await import('../src/dev/mockLlm.js');
  mockTransport();
  const { handleIncoming } = await import('../src/handlers/messageHandler.js');

  db.upsertContact(CLIENT.number, { name: 'John', language: 'en' });
  const sock = fakeSock();
  await handleIncoming(sock, incomingMessage('honestly that is too expensive for me'));
  await waitFor(() => textMessages(sock.sent, CLIENT.number).length > 0);
  await settle(30);

  const reply = textMessages(sock.sent, CLIENT.number)[0];
  assert.match(reply, /price matters/i, 'the deterministic closer answered, not the model');
  assert.match(reply, /650/);
  assert.equal(db.all('SELECT * FROM objection_attempts').length, 1, 'and it was counted');
});

test('"order kar do" in the chat creates an awaiting-payment order', async () => {
  const { mockTransport } = await import('../src/dev/mockLlm.js');
  mockTransport();
  const { handleIncoming } = await import('../src/handlers/messageHandler.js');
  writeProfile({ payment: { bank: { name: 'Example Bank', title: 'Burger Point', number: '0123456789' } } });
  P.reloadProfile();
  db.upsertContact(CLIENT.number, { name: 'John', language: 'roman-ur' });

  const sock = fakeSock();
  await handleIncoming(sock, incomingMessage('theek hai order kar do'));
  await waitFor(() => textMessages(sock.sent, CLIENT.number).length > 0);
  await settle(30);

  const order = db.orderFor(CLIENT.jid);
  assert.ok(order, 'an order exists');
  assert.equal(order.status, 'awaiting_payment');
  assert.match(textMessages(sock.sent, CLIENT.number).join(' '), /Example Bank/);

  writeProfile();
  P.reloadProfile();
});
