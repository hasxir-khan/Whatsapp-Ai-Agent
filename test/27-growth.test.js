// Phase 3 Part 1 — the shared safety layer.
//
// Growth agents are the only thing here that talks to someone who did not just
// ask a question, so these tests are the ones that matter most: an opt-out is
// permanent, the night is quiet, the caps hold, and nothing goes silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, fakeSock, incomingMessage, textMessages, waitFor, settle, CLIENT } from './helpers.js';

const dataDir = isolate('growth');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
process.env.GROQ_API_KEY = 'test-groq-key';

fs.writeFileSync(
  path.join(configDir, 'owner.json'),
  JSON.stringify(
    {
      business: { name: 'Burger Point', type: 'Restaurant', hours: 'Daily 12:00–23:00', timezone: 'Asia/Karachi' },
      catalog: { items: [{ name: 'Zinger Burger', kind: 'product', price: 650, stock: 20 }] },
      features: { businessProfile: true, catalog: true, bookingAgent: true },
    },
    null,
    2
  )
);

const db = await import('../src/utils/db.js');
await db.initDB();
const P = await import('../src/services/profile.js');
P.reloadProfile();
const { config } = await import('../src/config/env.js');
const G = await import('../src/services/growth.js');

const NUMBER = '923004445566';
const JID = `${NUMBER}@s.whatsapp.net`;
// 2030-06-07 is a Friday. 12:00 PKT = 07:00Z, 22:00 PKT = 17:00Z.
const NOON_PKT = new Date('2030-06-07T07:00:00Z');
const NIGHT_PKT = new Date('2030-06-07T17:00:00Z');

function fakeTransport({ kind = 'baileys', window = true } = {}) {
  const sock = fakeSock();
  return {
    kind,
    sock,
    sent: () => textMessages(sock.sent, NUMBER),
    allSent: () => textMessages(sock.sent),
    ownerSent: () => textMessages(sock.sent, config.owner.number),
    async sendMessage(jid, payload) {
      return sock.sendMessage(jid, payload);
    },
    windowOpen: () => window,
    can: () => true,
  };
}

function reset() {
  db.run('DELETE FROM growth_sends');
  db.run('DELETE FROM growth_optouts');
  db.run('DELETE FROM growth_drafts');
}

// ── opt-out language coverage ──────────────────────────────
test('opt-out is understood in English, Roman Urdu and Urdu', () => {
  for (const text of ['stop', 'STOP.', 'please stop 🙏', 'unsubscribe', 'remove me', "don't message me", 'no more messages']) {
    assert.equal(G.detectOptOut(text), true, `English: ${text}`);
  }
  for (const text of ['band karo', 'mat bhejo', 'message mat bhejo', 'pareshan mat karo']) {
    assert.equal(G.detectOptOut(text), true, `Roman Urdu: ${text}`);
  }
  for (const text of ['بند کرو', 'میسج مت بھیجو', 'پریشان مت کرو']) {
    assert.equal(G.detectOptOut(text), true, `Urdu: ${text}`);
  }
});

test('a sentence that merely contains the word "stop" is not an opt-out', () => {
  for (const text of ['stop by the shop tomorrow?', 'I will stop at 5', 'the bus stop is far', 'non-stop flights?']) {
    assert.equal(G.detectOptOut(text), false, text);
  }
});

test('an opt-out is stored, idempotent, and survives a reload', () => {
  reset();
  assert.equal(G.recordOptOut(NUMBER, { reason: 'stop' }), true, 'first time is news');
  assert.equal(G.recordOptOut(NUMBER, { reason: 'stop again' }), false, 'second time is not');
  assert.equal(G.isOptedOut(NUMBER), true);
  assert.equal(db.optOutCount(), 1);
  assert.equal(db.optOutList(5)[0].number, NUMBER);
});

test('an opt-out instantly blocks a proactive send', async () => {
  reset();
  const t = fakeTransport();
  db.optOut(NUMBER, { reason: 'stop' });

  const res = await G.sendProactively({ transport: t, number: NUMBER, text: 'reminder', agent: 'followup', now: NOON_PKT });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'opted_out');
  assert.equal(t.sent().length, 0, 'nothing was sent');
  assert.equal(db.growthStatsSince('1970-01-01')[0].result, 'skipped', 'and it is on the record');
});

