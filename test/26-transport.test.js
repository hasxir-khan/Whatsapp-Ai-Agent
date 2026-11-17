// Phase 2 Step 4 — the transport abstraction.
//
// The point of this file is that most of it runs twice: once against a fake
// Baileys socket, once against a fake Graph API. If a behaviour is listed in
// SHARED and passes both times, then memory, replies, media and receipts work
// the same whichever transport the business happens to use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isolate, fakeSock, textMessages, waitFor, settle, incomingMessage, CLIENT } from './helpers.js';

const dataDir = isolate('transport');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
process.env.GROQ_API_KEY = 'test-groq-key';

fs.writeFileSync(
  path.join(configDir, 'owner.json'),
  JSON.stringify(
    {
      business: { name: 'Burger Point', type: 'Restaurant', hours: 'Daily 12:00–23:00' },
      catalog: { items: [{ name: 'Zinger Burger', kind: 'product', price: 650, stock: 20 }] },
      features: { businessProfile: true, catalog: true, cloudApi: true },
    },
    null,
    2
  )
);

const db = await import('../src/utils/db.js');
await db.initDB();
const { config } = await import('../src/config/env.js');
const P = await import('../src/services/profile.js');
P.reloadProfile();

const { BaileysTransport, normalizeBaileys } = await import('../src/transport/baileys.js');
const { CloudTransport, signBody, verifySignature, normalizeCloudMessage } = await import('../src/transport/cloud.js');
const { registerTransport, clearTransports, transportFor, transports, createTransport } = await import('../src/transport/index.js');
const { describeCapabilities } = await import('../src/transport/base.js');
const { handleWebhookRequest, slugFromPath } = await import('../src/transport/webhooks.js');
const { createGateway } = await import('../src/transport/gateway.js');

const NUMBER = '923001112233';
const JID = `${NUMBER}@s.whatsapp.net`;
const NOW = Date.parse('2030-06-07T10:00:00.000Z');

// ════════════════════════════════════════════════════════════
// Two fakes with one API, so one suite can test both
// ════════════════════════════════════════════════════════════

function baileysHarness() {
  const sock = fakeSock();
  const t = BaileysTransport.wrap(sock);
  return {
    name: 'baileys',
    t,
    jid: JID,
    number: NUMBER,
    /** what the customer actually received */
    texts: () => textMessages(sock.sent, NUMBER),
    ownerTexts: () => textMessages(sock.sent, config.owner.number),
    kinds: () =>
      sock.sent
        .map((m) => m.payload)
        .filter((p) => p && !p.text)
        .map((p) => (p.audio ? 'audio' : p.image ? 'image' : p.video ? 'video' : p.document ? 'document' : 'other')),
    lastPayload: () => sock.sent.at(-1)?.payload,
    markReads: () => sock.reads.flat().length,
    sock,
  };
}

function cloudHarness({ windowOpen = true, template = null } = {}) {
  const requests = [];
  let counter = 0;
  const fetchImpl = async (url, options = {}) => {
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    requests.push({ url, method: options.method || 'GET', body, headers: options.headers || {} });

    if (String(url).includes('/media') && (options.method || 'GET') === 'POST') {
      return jsonResponse({ id: `MEDIA-${++counter}` });
    }
    if (options.method === 'POST' && String(url).endsWith('/messages')) {
      return jsonResponse({ messages: [{ id: `wamid.${++counter}` }] });
    }
    return jsonResponse({});
  };

  const t = new CloudTransport({
    slug: 'test',
    phoneId: '111222333',
    token: 'SECRET-TOKEN-VALUE',
    verifyToken: 'verify-me',
    appSecret: 'app-secret',
    template,
    fetchImpl,
    now: () => NOW,
  });

  if (windowOpen) {
    const recent = new Date(NOW - 60 * 60 * 1000).toISOString();
    db.cloudWindowTouch(NUMBER, recent);
    db.cloudWindowTouch(config.owner.number, recent);
  } else {
    db.run('DELETE FROM cloud_windows WHERE number IN (?, ?)', [NUMBER, config.owner.number]);
  }

  const messagePosts = () => requests.filter((r) => r.method === 'POST' && r.url.endsWith('/messages') && r.body?.to);
  return {
    name: 'cloud',
    t,
    jid: JID,
    number: NUMBER,
    requests,
    texts: () => messagePosts().filter((r) => r.body.type === 'text' && r.body.to === NUMBER).map((r) => r.body.text.body),
    ownerTexts: () =>
      messagePosts().filter((r) => r.body.type === 'text' && r.body.to === config.owner.number).map((r) => r.body.text.body),
    kinds: () => messagePosts().map((r) => r.body.type),
    lastPayload: () => messagePosts().at(-1)?.body,
    markReads: () => requests.filter((r) => r.body?.status === 'read').length,
  };
}

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(obj),
    json: async () => obj,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(obj)).buffer,
  };
}

