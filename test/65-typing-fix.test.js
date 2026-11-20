// test/65-typing-fix.test.js
// B1 of the fix pass: the typing indicator, sent the way the socket expects.
//
// The bug: `defaultPresence` fell through to `sock.setPresence(state)` while the
// transport's method is `setPresence(jid, state)`, so every "typing" attempt was
// a *pause* addressed to a chat called `composing`. It never threw, and the
// fakes exposed a method the real pipeline never passes, so nothing caught it.
//
// These tests are the contract that stops it coming back:
//   1. the real transports and the fakes answer to the same interface;
//   2. presence reaches the socket in the state-first order Baileys documents;
//   3. the owner's chosen `.typing-test` variant is the one used;
//   4. "typing…" is refreshed while pending and always taken down;
//   5. TYPING_FIX=0 restores the old calls, so the flag is real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-typing-fix-'));
process.env.DATA_DIR = dir;
process.env.TMP_DIR = path.join(dir, 'tmp');
process.env.SESSION_FOLDER = path.join(dir, 'sessions');
process.env.CONFIG_DIR = path.join(dir, 'config');
process.env.MY_NUMBER = '923001234567';
process.env.ENABLE_WEB = 'false';
process.env.VOICE_REPLY_MODE = 'off';
process.env.REPLY_TIMING = 'on';
process.env.MAX_DELAY_MS = '60'; // sendHuman's own pacing, compressed

const db = await import('../src/utils/db.js');
await db.initDB();

const timing = await import('../src/core/timing.js');
const audit = await import('../src/services/transportAudit.js');
const typing = await import('../src/services/typingTest.js');
const contract = await import('../src/transport/contract.js');
const { BaileysTransport } = await import('../src/transport/baileys.js');
const { CloudTransport } = await import('../src/transport/cloud.js');
const { createFakeSocket, createFakeTransport, presenceCalls } = await import('./fakes.js');

const JID = '923001112223@s.whatsapp.net';
const LID = '77112233445566@lid';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Timings short enough for a test, long enough to observe a refresh. */
function fastTiming(extra = {}) {
  return { refreshMs: 20, hardCapMs: 200, goOnline: false, fix: true, ...extra };
}

test.beforeEach(() => {
  audit.resetAudit();
  typing.setStrategy('a');
  delete process.env.TYPING_FIX;
  delete process.env.TYPING_GO_ONLINE;
});

// ── 1. one interface, real and fake ─────────────────────────
test('both transports answer to the transport contract', () => {
  for (const [name, klass] of [
    ['BaileysTransport', BaileysTransport],
    ['CloudTransport', CloudTransport],
  ]) {
    const check = contract.checkInterface(klass.prototype);
    assert.ok(check.ok, `${name} is missing: ${check.missing.join(', ')}`);
  }
  assert.ok(contract.TRANSPORT_METHODS.includes('setPresence'));
  assert.ok(contract.SOCKET_METHODS.includes('sendPresenceUpdate'));
});

test('the fakes answer to the same contract as the real things', () => {
  const transport = createFakeTransport();
  const socket = createFakeSocket();
  assert.ok(contract.checkInterface(transport).ok);
  assert.ok(contract.checkInterface(socket, contract.SOCKET_METHODS).ok);

  // A fake shaped like the bug — setPresence(state) only — is rejected, so the
  // suite cannot drift back into a fake that is easier to satisfy than reality.
  const badSocket = { sendMessage() {}, setPresence(state) {} };
  const badTransport = contract.checkInterface(badSocket);
  assert.equal(badTransport.ok, false);
  assert.ok(badTransport.missing.includes('send'));
});

test('the real Baileys transport forwards presence state-first to the socket', async () => {
  const sock = createFakeSocket();
  const transport = Object.create(BaileysTransport.prototype);
  transport.sock = sock;
  await transport.setPresence(JID, 'composing');
  const [call] = sock.calls.filter((c) => c.kind === 'presence');
  assert.deepEqual(call, { kind: 'presence', state: 'composing', jid: JID });
  // And the channel agrees about who takes which argument.
  const channel = contract.presenceChannel(transport);
  assert.equal(channel.via, 'setPresence');
  assert.equal(channel.order, 'jid-first');
  const raw = contract.presenceChannel(sock);
  assert.equal(raw.via, 'sendPresenceUpdate');
  assert.equal(raw.order, 'state-first');
});

