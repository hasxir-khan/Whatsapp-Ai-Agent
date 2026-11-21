// Phase 3 Part 3 — the reactivation agent.
//
// Win-back campaigns are the easiest way to lose a phone number, so most of
// this file is about restraint: who is *not* eligible, how many cycles, how
// slow, and what happens when the owner says stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, fakeSock, textMessages } from './helpers.js';

const dataDir = isolate('reactivation-agent');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;

function writeProfile(features = {}, { offers = ['10% off your next order this month'] } = {}) {
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify(
      {
        business: {
          name: 'Burger Point',
          type: 'Restaurant',
          city: 'Islamabad',
          timezone: 'Asia/Karachi',
          hours: 'Daily 12:00–23:00',
          offers,
          reviewLink: 'https://g.page/x/review',
        },
        catalog: { items: [{ name: 'Zinger Burger', kind: 'product', price: 650 }] },
        policies: { delivery: 'We deliver within 5 km in 30 minutes.' },
        features: { businessProfile: true, catalog: true, reactivationAgent: true, ...features },
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
const R = await import('../src/services/reactivationAgent.js');
const { config } = await import('../src/config/env.js');

const NOW = new Date('2030-08-20T07:00:00Z'); // 12:00 PKT
const DAY = 86_400_000;

function fakeTransport(kind = 'baileys', { template = null, windowOpen = true } = {}) {
  const sock = fakeSock();
  return {
    kind,
    sock,
    template,
    sent: (n = '') => textMessages(sock.sent, n),
    async sendMessage(jid, payload) {
      return sock.sendMessage(jid, payload);
    },
    windowOpen: () => windowOpen,
    can: () => true,
  };
}

function clean() {
  for (const t of ['messages', 'contacts', 'leads', 'bookings', 'orders', 'facts', 'events', 'growth_sends', 'growth_optouts', 'reactivation_log']) {
    db.run(`DELETE FROM ${t}`);
  }
  db.setSetting('campaign', null);
}

const daysAgo = (n, from = NOW) => new Date(from.getTime() - n * DAY).toISOString().slice(0, 10);

/** A customer whose table was served 60 days ago. */
function pastCustomer(number = '923001110001', days = 60, date = null) {
  db.upsertContact(number, { name: 'Ayesha', language: 'en' });
  const { booking } = db.createBooking({ chat: `${number}@s.whatsapp.net`, service: 'Table for 4', date: date || daysAgo(days), time: '20:00' });
  db.setBookingStatus(booking.id, 'done');
  return number;
}

function coldLead(number = '923001110002', days = 60) {
  db.upsertContact(number, { name: 'Bilal', language: 'roman-ur' });
  db.saveLead({ number, status: 'quoted', project_type: 'Zinger Burger' });
  db.run('UPDATE leads SET updated_at = ? WHERE number = ?', [new Date(NOW.getTime() - days * DAY).toISOString(), number]);
  return number;
}

// ── segments ───────────────────────────────────────────────
test('a finished job older than the window is a past customer', () => {
  clean();
  pastCustomer();
  const rows = R.pastCustomers(NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].number, '923001110001');
  assert.equal(rows[0].segment, 'past');
});

test('a job finished last week is left alone', () => {
  clean();
  pastCustomer('923001110009', 10);
  assert.equal(R.pastCustomers(NOW).length, 0);
});

test('a lead who never bought and went quiet is a cold lead', () => {
  clean();
  coldLead();
  const rows = R.coldLeads(NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].number, '923001110002');
});

test('a lead who actually bought is not cold', () => {
  clean();
  const n = coldLead('923001110003');
  db.createOrder({ chat: `${n}@s.whatsapp.net`, items: [{ name: 'Zinger Burger', qty: 1 }], total: 650 });
  db.run("UPDATE orders SET status = 'paid', created_at = ?", [new Date(NOW.getTime() - 90 * DAY).toISOString()]);
  assert.equal(R.coldLeads(NOW).length, 0);
});

test('a birthday only counts if the customer told us', () => {
  clean();
  db.upsertContact('923001110004', { name: 'Sara' });
  db.setFact('923001110004', 'birthday', '08-22');
  const rows = R.dateSegment(NOW, 7);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'birthday');
  assert.equal(rows[0].inDays, 2);

  // Guessed dates never appear: a contact with no fact has no date segment.
  db.upsertContact('923001110005', { name: 'Nobody' });
  assert.equal(R.dateSegment(NOW, 7).length, 1);
});

