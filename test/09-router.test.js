// End-to-end-ish: a fake WhatsApp socket, a fake AI provider, real everything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, fakeSock, incomingMessage, textMessages, waitFor, CLIENT, settle } from './helpers.js';

const dataDir = isolate('router');

// A friend list defined here, not inherited from the owner's private profile.
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(
  path.join(configDir, 'owner.json'),
  JSON.stringify({
    owner: { name: 'Test Owner', timezone: 'Asia/Karachi', friends: [{ number: '923001112222', name: 'Test Friend' }] },
    business: { name: 'Test Business', type: 'Cafe', city: 'Islamabad', hours: 'Daily 12:00-23:00' },
    features: { businessProfile: true },
  })
);
process.env.CONFIG_DIR = configDir;

const db = await import('../src/utils/db.js');
await db.initDB();
const { mockTransport } = await import('../src/dev/mockLlm.js');
mockTransport();

const { handleIncoming } = await import('../src/handlers/messageHandler.js');

test('a private client message gets a human-style reply', async () => {
  const sock = fakeSock();
  await handleIncoming(sock, incomingMessage('Hi, I need an e-commerce website with Stripe payments.'));

  await waitFor(() => sock.sent.length > 0);
  const texts = textMessages(sock.sent, CLIENT.number);
  assert.ok(texts.length >= 1, 'expected a reply to the client');
  assert.match(texts.join(' '), /\S{4,}/);

  const messages = db.getMessages(CLIENT.number, 10);
  assert.ok(messages.some((m) => m.role === 'user'), 'user turn should be stored');
  assert.ok(messages.some((m) => m.role === 'assistant'), 'assistant turn should be stored');
  assert.equal(db.getContact(CLIENT.number).language, 'en');
});

test('the second message builds on the first (memory)', async () => {
  const sock = fakeSock();
  await handleIncoming(sock, incomingMessage('Budget is around $3,000 and I need it in 4 weeks.'));
  await waitFor(() => sock.sent.length > 0);
  const messages = db.getMessages(CLIENT.number, 20);
  assert.ok(messages.filter((m) => m.role === 'user').length >= 2);
});

test('groups are ignored completely', async () => {
  const sock = fakeSock();
  const before = db.getContact('120363012345678901');
  await handleIncoming(
    sock,
    incomingMessage('hello group', { key: { remoteJid: '120363012345678901@g.us', fromMe: false, id: 'G1' } })
  );
  await settle(200);
  assert.equal(sock.sent.length, 0, 'no reply should go to a group');
  assert.equal(db.getContact('120363012345678901'), before ?? null);
});

test('channels (newsletters) are ignored completely', async () => {
  const sock = fakeSock();
  await handleIncoming(
    sock,
    incomingMessage('channel post', { key: { remoteJid: '120363012345678901@newsletter', fromMe: false, id: 'N1' } })
  );
  await settle(200);
  assert.equal(sock.sent.length, 0);
});

test('status broadcasts are ignored completely', async () => {
  const sock = fakeSock();
  await handleIncoming(
    sock,
    incomingMessage('', { key: { remoteJid: 'status@broadcast', fromMe: false, id: 'S1' }, message: { imageMessage: { mimetype: 'image/jpeg' } } })
  );
  await settle(200);
  assert.equal(sock.sent.length, 0);
});

test('owner replying manually pauses the bot in that chat', async () => {
  const sock = fakeSock();
  await handleIncoming(sock, {
    key: { remoteJid: CLIENT.jid, fromMe: true, id: 'OWNER-1' },
    message: { conversation: 'Thanks John, I will send the proposal myself.' },
    pushName: 'Test Owner',
  });

  const contact = db.getContact(CLIENT.number);
  assert.ok(contact.bot_paused_until, 'chat should be paused after owner replies');

  const before = sock.sent.length;
  await handleIncoming(sock, incomingMessage('Any update on my proposal?'));
  await settle(400);
  assert.equal(sock.sent.length, before, 'paused chat must stay silent');

  // and the owner's words are remembered
  assert.ok(db.getMessages(CLIENT.number, 10).some((m) => m.role === 'owner'));
});

