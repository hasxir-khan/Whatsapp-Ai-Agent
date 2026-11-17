// Offline resilience: a reply that cannot be sent must be queued and delivered
// later, not lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, fakeSock } from './helpers.js';

process.env.DRY_RUN = '0'; // the queue is bypassed in dry-run mode

isolate('outbox');

const db = await import('../src/utils/db.js');
await db.initDB();
const { sendReliable, flushOutbox, isRetryable, outboxStatus } = await import('../src/services/outbox.js');

function brokenSock(message = 'Connection Closed') {
  return {
    sent: [],
    async sendMessage(jid, payload) {
      throw new Error(message);
    },
  };
}

test('retryable vs permanent failures are classified correctly', () => {
  assert.equal(isRetryable(new Error('Connection Closed')), true);
  assert.equal(isRetryable(new Error('socket hang up')), true);
  assert.equal(isRetryable(new Error('ETIMEDOUT')), true);
  assert.equal(isRetryable(new Error('Timed Out')), true);
  assert.equal(isRetryable(new Error('forbidden')), false);
  assert.equal(isRetryable(new Error('invalid jid')), false);
  const err401 = new Error('nope');
  err401.status = 401;
  assert.equal(isRetryable(err401), false);
});

test('a failed send is queued, then delivered when the connection is back', async () => {
  const jid = '447700900123@s.whatsapp.net';
  const offline = brokenSock('Connection Closed');

  const result = await sendReliable(offline, jid, { text: 'Your quote is ready' });
  assert.equal(result.queued, true, 'should report that it was queued');
  assert.equal(outboxStatus().pending, 1);

  // connection recovers
  const sock = fakeSock();
  const flushed = await flushOutbox(sock);
  assert.equal(flushed.sent, 1);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].payload.text, 'Your quote is ready');
  assert.equal(outboxStatus().pending, 0);
});

test('permanent failures are thrown, not queued', async () => {
  const jid = '447700900124@s.whatsapp.net';
  await assert.rejects(() => sendReliable(brokenSock('invalid jid'), jid, { text: 'hi' }), /invalid jid/);
  assert.equal(outboxStatus().pending, 0, 'a permanent failure must not sit in the queue');
});

test('the queue keeps order and survives a second outage', async () => {
  const jid = '447700900125@s.whatsapp.net';

  await sendReliable(brokenSock(), jid, { text: 'first' });
  await sendReliable(brokenSock(), jid, { text: 'second' });
  assert.equal(outboxStatus().pending, 2);

  // still offline: flushing must not lose anything
  const stillOffline = brokenSock('Connection Closed');
  const attempt = await flushOutbox(stillOffline);
  assert.equal(attempt.sent, 0);
  assert.equal(outboxStatus().pending, 2, 'nothing is dropped while offline');

  // back online: both arrive, in order
  const sock = fakeSock();
  const flushed = await flushOutbox(sock);
  assert.equal(flushed.sent, 2);
  assert.deepEqual(
    sock.sent.map((m) => m.payload.text),
    ['first', 'second']
  );
  assert.equal(outboxStatus().pending, 0);
});

test('sendHuman queues instead of throwing when the socket dies mid-chat', async () => {
  const { sendHuman } = await import('../src/core/humanizer.js');
  const jid = '447700900126@s.whatsapp.net';

  await sendHuman(brokenSock('Connection Closed'), jid, 'Hey, one moment', { incomingText: 'hello?' });
  assert.ok(outboxStatus().pending >= 1, 'the reply is waiting in the outbox');
});