// ════════════════════════════════════════════════════════════
// The shared suite — identical expectations on both transports
// ════════════════════════════════════════════════════════════

const SHARED = [
  {
    title: 'a text reply reaches the customer',
    async run(h) {
      await h.t.send(h.jid, { text: 'Table for four at 8, done.' });
      assert.deepEqual(h.texts(), ['Table for four at 8, done.']);
    },
  },
  {
    title: 'sendMessage is an alias, so existing code needs no branch',
    async run(h) {
      await h.t.sendMessage(h.jid, { text: 'aliased' });
      assert.ok(h.texts().includes('aliased'));
    },
  },
  {
    title: 'a voice note is sent as audio',
    async run(h) {
      await h.t.sendVoice(h.jid, { buffer: Buffer.from('OggS-not-really'), mimetype: 'audio/ogg; codecs=opus' });
      assert.equal(h.kinds().at(-1), 'audio');
    },
  },
  {
    title: 'an image is sent with its caption',
    async run(h) {
      await h.t.sendMedia(h.jid, { kind: 'image', buffer: Buffer.from('fake-jpeg'), mimetype: 'image/jpeg', caption: 'our menu' });
      assert.equal(h.kinds().at(-1), 'image');
    },
  },
  {
    title: 'a document keeps its filename',
    async run(h) {
      await h.t.sendMedia(h.jid, {
        kind: 'document',
        buffer: Buffer.from('%PDF'),
        mimetype: 'application/pdf',
        fileName: 'quote.pdf',
      });
      const sent = h.lastPayload();
      const name = sent.document?.filename || sent.fileName;
      assert.equal(name, 'quote.pdf');
    },
  },
  {
    title: 'read receipts are marked',
    async run(h) {
      await h.t.markRead([{ id: 'inbound-1' }]);
      assert.ok(h.markReads() >= 1);
    },
  },
  {
    title: 'groups are refused by both transports',
    async run(h) {
      assert.equal(h.t.can('groups'), false);
    },
  },
  {
    title: 'text, voice, media and downloads are on for both',
    async run(h) {
      for (const cap of ['text', 'voice', 'image', 'document', 'mediaDownload', 'markRead']) {
        assert.equal(h.t.can(cap), true, `${h.name} should support ${cap}`);
      }
    },
  },
  {
    title: 'the human-style sender works over this transport',
    async run(h) {
      const { sendHuman } = await import('../src/core/humanizer.js');
      const sent = await sendHuman(h.t, h.jid, 'Yes we do. Two seats at 8? ', { incomingText: 'table for two?' });
      assert.ok(sent.length >= 1);
      assert.ok(h.texts().join(' ').includes('Two seats at 8'));
    },
  },
  {
    title: 'the outbox retries through whichever transport is attached',
    async run(h) {
      db.run('DELETE FROM outbox');
      const row = db.enqueueOutbox(h.jid, { text: 'retried by the queue' }, { kind: 'text' });
      const { flushOutbox } = await import('../src/services/outbox.js');
      const result = await flushOutbox(h.t);
      assert.equal(result.sent, 1);
      assert.ok(h.texts().includes('retried by the queue'));
      assert.equal(db.get('SELECT status FROM outbox WHERE id = ?', [row.id]).status, 'sent');
    },
  },
  {
    title: 'an owner notification goes out over this transport',
    async run(h) {
      const { notifyOwner } = await import('../src/handlers/messageHandler.js');
      await notifyOwner(h.t, 'test notice from the bot');
      assert.ok(h.ownerTexts().some((t) => t.includes('test notice')), `owner got: ${JSON.stringify(h.ownerTexts())}`);
    },
  },
  {
    title: 'an owner command answers the same way',
    async run(h) {
      const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
      const res = await handleOwnerCommand(h.t, `${config.owner.number}@s.whatsapp.net`, '.status');
      assert.match(res.reply, /System status/);
      assert.match(res.reply, /Transport: (baileys|cloud)/);
    },
  },
  {
    title: 'a tool sends its result through this transport',
    async run(h) {
      const T = await import('../src/core/tools.js');
      const before = h.texts().length;
      const res = await T.executeTool(
        'send_quote',
        { service: 'Zinger Burger', goal: 'lunch for the team', budget: '5000' },
        { chat: h.jid, number: h.number, who: 'Ali', send: (text) => h.t.sendMessage(h.jid, { text }) }
      );
      assert.equal(res.status, 'ok', JSON.stringify(res));
      assert.ok(h.texts().length > before, 'the quote was actually delivered');
      assert.match(h.texts().join(' '), /Price:|scope/i);
    },
  },
  {
    title: 'an incoming message normalises to the same internal shape',
    async run(h) {
      const seen = [];
      h.t.onMessage((m) => seen.push(m));
      await h.t.emit(
        h.name === 'baileys'
          ? normalizeBaileys(incomingMessage('hi there', { key: { remoteJid: JID, fromMe: false, id: 'B1' } }))
          : normalizeCloudMessage({ from: NUMBER, id: 'C1', timestamp: '1900000000', type: 'text', text: { body: 'hi there' } })
      );
      assert.equal(seen.length, 1);
      const m = seen[0];
      assert.equal(m.chat, JID);
      assert.equal(m.number, NUMBER);
      assert.equal(m.kind, 'text');
      assert.equal(m.text, 'hi there');
      assert.equal(m.fromMe, false);
    },
  },
];

