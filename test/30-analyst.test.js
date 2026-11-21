// Phase 3 Part 2 — the analyst.
//
// The point of this file: the numbers must be right even when the model is
// wrong, absent, or switched off. Every assertion below is about arithmetic on
// a seeded database, not about prose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, fakeSock, textMessages, CLIENT } from './helpers.js';

const dataDir = isolate('analyst-agent');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;

function writeProfile(features = {}) {
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify(
      {
        business: { name: 'Burger Point', hours: 'Daily 12:00–23:00', timezone: 'Asia/Karachi', currency: 'PKR' },
        catalog: { items: [{ name: 'Zinger Burger', kind: 'product', price: 650 }] },
        features: { businessProfile: true, catalog: true, analystAgent: true, ...features },
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
const A = await import('../src/services/analystAgent.js');
const { config } = await import('../src/config/env.js');

// "Now" is Monday 09:00 in Karachi, so the report window is the week before.
const NOW = new Date('2030-06-10T04:00:00Z'); // Mon 10 Jun, 09:00 PKT
const THIS_WEEK = (d, h = 12) => new Date(`2030-06-${String(d).padStart(2, '0')}T${String(h - 5).padStart(2, '0')}:00:00Z`).toISOString();
// The previous week runs from 27 May to 3 June, so it uses May dates.
const LAST_WEEK = (d, h = 12) => new Date(`2030-05-${String(d).padStart(2, '0')}T${String(h - 5).padStart(2, '0')}:00:00Z`).toISOString();

function clean() {
  for (const t of ['messages', 'leads', 'orders', 'bookings', 'message_intents', 'events', 'growth_sends', 'growth_optouts', 'contacts', 'review_asks']) {
    db.run(`DELETE FROM ${t}`);
  }
}

function fakeTransport() {
  const sock = fakeSock();
  return {
    kind: 'baileys',
    sock,
    sent: () => textMessages(sock.sent, config.owner.number),
    async sendMessage(jid, payload) {
      return sock.sendMessage(jid, payload);
    },
    windowOpen: () => true,
    can: () => true,
  };
}

/** A week of ordinary business, seeded with exact timestamps. */
function seedWeek({ conversations = 6, at = THIS_WEEK(3), prefix = '923000000' } = {}) {
  for (let i = 0; i < conversations; i++) {
    const number = `${prefix}${i}`;
    db.upsertContact(number, { name: `Client ${i}`, category: 'new' });
    db.saveMessage(number, 'user', `question ${i}`, 'text');
    db.saveMessage(number, 'assistant', `answer ${i}`, 'text');
    db.run('UPDATE messages SET created_at = ? WHERE number = ? AND role = ?', [at, number, 'user']);
    db.run('UPDATE messages SET created_at = ? WHERE number = ? AND role = ?', [at, number, 'assistant']);
  }
}

/** Events are written with the real clock; tests move them into the fake week. */
function backdateEvents(types, at) {
  for (const type of types) db.run('UPDATE events SET created_at = ? WHERE type = ?', [at, type]);
}

// ── the numbers ────────────────────────────────────────────
test('the week is counted from SQLite, not from a model', () => {
  clean();
  seedWeek({ conversations: 6, at: THIS_WEEK(3), prefix: '923000000' });
  // Two leads, one of them referred.
  db.saveLead({ number: '9230000000', status: 'new', project_type: 'Zinger Burger' });
  db.saveLead({ number: '9230000001', status: 'new', project_type: 'Zinger Burger' });
  db.run('UPDATE leads SET created_at = ?', [THIS_WEEK(3)]);
  db.run("UPDATE contacts SET category = 'lead' WHERE number IN ('9230000000','9230000001')");
  db.logEvent('referral_attributed', '9230000001', { code: 'BP0001' });

  const n = A.weeklyNumbers(A.weekWindow(NOW));
  assert.equal(n.conversations, 6);
  assert.equal(n.newLeads, 2);
  assert.equal(n.leadsBySource.referral, 1);
  assert.equal(n.leadsBySource.lead, 1);
  assert.equal(n.low, false);
});

test('orders, revenue and bookings come from their own tables', () => {
  clean();
  db.upsertContact('923001112223', { name: 'A' });
  db.saveMessage('923001112223', 'user', 'hi', 'text');
  db.createOrder({ chat: '923001112223@s.whatsapp.net', items: [{ name: 'Zinger Burger', qty: 2 }], total: 1300, currency: 'PKR' });
  db.createOrder({ chat: '923001112223@s.whatsapp.net', items: [{ name: 'Fries', qty: 1 }], total: 300, currency: 'PKR' });
  db.run('UPDATE orders SET created_at = ?', [THIS_WEEK(4)]);
  db.createBooking({ chat: '923001112223@s.whatsapp.net', service: 'Table for 4', date: '2030-06-05', time: '20:00' });
  db.run('UPDATE bookings SET created_at = ?', [THIS_WEEK(4)]);

  const n = A.weeklyNumbers(A.weekWindow(NOW));
  assert.equal(n.orders, 2);
  assert.equal(n.revenue, 1600);
  assert.equal(n.bookings, 1);
});

test('the comparison with last week goes both ways', () => {
  clean();
  seedWeek({ conversations: 6, at: THIS_WEEK(5), prefix: '923000001' });
  seedWeek({ conversations: 2, at: LAST_WEEK(30), prefix: '923000002' });
  // Eight more conversations last week, so this week is down.
  seedWeek({ conversations: 8, at: LAST_WEEK(29), prefix: '923000003' });

  const window = A.weekWindow(NOW);
  const current = A.weeklyNumbers({ from: window.from, to: window.to });
  const previous = A.weeklyNumbers({ from: window.prevFrom, to: window.prevTo });
  const d = A.deltas(current, previous);

  assert.equal(d.conversations.current, 6);
  assert.equal(d.conversations.previous, 10);
  assert.equal(d.conversations.diff, -4);
  assert.equal(d.conversations.pct, -40);
});

test('first-response time is measured, and stays empty when we never answered', () => {
  clean();
  db.upsertContact('923004445556', { name: 'B' });
  db.saveMessage('923004445556', 'user', 'hello', 'text');
  db.saveMessage('923004445556', 'assistant', 'hi', 'text');
  db.run("UPDATE messages SET created_at = '2030-06-05T07:00:00.000Z' WHERE number = '923004445556' AND role = 'user'");
  db.run("UPDATE messages SET created_at = '2030-06-05T07:04:00.000Z' WHERE number = '923004445556' AND role = 'assistant'");

  const n = A.weeklyNumbers(A.weekWindow(NOW));
  assert.equal(n.avgFirstResponseMinutes, 4);

  db.run("DELETE FROM messages WHERE role = 'assistant'");
  assert.equal(A.weeklyNumbers(A.weekWindow(NOW)).avgFirstResponseMinutes, null);
});

test('busiest hours are local, not UTC', () => {
  clean();
  for (const hour of [13, 13, 13, 20]) {
    const number = `92300777${hour}${Math.floor(Math.random() * 900) + 100}`;
    db.upsertContact(number, { name: 'H' });
    db.saveMessage(number, 'user', 'q', 'text');
    // 13:00 PKT = 08:00Z
    db.run('UPDATE messages SET created_at = ? WHERE number = ?', [new Date(`2030-06-05T${String(hour - 5).padStart(2, '0')}:15:00Z`).toISOString(), number]);
  }
  const busiest = A.busiestHours(A.weekWindow(NOW).from, A.weekWindow(NOW).to);
  assert.equal(busiest[0].label, '13:00');
  assert.equal(busiest[0].count, 3);
});

test('questions the knowledge base could not answer are counted', () => {
  clean();
  db.logEvent('rag_miss', '92300', 'do you deliver to F-7?');
  db.logEvent('rag_miss', '92301', 'do you deliver to F-7?');
  db.logEvent('rag_miss', '92302', 'is there parking?');
  backdateEvents(['rag_miss'], THIS_WEEK(4));
  const top = A.unansweredQuestions(A.weekWindow(NOW).from, A.weekWindow(NOW).to);
  assert.equal(top[0].question, 'do you deliver to F-7?');
  assert.equal(top[0].count, 2);
});

test('follow-ups sent and answered are both counted', () => {
  clean();
  db.upsertContact('923008889990', { name: 'F' });
  db.logGrowthSend({ agent: 'followup', number: '923008889990', reason: 'quiet 24h', result: 'sent', at: THIS_WEEK(4) });
  db.logGrowthSend({ agent: 'followup', number: '923008889991', reason: 'quiet 24h', result: 'sent', at: THIS_WEEK(4) });
  db.upsertContact('923008889990', { name: 'F' });
  db.saveMessage('923008889990', 'user', 'yes tell me more', 'text');
  db.run("UPDATE messages SET created_at = ? WHERE number = '923008889990' AND role = 'user'", [THIS_WEEK(4, 14)]);

  const n = A.weeklyNumbers(A.weekWindow(NOW));
  assert.equal(n.followUpsSent, 2);
  assert.equal(n.followUpsAnswered, 1);
});

// ── the report ─────────────────────────────────────────────
test('a quiet week says so instead of inventing insight', async () => {
  clean();
  seedWeek({ conversations: 2 });
  const report = await A.buildWeeklyReport({ now: NOW });
  assert.equal(report.low, true);
  assert.match(report.text, /Quiet week: only 2 conversations/);
  assert.equal(report.suggestions.length, 3, 'still three suggestions, from the numbers');
  assert.doesNotMatch(report.text, /%/i.test(report.text) ? /trend of/ : /trend of/);
});

test('with no model configured, the suggestions are still concrete', async () => {
  clean();
  seedWeek({ conversations: 6 });
  db.logEvent('rag_miss', '92300', 'do you deliver to F-7?');
  backdateEvents(['rag_miss'], THIS_WEEK(4));
  const report = await A.buildWeeklyReport({ now: NOW });
  assert.equal(report.low, false);
  assert.equal(report.suggestions.length, 3);
  assert.ok(report.suggestions.every((s) => s.startsWith('- ')));
  assert.ok(report.suggestions.join(' ').includes('F-7'), 'it names the unanswered question');
});

test('the report carries the week-over-week direction', async () => {
  clean();
  seedWeek({ conversations: 6, from: THIS_WEEK });
  const report = await A.buildWeeklyReport({ now: NOW });
  assert.match(report.text, /6 conversations/);
  assert.match(report.text, /(up|down|same as last week)/);
});

// ── delivery ───────────────────────────────────────────────
test('the weekly report goes to the owner on the configured day and hour', async () => {
  writeProfile({ analystAgent: true });
  P.reloadProfile();
  db.setSetting('analyst_last_report', null);
  clean();
  seedWeek({ conversations: 6 });

  const t = fakeTransport();
  assert.equal(A.dueNow(NOW), true, 'Monday 09:00 in Karachi');

  const result = await A.runWeeklyReport({ transport: t, now: NOW });
  assert.equal(result.sent, true);
  assert.equal(t.sent().length, 1);
  assert.match(t.sent()[0], /Weekly report/);

  const again = await A.runWeeklyReport({ transport: t, now: new Date('2030-06-10T04:30:00Z') });
  assert.equal(again.reason, 'already_sent');
  assert.equal(t.sent().length, 1, 'once a week, not once an hour');
});

test('outside the scheduled hour nothing is sent', async () => {
  db.setSetting('analyst_last_report', null);
  const t = fakeTransport();
  const tuesday = new Date('2030-06-11T04:00:00Z');
  assert.equal(A.dueNow(tuesday), false);
  const result = await A.runWeeklyReport({ transport: t, now: tuesday });
  assert.equal(result.reason, 'not_due');
  assert.equal(t.sent().length, 0);
});

test('a late boot still sends the report the same day, but never twice', async () => {
  db.setSetting('analyst_last_report', null);
  clean();
  seedWeek({ conversations: 6 });
  const t = fakeTransport();

  const early = new Date('2030-06-10T02:00:00Z'); // 07:00 PKT, before 09:00
  assert.equal(A.dueNow(early), false);

  const late = new Date('2030-06-10T09:00:00Z'); // 14:00 PKT, missed the hour
  assert.equal(A.dueNow(late), true);
  const result = await A.runWeeklyReport({ transport: t, now: late });
  assert.equal(result.sent, true);
  assert.equal(t.sent().length, 1);
});

test('the analyst flag off means no report at all', async () => {
  writeProfile({ analystAgent: false });
  P.reloadProfile();
  db.setSetting('analyst_last_report', null);
  const t = fakeTransport();
  const result = await A.runWeeklyReport({ transport: t, now: NOW });
  assert.equal(result.reason, 'disabled');
  assert.equal(t.sent().length, 0);

  writeProfile();
  P.reloadProfile();
});

test('.report week gives the same numbers on demand', async () => {
  clean();
  // The command uses the real clock, so seed against the real week.
  seedWeek({ conversations: 6, at: new Date(Date.now() - 24 * 3600 * 1000).toISOString() });
  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const sock = fakeSock();
  const { reply } = await handleOwnerCommand(sock, '923001234567@s.whatsapp.net', '.report week');
  assert.match(reply, /Weekly report/);
  assert.match(reply, /6 conversations/);
});

test('.report (no argument) is still the daily brief', async () => {
  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const sock = fakeSock();
  const { reply } = await handleOwnerCommand(sock, '923001234567@s.whatsapp.net', '.report');
  assert.match(reply, /Daily brief/);
});

void CLIENT;