// ── 2. the fix: composing actually leaves the process ───────
test('a typing session sends composing to the right JID, state first', async () => {
  const transport = createFakeTransport();
  const session = timing.createTypingSession(transport, JID, { timing: fastTiming() });
  await session.stop({ paused: true });

  const onSocket = transport.sock.calls.filter((c) => c.kind === 'presence');
  assert.ok(onSocket.some((c) => c.state === 'composing' && c.jid === JID), 'the socket must receive composing for this chat');
  assert.ok(onSocket.some((c) => c.state === 'paused'), 'and a pause at the end');
  // Not one call went out addressed to the literal "composing".
  assert.ok(!onSocket.some((c) => c.jid === 'composing' || c.jid === 'paused'));
  assert.equal(audit.counters().presenceMismatch, 0);
});

test('"available" is announced to the chat before the first composing', async () => {
  const transport = createFakeTransport();
  const session = timing.createTypingSession(transport, JID, { timing: fastTiming({ goOnline: true }) });
  await session.stop({ paused: true });
  const states = transport.sock.calls.filter((c) => c.kind === 'presence').map((c) => c.state);
  assert.deepEqual(states.slice(0, 2), ['available', 'composing']);
  // Addressed to the chat, not broadcast to every contact on the account.
  const available = transport.sock.calls.find((c) => c.kind === 'presence' && c.state === 'available');
  assert.equal(available.jid, JID);
});

test('the indicator is refreshed while a reply is pending', async () => {
  const transport = createFakeTransport();
  const session = timing.createTypingSession(transport, JID, { timing: fastTiming() });
  await sleep(70); // > 3 refreshes at 20 ms
  await session.stop({ paused: true });
  const composing = transport.sock.calls.filter((c) => c.kind === 'presence' && c.state === 'composing');
  assert.ok(composing.length >= 3, `expected refreshes, saw ${composing.length}`);
  assert.equal(transport.sock.calls.filter((c) => c.kind === 'presence').at(-1).state, 'paused');
});

test('a failed presence never throws, is counted — and paused is still attempted', async () => {
  const transport = createFakeTransport({ throwOnPresence: true });
  const session = timing.createTypingSession(transport, JID, { timing: fastTiming() });
  await assert.doesNotReject(() => session.stop({ paused: true }));
  assert.ok(audit.counters().presenceFailed >= 1);
  // The transport was still asked to pause: presence is best-effort, not fatal.
  const asked = transport.calls.filter((c) => c.kind === 'setPresence').map((c) => c.state);
  assert.ok(asked.includes('paused'));
});

test('stop() is idempotent and always leaves a pause behind', async () => {
  const transport = createFakeTransport();
  const session = timing.createTypingSession(transport, JID, { timing: fastTiming() });
  await session.stop();
  await session.stop();
  const paused = transport.calls.filter((c) => c.kind === 'setPresence' && c.state === 'paused');
  assert.ok(paused.length >= 1);
});

// ── 3. the owner's chosen shape is the one used ─────────────
test('strategy b subscribes before composing', async () => {
  typing.setStrategy('b');
  const transport = createFakeTransport();
  const session = timing.createTypingSession(transport, JID, { timing: fastTiming() });
  await session.stop({ paused: true });
  const kinds = transport.sock.calls.map((c) => (c.kind === 'presence' ? c.state : c.kind));
  assert.equal(kinds[0], 'subscribe');
  assert.equal(kinds[1], 'composing');
});

test('strategy c says available even when going online is switched off', async () => {
  typing.setStrategy('c');
  const transport = createFakeTransport();
  const session = timing.createTypingSession(transport, JID, { timing: fastTiming({ goOnline: false }) });
  await session.stop({ paused: true });
  const states = transport.sock.calls.filter((c) => c.kind === 'presence').map((c) => c.state);
  assert.equal(states[0], 'available');
  assert.equal(states[1], 'composing');
});