for (const build of [baileysHarness, () => cloudHarness()]) {
  for (const scenario of SHARED) {
    test(`${build().name} · ${scenario.title}`, async () => {
      await scenario.run(build());
    });
  }
}

// ── what each transport honestly cannot do ─────────────────
test('capabilities are declared, not guessed', () => {
  const b = baileysHarness().t.capabilities;
  const c = cloudHarness().t.capabilities;

  assert.equal(b.presence, true, 'Baileys can show "typing…"');
  assert.equal(c.presence, false, 'the Cloud API cannot');
  assert.equal(b.deleteMessage, true);
  assert.equal(c.deleteMessage, false);
  assert.equal(b.callEvents, true);
  assert.equal(c.callEvents, false);
  assert.equal(c.templates, true, 'only the Cloud API has approved templates');

  const cloud = describeCapabilities(c);
  assert.ok(cloud.unsupported.includes('presence'));
  assert.ok(cloud.unsupported.includes('groups'));
});

test('a missing capability fails clearly, not silently', async () => {
  const { t } = cloudHarness();
  await assert.rejects(() => t.deleteMessage(JID), /not supported by the Cloud API/);
});

test('presence calls on the Cloud API are harmless no-ops', async () => {
  const { t, requests } = cloudHarness();
  await t.sendPresenceUpdate('composing', JID);
  assert.equal(requests.length, 0, 'nothing was sent to Meta');
});

// ════════════════════════════════════════════════════════════
// Cloud webhook: verification and signatures
// ════════════════════════════════════════════════════════════