test('"start" brings someone back', async () => {
  reset();
  db.optOut(NUMBER, { reason: 'stop' });
  assert.equal(G.detectOptIn('start'), true);
  assert.equal(G.recordOptIn(NUMBER), true);
  assert.equal(G.isOptedOut(NUMBER), false);
});

// ── quiet hours ────────────────────────────────────────────
test('quiet hours follow the business timezone, not the server', () => {
  assert.equal(G.inQuietHours(NOON_PKT), false, '12:00 in Karachi is fine');
  assert.equal(G.inQuietHours(NIGHT_PKT), true, '22:00 in Karachi is not');

  // Same instant, a business in London (UTC+1 in June) is at 18:00 — allowed.
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify({
      business: { name: 'London Cafe', timezone: 'Europe/London' },
      features: { businessProfile: true },
    })
  );
  P.reloadProfile();
  assert.equal(G.inQuietHours(NIGHT_PKT), false, '18:00 London is awake');

  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify({
      business: { name: 'Burger Point', timezone: 'Asia/Karachi' },
      features: { businessProfile: true, bookingAgent: true },
    })
  );
  P.reloadProfile();
});

test('the quiet window can be overridden per business', () => {
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify({
      business: { name: 'Night Cafe', timezone: 'Asia/Karachi', quietHours: { start: '02:00', end: '06:00' } },
      features: { businessProfile: true },
    })
  );
  P.reloadProfile();
  assert.equal(G.inQuietHours(new Date('2030-06-07T17:00:00Z')), false, '22:00 no longer quiet');
  assert.equal(G.inQuietHours(new Date('2030-06-07T22:00:00Z')), true, '03:00 now quiet');

  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify({
      business: { name: 'Burger Point', type: 'Restaurant', hours: 'Daily 12:00–23:00', timezone: 'Asia/Karachi' },
      catalog: { items: [{ name: 'Zinger Burger', kind: 'product', price: 650, stock: 20 }] },
      features: { businessProfile: true, catalog: true, bookingAgent: true },
    })
  );
  P.reloadProfile();
});

test('nothing proactive goes out at night, and we know when it can', async () => {
  reset();
  const t = fakeTransport();
  const res = await G.sendProactively({ transport: t, number: NUMBER, text: 'late nudge', agent: 'followup', now: NIGHT_PKT });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'quiet_hours');
  assert.equal(t.sent().length, 0);

  const next = G.nextAllowedMoment(NIGHT_PKT);
  assert.ok(next.getTime() > NIGHT_PKT.getTime());
  assert.equal(G.inQuietHours(next), false, 'the moment we return is outside the window');
});

// ── caps ───────────────────────────────────────────────────
test('one proactive message per person per 24 hours', async () => {
  reset();
  const t = fakeTransport();
  const first = await G.sendProactively({ transport: t, number: NUMBER, text: 'first', agent: 'followup', now: NOON_PKT });
  assert.equal(first.sent, true);

  const second = await G.sendProactively({ transport: t, number: NUMBER, text: 'second', agent: 'reminder', now: NOON_PKT });
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'contact_cap');
  assert.deepEqual(t.sent(), ['first']);
});

test('the daily ceiling holds, and Baileys gets the lower one', async () => {
  reset();
  const t = fakeTransport({ kind: 'cloud' });
  const originalCap = config.growth.dailyCap;
  config.growth.dailyCap = 2;
  try {
    for (let i = 0; i < 3; i++) {
      await G.sendProactively({ transport: t, number: `9230000000${i}`, text: `nudge ${i}`, agent: 'followup', now: NOON_PKT });
    }
    assert.equal(t.allSent().length, 2, 'the third was refused by the daily cap');

    const third = await G.sendProactively({ transport: t, number: '923000000099', text: 'x', agent: 'followup', now: NOON_PKT });
    assert.equal(third.reason, 'daily_cap');
  } finally {
    config.growth.dailyCap = originalCap;
  }

  assert.equal(G.dailyCapFor('baileys'), config.growth.baileysCap);
  assert.ok(config.growth.baileysCap < config.growth.dailyCap, 'Baileys is deliberately the stricter one');
});

