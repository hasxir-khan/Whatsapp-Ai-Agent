// Phase 3 Part 1 — the follow-up agent.
//
// The bar: one short, specific, human message — twice at most — in the
// customer's language, never at night, never after they replied, never after
// they opted out, and never quoting a price the catalogue does not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, fakeSock, textMessages, incomingMessage, waitFor, settle, CLIENT } from './helpers.js';

const dataDir = isolate('followup-agent');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
process.env.GROQ_API_KEY = 'test-groq-key';

function writeProfile(features = {}) {
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify(
      {
        business: { name: 'Burger Point', type: 'Restaurant', hours: 'Daily 12:00–23:00', timezone: 'Asia/Karachi' },
        catalog: { items: [{ name: 'Zinger Burger', kind: 'product', price: 650, stock: 20 }] },
        features: { businessProfile: true, catalog: true, followUpAgent: true, ...features },
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
const F = await import('../src/services/followUpAgent.js');
const { config } = await import('../src/config/env.js');

const NOON_PKT = new Date('2030-06-07T07:00:00Z'); // Friday 12:00 in Karachi
const NUMBER = '923006667788';

function fakeTransport() {
  const sock = fakeSock();
  return {
    kind: 'baileys',
    sock,
    sent: (n = NUMBER) => textMessages(sock.sent, n),
    ownerSent: () => textMessages(sock.sent, config.owner.number),
    async sendMessage(jid, payload) {
      return sock.sendMessage(jid, payload);
    },
    windowOpen: () => true,
    can: () => true,
  };
}

/** A lead who went quiet `hours` ago, with the score the agent filters on. */
function seedLead({ number = NUMBER, hours = 26, score = 70, name = 'Ali', lang = 'en', status = 'quoted', item = 'Zinger Burger', question = 'How much is the zinger burger?' }) {
  db.upsertContact(number, { name, push_name: name, language: lang, category: 'lead' });
  db.saveLead({
    number,
    name,
    status,
    score,
    project_type: item,
    quote_min: 650,
    quote_max: 650,
    quote_currency: 'PKR',
    goal: 'lunch for the team',
  });
  const seen = new Date(NOON_PKT.getTime() - hours * 3600 * 1000).toISOString();
  db.run('UPDATE contacts SET last_seen = ?, bot_paused_until = NULL, assigned_to = NULL WHERE number = ?', [seen, number]);
  db.run('DELETE FROM messages WHERE number = ?', [number]);
  db.saveMessage(number, 'user', question, 'text');
  return db.getLead(number);
}

function clean() {
  db.run('DELETE FROM growth_drafts');
  db.run('DELETE FROM growth_sends');
  db.run('DELETE FROM growth_optouts');
}

// ── who gets a nudge ───────────────────────────────────────
test('a quiet lead above the score bar is a candidate at 24h and again at 72h', () => {
  clean();
  seedLead({ hours: 26 });
  const at24 = F.candidates(NOON_PKT);
  assert.equal(at24.length, 1);
  assert.equal(at24[0].stage, 24);
  assert.equal(at24[0].attempt, 1);

  seedLead({ hours: 80 });
  const at72 = F.candidates(NOON_PKT);
  assert.equal(at72[0].stage, 72);
});

test('a lead below the score bar is left alone', () => {
  clean();
  seedLead({ hours: 30, score: 10 });
  assert.equal(F.candidates(NOON_PKT).length, 0);
});

test('a lead who asked five minutes ago is not "quiet"', () => {
  clean();
  seedLead({ hours: 1 });
  assert.equal(F.candidates(NOON_PKT).length, 0);
});

test('an owner takeover or a pause stops the agent dead', () => {
  clean();
  seedLead({ hours: 40 });
  db.setContactPaused(NUMBER, new Date(NOON_PKT.getTime() + 3600_000).toISOString());
  assert.equal(F.candidates(NOON_PKT).length, 0);

  db.setContactPaused(NUMBER, null);
  db.run("UPDATE contacts SET assigned_to = 'Bilal' WHERE number = ?", [NUMBER]);
  assert.equal(F.candidates(NOON_PKT).length, 0);
});

// ── the message ────────────────────────────────────────────
test('the message is personal, short, and in the customer’s language', () => {
  seedLead({ hours: 30, lang: 'en', name: 'Ali', question: 'Do you deliver to F-7?' });
  const english = F.buildFollowUp({ contact: db.getContact(NUMBER), lead: db.getLead(NUMBER), attempt: 1 });
  assert.match(english, /^Hi Ali/);
  assert.match(english, /F-7/, 'it quotes what they actually asked');
  assert.ok(english.length < 220, 'short');
  assert.equal(english.includes('\n'), false, 'one message, not an essay');

  db.run("UPDATE contacts SET language = 'roman-ur' WHERE number = ?", [NUMBER]);
  const roman = F.buildFollowUp({ contact: db.getContact(NUMBER), lead: db.getLead(NUMBER), attempt: 1 });
  assert.match(roman, /aap ne|Aage/, 'Roman Urdu');

  db.run("UPDATE contacts SET language = 'ur' WHERE number = ?", [NUMBER]);
  const urdu = F.buildFollowUp({ contact: db.getContact(NUMBER), lead: db.getLead(NUMBER), attempt: 1 });
  assert.match(urdu, /[\u0600-\u06FF]/, 'Urdu script');
});

test('the second message is the last one, and it offers a way out', () => {
  seedLead({ hours: 80, name: 'Ali' });
  const second = F.buildFollowUp({ contact: db.getContact(NUMBER), lead: db.getLead(NUMBER), attempt: 2 });
  assert.match(second, /close the file/i);
});

test('a price appears only when the catalogue actually has the item', () => {
  seedLead({ hours: 30, item: 'Zinger Burger' });
  const withPrice = F.buildFollowUp({ contact: db.getContact(NUMBER), lead: db.getLead(NUMBER), attempt: 1 });
  assert.match(withPrice, /PKR 650/);

  db.saveLead({ number: NUMBER, project_type: 'Corporate website' });
  const withoutPrice = F.buildFollowUp({ contact: db.getContact(NUMBER), lead: db.getLead(NUMBER), attempt: 1 });
  assert.doesNotMatch(withoutPrice, /PKR|Rs\.?|\d{3,}/, `no invented price in: ${withoutPrice}`);
});

// ── approval flow (default) ────────────────────────────────
test('by default a draft waits for the owner and nothing is sent', async () => {
  clean();
  seedLead({ hours: 30 });
  const t = fakeTransport();

  const result = await F.runFollowUpAgent({ transport: t, now: NOON_PKT });
  assert.equal(result.drafted, 1);
  assert.equal(result.sent, 0);
  assert.equal(t.sent().length, 0, 'the customer heard nothing yet');

  const drafts = db.pendingDrafts();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].agent, 'followup');
  assert.match(t.ownerSent().join(' '), /Follow-up draft #\d+/);
  assert.match(t.ownerSent().join(' '), /\.approve/);
});

test('.approve sends the draft to the customer', async () => {
  clean();
  seedLead({ hours: 30 });
  const t = fakeTransport();
  await F.runFollowUpAgent({ transport: t, now: NOON_PKT });
  const draft = db.pendingDrafts()[0];

  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const sock = fakeSock();

  // `.approve` is the owner pressing a button, so it reads the *real* clock —
  // and this suite may run after 21:00 Karachi, when the quiet window (correctly)
  // blocks the send. What is under test here is the press, not the hour, so the
  // window is neutralised for this one call and put back afterwards.
  P.setPath('business.quietHours', { start: '00:00', end: '00:00' });
  let reply;
  try {
    reply = (await handleOwnerCommand(sock, '923001234567@s.whatsapp.net', `.approve ${draft.id}`)).reply;
  } finally {
    P.setPath('business.quietHours', { start: '21:00', end: '09:00' });
  }
  assert.match(reply, /sent/);

  // The command sent it through its own transport, so check the record.
  assert.equal(db.getDraft(draft.id).status, 'sent');
  assert.equal(db.growthStatsSince('1970-01-01').find((r) => r.agent === 'followup')?.result, 'sent');
});

test('.skip drops it and it never goes out', async () => {
  clean();
  seedLead({ hours: 30 });
  const t = fakeTransport();
  await F.runFollowUpAgent({ transport: t, now: NOON_PKT });
  const draft = db.pendingDrafts()[0];

  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const sock = fakeSock();
  const reply = (await handleOwnerCommand(sock, '923001234567@s.whatsapp.net', `.skip ${draft.id}`)).reply;
  assert.match(reply, /dropped/);
  assert.equal(db.getDraft(draft.id).status, 'skipped');
  assert.equal(db.growthStatsSince('1970-01-01').length, 0, 'nothing was sent');
});

test('with approval off, the agent sends by itself', async () => {
  writeProfile({ growthApproval: false });
  P.reloadProfile();
  assert.equal(F.approvalRequired(), false);

  clean();
  seedLead({ hours: 30 });
  const t = fakeTransport();
  const result = await F.runFollowUpAgent({ transport: t, now: NOON_PKT });

  assert.equal(result.sent, 1);
  assert.equal(result.drafted, 0);
  assert.equal(t.sent().length, 1);
  assert.match(t.sent()[0], /Ali/);

  writeProfile();
  P.reloadProfile();
  assert.equal(F.approvalRequired(), true, 'back to approval-by-default');
});

// ── stop conditions ────────────────────────────────────────
test('after two follow-ups the lead goes cold and gets nothing more', async () => {
  clean();
  seedLead({ hours: 80 });
  // Pretend both nudges already went out.
  db.logGrowthSend({ agent: 'followup', number: NUMBER, reason: 'quiet 24h', result: 'sent', at: '2030-06-05T07:00:00.000Z' });
  db.logGrowthSend({ agent: 'followup', number: NUMBER, reason: 'quiet 72h', result: 'sent', at: '2030-06-06T07:00:00.000Z' });

  assert.equal(F.candidates(NOON_PKT).length, 0);
  assert.equal(db.getLead(NUMBER).status, 'cold');
});

test('a stage is never repeated, even after a restart', async () => {
  clean();
  seedLead({ hours: 30 });
  db.logGrowthSend({ agent: 'followup', number: NUMBER, reason: 'quiet 24h · score 70', result: 'skipped', at: '2030-06-07T06:00:00.000Z' });

  const t = fakeTransport();
  const result = await F.runFollowUpAgent({ transport: t, now: NOON_PKT });
  assert.equal(result.drafted, 0, 'the 24h nudge was already handled');
});

test('a reply cancels a waiting draft immediately', async () => {
  clean();
  seedLead({ hours: 30 });
  const t = fakeTransport();
  await F.runFollowUpAgent({ transport: t, now: NOON_PKT });
  assert.equal(db.pendingDrafts().length, 1);

  assert.equal(F.cancelFor(NUMBER, 'replied'), 1);
  assert.equal(db.pendingDrafts().length, 0);
});

test('an opt-out makes the lead ineligible at once', async () => {
  clean();
  seedLead({ hours: 30 });
  db.optOut(NUMBER, { reason: 'stop' });
  assert.equal(F.candidates(NOON_PKT).length, 0);

  const t = fakeTransport();
  const result = await F.runFollowUpAgent({ transport: t, now: NOON_PKT });
  assert.equal(result.drafted, 0);
  assert.equal(t.ownerSent().length, 0, `owner got: ${JSON.stringify(t.ownerSent())}`);
});

test('nothing is drafted or sent at night', async () => {
  clean();
  seedLead({ hours: 30 });
  const t = fakeTransport();
  const night = new Date('2030-06-07T17:00:00Z'); // 22:00 in Karachi

  const result = await F.runFollowUpAgent({ transport: t, now: night });
  assert.deepEqual(result, { drafted: 0, sent: 0, skipped: 0 });
  assert.equal(db.pendingDrafts().length, 0);
  assert.equal(t.sent().length, 0);
});

// ── the flag ───────────────────────────────────────────────
test('with the flag off, the agent does nothing at all', async () => {
  writeProfile({ followUpAgent: false });
  P.reloadProfile();
  assert.equal(F.followUpAgentEnabled(), false);

  clean();
  seedLead({ hours: 40 });
  const t = fakeTransport();
  const result = await F.runFollowUpAgent({ transport: t, now: NOON_PKT });
  assert.deepEqual(result, { drafted: 0, sent: 0, skipped: 0 });

  writeProfile();
  P.reloadProfile();
});

// ── end to end: a reply stops the nudge ────────────────────
test('when the lead writes back, the draft dies before it can be approved', async () => {
  clean();
  const { mockTransport } = await import('../src/dev/mockLlm.js');
  mockTransport();
  const { handleIncoming } = await import('../src/handlers/messageHandler.js');

  db.upsertContact(CLIENT.number, { name: 'John', language: 'en' });
  db.saveLead({ number: CLIENT.number, status: 'quoted', score: 70, project_type: 'Zinger Burger' });
  db.run('UPDATE contacts SET last_seen = ? WHERE number = ?', ['2030-06-06T07:00:00.000Z', CLIENT.number]);
  db.addDraft({ number: CLIENT.number, agent: 'followup', kind: 'followup', text: 'Hi John — shall we go ahead?', reason: 'quiet 24h' });
  assert.equal(db.pendingDrafts().length, 1);

  const sock = fakeSock();
  await handleIncoming(sock, incomingMessage('yes let’s do it, send the invoice'));
  await waitFor(() => textMessages(sock.sent, CLIENT.number).length > 0);
  await settle(30);

  assert.equal(db.pendingDrafts().length, 0, 'the draft was cancelled the moment they replied');
  assert.equal(db.all("SELECT * FROM growth_drafts WHERE status = 'replied'").length, 1);
});
