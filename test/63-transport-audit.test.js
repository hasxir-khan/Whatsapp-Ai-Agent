// test/63-transport-audit.test.js
// Commit A of the Baileys fix pass: the evidence, before any behaviour change.
//
// Two things were reported from a real phone and neither is visible from the
// inside: the "typing…" bubble never appears, and outgoing messages sit on
// "Waiting for this message" until they are retried. These tests cover the
// instruments added to see both — presence accounting with the exact JID and
// call shape, outbound delivery tracking, decryption counters, and the
// `.typing-test` command that asks a human which of four presences their phone
// actually showed.
//
// Nothing here asserts a *fix*. It asserts that the bot can now tell the
// difference between "we called a function" and "WhatsApp accepted it".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-audit-'));
process.env.DATA_DIR = dir;
process.env.TMP_DIR = path.join(dir, 'tmp');
process.env.SESSION_FOLDER = path.join(dir, 'sessions');
process.env.MY_NUMBER = '923001234567';
process.env.CONFIG_DIR = path.join(dir, 'config');
process.env.ENABLE_WEB = 'false';
process.env.VOICE_REPLY_MODE = 'off';
process.env.REPLY_TIMING = 'on';
// The command sends eight one-second presences in production; here it must not.
process.env.TYPING_TEST_HOLD_MS = '120';
process.env.TYPING_TEST_GAP_MS = '60';
process.env.TYPING_TEST_REFRESH_MS = '1000';

const db = await import('../src/utils/db.js');
await db.initDB();
const audit = await import('../src/services/transportAudit.js');
const typing = await import('../src/services/typingTest.js');
const { config } = await import('../src/config/env.js');
const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
const { registerTransport, clearTransports } = await import('../src/transport/index.js');
const { BaileysTransport } = await import('../src/transport/baileys.js');

const OWNER = `+${config.owner.number}`;

function fakeSock() {
  const calls = [];
  return {
    calls,
    async sendPresenceUpdate(state, jid) {
      calls.push({ kind: 'presence', state, jid: jid ?? null });
    },
    async presenceSubscribe(jid) {
      calls.push({ kind: 'subscribe', jid });
    },
  };
}

/** The transport as it exists in the process: only a setPresence(jid, state). */
function transportOnlyTarget() {
  const calls = [];
  return {
    calls,
    setPresence(jid, state) {
      calls.push({ jid, state });
    },
  };
}

test.beforeEach(() => {
  audit.resetAudit();
  clearTransports();
});

// ── 1. what is actually running ─────────────────────────────
test('environment reports Node, the declared Baileys range and the timing model', () => {
  const env = audit.environment();
  assert.equal(env.node, process.version);
  assert.equal(env.baileys.declared, '^6.7.9');
  // Not installed on a CI box, installed on a server — both are answers.
  assert.ok(env.baileys.installed === null || /^\d+\.\d+/.test(env.baileys.installed));
  assert.ok(env.timing.strategy);
  const lines = audit.environmentLines().join('\n');
  assert.match(lines, /Node v\d+/);
  assert.match(lines, /Baileys:/);
  assert.match(lines, /Reply timing:/);
});

// ── 2. which JID did this contact write from? ───────────────
test('an inbound message records the phone form and the LID form', () => {
  audit.noteInbound({ key: { remoteJid: '923001112223@s.whatsapp.net', id: 'A1' } });
  const plain = audit.jidForms('923001112223');
  assert.equal(plain.replyJid, '923001112223@s.whatsapp.net');
  assert.equal(plain.lid, null);

  audit.noteInbound({
    key: { remoteJid: '77112233445566@lid', remoteJidAlt: '923001112223@s.whatsapp.net', id: 'A2' },
  });
  const lid = audit.jidForms('923001112223');
  assert.equal(lid.replyJid, '77112233445566@lid', 'the reply address is the one the message arrived on');
  assert.equal(lid.phone, '923001112223@s.whatsapp.net');
  assert.equal(lid.lid, '77112233445566@lid');
  assert.equal(lid.lastInboundId, 'A2');
});

