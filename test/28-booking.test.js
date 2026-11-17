// Phase 3 Part 1 — the booking agent.
//
// The promise being tested: a slot offered is a slot that exists, a slot taken
// cannot be taken twice, a reminder arrives at the right hour (and not at
// night), a no-show gets exactly one offer, and cancelling frees the slot the
// instant the customer says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, fakeSock, textMessages } from './helpers.js';

const dataDir = isolate('booking-agent');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
process.env.GROQ_API_KEY = 'test-groq-key';

function writeProfile(extra = {}) {
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify(
      {
        business: {
          name: 'Burger Point',
          type: 'Restaurant',
          hours: 'Mon–Sat 10:00–21:00, Sunday closed',
          timezone: 'Asia/Karachi',
          bookingService: 'Table for 4',
          ...(extra.business || {}),
        },
        catalog: { items: [{ name: 'Table for 4', kind: 'service', price: 0 }] },
        features: { businessProfile: true, catalog: true, bookingAgent: true, ...(extra.features || {}) },
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
const B = await import('../src/services/bookingAgent.js');
const { config } = await import('../src/config/env.js');

// 2030-06-03 is a Monday. 09:00 PKT = 04:00Z.
const MONDAY_9AM = new Date('2030-06-03T04:00:00Z');
const NUMBER = '923005556677';
const JID = `${NUMBER}@s.whatsapp.net`;

function fakeTransport() {
  const sock = fakeSock();
  return {
    kind: 'baileys',
    sock,
    sent: (n = NUMBER) => textMessages(sock.sent, n),
    async sendMessage(jid, payload) {
      return sock.sendMessage(jid, payload);
    },
    windowOpen: () => true,
    can: () => true,
  };
}

function clean() {
  db.run('DELETE FROM bookings');
  db.run('DELETE FROM booking_reminders');
  db.run('DELETE FROM growth_sends');
  db.run('DELETE FROM cloud_messages');
  B.clearOffers();
}

// ── slots ──────────────────────────────────────────────────
test('offered slots are real: inside opening hours, in the future', () => {
  clean();
  const slots = B.bookableSlots({ from: MONDAY_9AM, count: 3 });
  assert.equal(slots.length, 3);
  assert.equal(slots[0].date, '2030-06-03');
  assert.equal(slots[0].time, '10:00', 'the shop opens at 10:00');
  for (const s of slots) assert.match(s.label, /Mon 3\/6/);
});

test('a booked slot is never offered again', () => {
  clean();
  const [first] = B.bookableSlots({ from: MONDAY_9AM, count: 1 });
  db.createBooking({ chat: JID, service: 'Table for 4', date: first.date, time: first.time });

  const slots = B.bookableSlots({ from: MONDAY_9AM, count: 3 });
  assert.ok(!slots.some((s) => s.date === first.date && s.time === first.time), 'the taken slot is gone');
});

test('Sunday is closed, so Sunday is never offered', () => {
  clean();
  const slots = B.bookableSlots({ from: new Date('2030-06-09T04:00:00Z'), count: 3 }); // Sunday 09:00 PKT
  assert.ok(!slots.some((s) => s.date === '2030-06-09'), 'no Sunday slots');
  assert.equal(slots[0].date, '2030-06-10', 'next open day is Monday');
});

// ── double booking ─────────────────────────────────────────
test('two customers cannot get the same slot', async () => {
  clean();
  const a = await B.book({ number: NUMBER, chat: JID, service: 'Table for 4', date: '2030-06-03', time: '19:00', now: MONDAY_9AM });
  assert.equal(a.ok, true);

  const b = await B.book({
    number: '923007778888',
    chat: '923007778888@s.whatsapp.net',
    service: 'Table for 4',
    date: '2030-06-03',
    time: '19:00',
    now: MONDAY_9AM,
  });
  assert.equal(b.ok, false);
  assert.equal(b.problem, 'slot_taken');
  assert.ok(b.slots.length >= 1, 'and they are offered something that does exist');

  const rows = db.all("SELECT * FROM bookings WHERE date = '2030-06-03' AND time = '19:00' AND status = 'booked'");
  assert.equal(rows.length, 1, 'the database still holds exactly one');
});

test('a slot in the past is refused', async () => {
  clean();
  const res = await B.book({ number: NUMBER, chat: JID, service: 'Table for 4', date: '2030-06-03', time: '08:00', now: MONDAY_9AM });
  assert.equal(res.ok, false);
  assert.equal(res.problem, 'in_the_past');
});

// ── the conversation ───────────────────────────────────────
test('"I want to book" gets three real times, and "1" books the first', async () => {
  clean();
  const offer = await B.handleBookingTurn({ number: NUMBER, text: 'I want to book a table for 4', now: MONDAY_9AM });
  assert.equal(offer.handled, true);
  assert.match(offer.reply, /1\. Mon 3\/6, 10:00/);
  assert.match(offer.reply, /2\./);
  assert.match(offer.reply, /3\./);

  const chosen = await B.handleBookingTurn({ number: NUMBER, text: '1', lang: 'en', now: MONDAY_9AM });
  assert.equal(chosen.handled, true);
  assert.equal(chosen.booking.date, '2030-06-03');
  assert.equal(chosen.booking.time, '10:00');
  assert.match(chosen.reply, /Booking #\d+/);

  const rows = db.all("SELECT * FROM bookings WHERE chat = ?", [JID]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'booked');
});

test('a booking with a time in it is booked straight away', async () => {
  clean();
  const res = await B.handleBookingTurn({ number: NUMBER, text: 'book a table tomorrow at 8pm', now: MONDAY_9AM });
  assert.equal(res.handled, true);
  assert.equal(res.booking.date, '2030-06-04');
  assert.equal(res.booking.time, '20:00');
});

test('Roman Urdu and Urdu booking requests work too', async () => {
  clean();
  const roman = await B.handleBookingTurn({ number: NUMBER, text: 'kal 8 baje table chahiye', lang: 'roman-ur', now: MONDAY_9AM });
  assert.equal(roman.handled, true);
  assert.equal(roman.booking.date, '2030-06-04');
  assert.equal(roman.booking.time, '20:00');
  assert.match(roman.reply, /Ho gaya/);

  clean();
  const urdu = await B.handleBookingTurn({ number: NUMBER, text: 'کل 7 بجے بکنگ کرنی ہے', lang: 'ur', now: MONDAY_9AM });
  assert.equal(urdu.handled, true);
  assert.equal(urdu.booking.time, '19:00');
  assert.match(urdu.reply, /بکنگ/);
});

test('outside opening hours the agent says so and offers real times instead', async () => {
  clean();
  const res = await B.handleBookingTurn({ number: NUMBER, text: 'book for tomorrow at 3am', now: MONDAY_9AM });
  assert.equal(res.handled, true);
  assert.ok(!res.booking, 'no booking was written');
  assert.match(res.reply, /1\./, 'alternatives were offered');
  assert.equal(db.all('SELECT * FROM bookings').length, 0);
});

// ── reminders ──────────────────────────────────────────────
test('bookings get a 24h and a 2h reminder at the right moments', async () => {
  clean();
  const res = await B.book({ number: NUMBER, chat: JID, service: 'Table for 4', date: '2030-06-04', time: '20:00', now: MONDAY_9AM });
  const reminders = db.remindersFor(res.booking.id);

  assert.equal(reminders.length, 2);
  const byKind = Object.fromEntries(reminders.map((r) => [r.kind, r.due_at]));
  // 20:00 PKT is 15:00Z. 24h before = 2030-06-03T15:00Z, 2h before = 2030-06-04T13:00Z.
  assert.equal(byKind['24h'], '2030-06-03T15:00:00.000Z');
  assert.equal(byKind['2h'], '2030-06-04T13:00:00.000Z');
});

test('a reminder is not sent before it is due', async () => {
  clean();
  await B.book({ number: NUMBER, chat: JID, service: 'Table for 4', date: '2030-06-04', time: '20:00', now: MONDAY_9AM });
  const t = fakeTransport();
  const results = await B.runReminders({ transport: t, now: new Date('2030-06-03T10:00:00Z') });
  assert.equal(results.length, 0);
  assert.equal(t.sent().length, 0);
});

test('the 24h reminder goes out when due, and the 2h one is not swallowed by the lead cap', async () => {
  clean();
  await B.book({ number: NUMBER, chat: JID, service: 'Table for 4', date: '2030-06-04', time: '20:00', now: MONDAY_9AM });
  const t = fakeTransport();

  const first = await B.runReminders({ transport: t, now: new Date('2030-06-03T15:00:00Z') });
  assert.equal(first.length, 1);
  assert.equal(first[0].outcome.sent, true);
  assert.match(t.sent().join(' '), /tomorrow/);

  const second = await B.runReminders({ transport: t, now: new Date('2030-06-04T13:00:00Z') });
  assert.equal(second[0].outcome.sent, true, 'a booking reminder is transactional, not a lead nudge');
  assert.match(t.sent().join(' '), /2 hours/);
});

test('a reminder that falls in the quiet window waits instead of waking someone', async () => {
  clean();
  // 08:00 PKT on Sunday → book Monday 10:00. The 2h reminder lands at 08:00.
  await B.book({ number: NUMBER, chat: JID, service: 'Table for 4', date: '2030-06-10', time: '10:00', now: MONDAY_9AM });
  const t = fakeTransport();

  const atNight = await B.runReminders({ transport: t, now: new Date('2030-06-10T03:00:00Z') }); // 08:00 PKT
  const twoHourNight = atNight.find((r) => r.reminder.kind === '2h');
  assert.ok(twoHourNight, 'the 2h reminder was due');
  assert.equal(twoHourNight.outcome.sent, false);
  assert.equal(twoHourNight.outcome.reason, 'quiet_hours');
  assert.equal(t.sent().length, 0);

  const row = db.remindersFor(twoHourNight.reminder.booking_id).find((r) => r.kind === '2h');
  assert.equal(row.status, 'pending', 'still queued, not lost');

  const morning = await B.runReminders({ transport: t, now: new Date('2030-06-10T04:05:00Z') }); // 09:05 PKT
  const twoHourMorning = morning.find((r) => r.reminder.kind === '2h');
  assert.equal(twoHourMorning.outcome.sent, true);
});

test('a cancelled booking never sends its reminders', async () => {
  clean();
  const res = await B.book({ number: NUMBER, chat: JID, service: 'Table for 4', date: '2030-06-04', time: '20:00', now: MONDAY_9AM });
  db.cancelBooking(res.booking.id);

  const t = fakeTransport();
  const results = await B.runReminders({ transport: t, now: new Date('2030-06-03T15:00:00Z') });
  assert.equal(results.length, 0);
  assert.equal(t.sent().length, 0);
});

// ── no-shows ───────────────────────────────────────────────
test('a no-show gets exactly one polite rebook message', async () => {
  clean();
  await B.book({ number: NUMBER, chat: JID, service: 'Table for 4', date: '2030-06-04', time: '20:00', now: MONDAY_9AM });

  const t = fakeTransport();

  // 22:00 in Karachi — detected, but the night belongs to the customer.
  const night = await B.runNoShows({ transport: t, now: new Date('2030-06-04T17:00:00Z') });
  assert.equal(night[0].outcome.sent, false);
  assert.equal(night[0].outcome.reason, 'quiet_hours');
  assert.equal(t.sent().length, 0);
  assert.equal(db.all("SELECT * FROM bookings WHERE status = 'booked'").length, 1, 'still not marked');

  // 09:30 next morning: the one offer to rebook.
  const first = await B.runNoShows({ transport: t, now: new Date('2030-06-05T04:30:00Z') });
  assert.equal(first.length, 1);
  assert.equal(first[0].outcome.sent, true);
  assert.match(t.sent()[0], /another time/);

  const second = await B.runNoShows({ transport: t, now: new Date('2030-06-05T06:00:00Z') });
  assert.equal(second.length, 0, 'never twice');
  assert.equal(t.sent().length, 1);
  assert.equal(db.all("SELECT * FROM bookings WHERE status = 'no_show'").length, 1);
});

test('a confirmed customer is still asked once if they vanish — and that is all', async () => {
  clean();
  const res = await B.book({ number: NUMBER, chat: JID, service: 'Table for 4', date: '2030-06-04', time: '20:00', now: MONDAY_9AM });
  B.confirmByChat(NUMBER);
  assert.equal(db.getBooking(res.booking.id).status, 'confirmed');

  const t = fakeTransport();
  await B.runNoShows({ transport: t, now: new Date('2030-06-05T04:30:00Z') });
  await B.runNoShows({ transport: t, now: new Date('2030-06-05T06:00:00Z') });
  assert.equal(t.sent().length, 1);
});

// ── cancel / reschedule by chat ────────────────────────────
test('cancelling by chat frees the slot instantly', async () => {
  clean();
  const res = await B.book({ number: NUMBER, chat: JID, service: 'Table for 4', date: '2030-06-03', time: '19:00', now: MONDAY_9AM });

  const turn = await B.handleBookingTurn({ number: NUMBER, text: 'cancel my booking', now: MONDAY_9AM });
  assert.equal(turn.handled, true);
  assert.match(turn.reply, /free again/);
  assert.equal(db.getBooking(res.booking.id).status, 'cancelled');

  // someone else can have it now
  const other = await B.book({
    number: '923007778888',
    chat: '923007778888@s.whatsapp.net',
    service: 'Table for 4',
    date: '2030-06-03',
    time: '19:00',
    now: MONDAY_9AM,
  });
  assert.equal(other.ok, true);
});

test('rescheduling moves the booking and frees the old slot', async () => {
  clean();
  const res = await B.book({ number: NUMBER, chat: JID, service: 'Table for 4', date: '2030-06-03', time: '19:00', now: MONDAY_9AM });

  const turn = await B.handleBookingTurn({ number: NUMBER, text: 'can we reschedule to tomorrow at 8pm', now: MONDAY_9AM });
  assert.equal(turn.handled, true);

  const after = db.getBooking(res.booking.id);
  assert.equal(after.date, '2030-06-04');
  assert.equal(after.time, '20:00');
  assert.equal(db.isSlotTaken('Table for 4', '2030-06-03', '19:00'), false, 'the old slot is free');
  assert.equal(db.remindersFor(res.booking.id).filter((r) => r.status === 'pending').length, 2, 'reminders moved with it');
});

test('a reschedule onto a taken slot is refused, with alternatives', async () => {
  clean();
  await B.book({ number: '923007778888', chat: '923007778888@s.whatsapp.net', service: 'Table for 4', date: '2030-06-04', time: '20:00', now: MONDAY_9AM });
  await B.book({ number: NUMBER, chat: JID, service: 'Table for 4', date: '2030-06-03', time: '19:00', now: MONDAY_9AM });

  const res = B.rescheduleByChat(NUMBER, { date: '2030-06-04', time: '20:00' });
  assert.equal(res.ok, false);
  assert.equal(res.problem, 'slot_taken');
  assert.ok(res.slots.length >= 1);
});

// ── calendar ───────────────────────────────────────────────
test('with no Google credentials, bookings simply stay local', async () => {
  const C = await import('../src/services/calendar.js');
  assert.equal(C.calendarConfigured(), false);
  assert.equal(C.calendarStatus().mode, 'off');

  const pushed = await C.pushBooking({ date: '2030-06-04', time: '20:00', service: 'Table' });
  assert.equal(pushed.synced, false);
  assert.equal(pushed.reason, 'not_configured');

  clean();
  const res = await B.book({ number: NUMBER, chat: JID, service: 'Table for 4', date: '2030-06-04', time: '20:00', now: MONDAY_9AM });
  assert.equal(res.ok, true, 'a missing calendar never blocks a booking');
  assert.equal(res.calendar.synced, false);
});

test('with credentials, the event is pushed — and a Google failure still keeps the booking', async () => {
  const C = await import('../src/services/calendar.js');
  const original = { ...config.calendar };
  config.calendar.id = 'team@example.com';
  config.calendar.clientId = 'client';
  config.calendar.clientSecret = 'secret';
  config.calendar.refreshToken = 'refresh';

  const calls = [];
  C.__setFetch(async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).includes('oauth2')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'evt_123' }) };
  });

  const ok = await C.pushBooking({ chat: JID, date: '2030-06-04', time: '20:00', service: 'Table for 4', name: 'Ali', id: 7 });
  assert.equal(ok.synced, true);
  assert.equal(ok.id, 'evt_123');

  const event = calls.find((c) => String(c.url).includes('/events'));
  const body = JSON.parse(event.options.body);
  assert.equal(body.start.dateTime, '2030-06-04T20:00:00');
  assert.equal(body.start.timeZone, 'Asia/Karachi');
  assert.match(body.summary, /Table for 4/);

  // Google breaks → the booking is still a booking
  C.__setFetch(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
  clean();
  const res = await B.book({ number: NUMBER, chat: JID, service: 'Table for 4', date: '2030-06-04', time: '20:00', now: MONDAY_9AM });
  assert.equal(res.ok, true);
  assert.equal(res.calendar.synced, false);
  assert.ok(db.getBooking(res.booking.id));

  C.__setFetch(null);
  Object.assign(config.calendar, original);
});

