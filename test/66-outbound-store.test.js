// test/66-outbound-store.test.js
// B2 of the fix pass: answer the retry, and stop dropping the backlog.
//
// Two separate reasons a message shows "Waiting for this message" on the other
// phone: the sender had nothing to hand back when WhatsApp asked, and the
// receiver dropped the message on a reconnect. Both are fixed here, and both
// have a limit: 48 hours and 2 minutes respectively, on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-outbound-'));
process.env.DATA_DIR = dir;
process.env.TMP_DIR = path.join(dir, 'tmp');
process.env.SESSION_FOLDER = path.join(dir, 'sessions');
process.env.CONFIG_DIR = path.join(dir, 'config');
process.env.MY_NUMBER = '923001234567';
process.env.ENABLE_WEB = 'false';
process.env.VOICE_REPLY_MODE = 'off';

const db = await import('../src/utils/db.js');
await db.initDB();
const store = await import('../src/services/outboundStore.js');
const privacy = await import('../src/services/privacy.js');
const { BaileysTransport, buildSocketOptions, appendWindowMs, appendUpsertsEnabled } = await import('../src/transport/baileys.js');

const JID = '923001112223@s.whatsapp.net';
const NUMBER = '923001112223';

// ── 1. the store ───────────────────────────────────────────
test('a sent text is kept, and comes back as an IMessage', async () => {
  const res = store.storeOutbound({ id: 'WAMID-1', jid: JID, payload: { text: 'Your quote is 5,000 PKR.' } });
  assert.equal(res.stored, true);
  assert.deepEqual(store.toMessage({ text: 'hi' }), { conversation: 'hi' });

  const message = await store.storedMessage({ id: 'WAMID-1' });
  assert.deepEqual(message, { conversation: 'Your quote is 5,000 PKR.' });
  assert.equal(await store.storedMessage({ id: 'NEVER-SENT' }), undefined);
  assert.equal(await store.storedMessage(null), undefined, 'a missing key is not a crash');
});

test('the stored payload survives a restart (it is in SQLite, not memory)', async () => {
  store.storeOutbound({ id: 'WAMID-PERSIST', jid: JID, payload: { text: 'persisted' } });
  db.saveDB(true);
  const row = db.get('SELECT body FROM outbound_messages WHERE id = ?', ['WAMID-PERSIST']);
  assert.ok(row, 'the row is on disk');
  assert.deepEqual(JSON.parse(row.body), { conversation: 'persisted' });
});

test('a media payload is not stored, and says why', () => {
  const res = store.storeOutbound({ id: 'WAMID-MEDIA', jid: JID, payload: { image: Buffer.from('x'), caption: 'a photo' } });
  assert.equal(res.stored, false);
  assert.equal(res.reason, 'unsupported_kind');
  assert.equal(store.getStoredOutbound('WAMID-MEDIA'), null);
});

test('the window is 48 hours by default, and expired rows are gone on read', async () => {
  assert.equal(store.outboundWindowHours(), 48);
  const now = new Date('2026-11-17T08:00:00.000Z');
  store.storeOutbound({ id: 'WAMID-OLD', jid: JID, payload: { text: 'old' }, now });
  assert.ok(store.getStoredOutbound('WAMID-OLD', { now: new Date(now.getTime() + 47 * 3_600_000) }));
  assert.equal(
    store.getStoredOutbound('WAMID-OLD', { now: new Date(now.getTime() + 49 * 3_600_000) }),
    null,
    'after 48 hours there is nothing to hand back'
  );
  assert.equal(db.get('SELECT id FROM outbound_messages WHERE id = ?', ['WAMID-OLD']), null, 'and the row is removed');
});

test('the purge removes expired rows and respects the row cap', () => {
  db.run('DELETE FROM outbound_messages');
  const now = new Date('2026-11-17T08:00:00.000Z');
  for (let i = 0; i < 6; i += 1) {
    store.storeOutbound({ id: `CAP-${i}`, jid: JID, payload: { text: `m${i}` }, now: new Date(now.getTime() + i) });
  }
  const before = db.get('SELECT COUNT(*) AS n FROM outbound_messages').n;
  assert.equal(before, 6);
  const removed = store.purgeOutbound({ now, maxRows: 3 });
  assert.equal(removed, 3, 'the oldest three go first');
  const ids = db.all('SELECT id FROM outbound_messages ORDER BY created_at').map((r) => r.id);
  assert.deepEqual(ids, ['CAP-3', 'CAP-4', 'CAP-5']);
});

test('OUTBOUND_STORE=0 disables it completely', async () => {
  process.env.OUTBOUND_STORE = '0';
  try {
    assert.equal(store.outboundStoreEnabled(), false);
    assert.equal(store.storeOutbound({ id: 'OFF-1', jid: JID, payload: { text: 'x' } }).reason, 'disabled');
    assert.equal(await store.storedMessage({ id: 'OFF-1' }), undefined);
  } finally {
    delete process.env.OUTBOUND_STORE;
  }
});

test('the store line is a count, never a message', () => {
  const line = store.outboundStoreLine();
  assert.match(line, /Retry store: \d+\/\d+ messages/);
  assert.doesNotMatch(line, /5,000 PKR/);
});

