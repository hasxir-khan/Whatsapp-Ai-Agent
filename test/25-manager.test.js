// Phase 2 Step 3 — the manager agent.
//
// What these tests defend: routing works in the three languages this bot
// actually receives, the model is only called when the rules are genuinely
// unsure (quota), the decision survives a provider outage, a complaint always
// reaches the owner, and a specialist cannot use a tool its job does not need.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, fakeSock } from './helpers.js';

const dataDir = isolate('manager');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
process.env.GROQ_API_KEY = 'test-groq-key';

const db = await import('../src/utils/db.js');
await db.initDB();
const P = await import('../src/services/profile.js');
const M = await import('../src/core/manager.js');
const T = await import('../src/core/tools.js');
const { __setFetch } = await import('../src/core/llm.js');

function setProfile({ managerAgent = true, hours = 'Daily 12:00–23:00' } = {}) {
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify(
      {
        business: { name: 'Burger Point', type: 'Restaurant', hours, timezone: 'Asia/Karachi' },
        catalog: { items: [{ name: 'Zinger Burger', kind: 'product', price: 650, stock: 20 }] },
        features: { businessProfile: true, catalog: true, toolCalling: true, managerAgent },
      },
      null,
      2
    )
  );
  P.reloadProfile();
  M.clearRouteCache();
}

// A fetch that counts calls and answers with one word — the router's worst case.
let calls = 0;
let answer = 'booking';
function mockRouter({ word = () => answer, fail = null, delay = 0 } = {}) {
  calls = 0;
  __setFetch(async () => {
    calls += 1;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (fail === 'throw') throw new Error('provider down');
    if (fail === 'http') {
      return { ok: false, status: 429, headers: { get: () => null }, text: async () => 'rate limited' };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: word() } }] }),
    };
  });
}

