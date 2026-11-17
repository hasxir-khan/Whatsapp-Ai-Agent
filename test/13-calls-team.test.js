// Missed-call rescue + the multi-user (team) layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, fakeSock, textMessages, waitFor, settle } from './helpers.js';

// 1-second fallback so the test is quick but still exercises the timer
process.env.CALL_FALLBACK_SECONDS = '1';
process.env.CALL_FALLBACK_MODE = 'text';
process.env.CALL_FALLBACK_MAX_PER_DAY = '2';
process.env.CALL_NOTIFY_OWNER = 'false';
process.env.CALLS_ENABLED = 'true';

isolate('calls-team');

const db = await import('../src/utils/db.js');
await db.initDB();
const { mockTransport } = await import('../src/dev/mockLlm.js');
mockTransport();

const { config } = await import('../src/config/env.js');
const { handleCallEvents, handleMissedCall } = await import('../src/services/calls.js');
const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
const { handleIncoming } = await import('../src/handlers/messageHandler.js');

const jidFor = (n) => `${n}@s.whatsapp.net`;

// ── calls ───────────────────────────────────────────────────
test('a missed call becomes a chat message', async () => {
  const number = '447700900123';
  const sock = fakeSock();

  await handleCallEvents(sock, [{ id: 'CALL-1', chatId: jidFor(number), status: 'offer', isVideo: false }]);
  await settle(1600);

  const texts = textMessages(sock.sent, number);
  assert.equal(texts.length, 1, 'one message to the caller');
  assert.ok(texts[0].length > 10);

  const call = db.getCall('CALL-1');
  assert.equal(call.status, 'handled');
  assert.match(call.outcome || '', /text/);
  assert.equal(db.getContact(number).category, 'lead', 'a caller is a lead');
});

test('a call the owner answers gets no auto-reply', async () => {
  const number = '447700900999';
  const sock = fakeSock();

  await handleCallEvents(sock, [{ id: 'CALL-2', chatId: jidFor(number), status: 'offer' }]);
  await handleCallEvents(sock, [{ id: 'CALL-2', chatId: jidFor(number), status: 'accept' }]);
  await settle(1400);

  assert.equal(textMessages(sock.sent, number).length, 0, 'no auto-reply when the owner picked up');
  assert.equal(db.getCall('CALL-2').status, 'accepted');
});

test('calls from groups are ignored, and the daily cap is respected', async () => {
  const groupSock = fakeSock();
  await handleCallEvents(groupSock, [{ id: 'CALL-G', chatId: '120363012345678901@g.us', status: 'offer' }]);
  await settle(1200);
  assert.equal(groupSock.sent.length, 0);
  assert.equal(db.getCall('CALL-G'), null);

  const number = '923551112223';
  const sock = fakeSock();
  // cap is 2 per number per day
  for (let i = 0; i < 3; i++) {
    await handleMissedCall(sock, number, { id: `CAP-${i}`, reason: 'test' });
  }
  await settle(300);
  assert.equal(textMessages(sock.sent, number).length, 2, 'third attempt must be skipped');
});

// ── team ────────────────────────────────────────────────────
test('team commands: takeover, release, permissions', async () => {
  // add a teammate the way config/owner.json would
  config.owner.profile.owner.team = [
    { number: '923001112233', name: 'Ayesha', role: 'sales' },
    { number: '923004445566', name: 'Bilal', role: 'support' },
  ];

  const sock = fakeSock();
  const ownerJid = config.owner.jid;

  // owner sees the roster
  const team = await handleOwnerCommand(sock, ownerJid, '.team');
  assert.match(team.reply, /Ayesha/);
  assert.match(team.reply, /sales/);
  assert.match(team.reply, /Bilal/);

  // sales can take over a chat
  const takeover = await handleOwnerCommand(sock, jidFor('923001112233'), '.takeover 923551119999', '923001112233');
  assert.match(takeover.reply, /got \+923551119999/);
  const contact = db.getContact('923551119999');
  assert.equal(contact.assigned_to, 'Ayesha');
  assert.ok(contact.bot_paused_until, 'bot pauses while a human handles it');
  assert.ok(
    sock.sent.some((m) => m.jid === ownerJid && /Ayesha took over/.test(m.payload?.text || '')),
    'owner is told'
  );

  // support sees it in .mine only for their own name
  const mine = await handleOwnerCommand(sock, jidFor('923001112233'), '.mine', '923001112233');
  assert.match(mine.reply, /Your chats/);

  // sales cannot assign to others, cannot export, cannot flip global switches
  const assign = await handleOwnerCommand(sock, jidFor('923001112233'), '.assign 923551119999 Bilal', '923001112233');
  assert.match(assign.reply, /can't use \.assign/);
  const exp = await handleOwnerCommand(sock, jidFor('923001112233'), '.export', '923001112233');
  assert.match(exp.reply, /owner-only/);
  const ai = await handleOwnerCommand(sock, jidFor('923001112233'), '.ai off', '923001112233');
  assert.match(ai.reply, /owner-only/);

  // owner can assign
  const okAssign = await handleOwnerCommand(sock, ownerJid, '.assign 923551119999 Bilal');
  assert.match(okAssign.reply, /Assigned .* to Bilal/);
  assert.equal(db.getContact('923551119999').assigned_to, 'Bilal');

  // release gives it back to the bot
  const release = await handleOwnerCommand(sock, jidFor('923001112233'), '.release 923551119999', '923001112233');
  assert.match(release.reply, /back with the bot/);
  assert.equal(db.getContact('923551119999').assigned_to, null);
});

test('strangers cannot run commands', async () => {
  const sock = fakeSock();
  const res = await handleOwnerCommand(sock, '447700900555@s.whatsapp.net', '.leads', '447700900555');
  assert.match(res.reply, /private/i);
});

test('a teammate DMing the bot is an operator, not a client', async () => {
  const sock = fakeSock();
  const number = '923001112233';

  await handleIncoming(sock, {
    key: { remoteJid: jidFor(number), fromMe: false, id: 'TEAM-1' },
    message: { conversation: 'kya haal hai' },
    pushName: 'Ayesha',
  });

  await waitFor(() => sock.sent.some((m) => m.jid === jidFor(number)));
  const reply = textMessages(sock.sent, number).join('\n');
  assert.ok(reply.length > 2, 'teammates get a real answer');
  assert.equal(db.getContact(number), null, 'teammates are never stored as clients');
});
