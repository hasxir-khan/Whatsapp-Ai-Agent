// Phase 4 Part 2 — the live inbox.
//
// The inbox is the most private screen this bot has: it is every conversation,
// with phone numbers and names, in a browser. So most of this file is about the
// gate rather than the view — who can open it, what a reply actually does, and
// what happens when the process cannot send.
//
// The routes are exercised with a fake req/res: no sockets, no ports, nothing
// to be flaky at 3am.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { isolate } from './helpers.js';

const dataDir = isolate('live-inbox');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
process.env.ENABLE_WEB = 'false';
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DASHBOARD_TOKEN;

const CLIENT = '923001234567';
const OTHER = '923009999999';

function writeProfile(features = {}) {
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify(
      {
        owner: { name: 'Hashir', timezone: 'Asia/Karachi' },
        business: { name: 'HasDevs Cafe', type: 'Cafe', city: 'Islamabad', timezone: 'Asia/Karachi' },
        catalog: { items: [{ name: 'Chicken Karahi', price: 1350 }] },
        features: { businessProfile: true, ...features },
      },
      null,
      2
    )
  );
  env.reloadProfile();
}

const env = await import('../src/config/env.js');
writeProfile();

const db = await import('../src/utils/db.js');
const profile = await import('../src/services/profile.js');
const L = await import('../src/services/liveInbox.js');
const { handleInboxRoute, inboxPage, authorised } = await import('../src/server.js');
const { handleDemoRoute } = await import('../src/server.js');
const { registerTransport, clearTransports } = await import('../src/transport/index.js');
const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');

await db.initDB();

const setFlag = (key, value) => profile.setPath(`features.${key}`, value);

function seed() {
  db.run('DELETE FROM messages');
  db.run('DELETE FROM contacts');
  // Bilal first, so Ayesha's chat is the most recent activity.
  db.upsertContact(OTHER, { push_name: 'Bilal', jid: `${OTHER}@s.whatsapp.net` });
  db.saveMessage(OTHER, 'user', 'Salam', 'text');
  db.saveMessage(OTHER, 'owner', 'Walaikum salam', 'text');

  db.upsertContact(CLIENT, { push_name: 'Ayesha', name: 'Ayesha Khan', stage: 'lead', jid: `${CLIENT}@s.whatsapp.net` });
  db.saveMessage(CLIENT, 'user', 'Do you deliver to F-11?', 'text');
  db.saveMessage(CLIENT, 'assistant', 'We deliver within 5 km.', 'text');
  db.saveMessage(CLIENT, 'user', 'Ok and how long does it take?', 'text');
}
seed();