test('GET verification answers Meta with the challenge, and only with the right token', () => {
  const { t } = cloudHarness();
  const ok = t.verifyWebhook({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '12345' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, '12345');

  const wrong = t.verifyWebhook({ 'hub.mode': 'subscribe', 'hub.verify_token': 'guess', 'hub.challenge': '12345' });
  assert.equal(wrong.status, 403);

  const noMode = t.verifyWebhook({ 'hub.verify_token': 'verify-me' });
  assert.equal(noMode.status, 400);
});

test('an unsigned webhook is refused', async () => {
  const { t, requests } = cloudHarness();
  const res = await t.handleWebhook({ rawBody: JSON.stringify({ entry: [] }) });
  assert.equal(res.status, 401);
  assert.equal(requests.length, 0);
});

test('a webhook with a bad signature is refused', async () => {
  const { t } = cloudHarness();
  const body = JSON.stringify({ entry: [] });
  const res = await t.handleWebhook({ rawBody: body, signature: signBody(body, 'the-wrong-secret') });
  assert.equal(res.status, 401);
});

test('a correctly signed webhook is accepted and its message emerges normalised', async () => {
  const { t } = cloudHarness();
  const seen = [];
  t.onMessage((m) => seen.push(m));

  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '923001112233', phone_number_id: '111222333' },
              contacts: [{ profile: { name: 'Ali' }, wa_id: NUMBER }],
              messages: [{ from: NUMBER, id: 'wamid.IN1', timestamp: '1900000000', type: 'text', text: { body: 'do you deliver to F-7?' } }],
            },
          },
        ],
      },
    ],
  });

  const res = await t.handleWebhook({ rawBody: body, signature: signBody(body, 'app-secret') });
  assert.equal(res.status, 200);
  await settle(20);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, 'do you deliver to F-7?');
  assert.equal(seen[0].pushName, 'Ali');
});

test('incoming media keeps its id so it can be downloaded later', () => {
  const m = normalizeCloudMessage({
    from: NUMBER,
    id: 'wamid.IMG',
    type: 'image',
    image: { id: 'MEDIA-42', mime_type: 'image/jpeg', caption: 'the receipt' },
  });
  assert.equal(m.kind, 'image');
  assert.equal(m.caption, 'the receipt');
  assert.equal(m.mediaRef.mediaId, 'MEDIA-42');
});

test('media is downloaded through the Graph API in two steps', async () => {
  const { t, requests } = cloudHarness();
  // metadata, then the file itself
  t.fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', headers: options.headers });
    if (String(url).endsWith('/MEDIA-42')) return jsonResponse({ url: 'https://lookaside.example/file', mime_type: 'image/jpeg' });
    return {
      ...jsonResponse({}),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    };
  };

  const { buffer, mimetype } = await t.getMedia({ mediaRef: { mediaId: 'MEDIA-42' } });
  assert.equal(mimetype, 'image/jpeg');
  assert.deepEqual([...buffer], [1, 2, 3]);
  assert.match(requests[0].url, /\/MEDIA-42$/);
  assert.equal(requests[1].url, 'https://lookaside.example/file');
});

// ════════════════════════════════════════════════════════════
// The 24-hour window
// ════════════════════════════════════════════════════════════

test('inside the window we send free-form', async () => {
  const h = cloudHarness({ windowOpen: true });
  await h.t.send(JID, { text: 'yes, we deliver to F-7' });
  assert.deepEqual(h.texts(), ['yes, we deliver to F-7']);
  assert.equal(h.t.windowOpen(NUMBER), true);
});

test('outside the window, with no template, the message is held and the owner is told', async () => {
  const h = cloudHarness({ windowOpen: false });
  db.run("DELETE FROM outbox");
  db.cloudWindowTouch(NUMBER, new Date(NOW - 25 * 60 * 60 * 1000).toISOString());
  assert.equal(h.t.windowOpen(NUMBER), false);

  const res = await h.t.send(JID, { text: 'your table is ready' });
  assert.equal(res.queued, true);
  assert.equal(res.held, true);
  assert.equal(res.window, 'closed');
  assert.equal(h.texts().length, 0, 'nothing was sent to a closed window');

  const held = db.get("SELECT * FROM outbox WHERE status = 'held'");
  assert.ok(held, 'the message is queued, not dropped');
  assert.match(held.error, /24-hour window/);

  assert.equal(h.t.notified.length, 1);
  assert.match(h.t.notified[0].text, /window is closed/i);
  assert.match(h.t.notified[0].text, /queued/i);
});

test('outside the window, with an approved template, the template goes out', async () => {
  const h = cloudHarness({ windowOpen: false, template: { name: 'order_update', language: 'en' } });
  db.cloudWindowTouch(NUMBER, new Date(NOW - 30 * 60 * 60 * 1000).toISOString());

  await h.t.send(JID, { text: 'your order is on the way' });
  const sent = h.lastPayload();
  assert.equal(sent.type, 'template');
  assert.equal(sent.template.name, 'order_update');
  assert.equal(sent.template.language.code, 'en');
  assert.equal(sent.template.components[0].parameters[0].text, 'your order is on the way');
});

