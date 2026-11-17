// Phase 3 Part 2 — reviews and referrals.
//
// The one behaviour that matters most: a person who says the visit was bad is
// never handed a review link. They are heard, and the owner is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, fakeSock, textMessages, incomingMessage, waitFor, settle, CLIENT } from './helpers.js';

const dataDir = isolate('review-agent');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
process.env.GROQ_API_KEY = 'test-groq-key';

function writeProfile({ features = {}, review = null, referral = null, reviewLink = 'https://g.page/burger-point/review' } = {}) {
  const business = {
    name: 'Burger Point',
    timezone: 'Asia/Karachi',
    hours: 'Daily 12:00–23:00',
    reviewLink,
  };
  if (review) business.review = review;
  if (referral) business.referral = referral;
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify(
      {
        business,
        catalog: { items: [{ name: 'Zinger Burger', kind: 'product', price: 650 }] },
        features: { businessProfile: true, catalog: true, reviewAgent: true, ...features },
        currency: { base: 'PKR' },
      },
      null,
      2
    )
  );
}
writeProfile();

const db = await import('../src/utils/db.js');
await db.initDB();
const P = await import('../src/services/profile.js');
P.reloadProfile();
const R = await import('../src/services/reviewAgent.js');
const J = await import('../src/services/jobFlow.js');
const { config } = await import('../src/config/env.js');

const NOON_PKT = new Date('2030-06-10T07:00:00Z');
const NUMBER = '923005556677';
const JID = `${NUMBER}@s.whatsapp.net`;

function fakeTransport() {
  const sock = fakeSock();
  return {
    kind: 'baileys',
    sock,
    toClient: (n = NUMBER) => textMessages(sock.sent, n),
    toOwner: () => textMessages(sock.sent, config.owner.number),
    async sendMessage(jid, payload) {
      return sock.sendMessage(jid, payload);
    },
    windowOpen: () => true,
    can: () => true,
  };
}

function clean() {
  for (const t of ['review_asks', 'contacts', 'leads', 'events', 'bookings', 'orders', 'referrals', 'growth_sends', 'growth_optouts']) {
    db.run(`DELETE FROM ${t}`);
  }
}

function aFinishedBooking() {
  db.upsertContact(NUMBER, { name: 'Ali Raza', language: 'en' });
  const { booking } = db.createBooking({ chat: JID, service: 'Table for 4', date: '2030-06-09', time: '20:00' });
  return booking;
}

// ── the schedule ───────────────────────────────────────────
test('.done queues one feedback ask, 24 hours later', () => {
  clean();
  const booking = aFinishedBooking();
  const res = J.finishJob({ id: booking.id, now: NOON_PKT });

  assert.match(res.reply, /marked done/);
  assert.match(res.reply, /24h/);
  assert.equal(db.getBooking(booking.id).status, 'done');

  const ask = db.all('SELECT * FROM review_asks')[0];
  assert.equal(ask.kind, 'booking');
  assert.equal(ask.ref_id, booking.id);
  assert.equal(ask.status, 'scheduled');
  assert.equal(ask.due_at, new Date(NOON_PKT.getTime() + 24 * 3600_000).toISOString());
});

test('marking the same job done twice does not queue two asks', () => {
  const booking = db.all("SELECT * FROM bookings WHERE status = 'done'")[0];
  J.finishJob({ id: booking.id, now: NOON_PKT });
  assert.equal(db.all('SELECT * FROM review_asks').length, 1);
});

test('nothing is sent before the delay has passed', async () => {
  const t = fakeTransport();
  const early = await R.runReviewAgent({ transport: t, now: new Date(NOON_PKT.getTime() + 23 * 3600_000) });
  assert.equal(early.asked, 0);
  assert.equal(t.toClient().length, 0);
});