test('an unknown contact still yields the phone form as the reply address', () => {
  const forms = audit.jidForms('923009998887');
  assert.equal(forms.replyJid, '923009998887@s.whatsapp.net');
  assert.equal(forms.lastInboundJid, null);
});

// ── 3. presence accounting, and the argument-order trap ─────
test('a presence call through the transport is counted, and the wrong call shape is flagged', () => {
  const wrong = { setPresence(jid, state) {} };
  audit.noteTyping({ jid: '923001112223@s.whatsapp.net', state: 'composing', via: 'setPresence', sock: wrong });
  assert.equal(audit.counters().presenceSent, 1);
  assert.equal(audit.counters().presenceMismatch, 1, 'setPresence(jid, state) called with (state) is a mismatch');

  const right = { sendPresenceUpdate(state, jid) {} };
  audit.noteTyping({ jid: '923001112223@s.whatsapp.net', state: 'composing', via: 'sendPresenceUpdate', sock: right });
  assert.equal(audit.counters().presenceMismatch, 1, 'the socket method takes the state first');

  audit.noteInbound({ key: { remoteJid: '923001112223@s.whatsapp.net' } });
  const lines = audit.summaryLines().join('\n');
  assert.match(lines, /Typing: composing → 923001112223@s\.whatsapp\.net/);
  assert.match(lines, /wrong argument order/);
});

test('a failed presence send is counted rather than swallowed', () => {
  audit.noteTyping({ jid: '92300@s.whatsapp.net', state: 'composing', via: 'sendPresenceUpdate', ok: false, error: 'boom' });
  assert.equal(audit.counters().presenceFailed, 1);
  assert.equal(audit.recentTyping(1)[0].error, 'boom');
});

test('the transport sends presence in the state-first order', async () => {
  const sock = fakeSock();
  const transport = Object.create(BaileysTransport.prototype);
  transport.sock = sock;
  await transport.setPresence('923001112223@s.whatsapp.net', 'composing');
  assert.deepEqual(sock.calls[0], { kind: 'presence', state: 'composing', jid: '923001112223@s.whatsapp.net' });
  assert.equal(audit.counters().presenceSent, 1);
  assert.equal(audit.counters().presenceMismatch, 0);
});

const { createTypingSession } = await import('../src/core/timing.js');

test('the timing session records what it actually sent, including a wrong call shape', async () => {
  const target = transportOnlyTarget();
  const session = createTypingSession(target, '923001112223@s.whatsapp.net', { timing: { refreshMs: 100000, hardCapMs: 100000 } });
  session.pause();
  await session.stop({ paused: false });
  assert.equal(target.calls.length, 2);
  assert.equal(audit.counters().presenceMismatch, 2, 'both composing and paused go through setPresence(state)');
  assert.equal(audit.lastTyping().state, 'paused');
});

// ── 4. outbound delivery tracking ───────────────────────────
test('send → delivered latency is measured from messages.update', () => {
  const sentAt = Date.now() - 1200;
  audit.noteOutbound({ id: 'MSG1', jid: '923001112223@s.whatsapp.net', at: sentAt });
  audit.noteStatusUpdate([{ key: { id: 'MSG1' }, update: { status: 3 } }]);
  const lines = audit.deliveryLines().join('\n');
  assert.match(lines, /sent → delivered in 1\.\d+s/);

  audit.noteStatusUpdate([{ key: { id: 'MSG1' }, update: { status: 4 } }]);
  assert.match(audit.deliveryLines().join('\n'), /read in/);
});