test('when the customer writes, held messages become sendable again', async () => {
  const h = cloudHarness({ windowOpen: false });
  db.run("DELETE FROM outbox");
  db.cloudWindowTouch(NUMBER, new Date(NOW - 48 * 60 * 60 * 1000).toISOString());

  await h.t.send(JID, { text: 'held one' });
  assert.equal(db.outboxStats().held, 1);

  const nowSeconds = String(Math.floor(NOW / 1000));
  const body = JSON.stringify({
    entry: [{ changes: [{ value: { messages: [{ from: NUMBER, id: 'wamid.RE', timestamp: nowSeconds, type: 'text', text: { body: 'hello again' } }] } }] }],
  });
  await h.t.handleWebhook({ rawBody: body, signature: signBody(body, 'app-secret') });

  // The inbound message refreshed the window and released the held row…
  assert.ok(db.cloudWindowGet(NUMBER).last_inbound);
  assert.equal(db.outboxStats().held, 0);
  assert.equal(db.outboxStats().pending, 1);

  // …and the next send goes straight out.
  await h.t.send(JID, { text: 'welcome back' });
  assert.ok(h.texts().includes('welcome back'));
});

// ════════════════════════════════════════════════════════════
// Delivery and read receipts
// ════════════════════════════════════════════════════════════

test('Meta statuses land on our records and on the outbox row', async () => {
  const h = cloudHarness();
  db.run('DELETE FROM outbox');
  const row = db.enqueueOutbox(JID, { text: 'queued reply' }, { kind: 'text' });
  db.cloudTrack({ waId: 'wamid.TRACK', number: NUMBER, kind: 'text', outboxId: row.id });

  const body = JSON.stringify({
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.TRACK', status: 'delivered', recipient_id: NUMBER }] } }] }],
  });
  await h.t.handleWebhook({ rawBody: body, signature: signBody(body, 'app-secret') });

  assert.equal(db.cloudMessage('wamid.TRACK').status, 'delivered');
  assert.equal(db.get('SELECT status FROM outbox WHERE id = ?', [row.id]).status, 'delivered');

  const read = JSON.stringify({
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.TRACK', status: 'read', recipient_id: NUMBER }] } }] }],
  });
  await h.t.handleWebhook({ rawBody: read, signature: signBody(read, 'app-secret') });
  assert.equal(db.cloudMessage('wamid.TRACK').status, 'read');
});

test('a failed status becomes a failed outbox row with the reason', async () => {
  const h = cloudHarness();
  const row = db.enqueueOutbox(JID, { text: 'x' }, { kind: 'text' });
  db.cloudTrack({ waId: 'wamid.FAIL', number: NUMBER, outboxId: row.id });

  const body = JSON.stringify({
    entry: [
      {
        changes: [
          { value: { statuses: [{ id: 'wamid.FAIL', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] }] } },
        ],
      },
    ],
  });
  await h.t.handleWebhook({ rawBody: body, signature: signBody(body, 'app-secret') });

  assert.equal(db.cloudMessage('wamid.FAIL').status, 'failed');
  const after = db.get('SELECT * FROM outbox WHERE id = ?', [row.id]);
  assert.equal(after.status, 'failed');
  assert.match(after.error, /131047/);
});

test('a 401 from Meta is permanent, a 500 is worth retrying', async () => {
  const h = cloudHarness();
  h.t.fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: 'Invalid OAuth access token', code: 190 } }),
  });
  await assert.rejects(() => h.t.send(JID, { text: 'x' }), (err) => {
    assert.equal(err.permanent, true);
    assert.equal(err.status, 401);
    return true;
  });

  h.t.fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(() => h.t.send(JID, { text: 'x' }), (err) => {
    assert.equal(err.permanent, false);
    assert.equal(err.status, 500);
    return true;
  });
});