test('at the right moment the ask goes out, once, in their language', async () => {
  const t = fakeTransport();
  const due = new Date(NOON_PKT.getTime() + 24 * 3600_000 + 60_000);
  const first = await R.runReviewAgent({ transport: t, now: due });
  assert.equal(first.asked, 1);
  assert.equal(t.toClient().length, 1);
  assert.match(t.toClient()[0], /1 to 5/);

  const second = await R.runReviewAgent({ transport: t, now: new Date(due.getTime() + 3600_000) });
  assert.equal(second.asked, 0);
  assert.equal(t.toClient().length, 1, 'asked once per job');

  const ask = db.all('SELECT * FROM review_asks')[0];
  assert.equal(ask.status, 'asked');

  // Roman Urdu customers get Roman Urdu.
  assert.match(R.buildAsk({ contact: { name: 'Ali', language: 'roman-ur' }, kind: 'booking' }), /1 se 5/);
  assert.match(R.buildAsk({ contact: { name: 'Ali', language: 'ur' }, kind: 'order' }), /[\u0600-\u06FF]/);
});

test('quiet hours hold the ask for the morning instead of cancelling it', async () => {
  clean();
  const booking = aFinishedBooking();
  J.finishJob({ id: booking.id, now: NOON_PKT });
  // 22:00 in Karachi, the day after the job — the ask is due, the hour is not.
  const night = new Date('2030-06-11T17:00:00Z');
  const t = fakeTransport();
  const result = await R.runReviewAgent({ transport: t, now: night });

  assert.equal(result.asked, 0);
  assert.equal(result.details[0].reason, 'quiet_hours');
  assert.equal(result.details[0].retry, true);
  assert.equal(db.all('SELECT * FROM review_asks')[0].status, 'scheduled', 'still waiting');

  const morning = await R.runReviewAgent({ transport: t, now: new Date('2030-06-12T04:30:00Z') });
  assert.equal(morning.asked, 1);
});

test('someone who opted out is never asked', async () => {
  clean();
  const booking = aFinishedBooking();
  db.optOut(NUMBER, { reason: 'stop' });
  J.finishJob({ id: booking.id, now: NOON_PKT });

  const t = fakeTransport();
  const result = await R.runReviewAgent({ transport: t, now: new Date(NOON_PKT.getTime() + 25 * 3600_000) });
  assert.equal(result.asked, 0);
  assert.equal(result.details[0].reason, 'opted_out');
  assert.equal(db.all('SELECT * FROM review_asks')[0].status, 'skipped');
  assert.equal(t.toClient().length, 0);
});

// ── the answers ────────────────────────────────────────────
test('ratings are read in digits, stars, words and Urdu numerals', () => {
  assert.equal(R.parseRating('5'), 5);
  assert.equal(R.parseRating('4/5'), 4);
  assert.equal(R.parseRating('3 stars'), 3);
  assert.equal(R.parseRating('five'), 5);
  assert.equal(R.parseRating('۵'), 5);
  assert.equal(R.parseRating('thanks!'), null);
  assert.equal(R.parseRating('can I order 2 burgers'), null);
});

test('5 out of 5 gets the review link and one referral invitation', async () => {
  clean();
  const booking = aFinishedBooking();
  J.finishJob({ id: booking.id, now: NOON_PKT });
  const t = fakeTransport();
  await R.runReviewAgent({ transport: t, now: new Date(NOON_PKT.getTime() + 25 * 3600_000) });

  const result = await R.handleRating({ number: NUMBER, text: '5', transport: t, now: NOON_PKT });
  assert.equal(result.handled, true);
  assert.equal(result.rating, 5);
  assert.equal(result.reviewLinkSent, true);
  assert.match(result.reply, /g\.page\/burger-point\/review/);
  assert.match(result.reply, new RegExp(result.referralCode));

  assert.equal(db.all("SELECT * FROM review_asks WHERE status = 'rated' AND rating = 5").length, 1);

  // The invitation is sent once, ever — not once per good rating.
  const second = await R.handleRating({ number: NUMBER, text: '5', transport: t, now: NOON_PKT });
  assert.equal(second.handled, false, 'the ask is spent');
});