test('an outgoing message with no ack after 60s is flagged, and counted', () => {
  audit.noteOutbound({ id: 'MSG2', jid: '923001112223@s.whatsapp.net', at: Date.now() - 75000 });
  assert.equal(audit.unackedCount(), 1);
  assert.match(audit.deliveryLines().join('\n'), /no delivery ack after 7\ds/);
  assert.match(audit.summaryLines().join('\n'), /1 unacked >60s/);

  // A late receipt clears the flag; the latency is still recorded.
  audit.noteStatusUpdate([{ key: { id: 'MSG2' }, update: { status: 3 } }]);
  assert.equal(audit.unackedCount(), 0);
});

test('a read receipt with a timestamp is honoured', () => {
  audit.noteOutbound({ id: 'MSG3', jid: '923001112223@s.whatsapp.net', at: Date.now() - 5000 });
  audit.noteStatusUpdate([{ key: { id: 'MSG3' }, receipt: { readTimestamp: Math.floor((Date.now() - 1000) / 1000) } }]);
  assert.match(audit.deliveryLines().join('\n'), /read in/);
});

test('the transport remembers the id of every message it sends', async () => {
  const transport = Object.create(BaileysTransport.prototype);
  transport.sock = {
    async sendMessage(jid, payload) {
      assert.equal(payload.text, 'hi');
      return { key: { id: 'SENT1', remoteJid: jid } };
    },
  };
  const sent = await transport.send('923001112223@s.whatsapp.net', { text: 'hi' });
  assert.equal(sent.key.id, 'SENT1');
  assert.match(audit.deliveryLines().join('\n'), /923001112223/);
  assert.equal(audit.counters().outboundSent, 1);
});

test('status updates for unknown ids are ignored, not invented', () => {
  audit.noteStatusUpdate([{ key: { id: 'NEVER-SENT' }, update: { status: 3 } }]);
  assert.equal(audit.counters().outboundDelivered, 0);
  assert.deepEqual(audit.deliveryLines(), []);
});

// ── 5. decryption counters, with no content kept ────────────
test('decryption failures are counted by category from log text', () => {
  assert.equal(audit.noteLogText('Decryption error: Bad MAC'), 'badMac');
  assert.equal(audit.noteLogText('Closing open session in favor of incoming prekey bundle'), 'sessionReset');
  assert.equal(audit.noteLogText('Message absent from node'), 'absentMessage');
  assert.equal(audit.noteLogText('failed to process retry receipt'), 'retryFailed');
  assert.equal(audit.noteLogText('connection is open'), null);

  const c = audit.counters();
  assert.equal(c.badMac, 1);
  assert.equal(c.sessionReset, 1);
  assert.equal(c.absentMessage, 1);
  assert.equal(c.retryFailed, 1);
  assert.match(audit.summaryLines().join('\n'), /1 bad MAC · 1 session reset/);
});

test('a wrapped logger counts in every call shape and passes the line through', () => {
  const seen = [];
  const base = {
    level: 'silent',
    info: (...args) => seen.push(args),
    error: (...args) => seen.push(args),
    child: () => base,
  };
  const wrapped = audit.createAuditLogger(base);
  wrapped.info('Bad MAC');
  wrapped.error({ err: { message: 'Closing open session in favor of incoming prekey bundle' } }, 'context');
  wrapped.info({ msg: 'nothing to see' });
  assert.equal(seen.length, 3, 'every line reaches the real logger');
  assert.equal(audit.counters().badMac, 1);
  assert.equal(audit.counters().sessionReset, 1);
});

test('a message stub of type 2 counts as "absent from node"', () => {
  audit.noteStatusUpdate([{ key: { id: 'X' }, update: { messageStubType: 2 } }]);
  audit.noteStatusUpdate([{ key: { id: 'Y' }, messageStubParameters: ['Message absent from node'] }]);
  assert.equal(audit.counters().absentMessage, 2);
});