// ════════════════════════════════════════════════════════════
// One shared port, one path per tenant
// ════════════════════════════════════════════════════════════

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, { method = 'GET', path: p = '/', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('each tenant answers on its own /webhook/<slug>', async () => {
  clearTransports();
  const a = new CloudTransport({
    slug: 'ayesha',
    phoneId: 'A1',
    token: 'TOKEN-A',
    verifyToken: 'verify-a',
    appSecret: 'secret-a',
    fetchImpl: async () => jsonResponse({ messages: [{ id: 'wamid.A' }] }),
    now: () => NOW,
  });
  const b = new CloudTransport({
    slug: 'burger',
    phoneId: 'B1',
    token: 'TOKEN-B',
    verifyToken: 'verify-b',
    appSecret: 'secret-b',
    fetchImpl: async () => jsonResponse({ messages: [{ id: 'wamid.B' }] }),
    now: () => NOW,
  });
  registerTransport(a);
  registerTransport(b);

  const gotA = [];
  const gotB = [];
  a.onMessage((m) => gotA.push(m));
  b.onMessage((m) => gotB.push(m));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    handleWebhookRequest(req, res, url).catch(() => res.end());
  });
  const port = await listen(server);

  // verification is per tenant
  const va = await request(port, { path: '/webhook/ayesha?hub.mode=subscribe&hub.verify_token=verify-a&hub.challenge=AAA' });
  assert.equal(va.status, 200);
  assert.equal(va.body, 'AAA');
  const vb = await request(port, { path: '/webhook/ayesha?hub.mode=subscribe&hub.verify_token=verify-b&hub.challenge=BBB' });
  assert.equal(vb.status, 403, "one tenant's verify token must not open another");

  // and so is delivery
  const body = JSON.stringify({
    entry: [{ changes: [{ value: { messages: [{ from: NUMBER, id: 'wamid.X', timestamp: '1900000000', type: 'text', text: { body: 'hi' } }] } }] }],
  });
  const pa = await request(port, {
    method: 'POST',
    path: '/webhook/ayesha',
    body,
    headers: { 'x-hub-signature-256': signBody(body, 'secret-a'), 'content-type': 'application/json' },
  });
  assert.equal(pa.status, 200);
  await settle(20);
  assert.equal(gotA.length, 1);
  assert.equal(gotB.length, 0, 'the burger tenant never saw ayesha’s message');

  const wrong = await request(port, {
    method: 'POST',
    path: '/webhook/burger',
    body,
    headers: { 'x-hub-signature-256': signBody(body, 'secret-a') },
  });
  assert.equal(wrong.status, 401, 'a signature from another tenant does not count');

  const unknown = await request(port, { path: '/webhook/nobody?hub.mode=subscribe&hub.verify_token=x' });
  assert.equal(unknown.status, 404);

  await new Promise((r) => server.close(r));
  clearTransports();
});

test('the gateway puts every tenant behind one port', async () => {
  const upstreamA = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`A:${req.url}`);
  });
  const upstreamB = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`B:${req.url}`);
  });
  const portA = await listen(upstreamA);
  const portB = await listen(upstreamB);

  const gateway = createGateway({
    routes: [
      { slug: 'ayesha', target: `http://127.0.0.1:${portA}` },
      { slug: 'burger', target: `http://127.0.0.1:${portB}` },
    ],
  });
  const gatewayPort = await listen(gateway);

  const a = await request(gatewayPort, { path: '/webhook/ayesha' });
  assert.equal(a.body, 'A:/webhook/ayesha');
  const b = await request(gatewayPort, { path: '/webhook/burger' });
  assert.equal(b.body, 'B:/webhook/burger');
  const none = await request(gatewayPort, { path: '/webhook/nobody' });
  assert.equal(none.status, 404);

  await new Promise((r) => gateway.close(r));
  await new Promise((r) => upstreamA.close(r));
  await new Promise((r) => upstreamB.close(r));
});

test('webhook paths parse correctly', () => {
  assert.equal(slugFromPath('/webhook/ayesha'), 'ayesha');
  assert.equal(slugFromPath('/webhook/ayesha/'), 'ayesha');
  assert.equal(slugFromPath('/webhook'), 'default');
  assert.equal(slugFromPath('/'), null);
  assert.equal(slugFromPath('/api/status'), null);
});

// ════════════════════════════════════════════════════════════
// The transport switch itself
// ════════════════════════════════════════════════════════════

test('cloud is refused while features.cloudApi is off', () => {
  fs.writeFileSync(path.join(configDir, 'owner.json'), JSON.stringify({ business: { name: 'X' }, features: {} }, null, 2));
  P.reloadProfile();
  clearTransports();
  assert.throws(() => createTransport({ kind: 'cloud' }), /features\.cloudApi is off/);
});