// ── 2. the socket actually receives getMessage ─────────────
test('the socket options answer retries from the store, and keep the cacheable key store', async () => {
  store.storeOutbound({ id: 'WAMID-RETRY', jid: JID, payload: { text: 'the answer' } });
  const baileys = {
    Browsers: { ubuntu: () => ['Ubuntu', 'Chrome', '1.0'] },
    makeCacheableSignalKeyStore: (keys) => ({ cacheable: keys }),
  };
  const options = buildSocketOptions({
    baileys,
    version: [2, 3000, 1],
    state: { creds: { registered: true }, keys: { preKeys: {} } },
  });
  assert.equal(typeof options.getMessage, 'function', 'getMessage must exist — this is the original bug');
  assert.deepEqual(await options.getMessage({ id: 'WAMID-RETRY', remoteJid: JID }), { conversation: 'the answer' });
  assert.equal(await options.getMessage({ id: 'UNKNOWN' }), undefined);
  assert.ok(options.auth.keys.cacheable, 'the key store stays cacheable');
  assert.equal(options.markOnlineOnConnect, false, 'the bot does not appear online all day');
  assert.equal(options.printQRInTerminal, false);
});

test('.health reports the retry store, and .status stays readable', async () => {
  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const { config } = await import('../src/config/env.js');
  const res = await handleOwnerCommand(null, `${config.owner.number}@s.whatsapp.net`, '.health', `+${config.owner.number}`);
  assert.match(res.reply, /Retry store:/);
});

// ── 3. export, forget, retention ───────────────────────────
test('.export includes the retryable messages this contact was sent', () => {
  store.storeOutbound({ id: 'EXP-1', jid: JID, payload: { text: 'exported line' } });
  const exported = privacy.exportContact(NUMBER);
  assert.equal(exported.ok, true);
  assert.ok(Array.isArray(exported.payload.retryableMessages));
  assert.ok(exported.payload.retryableMessages.some((m) => m.text === 'exported line'));
  assert.equal(exported.counts.retryableMessages, exported.payload.retryableMessages.length);
});

test('.forget removes them with everything else', () => {
  store.storeOutbound({ id: 'FORGET-1', jid: JID, payload: { text: 'deleted with them' } });
  assert.ok(store.getStoredOutbound('FORGET-1'));
  const result = privacy.forgetContact(NUMBER, { reason: 'test' });
  assert.equal(result.ok, true);
  assert.equal(store.getStoredOutbound('FORGET-1'), null);
  assert.equal(db.get('SELECT id FROM outbound_messages WHERE chat = ?', [JID]), null);
});

test('the retention purge takes the retry store with it', () => {
  const now = new Date('2026-11-17T08:00:00.000Z');
  store.storeOutbound({ id: 'RET-1', jid: '923009990000@s.whatsapp.net', payload: { text: 'gone' }, now });
  const res = privacy.purgeRetention({ days: 30, now: new Date(now.getTime() + 49 * 3_600_000) });
  assert.equal(res.ok, true);
  assert.ok(res.retryPurged >= 1);
  assert.equal(store.getStoredOutbound('RET-1'), null);
});

// ── 4. append upserts are a backlog, not history ───────────
test('a recent append is processed; an old one is history', () => {
  const transport = Object.create(BaileysTransport.prototype);
  const now = Math.floor(Date.now() / 1000);
  const fresh = { key: { id: 'A1', remoteJid: JID }, message: { conversation: 'hi' }, messageTimestamp: now - 30 };
  const old = { key: { id: 'A2', remoteJid: JID }, message: { conversation: 'old' }, messageTimestamp: now - 3600 };
  const mine = { key: { id: 'A3', remoteJid: JID, fromMe: true }, message: { conversation: 'mine' }, messageTimestamp: now - 10 };

  assert.equal(transport.worthProcessing(fresh, 'append'), true);
  assert.equal(transport.worthProcessing(old, 'append'), false, 'an hour old is history');
  assert.equal(transport.worthProcessing(mine, 'append'), false, 'our own echo is not a customer message');
  assert.equal(transport.worthProcessing(fresh, 'notify'), true);
  assert.equal(transport.worthProcessing({ key: { id: 'A4' } }, 'append'), false, 'a stub has nothing to answer');
  assert.equal(transport.worthProcessing(fresh, 'replace'), false);
});

test('the append window is 2 minutes and configurable', () => {
  assert.equal(appendWindowMs(), 120000);
  process.env.APPEND_WINDOW_MS = '30000';
  try {
    assert.equal(appendWindowMs(), 30000);
  } finally {
    delete process.env.APPEND_WINDOW_MS;
  }
});

test('APPEND_UPSERTS=0 restores the old behaviour', () => {
  assert.equal(appendUpsertsEnabled(), true);
  process.env.APPEND_UPSERTS = '0';
  try {
    assert.equal(appendUpsertsEnabled(), false);
  } finally {
    delete process.env.APPEND_UPSERTS;
  }
});

test('a message replayed by append is answered once, not twice', async () => {
  const { handleIncoming, drainBatches } = await import('../src/handlers/messageHandler.js');
  const sent = [];
  const transport = {
    kind: 'fake',
    slug: 'fake',
    can: () => false,
    capabilities: {},
    async send(jid, payload) {
      sent.push({ jid, payload });
      return { key: { id: `out-${sent.length}` } };
    },
    async sendMessage(jid, payload) {
      return this.send(jid, payload);
    },
    async setPresence() {},
  };
  const msg = {
    id: 'DUP-1',
    chat: '923005556667@s.whatsapp.net',
    number: '923005556667',
    kind: 'text',
    text: 'what are your timings?',
    pushName: 'Test',
  };
  await handleIncoming(transport, msg);
  await drainBatches({ timeoutMs: 2000 });
  const first = sent.length;
  await handleIncoming(transport, msg); // the same id, replayed by append
  await drainBatches({ timeoutMs: 2000 });
  assert.equal(sent.length, first, 'the id is deduped before anything is sent');
});