// ── the message ────────────────────────────────────────────
test('the offer and the policy come from config, not from a model', () => {
  const text = R.buildReactivation({ contact: { name: 'Ayesha', language: 'en' }, segment: 'past' });
  assert.match(text, /10% off your next order this month/);
  assert.match(text, /deliver within 5 km/);
  assert.match(text, /Ayesha/);

  writeProfile({}, { offers: [] });
  P.reloadProfile();
  const fallback = R.buildReactivation({ contact: { name: 'Ayesha', language: 'en' }, segment: 'past' });
  assert.match(fallback, /Zinger Burger/);
  assert.match(fallback, /650/, 'the catalogue price, not an invented offer');
  assert.doesNotMatch(fallback, /%/, 'no invented discount');

  writeProfile();
  P.reloadProfile();
});

test('the message is written in the customer’s language', () => {
  assert.match(R.buildReactivation({ contact: { name: 'Bilal', language: 'roman-ur' }, segment: 'past' }), /kaafi arsa/);
  assert.match(R.buildReactivation({ contact: { name: 'Bilal', language: 'ur' }, segment: 'past' }), /[\u0600-\u06FF]/);
  assert.match(R.buildReactivation({ contact: { name: 'Sara', language: 'en' }, segment: 'date', kind: 'birthday' }), /Happy birthday/);
});

// ── cycles and cooldown ────────────────────────────────────
test('two cycles without a reply, then six months of silence', () => {
  clean();
  const n = pastCustomer();

  db.logReactivation({ number: n, segment: 'past', cycle: 1, at: new Date(NOW.getTime() - 60 * DAY).toISOString() });
  assert.equal(R.segments(NOW).length, 1, 'one cycle in, still eligible');

  db.logReactivation({ number: n, segment: 'past', cycle: 2, at: new Date(NOW.getTime() - 30 * DAY).toISOString() });
  assert.equal(R.segments(NOW).length, 0, 'two cycles, everyone stops');

  const later = new Date(NOW.getTime() + 200 * DAY);
  assert.equal(R.segments(later).length, 1, 'and comes back after the cooldown');
});

test('someone who replied is warm again, not a campaign target', () => {
  clean();
  const n = pastCustomer();
  db.logReactivation({ number: n, segment: 'past', cycle: 1, at: new Date(NOW.getTime() - 20 * DAY).toISOString() });
  db.saveMessage(n, 'user', 'yes please, same as last time', 'text');
  db.run('UPDATE messages SET created_at = ? WHERE number = ?', [new Date(NOW.getTime() - 10 * DAY).toISOString(), n]);
  assert.equal(R.segments(NOW).length, 0);
});

test('an opted-out customer is never in the audience', () => {
  clean();
  const n = pastCustomer();
  db.optOut(n, { reason: 'stop' });
  const list = R.segments(NOW);
  assert.equal(list.find((r) => r.number === n), undefined);
});

// ── preview → send → stop ──────────────────────────────────
test('preview shows the audience, the samples and how many can actually go', () => {
  clean();
  pastCustomer('923001110001');
  coldLead('923001110002');
  db.upsertContact('923001110004', { name: 'Sara' });
  db.setFact('923001110004', 'birthday', '08-22');

  const preview = R.previewCampaign(NOW);
  assert.equal(preview.total, 3);
  assert.equal(preview.bySegment.past, 1);
  assert.equal(preview.bySegment.cold, 1);
  assert.equal(preview.bySegment.date, 1);
  assert.equal(preview.sample.length, 2);
  assert.match(R.previewText(NOW), /Reactivation preview/);
  assert.match(R.previewText(NOW), /\.campaign send/);
});

test('nothing is sent until the owner starts the campaign', async () => {
  const t = fakeTransport();
  const idle = await R.runCampaignTick({ transport: t, now: NOW });
  assert.equal(idle.sent, 0);
  assert.equal(idle.reason, 'not_running');
  assert.equal(t.sent().length, 0);
});

test('a campaign sends slowly, one at a time, then finishes', async () => {
  const t = fakeTransport();
  const started = R.startCampaign({ now: NOW });
  assert.equal(started.ok, true);
  assert.equal(started.campaign.total, 3);

  const first = await R.runCampaignTick({ transport: t, now: NOW, max: 1 });
  assert.equal(first.sent, 1);
  assert.equal(t.sent().length, 1);

  // Immediately after: the gap has not elapsed, so nothing else goes out.
  const tooSoon = await R.runCampaignTick({ transport: t, now: new Date(NOW.getTime() + 1000), max: 5 });
  assert.equal(tooSoon.sent, 0);
  assert.equal(tooSoon.reason, 'waiting');
  assert.equal(t.sent().length, 1);

  const later = new Date(NOW.getTime() + config.reactivation.maxGapMs + 1000);
  const rest = await R.runCampaignTick({ transport: t, now: later, max: 5 });
  assert.equal(rest.sent, 2);
  assert.equal(rest.done, true);
  assert.equal(t.sent().length, 3);
  assert.equal(R.campaignStatus().status, 'finished');
});