test('the default stays Baileys, and wrapping a socket changes nothing', async () => {
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify({ business: { name: 'X' }, features: { cloudApi: true } }, null, 2)
  );
  P.reloadProfile();

  const sock = fakeSock();
  const t = createTransport({ kind: 'baileys', sock });
  assert.equal(t.kind, 'baileys');
  assert.equal(t.sock, sock, 'the very same socket, not a copy');
  await t.sendMessage(JID, { text: 'unchanged path' });
  assert.deepEqual(textMessages(sock.sent, NUMBER), ['unchanged path']);

  // and the Baileys transport is still what an empty config builds
  assert.equal(transportFor(t.slug), t);
});

// ════════════════════════════════════════════════════════════
// The whole bot on the Cloud API
// ════════════════════════════════════════════════════════════

test('a customer message over the Cloud API gets a real reply, sent over the Cloud API', async () => {
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify(
      {
        business: { name: 'Burger Point', type: 'Restaurant', hours: 'Daily 12:00–23:00' },
        catalog: { items: [{ name: 'Zinger Burger', kind: 'product', price: 650, stock: 20 }] },
        features: { businessProfile: true, catalog: true, cloudApi: true },
      },
      null,
      2
    )
  );
  P.reloadProfile();

  const { mockTransport } = await import('../src/dev/mockLlm.js');
  mockTransport();
  const { handleIncoming } = await import('../src/handlers/messageHandler.js');

  const h = cloudHarness({ windowOpen: false });
  db.cloudWindowTouch(CLIENT.number, new Date(NOW - 30 * 60 * 1000).toISOString());
  h.t.onMessage((m) => handleIncoming(h.t, m));

  const body = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name: 'Ali' }, wa_id: CLIENT.number }],
              messages: [
                {
                  from: CLIENT.number,
                  id: 'wamid.E2E',
                  timestamp: String(Math.floor(NOW / 1000)),
                  type: 'text',
                  text: { body: 'How much is the zinger burger?' },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  const res = await h.t.handleWebhook({ rawBody: body, signature: signBody(body, 'app-secret') });
  assert.equal(res.status, 200);

  const clientTexts = () =>
    h.requests
      .filter((r) => r.method === 'POST' && r.url.endsWith('/messages') && r.body?.to === CLIENT.number)
      .map((r) => r.body.text?.body || r.body.image?.caption || '')
      .filter(Boolean);

  await waitFor(() => clientTexts().length > 0, { timeout: 8000 });
  const reply = clientTexts().join(' ');
  assert.match(reply, /\S{4,}/);

  const contact = db.getContact(CLIENT.number);
  assert.ok(contact, 'the contact was created by the cloud path too');
  const messages = db.getMessages(CLIENT.number, 10);
  assert.ok(messages.some((m) => m.role === 'user'));
  assert.ok(messages.some((m) => m.role === 'assistant'));
});

// ════════════════════════════════════════════════════════════
// Secrets
// ════════════════════════════════════════════════════════════

test('the token never appears in a log line', async () => {
  const h = cloudHarness();
  const lines = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => lines.push(args.join(' '));
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    await h.t.connect();
    await h.t.send(JID, { text: 'hello' });
    await h.t.handleWebhook({ rawBody: JSON.stringify({ entry: [] }), signature: signBody('{"entry":[]}', 'app-secret') });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  const all = lines.join('\n');
  assert.ok(all.length > 0, 'something was logged');
  assert.ok(!all.includes('SECRET-TOKEN-VALUE'), 'the token must never be printed');
});

test('signatures are constant-time compared and reject tampering', () => {
  const body = '{"a":1}';
  assert.equal(verifySignature(body, signBody(body, 's'), 's'), true);
  assert.equal(verifySignature(body, signBody(body, 's'), 'other'), false);
  assert.equal(verifySignature(body, null, 's'), false);
  assert.equal(verifySignature(body, 'sha256=deadbeef', 's'), false);

  const expected = `sha256=${crypto.createHmac('sha256', 's').update(body).digest('hex')}`;
  assert.equal(signBody(body, 's'), expected);
});