test('strategy d composes on the alternate JID form', async () => {
  typing.setStrategy('d');
  const transport = createFakeTransport();
  const session = timing.createTypingSession(transport, JID, { timing: fastTiming(), altJid: LID });
  await session.stop({ paused: true });
  const composing = transport.sock.calls.filter((c) => c.kind === 'presence' && c.state === 'composing');
  assert.ok(composing.length >= 1);
  assert.ok(composing.every((c) => c.jid === LID), 'composing must go to the alternate address');
  // The pause follows the same address, or the bubble would stay up there.
  const last = transport.sock.calls.filter((c) => c.kind === 'presence').at(-1);
  assert.equal(last.state, 'paused');
  assert.equal(last.jid, LID);
});

test('strategy d without an alternate address falls back to the chat', async () => {
  typing.setStrategy('d');
  const transport = createFakeTransport();
  const session = timing.createTypingSession(transport, JID, { timing: fastTiming() });
  await session.stop({ paused: true });
  const composing = transport.sock.calls.filter((c) => c.kind === 'presence' && c.state === 'composing');
  assert.ok(composing.every((c) => c.jid === JID));
});

test('the alternate JID is the other form, never the same one', () => {
  assert.equal(typing.alternateJid({ phone: JID, lid: LID }, JID), LID);
  assert.equal(typing.alternateJid({ phone: JID, lid: null }, JID), null);
  assert.equal(typing.alternateJid({ phone: JID, lid: JID }, JID), null);
  // Chat addressed on the LID: the phone form is the alternate.
  assert.equal(typing.alternateJid({ phone: JID, lid: LID }, LID), JID);
});

// ── 4. the session is driven by humanizer, end to end ───────
test('sendHuman pauses before the message and never leaves typing on', async () => {
  const { sendHuman } = await import('../src/core/humanizer.js');
  const transport = createFakeTransport();
  await sendHuman(transport, JID, 'The fee is 5,000 PKR for the first visit.', { incomingText: 'how much?', lang: 'en' });
  const sequence = transport.sock.calls.map((c) => (c.kind === 'presence' ? c.state : c.kind));
  const firstMessage = sequence.indexOf('message');
  assert.ok(firstMessage > 0, 'something was sent');
  assert.ok(sequence.slice(0, firstMessage).includes('paused'), 'paused must come before the text');
  // After the send the indicator is down for good: the last presence state is
  // either the pause or nothing new at all.
  const presenceStates = sequence.filter((s) => s !== 'message' && s !== 'send');
  assert.equal(presenceStates.at(-1), 'paused');
});

// ── 5. the flag is real ────────────────────────────────────
test('TYPING_FIX=0 restores the old call shape, mismatch and all', async () => {
  process.env.TYPING_FIX = '0';
  try {
    const transport = createFakeTransport();
    const session = timing.createTypingSession(transport, JID, { timing: fastTiming({ fix: false }) });
    await session.stop({ paused: true });
    const asked = transport.calls.filter((c) => c.kind === 'setPresence');
    assert.equal(asked[0].jid, 'composing', 'the rollback path swaps the arguments');
    assert.notEqual(asked[0].state, 'composing', 'the state went into the JID slot, which is the bug');
    assert.ok(audit.counters().presenceMismatch >= 1);
  } finally {
    delete process.env.TYPING_FIX;
  }
});

test('markAvailable uses the same channel, so its arguments are never swapped', async () => {
  const transport = createFakeTransport();
  timing.markAvailable(transport, JID);
  const [call] = transport.sock.calls.filter((c) => c.kind === 'presence');
  assert.deepEqual(call, { kind: 'presence', state: 'available', jid: JID });
});

test('a raw socket still works: state first, no transport wrapper needed', async () => {
  const sock = createFakeSocket();
  const session = timing.createTypingSession(sock, JID, { timing: fastTiming() });
  await session.stop({ paused: true });
  const composing = sock.calls.filter((c) => c.kind === 'presence' && c.state === 'composing');
  assert.ok(composing.length >= 1);
  assert.equal(composing[0].jid, JID);
});
