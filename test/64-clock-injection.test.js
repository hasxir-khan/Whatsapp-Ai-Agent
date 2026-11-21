// test/64-clock-injection.test.js
// C0 of the fix pass: one clock, handed in, never read from the wall.
//
// The golden eval pins "now" to 2026-11-17 so a conversation about "tomorrow"
// means the same date forever. The booking agent was reading `new Date()`
// instead, so three days later every booking scenario in the suite was asking
// for a slot in the past. These tests pin the fix: the pipeline uses the clock
// it is given, and the default clock is still the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-clock-'));
process.env.DATA_DIR = dir;
process.env.TMP_DIR = path.join(dir, 'tmp');
process.env.SESSION_FOLDER = path.join(dir, 'sessions');
process.env.CONFIG_DIR = path.join(dir, 'config');
process.env.MY_NUMBER = '923001234567';
process.env.ENABLE_WEB = 'false';
process.env.VOICE_REPLY_MODE = 'off';
process.env.DEBOUNCE_MS = '5';
process.env.NOTIFY_NEW_CHATS = 'false';
process.env.QUIET_HOURS = '';
process.env.REPLY_TIMING = 'off';

const db = await import('../src/utils/db.js');
await db.initDB();
const { handleIncoming, drainBatches, makeClock } = await import('../src/handlers/messageHandler.js');
const { setPath } = await import('../src/services/profile.js');
const { config } = await import('../src/config/env.js');

const FIXED = new Date('2026-11-17T08:00:00.000Z'); // 13:00 Karachi
const NUMBER = '923001112223';

/** A transport that records what was said, and nothing else. */
function fakeTransport() {
  const sent = [];
  return {
    sent,
    kind: 'fake',
    slug: 'fake',
    can: () => true,
    capabilities: {},
    async send(jid, payload) {
      sent.push({ jid, payload });
      return { key: { id: `wamid-${sent.length}` } };
    },
    async sendMessage(jid, payload) {
      return this.send(jid, payload);
    },
    async markRead() {},
    async setPresence() {},
  };
}

function incoming(text, { fromMe = false, number = NUMBER, id = null } = {}) {
  return {
    id: id || `msg-${Math.random().toString(36).slice(2)}`,
    chat: `${number}@s.whatsapp.net`,
    number,
    fromMe,
    kind: 'text',
    text,
    pushName: 'Test',
    timestamp: FIXED.toISOString(),
  };
}

function said(transport) {
  return transport.sent.map((s) => s.payload.text || `[${Object.keys(s.payload)[0]}]`).join('\n');
}

// ── the clock itself ────────────────────────────────────────
test('the default clock is the real clock', () => {
  const clock = makeClock(null);
  const before = Date.now();
  const now = clock().getTime();
  const after = Date.now();
  assert.ok(now >= before && now <= after, 'null means "read the wall clock"');
});

test('a fixed clock returns the same instant every time', () => {
  const clock = makeClock(FIXED);
  assert.equal(clock().toISOString(), FIXED.toISOString());
  assert.equal(clock().toISOString(), clock().toISOString());
  // And it is a copy: a caller mutating the returned Date cannot move the clock.
  const first = clock();
  first.setFullYear(1999);
  assert.equal(clock().getUTCFullYear(), 2026);
});

test('milliseconds and ISO strings are accepted too', () => {
  assert.equal(makeClock(FIXED.getTime())().toISOString(), FIXED.toISOString());
  assert.equal(makeClock(FIXED.toISOString())().toISOString(), FIXED.toISOString());
});

// ── the pipeline uses the clock it is handed ────────────────
test('an owner handoff pauses the chat relative to the injected clock', async () => {
  const transport = fakeTransport();
  const number = '923004445556';
  const minutes = config.behavior.handoffMinutes;
  await handleIncoming(transport, incoming('I will take this one', { fromMe: true, number }), { now: FIXED });
  await drainBatches({ timeoutMs: 2000 });
  const contact = db.getContact(number);
  const until = new Date(contact.bot_paused_until).getTime();
  assert.equal(until, FIXED.getTime() + minutes * 60000);
});

test('a booking request books against the injected clock, not today\'s date', async () => {
  setPath('features.bookingAgent', true);
  setPath('business.bookingService', 'Consultation');
  const transport = fakeTransport();
  const number = '923007778889';

  await handleIncoming(transport, incoming('book me tomorrow at 10am please', { number }), { now: FIXED });
  await drainBatches({ timeoutMs: 5000 });

  const row = db.get('SELECT * FROM bookings ORDER BY id DESC LIMIT 1');
  assert.ok(row, `expected a booking; the bot said: ${said(transport)}`);
  assert.equal(row.date, '2026-11-18', 'tomorrow is relative to the injected clock');
  assert.equal(row.time, '10:00');
  // The real clock is three days later in this sandbox; if the booking had read
  // it, the date would be 2026-11-21 and the test above would fail.
  assert.notEqual(row.date, new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
});

test('without a clock the pipeline still runs on the real clock', async () => {
  const transport = fakeTransport();
  // No third argument: exactly how production calls it.
  await assert.doesNotReject(() => handleIncoming(transport, incoming('hello there')));
  await drainBatches({ timeoutMs: 500 });
});