test('1 to 3 gets no link at all, and the owner hears why', async () => {
  clean();
  const booking = aFinishedBooking();
  J.finishJob({ id: booking.id, now: NOON_PKT });
  const t = fakeTransport();
  await R.runReviewAgent({ transport: t, now: new Date(NOON_PKT.getTime() + 25 * 3600_000) });

  const result = await R.handleRating({ number: NUMBER, text: '2 — the burger was cold', transport: t, now: NOON_PKT });
  assert.equal(result.handled, true);
  assert.equal(result.rating, 2);
  assert.equal(result.reviewLinkSent, false);
  assert.doesNotMatch(result.reply, /g\.page/);
  assert.match(result.reply, /sorry/i);

  assert.equal(t.toOwner().length, 1);
  assert.match(t.toOwner()[0], /Low rating: 2\/5/);
  assert.match(t.toOwner()[0], /cold/);
  assert.equal(db.all("SELECT * FROM review_asks WHERE status = 'rated'").length, 1);
});

test('a "5" before we have asked is not a rating either', async () => {
  clean();
  const booking = aFinishedBooking();
  J.finishJob({ id: booking.id, now: NOON_PKT });
  const result = await R.handleRating({ number: NUMBER, text: '5', transport: fakeTransport(), now: NOON_PKT });
  assert.equal(result.handled, false, 'the ask has not gone out yet');
  assert.equal(db.all("SELECT * FROM review_asks WHERE status = 'rated'").length, 0);
});

test('a stray "5" outside a review conversation is not a rating', async () => {
  clean();
  db.upsertContact(NUMBER, { name: 'Ali' });
  const result = await R.handleRating({ number: NUMBER, text: '5', transport: fakeTransport(), now: NOON_PKT });
  assert.equal(result.handled, false);
});

// ── referrals ──────────────────────────────────────────────
test('a customer gets one stable code, and it is readable', () => {
  clean();
  db.upsertContact(NUMBER, { name: 'Ali' });
  const code = R.referralCode(NUMBER);
  assert.match(code, /^[A-Z]{2}[A-Z0-9]{4}$/);
  assert.equal(R.referralCode(NUMBER), code, 'same customer, same code');

  const other = R.referralCode('923001112233');
  assert.notEqual(other, code);
  assert.equal(db.recentReferrals().length, 2);
});

test('a newcomer quoting the code is attributed and the owner is told', () => {
  const code = R.referralCode(NUMBER);
  const NEWCOMER = '923009998877';
  db.upsertContact(NEWCOMER, { name: 'Sara' });
  const t = fakeTransport();

  const res = R.attributeReferral({ number: NEWCOMER, text: `Ali ne bheja hai, code ${code}`, transport: t, context: 'Ali ne bheja' });
  assert.equal(res.code, code);
  assert.equal(res.referrer, NUMBER);
  assert.equal(db.getReferral(code).uses, 1);
  assert.equal(db.getContact(NEWCOMER).category, 'referral');
  assert.equal(db.all("SELECT * FROM events WHERE type = 'referral_attributed'").length, 1);

  assert.equal(t.toOwner().length >= 1, true);
  const alert = t.toOwner().find((m) => /Referral/.test(m));
  assert.match(alert, new RegExp(code));
  assert.match(alert, /tracking only|Reward/);
});

test('a reward is mentioned only when the business configured one', () => {
  writeProfile({ referral: { reward: '10% off your next order' } });
  P.reloadProfile();
  const invite = R.buildReferralInvite({ contact: { name: 'Ali' }, lang: 'en', code: 'BP1234', reward: '10% off your next order' });
  assert.match(invite, /10% off your next order/);

  writeProfile();
  P.reloadProfile();
  const plain = R.buildReferralInvite({ contact: { name: 'Ali' }, lang: 'en', code: 'BP1234', reward: null });
  assert.doesNotMatch(plain, /%|reward/i);
});

test('your own code is not a referral', () => {
  const code = R.referralCode(NUMBER);
  assert.equal(R.findReferralCode(`mera code ${code}`, NUMBER), null);
});

test('an order delivered also triggers the review flow', async () => {
  clean();
  db.upsertContact(NUMBER, { name: 'Ali' });
  const { order } = db.createOrder({ chat: JID, items: [{ name: 'Zinger Burger', qty: 2 }], total: 1300, currency: 'PKR' });
  const res = J.finishJob({ id: order.id, kind: 'order', now: NOON_PKT });
  assert.match(res.reply, /delivered/);
  assert.equal(db.getOrder(order.id).status, 'delivered');
  assert.equal(db.all("SELECT * FROM review_asks WHERE kind = 'order'").length, 1);
});