test('.campaign stop halts it immediately', async () => {
  clean();
  pastCustomer('923001110001');
  coldLead('923001110002');
  const t = fakeTransport();
  R.startCampaign({ now: NOW });
  await R.runCampaignTick({ transport: t, now: NOW, max: 1 });

  const stopped = R.stopCampaign();
  assert.equal(stopped.ok, true);
  assert.equal(R.campaignStatus().status, 'stopped');

  const after = await R.runCampaignTick({ transport: t, now: new Date(NOW.getTime() + 10 * 60_000) });
  assert.equal(after.sent, 0);
  assert.equal(t.sent().length, 1, 'nothing goes out after a stop');
});

test('the owner commands work end to end', async () => {
  clean();
  // The command uses the real clock, so the finished job is 60 real days old.
  pastCustomer('923001110001', 60, new Date(Date.now() - 60 * DAY).toISOString().slice(0, 10));
  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const sock = fakeSock();
  const jid = '923001234567@s.whatsapp.net';

  const preview = await handleOwnerCommand(sock, jid, '.campaign preview');
  assert.match(preview.reply, /Reactivation preview/);

  const send = await handleOwnerCommand(sock, jid, '.campaign send');
  assert.match(send.reply, /Campaign started/);
  assert.equal(R.campaignStatus().status, 'running');

  const stop = await handleOwnerCommand(sock, jid, '.campaign stop');
  assert.match(stop.reply, /stopped/i);
  assert.equal(R.campaignStatus().status, 'stopped');
});

// ── the Cloud window and its template ──────────────────────
test('on Cloud, a closed window with no template is skipped and logged', async () => {
  clean();
  const n = pastCustomer('923001110001');
  const t = fakeTransport('cloud', { windowOpen: false, template: null });
  R.startCampaign({ now: NOW });

  const tick = await R.runCampaignTick({ transport: t, now: NOW, max: 1 });
  assert.equal(tick.sent, 0);
  assert.equal(t.sent().length, 0);
  assert.equal(tick.results[0].reason, 'window_closed');

  const log = db.all("SELECT * FROM growth_sends WHERE agent = 'reactivation'");
  assert.equal(log.length, 1);
  assert.equal(log[0].result, 'held');
  assert.match(log[0].detail, /no approved template/i);

  // And the campaign keeps them for later rather than burning the slot twice.
  assert.equal(tick.campaign.cursor, 1);
  void n;
});

test('on Cloud, a configured template is used outside the window', async () => {
  clean();
  pastCustomer('923001110001');
  const t = fakeTransport('cloud', { windowOpen: false, template: { name: 'winback_june' } });
  R.startCampaign({ now: NOW });

  const tick = await R.runCampaignTick({ transport: t, now: NOW, max: 1 });
  assert.equal(tick.sent, 1);
  assert.equal(t.sent().length, 1);
  assert.equal(db.all("SELECT * FROM growth_sends WHERE result = 'sent'")[0].detail, 'template winback_june');
});

test('opt-out and quiet hours are honoured inside a campaign', async () => {
  clean();
  const opted = pastCustomer('923001110001');
  pastCustomer('923001110002');
  db.optOut(opted, { reason: 'stop' });

  const t = fakeTransport();
  R.startCampaign({ now: NOW });
  const tick = await R.runCampaignTick({ transport: t, now: NOW, max: 5 });

  assert.equal(t.sent().length, 1, 'only the person who did not opt out');
  assert.equal(tick.campaign.total, 1, 'the opted-out customer never made it into the audience');
  assert.equal(t.sent('923001110001').length, 0);

  // 22:00 in Karachi: the gate refuses everything, and says why.
  clean();
  pastCustomer('923001110003');
  R.startCampaign({ now: NOW });
  const night = new Date('2030-08-20T17:00:00Z');
  const nightTick = await R.runCampaignTick({ transport: t, now: night, max: 5 });
  assert.equal(nightTick.sent, 0);
  assert.equal(nightTick.results[0].reason, 'quiet_hours');
});

// ── the flag ───────────────────────────────────────────────
test('with the flag off there are no segments and no campaign', () => {
  writeProfile({ reactivationAgent: false });
  P.reloadProfile();
  assert.equal(R.reactivationAgentEnabled(), false);
  assert.deepEqual(R.startCampaign({ now: NOW }), { ok: false, reason: 'disabled' });

  writeProfile();
  P.reloadProfile();
  assert.equal(R.reactivationAgentEnabled(), true);
});

test('gaps are random but always inside the configured range', () => {
  for (const r of [0, 0.25, 0.5, 0.99]) {
    const gap = R.nextGapMs(() => r);
    assert.ok(gap >= config.reactivation.minGapMs && gap <= config.reactivation.maxGapMs, `${r} → ${gap}`);
  }
});
