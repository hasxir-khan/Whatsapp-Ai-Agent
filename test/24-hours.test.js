// Phase 2 Step 3a — opening hours and timezones.
//
// A booking is a promise. These tests make sure the promise matches the hours
// the owner typed, in the owner's timezone, and that a refusal always comes
// with times that are actually possible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate } from './helpers.js';

const dataDir = isolate('hours');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
process.env.GROQ_API_KEY = 'test-groq-key';

const H = await import('../src/services/hours.js');
const db = await import('../src/utils/db.js');
await db.initDB();
const P = await import('../src/services/profile.js');
const T = await import('../src/core/tools.js');

const PK = 'Asia/Karachi';

function setBusiness(hours, timezone = PK) {
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify(
      {
        business: { name: 'Burger Point', type: 'Restaurant', hours, timezone },
        catalog: { items: [{ name: 'Table for 4', kind: 'service', price: 0 }] },
        features: { toolCalling: true },
        owner: { timezone },
      },
      null,
      2
    )
  );
  P.reloadProfile();
}

// Reference days in 2030, so "in the past" never interferes.
// 2030-06-03 is a Monday, 2030-06-07 a Friday, 2030-06-09 a Sunday.
const MONDAY = '2030-06-03';
const FRIDAY = '2030-06-07';
const SUNDAY = '2030-06-09';

// ── parsing ────────────────────────────────────────────────
test('parses the hour formats owners actually type', () => {
  const daily = H.parseHours('Daily 12:00–23:00');
  assert.equal(daily.byDay[1][0].start, 12 * 60);
  assert.equal(daily.byDay[0].length, 1, 'Daily covers Sunday too');

  const weekdays = H.parseHours('Mon–Sat 10:00–20:00, Sunday closed');
  assert.equal(weekdays.byDay[0].length, 0, 'Sunday closed');
  assert.equal(weekdays.byDay[6][0].end, 20 * 60, 'Saturday open');

  const split = H.parseHours('Mon-Sat 10:00-14:00, 17:00-23:00; Sun closed');
  assert.equal(split.byDay[2].length, 2, 'lunch break modelled as two ranges');

  const object = H.parseHours({ mon: '10:00-20:00', sun: 'closed' });
  assert.equal(object.byDay[1][0].start, 10 * 60);
  assert.equal(object.byDay[0].length, 0);

  assert.equal(H.parseHours('24/7').byDay[3][0].end, 1440);
});

test('12-hour times are understood', () => {
  const parsed = H.parseHours('Mon-Sat 9:00 am - 9:00 pm');
  assert.equal(parsed.byDay[1][0].start, 9 * 60);
  assert.equal(parsed.byDay[1][0].end, 21 * 60);
});

test('an unknown hours string is not invented into something usable', () => {
  assert.equal(H.parseHours('ask the owner').known, false);
  assert.equal(H.parseHours('').known, false);
});

// ── timezone conversion ────────────────────────────────────
test('wall-clock times resolve through the business timezone', () => {
  // 22:30 in Karachi (UTC+5) is 17:30 UTC
  assert.equal(H.zonedToUtc(2030, 6, 7, 22, 30, PK).toISOString(), '2030-06-07T17:30:00.000Z');
  // …and it stays the same answer whatever the server clock is set to
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  assert.equal(H.zonedToUtc(2030, 6, 7, 22, 30, PK).toISOString(), '2030-06-07T17:30:00.000Z');
  if (previous === undefined) delete process.env.TZ;
  else process.env.TZ = previous;
});

test('the weekday comes from the business timezone, not the server', () => {
  // Monday 00:30 in Karachi is Sunday 19:30 UTC
  const instant = H.zonedToUtc(2030, 6, 3, 0, 30, PK);
  assert.equal(H.partsInTz(instant, PK).weekday, 1, 'Monday in Karachi');
  assert.equal(H.partsInTz(instant, 'UTC').weekday, 0, 'still Sunday in UTC');
});

// ── the rules the bot now enforces ─────────────────────────
test('3 a.m. is refused, with the next real slots offered', async () => {
  setBusiness('Daily 12:00–23:00');
  const res = await T.executeTool('book_slot', { service: 'Table for 4', date: FRIDAY, time: '03:00' }, { chat: 'c1@s.whatsapp.net' });

  assert.equal(res.status, 'error');
  assert.equal(res.result.problem, 'outside_hours');
  assert.match(res.result.message, /open 12:00–23:00/);
  assert.ok(res.result.suggestions.length >= 1);
  assert.match(res.result.suggestions[0].time, /^12:00$/);
});

test('a closed day is refused and the next open day is suggested', async () => {
  setBusiness('Mon–Sat 10:00–20:00, Sunday closed');
  const res = await T.executeTool('book_slot', { service: 'Table for 4', date: SUNDAY, time: '12:00' }, { chat: 'c2@s.whatsapp.net' });

  assert.equal(res.status, 'error');
  assert.equal(res.result.problem, 'closed_day');
  assert.match(res.result.message, /closed on Sunday/);
  assert.equal(res.result.suggestions[0].date, '2030-06-10', 'the Monday after');
});