// ── the Cloud 24-hour window ───────────────────────────────
test('on the Cloud API, a closed window means skip and say why — not a failure', async () => {
  reset();
  const t = fakeTransport({ kind: 'cloud', window: false });
  const res = await G.sendProactively({ transport: t, number: NUMBER, text: 'nudge', agent: 'followup', now: NOON_PKT });

  assert.equal(res.sent, false);
  assert.equal(res.reason, 'window_closed');
  assert.equal(t.sent().length, 0);

  const row = db.growthStatsSince('1970-01-01')[0];
  assert.equal(row.result, 'held');
});

test('on the Cloud API, an open window sends normally', async () => {
  reset();
  const t = fakeTransport({ kind: 'cloud', window: true });
  const res = await G.sendProactively({ transport: t, number: NUMBER, text: 'nudge', agent: 'reminder', now: NOON_PKT });
  assert.equal(res.sent, true);
  assert.deepEqual(t.sent(), ['nudge']);
});

// ── the log ────────────────────────────────────────────────
test('every proactive attempt is recorded, with agent and reason', async () => {
  reset();
  const t = fakeTransport();
  await G.sendProactively({ transport: t, number: NUMBER, text: 'a', agent: 'followup', reason: 'quiet 24h', now: NOON_PKT });
  await G.sendProactively({ transport: t, number: '923007778899', text: 'b', agent: 'reminder', reason: 'booking #1', now: NOON_PKT });
  await G.sendProactively({ transport: t, number: NUMBER, text: 'c', agent: 'followup', reason: 'quiet 72h', now: NOON_PKT });

  const rows = db.growthStatsSince('1970-01-01');
  const agents = [...new Set(rows.map((r) => r.agent))].sort();
  assert.deepEqual(agents, ['followup', 'reminder'], 'both agents appear');
  const skipped = rows.find((r) => r.result === 'skipped');
  assert.ok(skipped, 'the refused one is in the log too');
});

// ── owner commands ─────────────────────────────────────────
test('.growth and .optouts show what happened', async () => {
  reset();
  const t = fakeTransport();
  await G.sendProactively({ transport: t, number: NUMBER, text: 'sent one', agent: 'followup', reason: 'quiet 24h', now: NOON_PKT });
  db.optOut('923001234567', { reason: 'stop' });

  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const sock = fakeSock();
  const OWNER = '923169896229@s.whatsapp.net';

  const growth = (await handleOwnerCommand(sock, OWNER, '.growth')).reply;
  assert.match(growth, /Growth today/);
  assert.match(growth, /followup: 1 sent/);
  assert.match(growth, /quiet 21:00–09:00/);

  const optouts = (await handleOwnerCommand(sock, OWNER, '.optouts')).reply;
  assert.match(optouts, /Opted out/);
  assert.match(optouts, /923001234567/);
});

// ── end to end: the customer says stop ─────────────────────
test('saying "stop" in the chat gets one polite confirmation and blocks everything', async () => {
  reset();
  const { mockTransport } = await import('../src/dev/mockLlm.js');
  mockTransport();
  const { handleIncoming } = await import('../src/handlers/messageHandler.js');
  const { saveLead } = db;

  const sock = fakeSock();
  db.upsertContact(CLIENT.number, { name: 'Ali' });
  saveLead({ number: CLIENT.number, status: 'quoted', score: 70, project_type: 'Zinger Burger' });

  await handleIncoming(sock, incomingMessage('band karo'));
  await waitFor(() => textMessages(sock.sent, CLIENT.number).length > 0);
  await settle(50);

  const replies = textMessages(sock.sent, CLIENT.number);
  assert.equal(replies.length, 1, 'exactly one confirmation');
  assert.match(replies[0], /reminder|yad|یاد/i);
  assert.equal(G.isOptedOut(CLIENT.number), true);

  // and nothing proactive can reach them afterwards
  const t = fakeTransport();
  const res = await G.sendProactively({ transport: t, number: CLIENT.number, text: 'nudge', agent: 'followup', now: NOON_PKT });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'opted_out');
});