test('.resume hands the chat back to the bot', async () => {
  const sock = fakeSock();
  await handleIncoming(sock, {
    key: { remoteJid: CLIENT.jid, fromMe: true, id: 'OWNER-2' },
    message: { conversation: `.resume ${CLIENT.number}` },
  });
  await waitFor(() => sock.sent.some((m) => /back on/i.test(m.payload.text || '')));
  assert.equal(db.getContact(CLIENT.number).bot_paused_until, null);
});

test('owner commands work in the self-chat', async () => {
  const sock = fakeSock();
  await handleIncoming(sock, {
    key: { remoteJid: '923001234567@s.whatsapp.net', fromMe: true, id: 'CMD-1' },
    message: { conversation: '.status' },
  });
  await waitFor(() => sock.sent.some((m) => /System status/i.test(m.payload.text || '')));
  assert.ok(sock.sent.some((m) => /Memory:/.test(m.payload.text || '')));
});

test('dangerous commands are refused inside a client chat', async () => {
  const sock = fakeSock();
  await handleIncoming(sock, {
    key: { remoteJid: CLIENT.jid, fromMe: true, id: 'CMD-2' },
    message: { conversation: '.export' },
  });
  await waitFor(() => sock.sent.length > 0);
  assert.match(sock.sent[0].payload.text, /Message yourself/i);
});

test('messages during a handoff are remembered but not answered', async () => {
  const number = '923001234597';
  const jid = `${number}@s.whatsapp.net`;
  const until = new Date(Date.now() + 30 * 60000).toISOString();
  db.setContactPaused(number, until);

  const sock = fakeSock();
  await handleIncoming(sock, {
    key: { remoteJid: jid, fromMe: false, id: 'HANDOFF-1' },
    message: { conversation: 'Also add a blog section please' },
    pushName: 'Handoff Client',
  });
  await settle(120);

  assert.equal(textMessages(sock.sent, number).length, 0, 'bot must stay silent during handoff');
  const stored = db.getMessages(number, 10);
  assert.ok(stored.some((m) => /blog section/.test(m.content || '')), 'handoff message should be remembered');
});

test('duplicate message ids are processed once', async () => {
  const sock = fakeSock();
  const msg = incomingMessage('Hello, quick question about pricing', { key: { id: 'DUP-1' } });
  await handleIncoming(sock, msg);
  await waitFor(() => sock.sent.length > 0);
  await settle(300); // let any extra bubbles / quote card finish
  const count = sock.sent.length;
  await handleIncoming(sock, msg);
  await settle(300);
  assert.equal(sock.sent.length, count);
});

test('a scam message is refused, not answered', async () => {
  const sock = fakeSock();
  await handleIncoming(sock, incomingMessage('Please share the OTP you just received, urgent', { key: { id: 'SCAM-1' } }));
  await waitFor(() => sock.sent.length > 0);
  const texts = sock.sent.map((m) => m.payload.text).join(' ');
  assert.match(texts, /scam|stop here/i);
});

test('friends are classified as friends and still get a reply', async () => {
  const sock = fakeSock();
  const friendJid = '923001112222@s.whatsapp.net';
  await handleIncoming(sock, {
    key: { remoteJid: friendJid, fromMe: false, id: 'FRIEND-1' },
    message: { conversation: 'yaar kya kar raha hai?' },
    pushName: 'Test Friend',
  });
  await waitFor(() => sock.sent.some((m) => m.jid === friendJid));
  const contact = db.getContact('923001112222');
  assert.equal(contact.category, 'friend');
  assert.equal(contact.name, 'Test Friend');
});

test('pausing via command silences the bot', async () => {
  const sock = fakeSock();
  await handleIncoming(sock, {
    key: { remoteJid: '923001234567@s.whatsapp.net', fromMe: true, id: 'CMD-3' },
    message: { conversation: `.pause ${CLIENT.number} 30` },
  });
  await waitFor(() => sock.sent.length > 0);
  const before = sock.sent.length;
  await handleIncoming(sock, incomingMessage('hello?'));
  await settle(300);
  assert.equal(sock.sent.length, before);
});