test('a time inside opening hours still asks for confirmation', async () => {
  setBusiness('Mon–Sat 10:00–20:00, Sunday closed');
  const res = await T.executeTool('book_slot', { service: 'Table for 4', date: FRIDAY, time: '14:00' }, { chat: 'c3@s.whatsapp.net' });
  assert.equal(res.status, 'needs_confirmation');
  T.cancelPending('c3@s.whatsapp.net');
});

test('the boundary minutes are respected', async () => {
  setBusiness('Mon–Sat 10:00–20:00');
  const atTen = await T.executeTool('book_slot', { service: 'Table for 4', date: FRIDAY, time: '10:00' }, { chat: 'c4@s.whatsapp.net' });
  assert.equal(atTen.status, 'needs_confirmation', '10:00 exactly is open');
  T.cancelPending('c4@s.whatsapp.net');

  const atTenPm = await T.executeTool('book_slot', { service: 'Table for 4', date: FRIDAY, time: '20:00' }, { chat: 'c4@s.whatsapp.net' });
  assert.equal(atTenPm.status, 'error', 'closing time itself is closed');
  assert.equal(atTenPm.result.problem, 'outside_hours');
});

test('an overnight business accepts after midnight', async () => {
  setBusiness('Daily 18:00–02:00');
  const late = await T.executeTool('book_slot', { service: 'Table for 4', date: FRIDAY, time: '23:30' }, { chat: 'c5@s.whatsapp.net' });
  assert.equal(late.status, 'needs_confirmation');
  T.cancelPending('c5@s.whatsapp.net');

  const after = await T.executeTool('book_slot', { service: 'Table for 4', date: FRIDAY, time: '01:00' }, { chat: 'c5@s.whatsapp.net' });
  assert.equal(after.status, 'needs_confirmation', '01:00 counts as the night before');
  T.cancelPending('c5@s.whatsapp.net');

  const midday = await T.executeTool('book_slot', { service: 'Table for 4', date: FRIDAY, time: '12:00' }, { chat: 'c5@s.whatsapp.net' });
  assert.equal(midday.status, 'error');
});

test('the business timezone decides, not the server clock', async () => {
  setBusiness('Daily 10:00–13:00', PK);
  const { timeZone } = T.businessHours();
  assert.equal(timeZone, PK, 'timezone comes from owner.json');

  const verdict = T.validateSlot({ date: FRIDAY, time: '12:00' });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.timeZone, PK);
  // 12:00 in Karachi is 07:00 UTC — a server-clock comparison would agree it is
  // "outside 10:00–13:00", so this passing proves the timezone is applied.
  assert.equal(verdict.when.toISOString(), '2030-06-07T07:00:00.000Z');
});

test('a different business timezone changes the verdict for the same instant', () => {
  setBusiness('Daily 10:00–13:00', 'Pacific/Kiritimati'); // UTC+14
  const kiritimati = T.validateSlot({ date: FRIDAY, time: '12:00' });
  assert.equal(kiritimati.ok, true);

  setBusiness('Daily 10:00–13:00', 'America/New_York'); // UTC-4 in June
  const ny = T.validateSlot({ date: FRIDAY, time: '12:00' });
  assert.equal(ny.ok, true);
  assert.notEqual(ny.when.toISOString(), kiritimati.when.toISOString(), 'same wall clock, different instant');
});

test('missing hours never block a booking', async () => {
  setBusiness('');
  const res = await T.executeTool('book_slot', { service: 'Table for 4', date: FRIDAY, time: '03:00' }, { chat: 'c6@s.whatsapp.net' });
  assert.equal(res.status, 'needs_confirmation', 'with no hours configured we stay permissive');
  T.cancelPending('c6@s.whatsapp.net');
});

test('next slots skip closed days and honour the opening time', () => {
  const parsed = H.parseHours('Mon–Fri 09:00–17:00, Sat–Sun closed');
  const from = H.zonedToUtc(2030, 6, 7, 18, 0, PK); // Friday evening, after close
  const slots = H.nextSlots({ hours: parsed, timeZone: PK, from, count: 2 });
  assert.equal(slots[0].date, '2030-06-10', 'jumps the weekend to Monday');
  assert.equal(slots[0].time, '09:00');
});

test('the closed-business explanation is a sentence, not a code', () => {
  const parsed = H.parseHours('Mon–Sat 10:00–20:00, Sunday closed');
  const verdict = H.isOpen(H.zonedToUtc(2030, 6, 9, 12, 0, PK), { hours: parsed, timeZone: PK });
  const text = H.explainClosed(verdict, H.nextSlots({ hours: parsed, timeZone: PK, from: new Date('2030-06-09T00:00:00Z'), count: 1 }));
  assert.match(text, /closed on Sunday/);
  assert.match(text, /Next available/);
});