// ── 6. the four variants ────────────────────────────────────
test('four variants are planned, and the alternate-JID one is skipped when there is no alternate', () => {
  const withLid = typing.planVariants({
    replyJid: '77112233445566@lid',
    lid: '77112233445566@lid',
    phone: '923001112223@s.whatsapp.net',
    number: '923001112223',
  });
  assert.equal(withLid.length, 4);
  assert.equal(withLid[3].jid, '923001112223@s.whatsapp.net', 'variant d tries the phone form');
  assert.deepEqual(withLid[1].steps, ['subscribe', 'composing']);
  assert.deepEqual(withLid[2].steps, ['available', 'composing']);

  const withoutLid = typing.planVariants({ replyJid: '923001112223@s.whatsapp.net', phone: '923001112223@s.whatsapp.net' });
  assert.ok(withoutLid[3].skipped, 'nothing to compare against');
});

test('the test sends only presence, refreshes, and always pauses', async () => {
  const sock = fakeSock();
  const report = await typing.runTypingTest({
    target: sock,
    number: '923001112223',
    forms: { replyJid: '77112233445566@lid', lid: '77112233445566@lid', phone: '923001112223@s.whatsapp.net', number: '923001112223' },
  });

  assert.equal(report.ok, true);
  assert.equal(report.via, 'sendPresenceUpdate');
  assert.equal(report.results.length, 4);

  // Variant a: one composing, then paused, on the inbound JID.
  const first = sock.calls.filter((c) => c.jid === '77112233445566@lid');
  assert.equal(first[0].state, 'composing');
  assert.equal(first.at(-1).state, 'paused');

  // Variant b: subscribe comes before composing.
  const bIndex = sock.calls.findIndex((c) => c.kind === 'subscribe');
  assert.ok(bIndex >= 0);
  assert.equal(sock.calls[bIndex + 1].state, 'composing');
  assert.equal(sock.calls[bIndex + 1].jid, '77112233445566@lid');

  // Variant c: available, then composing.
  const available = sock.calls.findIndex((c) => c.state === 'available');
  assert.ok(available >= 0);
  assert.equal(sock.calls[available + 1].state, 'composing');

  // Variant d: the other address.
  assert.ok(sock.calls.some((c) => c.state === 'composing' && c.jid === '923001112223@s.whatsapp.net'));

  // Every variant ends paused: a test must not leave "typing…" on a screen.
  const paused = sock.calls.filter((c) => c.state === 'paused');
  assert.equal(paused.length, 4);

  // No text was ever sent — presence only.
  assert.ok(sock.calls.every((c) => c.kind === 'presence' || c.kind === 'subscribe'));
});

test('the report reads as a numbered list a human can answer', async () => {
  const report = await typing.runTypingTest({
    target: fakeSock(),
    number: '923001112223',
    forms: { replyJid: '923001112223@s.whatsapp.net', phone: '923001112223@s.whatsapp.net', number: '923001112223' },
  });
  const text = typing.describeResults(report);
  assert.match(text, /^.*1\. composing only/m);
  assert.match(text, /2\. presenceSubscribe/);
  assert.match(text, /3\. available/);
  assert.match(text, /4\. .* skipped/);
  assert.match(text, /\.typing-test use <number>/);
});

test('a run with no transport says so instead of pretending', async () => {
  const report = await typing.runTypingTest({ target: null, number: '923001112223' });
  assert.equal(report.ok, false);
  assert.match(typing.describeResults(report), /No connected transport/);
});

// ── 7. the chosen strategy is remembered ────────────────────
test('strategy defaults to a, and .typing-test use stores the choice', () => {
  assert.equal(typing.strategy(), 'a');
  assert.equal(typing.setStrategy('3'), 'c');
  assert.equal(typing.strategy(), 'c');
  assert.equal(typing.setStrategy('b'), 'b');
  assert.equal(typing.strategy(), 'b');
  assert.throws(() => typing.setStrategy('z'), /Pick 1-4/);
});