// ── rules, in the languages customers actually type ────────
test('English messages are routed without asking the model', () => {
  const cases = [
    ['How much is the zinger burger?', 'sales'],
    ['I want to book a table for 4 on Friday', 'booking'],
    ['The app is not working, it gives an error', 'support'],
    ['This is the worst service I have ever had', 'complaint'],
    ['Hi', 'other'],
    ['thanks!', 'other'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(M.classifyByRules(text).intent, expected, text);
  }
});

test('Roman Urdu is routed without asking the model', () => {
  const cases = [
    ['burger ki price kya hai?', 'sales'],
    ['kal ke liye table book karna hai', 'booking'],
    ['app kaam nahi kar rahi, madad chahiye', 'support'],
    ['aap ki service bohat kharab hai, shikayat karni hai', 'complaint'],
    ['kitna charge karte ho?', 'sales'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(M.classifyByRules(text).intent, expected, text);
  }
});

test('Urdu script is routed without asking the model', () => {
  const cases = [
    ['برگر کی قیمت کتنی ہے؟', 'sales'],
    ['کل کے لیے بکنگ کرنی ہے', 'booking'],
    ['آپ کی سروس خراب ہے، شکایت ہے', 'complaint'],
    ['مدد چاہیے، کام نہیں کر رہا', 'support'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(M.classifyByRules(text).intent, expected, text);
  }
});

test('an angry tone is a complaint even when the words are neutral', () => {
  const res = M.classifyByRules('ok fine whatever', { mood: 'angry' });
  assert.equal(res.intent, 'complaint');
  assert.equal(res.sure, true);
});

test('a complaint outranks a price question in the same message', () => {
  const res = M.classifyByRules('you charged me twice, what is this price on the bill?');
  assert.equal(res.intent, 'complaint');
});

test('a genuinely vague message is honest about being unsure', () => {
  const res = M.classifyByRules('hmm that thing we discussed');
  assert.equal(res.sure, false);
});

// ── quota: the model is a last resort ──────────────────────
test('rules-only messages make zero router calls', async () => {
  setProfile();
  mockRouter();
  for (const text of ['burger ki price kya hai?', 'table book karni hai', 'kya haal hai']) {
    await M.routeMessage({ text, chatId: 'a@s.whatsapp.net' });
  }
  assert.equal(calls, 0, 'three clear messages, zero tokens spent');
});

test('the model is called once for a vague message, then remembered for the chat', async () => {
  setProfile();
  answer = 'sales';
  mockRouter({ word: () => 'sales' });

  const first = await M.routeMessage({ text: 'hmm that thing we discussed', chatId: 'b@s.whatsapp.net' });
  assert.equal(first.intent, 'sales');
  assert.equal(first.source, 'llm');
  assert.equal(calls, 1);

  const second = await M.routeMessage({ text: 'and the other one too', chatId: 'b@s.whatsapp.net' });
  assert.equal(second.intent, 'sales');
  assert.equal(second.source, 'cache', 'the conversation remembers its specialist');
  assert.equal(calls, 1, 'no second router call');

  // a different chat pays its own way
  await M.routeMessage({ text: 'hmm that thing we discussed', chatId: 'c@s.whatsapp.net' });
  assert.equal(calls, 2);
});

test('the cache expires, so a customer who changes subject is re-read', async () => {
  setProfile();
  mockRouter({ word: () => 'support' });
  await M.routeMessage({ text: 'hmm that thing we discussed', chatId: 'd@s.whatsapp.net' });
  assert.equal(calls, 1);

  const entry = M.cachedRoute('d@s.whatsapp.net');
  entry.at -= 16 * 60 * 1000; // pretend the conversation went quiet for 16 minutes
  await M.routeMessage({ text: 'hmm that other thing', chatId: 'd@s.whatsapp.net' });
  assert.equal(calls, 2);
});

// ── the router must never be the reason a reply fails ──────
test('a provider that throws falls back to the default brain', async () => {
  setProfile();
  M.clearRouteCache();
  mockRouter({ fail: 'throw' });
  const res = await M.routeMessage({ text: 'hmm that thing we discussed', chatId: 'e@s.whatsapp.net' });
  assert.equal(res.intent, 'other');
  assert.equal(res.source, 'fallback');
  assert.equal(res.tools, null, 'the default brain keeps every tool');
});

test('a 429 falls back instead of retrying forever', async () => {
  setProfile();
  M.clearRouteCache();
  mockRouter({ fail: 'http' });
  const res = await M.routeMessage({ text: 'hmm that thing we discussed', chatId: 'f@s.whatsapp.net' });
  assert.equal(res.intent, 'other');
  assert.equal(res.source, 'fallback');
});

test('a slow router is cut off instead of stalling the reply', async () => {
  setProfile();
  M.clearRouteCache();
  mockRouter({ delay: 250, word: () => 'booking' });
  const started = Date.now();
  // The production leash is 3 s; the test brings it down to 50 ms so the
  // suite stays fast while proving the same code path.
  const res = await M.routeMessage({
    text: 'hmm that thing we discussed',
    chatId: 'g@s.whatsapp.net',
    routerTimeoutMs: 50,
  });
  assert.equal(res.intent, 'other', 'better a default answer than a stalled chat');
  assert.ok(Date.now() - started < 200, 'gave up early rather than waiting');
});

test('the router can be switched off entirely', async () => {
  setProfile();
  M.clearRouteCache();
  mockRouter({ word: () => 'sales' });
  const res = await M.routeMessage({ text: 'hmm that thing we discussed', chatId: 'h@s.whatsapp.net', useModel: false });
  assert.equal(res.source, 'fallback');
  assert.equal(calls, 0);
});

// ── specialists get the tools their job needs ──────────────
test('each agent gets only the tools it needs', () => {
  assert.deepEqual(M.agentFor('complaint').tools, ['handoff'], 'a complaint cannot sell');
  assert.ok(M.agentFor('booking').tools.includes('book_slot'));
  assert.ok(!M.agentFor('booking').tools.includes('create_order'));
  assert.equal(M.agentFor('other').tools, null, 'the general brain keeps everything');
});

test('a tool outside the agent\'s list is refused', async () => {
  setProfile();
  const res = await T.executeTool(
    'send_quote',
    { service: 'Zinger Burger', goal: 'x', budget: '1000' },
    { chat: 'i@s.whatsapp.net', allowedTools: M.allowedTools('complaint'), send: async () => {} }
  );
  assert.equal(res.status, 'rejected');
  assert.match(res.message, /not available/);
});

test('the complaint agent is told not to sell', () => {
  const prompt = M.agentFor('complaint').prompt;
  assert.match(prompt, /Stop selling/);
  assert.match(prompt, /Apologise/);
  assert.match(prompt, /hand off/i);
  assert.match(prompt, /no prices, no offers/i);
});

// ── the log and the two commands ───────────────────────────
test('every routed message is logged, and .intents counts today', async () => {
  setProfile();
  db.run('DELETE FROM message_intents');
  for (const [text, chat] of [
    ['burger ki price kya hai?', 'j@s.whatsapp.net'],
    ['table book karni hai', 'k@s.whatsapp.net'],
    ['ye service bohat kharab hai, shikayat', 'l@s.whatsapp.net'],
  ]) {
    const route = await M.routeMessage({ text, chatId: chat });
    db.logIntent({ tenant: 'test', chat, intent: route.intent, agent: route.agent, source: route.source, confidence: route.confidence });
  }

  const counts = db.intentStatsForDay();
  const summary = M.intentSummary(counts);
  assert.equal(summary.byIntent.sales, 1);
  assert.equal(summary.byIntent.booking, 1);
  assert.equal(summary.byIntent.complaint, 1);
  assert.equal(summary.bySource.rules, 3);
  assert.equal(summary.bySource.llm, 0, 'no tokens were spent on three obvious messages');
});

test('.intents and .status report the router', async () => {
  setProfile();
  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const sock = fakeSock();
  const OWNER = '923169896229@s.whatsapp.net';

  const intents = (await handleOwnerCommand(sock, OWNER, '.intents')).reply;
  assert.match(intents, /Intents today/);
  assert.match(intents, /Routing: ✅ on/);
  assert.match(intents, /Decided by: \d+ rules/);

  const status = (await handleOwnerCommand(sock, OWNER, '.status')).reply;
  assert.match(status, /Routing: manager agent on/);
});

test('with the flag off nothing is routed and the command says so', async () => {
  setProfile({ managerAgent: false });
  assert.equal(M.managerEnabled(), false);

  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const sock = fakeSock();
  const res = await handleOwnerCommand(sock, '923169896229@s.whatsapp.net', '.intents');
  assert.match(res.reply, /Routing: ⏸ off/);

  setProfile({ managerAgent: true });
  assert.equal(M.managerEnabled(), true);
});

// ── the old name still works, so no config breaks ──────────
test('features.manager keeps working as an alias', () => {
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify({ business: { name: 'X' }, features: { manager: true } }, null, 2)
  );
  P.reloadProfile();
  assert.equal(M.managerEnabled(), true);
});

// ── the specialist's instructions and tools reach the model ─
test('the specialist prompt and tool subset arrive at the provider', async () => {
  setProfile();
  const bodies = [];
  __setFetch(async (url, options = {}) => {
    bodies.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'I am sorry about that.' } }] }),
    };
  });

  const { generateReply } = await import('../src/core/brain.js');
  await generateReply({
    number: '923001119999',
    text: 'my order was cold and late',
    langInfo: { code: 'en', name: 'English', script: 'latin', reply: 'English' },
    dossier: {},
    agent: 'complaint',
    chatId: 'm@s.whatsapp.net',
    send: async () => {},
  });

  const system = bodies[0].messages[0].content;
  assert.match(system, /COMPLAINT MODE/, 'the complaint instructions are in the system prompt');
  assert.ok(!/SALES MODE/.test(system));

  const offered = (bodies[0].tools || []).map((t) => t.function.name);
  if (offered.length) {
    assert.deepEqual(offered.sort(), ['handoff'], 'a complaint cannot quote, order or book');
  }

  // The plain brain still gets everything.
  __setFetch(async (url, options = {}) => {
    bodies.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Sure.' } }] }),
    };
  });
  await generateReply({
    number: '923001119999',
    text: 'how much is the burger',
    langInfo: { code: 'en', name: 'English', script: 'latin', reply: 'English' },
    dossier: {},
    agent: 'other',
    chatId: 'n@s.whatsapp.net',
    send: async () => {},
  });
  const all = (bodies[1].tools || []).map((t) => t.function.name);
  if (all.length) assert.ok(all.includes('send_quote'), 'the general agent keeps the full set');
});