// ── the flag ───────────────────────────────────────────────
test('with reviewAgent off, no ask is queued and no rating is handled', async () => {
  writeProfile({ features: { reviewAgent: false } });
  P.reloadProfile();
  assert.equal(R.reviewAgentEnabled(), false);
  clean();
  const booking = aFinishedBooking();
  const res = J.finishJob({ id: booking.id, now: NOON_PKT });
  assert.doesNotMatch(res.reply, /Feedback will be asked/);
  assert.equal(db.all('SELECT * FROM review_asks').length, 0);

  const rating = await R.handleRating({ number: NUMBER, text: '5', transport: fakeTransport(), now: NOON_PKT });
  assert.equal(rating.handled, false);

  writeProfile();
  P.reloadProfile();
  assert.equal(R.reviewAgentEnabled(), true);
});

// ── through the real handler ───────────────────────────────
test('a customer typing "4" in the chat is rated, end to end', async () => {
  clean();
  const { mockTransport } = await import('../src/dev/mockLlm.js');
  mockTransport();
  const { handleIncoming } = await import('../src/handlers/messageHandler.js');

  db.upsertContact(CLIENT.number, { name: 'John', language: 'en' });
  const { booking } = db.createBooking({ chat: CLIENT.jid, service: 'Table for 4', date: '2030-06-09', time: '20:00' });
  J.finishJob({ id: booking.id, now: NOON_PKT });
  db.setReviewAsk(db.all('SELECT * FROM review_asks')[0].id, { status: 'asked' });

  const sock = fakeSock();
  await handleIncoming(sock, incomingMessage('4 stars, really nice service'));
  await waitFor(() => textMessages(sock.sent, CLIENT.number).length > 0);
  await settle(30);

  const reply = textMessages(sock.sent, CLIENT.number)[0];
  assert.match(reply, /g\.page\/burger-point\/review/, 'a good rating gets the link');
  assert.equal(db.all("SELECT * FROM review_asks WHERE rating = 4").length, 1);
});

test('a bad rating arrives at the owner, and never as a review link', async () => {
  clean();
  const { mockTransport } = await import('../src/dev/mockLlm.js');
  mockTransport();
  const { handleIncoming } = await import('../src/handlers/messageHandler.js');

  db.upsertContact(CLIENT.number, { name: 'John', language: 'en' });
  const { booking } = db.createBooking({ chat: CLIENT.jid, service: 'Table for 4', date: '2030-06-09', time: '20:00' });
  J.finishJob({ id: booking.id, now: NOON_PKT });
  db.setReviewAsk(db.all('SELECT * FROM review_asks')[0].id, { status: 'asked' });

  const sock = fakeSock();
  await handleIncoming(sock, incomingMessage('1, it never arrived on time'));
  await waitFor(() => textMessages(sock.sent, config.owner.number).length > 0);
  await settle(30);

  const toClient = textMessages(sock.sent, CLIENT.number);
  assert.ok(toClient.length >= 1);
  assert.doesNotMatch(toClient.join(' '), /g\.page/);
  assert.match(textMessages(sock.sent, config.owner.number).join(' '), /Low rating: 1\/5/);
});

test('a first message carrying a referral code is attributed by the handler', async () => {
  clean();
  const { mockTransport } = await import('../src/dev/mockLlm.js');
  mockTransport();
  const { handleIncoming } = await import('../src/handlers/messageHandler.js');

  db.upsertContact('923001234567', { name: 'Ali' });
  const code = R.referralCode('923001234567');

  const stranger = '923009990011';
  const sock = fakeSock();
  await handleIncoming(
    sock,
    incomingMessage(`Ali ne bheja hai, code ${code}`, { key: { remoteJid: `${stranger}@s.whatsapp.net` } })
  );
  await waitFor(() => textMessages(sock.sent, config.owner.number).length > 0);
  await settle(30);

  assert.equal(db.getReferral(code).uses, 1);
  assert.match(textMessages(sock.sent, config.owner.number).join(' '), new RegExp(code));
});