// ── owner commands ─────────────────────────────────────────
test('.bookings shows today and tomorrow; .cancel frees the slot', async () => {
  clean();
  const today = await B.book({ number: NUMBER, chat: JID, service: 'Table for 4', date: '2030-06-03', time: '19:00', now: MONDAY_9AM });
  await B.book({ number: '923007778888', chat: '923007778888@s.whatsapp.net', service: 'Table for 4', date: '2030-06-04', time: '20:00', now: MONDAY_9AM });

  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const sock = fakeSock();
  const OWNER = '923001234567@s.whatsapp.net';

  // Fake "today" by asking for the range that contains our bookings.
  const realNow = Date.now;
  global.Date.now = () => MONDAY_9AM.getTime();
  let reply;
  try {
    reply = (await handleOwnerCommand(sock, OWNER, '.bookings')).reply;
  } finally {
    global.Date.now = realNow;
  }

  // The command uses the real clock for "today", so assert on structure and ids.
  assert.match(reply, /Bookings/);
  assert.match(reply, /\.cancel <id>/);

  const cancel = (await handleOwnerCommand(sock, OWNER, `.cancel ${today.booking.id}`)).reply;
  assert.match(cancel, /cancelled/);
  assert.equal(db.getBooking(today.booking.id).status, 'cancelled');
  assert.equal(db.isSlotTaken('Table for 4', '2030-06-03', '19:00'), false);
});

test('the flag decides whether the agent runs at all', () => {
  assert.equal(B.bookingAgentEnabled(), true);
  writeProfile({ features: { bookingAgent: false } });
  P.reloadProfile();
  assert.equal(B.bookingAgentEnabled(), false);

  writeProfile();
  P.reloadProfile();
  assert.equal(B.bookingAgentEnabled(), true);
});