// ── 8. the command ──────────────────────────────────────────
test('.typing-test shows what is running when given no number', async () => {
  typing.setStrategy('a');
  const res = await handleOwnerCommand(null, `${config.owner.number}@s.whatsapp.net`, '.typing-test', OWNER);
  assert.equal(res.handled, true);
  assert.match(res.reply, /presence only, no message is sent/);
  assert.match(res.reply, /Node v/);
  assert.match(res.reply, /Strategy: a/);
  assert.match(res.reply, /\.typing-test 923001234567/);
});

test('.typing-test <number> runs against the live transport and answers with the list', async () => {
  const sock = fakeSock();
  registerTransport({ slug: 'test-baileys', kind: 'baileys', ...sock });
  audit.noteInbound({ key: { remoteJid: '923001112223@s.whatsapp.net', id: 'IN1' } });
  const res = await handleOwnerCommand(null, `${config.owner.number}@s.whatsapp.net`, '.typing-test 923001112223', OWNER);
  assert.match(res.reply, /Typing test/);
  assert.match(res.reply, new RegExp(`Last inbound JID: 923001112223@s\\.whatsapp\\.net`));
  assert.match(res.reply, /1\. composing only/);
  assert.match(res.reply, /presence sent|composing/);
  assert.ok(sock.calls.length >= 4);
});

test('.typing-test use <n> is persisted and acknowledged', async () => {
  const res = await handleOwnerCommand(null, `${config.owner.number}@s.whatsapp.net`, '.typing-test use 4', OWNER);
  assert.match(res.reply, /strategy d/i);
  assert.equal(typing.strategy(), 'd');
  const bad = await handleOwnerCommand(null, `${config.owner.number}@s.whatsapp.net`, '.typing-test use nonsense', OWNER);
  assert.match(bad.reply, /Pick 1-4/);
});

test('.typing-test is owner-only', async () => {
  const res = await handleOwnerCommand(null, '923007770000@s.whatsapp.net', '.typing-test 923001112223', '+923007770000');
  assert.match(res.reply, /private/i);
});

test('a short number is refused with the usage line', async () => {
  const res = await handleOwnerCommand(null, `${config.owner.number}@s.whatsapp.net`, '.typing-test 123', OWNER);
  assert.match(res.reply, /Usage: \.typing-test/);
});

// ── 9. the existing commands now carry the evidence ─────────
test('.status and .health include the audit summary', async () => {
  audit.noteTyping({ jid: '923001112223@s.whatsapp.net', state: 'composing', via: 'sendPresenceUpdate' });
  audit.noteOutbound({ id: 'M9', jid: '923001112223@s.whatsapp.net', at: Date.now() - 90000 });

  const status = await handleOwnerCommand(null, `${config.owner.number}@s.whatsapp.net`, '.status', OWNER);
  assert.match(status.reply, /Typing: composing/);
  assert.match(status.reply, /Delivery: 1 sent/);
  assert.match(status.reply, /Decrypt: 0 bad MAC/);

  const health = await handleOwnerCommand(null, `${config.owner.number}@s.whatsapp.net`, '.health', OWNER);
  assert.match(health.reply, /Health/i);
  assert.match(health.reply, /transport/i);
  assert.match(health.reply, /Typing: composing/);
});

test('.debug last shows send → delivered latency', async () => {
  audit.noteOutbound({ id: 'M10', jid: '923001112223@s.whatsapp.net', at: Date.now() - 2000 });
  audit.noteStatusUpdate([{ key: { id: 'M10' }, update: { status: 3 } }]);
  const res = await handleOwnerCommand(null, `${config.owner.number}@s.whatsapp.net`, '.debug last', OWNER);
  assert.match(res.reply, /Delivery/);
  assert.match(res.reply, /sent → delivered in 2\.\d+s/);
});

test('the help text mentions the new command', async () => {
  const res = await handleOwnerCommand(null, `${config.owner.number}@s.whatsapp.net`, '.help', OWNER);
  assert.match(res.reply, /\.typing-test 92300/);
});