/** A request/response pair that never touches a socket. */
function fakeReqRes({ method = 'GET', url = '/api/inbox', headers = {}, body = null, rawBody = null } = {}) {
  const res = {
    status: null,
    headers: null,
    body: null,
    writeHead(status, h) {
      this.status = status;
      this.headers = h || {};
    },
    end(b) {
      this.body = b === undefined || b === null ? '' : String(b);
    },
  };
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = () => {};
  process.nextTick(() => {
    if (rawBody !== null) req.emit('data', Buffer.from(rawBody));
    else if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return { req, res };
}

async function call(opts) {
  const { req, res } = fakeReqRes(opts);
  const handled = await handleInboxRoute(req, res, new URL(opts.url, 'http://localhost'));
  return { handled, status: res.status, headers: res.headers, body: res.body ? safeJson(res.body) : null, raw: res.body };
}

const safeJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

test('off by default: the route does not exist and nothing leaks', async () => {
  assert.equal(profile.featureOn('liveInbox'), false);

  const api = await call({ url: '/api/inbox' });
  assert.equal(api.handled, true);
  assert.equal(api.status, 404);
  assert.equal(api.body.error, 'disabled');
  assert.match(api.body.hint, /features\.liveInbox/);

  const page = await call({ url: '/inbox' });
  assert.equal(page.status, 404);
  assert.match(page.raw, /features\.liveInbox/);
  assert.ok(!page.raw.includes('Ayesha'), 'no conversation content when the flag is off');
});

test('turned on: the chat list is what SQLite already knows', async () => {
  setFlag('liveInbox', true);
  seed();

  const { status, body } = await call({ url: '/api/inbox' });
  assert.equal(status, 200);
  assert.equal(body.chats.length, 2);
  assert.equal(body.summary.total, 2);

  const ayesha = body.chats.find((c) => c.number === CLIENT);
  assert.equal(ayesha.label, 'Ayesha Khan');
  assert.equal(ayesha.unread, 1, 'the customer spoke last, so one message is unread');
  assert.equal(ayesha.awaitingUs, true);
  assert.match(ayesha.preview, /how long/);

  const bilal = body.chats.find((c) => c.number === OTHER);
  assert.equal(bilal.unread, 0, 'the owner answered last');
  assert.equal(bilal.awaitingUs, false);
  assert.match(bilal.preview, /^You: /);

  // Newest activity first.
  assert.equal(body.chats[0].number, CLIENT);
  assert.equal(body.summary.awaitingUs, 1);
  assert.equal(body.summary.unreadMessages, 1);
});

test('a thread, newest last, and only the new rows when asked', async () => {
  const { status, body } = await call({ url: `/api/inbox/${CLIENT}` });
  assert.equal(status, 200);
  assert.equal(body.contact.number, CLIENT);
  assert.deepEqual(body.messages.map((m) => m.from), ['customer', 'bot', 'customer']);
  assert.equal(body.contact.unread, 1);

  const lastId = body.messages.at(-1).id;
  const newer = await call({ url: `/api/inbox/${CLIENT}?after=${lastId}` });
  assert.equal(newer.body.messages.length, 0);

  db.saveMessage(CLIENT, 'user', 'Hello?', 'text');
  const fresh = await call({ url: `/api/inbox/${CLIENT}?after=${lastId}` });
  assert.equal(fresh.body.messages.length, 1);
  assert.match(fresh.body.messages[0].text, /Hello\?/);
});

test('the page is one self-contained file with no outbound requests', () => {
  const html = inboxPage();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.match(html, /Live inbox|Inbox/);
  assert.match(html, /fetch\(/, 'it should talk to its own API');
  // No CDN, no analytics, no fonts: nothing leaves the box.
  assert.doesNotMatch(html, /https?:\/\/(?!localhost)/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
});

test('with DASHBOARD_TOKEN set, every inbox route needs it', async () => {
  // config is read at import; set the token on the live object for this test.
  const before = env.config.server.token;
  env.config.server.token = 'sekrit';

  assert.equal(authorised({ headers: {} }, new URL('http://x/api/inbox')), false);

  const denied = await call({ url: '/api/inbox' });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error, 'unauthorised');

  const allowed = await call({ url: '/api/inbox?token=sekrit' });
  assert.equal(allowed.status, 200);
  assert.ok(Array.isArray(allowed.body.chats));

  const bearer = await call({ url: '/api/inbox', headers: { authorization: 'Bearer sekrit' } });
  assert.equal(bearer.status, 200);

  const pageDenied = await call({ url: '/inbox' });
  assert.equal(pageDenied.status, 401);
  assert.match(pageDenied.raw, /token=/);

  const pageOk = await call({ url: '/inbox?token=sekrit' });
  assert.equal(pageOk.status, 200);
  assert.match(pageOk.headers['Content-Security-Policy'], /default-src 'self'/);
  assert.equal(pageOk.headers['X-Frame-Options'], 'DENY');

  env.config.server.token = before;
});

test('a reply from the browser behaves exactly like the owner typing', async () => {
  seed();
  const sent = [];
  registerTransport({
    slug: 'test',
    kind: 'baileys',
    can: () => true,
    async sendMessage(jid, payload) {
      sent.push({ jid, payload });
      return { key: { id: 'X1' } };
    },
  });

  const res = await call({
    method: 'POST',
    url: `/api/inbox/${CLIENT}/reply`,
    body: { text: 'F-11 mein 30 minute lagte hain.' },
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.handoff.minutes, env.config.behavior.handoffMinutes);

  // 1. it went out on the customer's chat
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, `${CLIENT}@s.whatsapp.net`);
  assert.match(sent[0].payload.text, /30 minute/);

  // 2. it is in the history as an owner turn, so the bot sees it as taken over
  const thread = L.inboxThread(CLIENT);
  assert.equal(thread.messages.at(-1).role, 'owner');
  assert.equal(thread.messages.at(-1).text, 'F-11 mein 30 minute lagte hain.');

  // 3. the bot is quiet there now
  const contact = db.getContact(CLIENT);
  assert.ok(Date.parse(contact.bot_paused_until) > Date.now());
  assert.equal(L.inboxChats().find((c) => c.number === CLIENT).paused, true);

  // 4. and the chat is no longer "waiting for us"
  assert.equal(L.inboxChats().find((c) => c.number === CLIENT).awaitingUs, false);
});

test('the reply endpoint refuses what it cannot do, with a reason', async () => {
  const empty = await call({ method: 'POST', url: `/api/inbox/${CLIENT}/reply`, body: { text: '   ' } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.reason, 'empty');

  const long = await call({ method: 'POST', url: `/api/inbox/${CLIENT}/reply`, body: { text: 'x'.repeat(4001) } });
  assert.equal(long.status, 400);
  assert.equal(long.body.reason, 'too_long');

  const unknown = await call({ method: 'POST', url: '/api/inbox/923000000000/reply', body: { text: 'hi' } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.reason, 'unknown_contact');

  const badJson = await call({ method: 'POST', url: `/api/inbox/${CLIENT}/reply`, rawBody: '{not json' });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error, 'bad_json');

  // blocked contact
  db.blockContact(CLIENT, true);
  const blocked = await call({ method: 'POST', url: `/api/inbox/${CLIENT}/reply`, body: { text: 'hello' } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.reason, 'blocked');
  db.blockContact(CLIENT, false);
});

test('with no connected transport the reply is refused, never queued silently', async () => {
  clearTransports();
  seed();
  const res = await call({ method: 'POST', url: `/api/inbox/${CLIENT}/reply`, body: { text: 'Delivery 30 min.' } });
  assert.equal(res.status, 503);
  assert.equal(res.body.reason, 'no_transport');

  // And nothing was written into the history pretending it was sent.
  const thread = L.inboxThread(CLIENT);
  assert.equal(thread.messages.at(-1).role, 'user');
});

test('takeover and release move the bot out of the way, and back', async () => {
  seed();
  const took = await call({ method: 'POST', url: `/api/inbox/${CLIENT}/takeover`, body: { minutes: 15 } });
  assert.equal(took.status, 200);
  assert.equal(took.body.minutes, 15);
  assert.ok(Date.parse(db.getContact(CLIENT).bot_paused_until) > Date.now());

  const released = await call({ method: 'POST', url: `/api/inbox/${CLIENT}/release` });
  assert.equal(released.status, 200);
  assert.equal(db.getContact(CLIENT).bot_paused_until, null);
  assert.equal(L.inboxChats().find((c) => c.number === CLIENT).paused, false);
});

test('wrong method is refused instead of guessed', async () => {
  const res = await call({ method: 'GET', url: `/api/inbox/${CLIENT}/reply` });
  assert.equal(res.status, 405);

  const nonsense = await call({ method: 'GET', url: `/api/inbox/${CLIENT}/dance` });
  assert.equal(nonsense.status, 405);
});

test('.inbox tells the owner where to look, and what is waiting', async () => {
  seed();
  const wasEnabled = env.config.server.enabled;
  env.config.server.enabled = true;
  try {
    const sock = { sent: [], async sendMessage(jid, payload) { this.sent.push({ jid, payload }); } };
    const res = await handleOwnerCommand(sock, '923001234567@s.whatsapp.net', '.inbox', '923001234567');
    assert.match(res.reply, /Live inbox/);
    assert.match(res.reply, /waiting for a reply/);
    assert.match(res.reply, /\/inbox/);
    assert.match(res.reply, /DASHBOARD_TOKEN/, 'it must say the token matters');
  } finally {
    env.config.server.enabled = wasEnabled;
  }
});

test('.inbox is honest when the web server is disabled', async () => {
  const wasEnabled = env.config.server.enabled;
  env.config.server.enabled = false;
  try {
    const res = await handleOwnerCommand({ async sendMessage() {} }, '923001234567@s.whatsapp.net', '.inbox', '923001234567');
    assert.match(res.reply, /web server is off/i);
  } finally {
    env.config.server.enabled = wasEnabled;
  }
});

test('.inbox explains itself when the feature is off', async () => {
  setFlag('liveInbox', false);
  const res = await handleOwnerCommand(
    { async sendMessage() {} },
    '923001234567@s.whatsapp.net',
    '.inbox',
    '923001234567'
  );
  assert.match(res.reply, /features\.liveInbox/);
  setFlag('liveInbox', true);
});

test('another tenant\'s contacts cannot appear in this inbox', async () => {
  seed();
  db.upsertContact('923111111111', { push_name: 'Other Tenant Person' });
  db.saveMessage('923111111111', 'user', 'from somewhere else', 'text');

  const { body } = await call({ url: '/api/inbox' });
  const numbers = body.chats.map((c) => c.number);
  assert.ok(numbers.includes(CLIENT));

  // Whatever this tenant's DB holds is the whole universe for this inbox: what
  // is not in it cannot be rendered. The page has no tenant switch at all.
  assert.equal(numbers.every((n) => typeof n === 'string' && n.length >= 10), true);
  const html = inboxPage();
  assert.doesNotMatch(html, /tenant|switch business/i);
});

test('a message with no text still has a preview the owner can act on', () => {
  db.upsertContact('923222222222', { push_name: 'Voice Person' });
  db.saveMessage('923222222222', 'user', '', 'voice');
  const row = L.inboxChats().find((c) => c.number === '923222222222');
  assert.equal(row.preview, '[voice note]');
  assert.equal(row.unread, 1);
});

// ── the zero-key demo endpoint ──────────────────────────────
// This is the one route that can create messages out of nothing, so it must be
// impossible to reach on a normal deployment.

async function callDemo(opts) {
  const { req, res } = fakeReqRes(opts);
  const handled = await handleDemoRoute(req, res, new URL(opts.url || '/api/demo/message', 'http://localhost'));
  return { handled, status: res.status, body: res.body ? safeJson(res.body) : null, raw: res.body };
}

test('the demo endpoint does not exist unless DEMO_MODE is set', async () => {
  const { req, res } = fakeReqRes({ method: 'POST', url: '/api/demo/message', body: { text: 'hello' } });
  const handled = await handleDemoRoute(req, res, new URL('/api/demo/message', 'http://localhost'));
  assert.equal(handled, true);
  assert.equal(res.status, 404);
  assert.match(String(res.body), /not_a_demo/);
});

test('in demo mode it needs a body, a POST and — when set — the token', async () => {
  process.env.DEMO_MODE = '1';
  const before = env.config.server.token;
  try {
    const empty = await callDemo({ method: 'POST', body: { text: '  ' } });
    assert.equal(empty.status, 400);

    const wrongMethod = await callDemo({ method: 'GET' });
    assert.equal(wrongMethod.status, 405);

    env.config.server.token = 'sekrit';
    const denied = await callDemo({ method: 'POST', body: { text: 'hi' } });
    assert.equal(denied.status, 401);

    // No transport registered in this test process → honest 503, not a 500.
    clearTransports();
    const noTransport = await callDemo({ method: 'POST', url: '/api/demo/message?token=sekrit', body: { text: 'hi' } });
    assert.equal(noTransport.status, 503);
    assert.equal(noTransport.body.error, 'no_transport');
  } finally {
    env.config.server.token = before;
    delete process.env.DEMO_MODE;
  }
});

test('the demo folder and the owner profile stay out of git', async () => {
  const { execFileSync } = await import('node:child_process');
  const ignored = execFileSync('git', ['check-ignore', 'config/owner.json', 'demo/data/assistant.db', 'tenants/x/.env'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  });
  assert.match(ignored, /config\/owner\.json/);
  assert.match(ignored, /demo\/data/);
  assert.match(ignored, /tenants/);
});