// ── end to end: a complaint reaches the owner ──────────────
test('a complaint is answered by the complaint agent and handed to the owner', async () => {
  setProfile();
  const { mockTransport } = await import('../src/dev/mockLlm.js');
  mockTransport();
  const { handleIncoming } = await import('../src/handlers/messageHandler.js');
  const { incomingMessage, textMessages, CLIENT, waitFor, settle } = await import('./helpers.js');

  const sock = fakeSock();
  const before = db.intentStatsForDay().find((r) => r.intent === 'complaint')?.count || 0;

  await handleIncoming(
    sock,
    incomingMessage('Your rider brought the wrong order and it was cold. This is the worst service in Islamabad.', {
      key: { remoteJid: CLIENT.jid, fromMe: false, id: `CMP-${Date.now()}` },
    })
  );

  await waitFor(() => sock.sent.some((m) => m.jid === '923169896229@s.whatsapp.net'));
  await settle(100);

  const toOwner = textMessages(sock.sent, '923169896229');
  assert.ok(
    toOwner.some((t) => /Complaint —/.test(t)),
    `owner should get a complaint summary, got: ${JSON.stringify(toOwner)}`
  );
  const handoff = toOwner.find((t) => /Complaint —/.test(t));
  assert.match(handoff, /wrong order/, 'the summary quotes what the customer actually said');

  const after = db.intentStatsForDay().find((r) => r.intent === 'complaint')?.count || 0;
  assert.equal(after, before + 1, 'the complaint is logged as an intent');

  const toClient = textMessages(sock.sent, CLIENT.number);
  assert.ok(toClient.length >= 1, 'the customer still gets a reply');
});
