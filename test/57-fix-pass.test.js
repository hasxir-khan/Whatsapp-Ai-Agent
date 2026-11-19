// test/57-fix-pass.test.js
// The fix pass, unit by unit. Each group here stands for one bug found in a
// live chat with a real model:
//
//   1. price integrity      — guards, published bands, no second range
//   2. sticky language      — dominance over the last N messages
//   3. one reply per batch  — the reply channel
//   4. scope guard          — off-topic requests, and nothing cut mid-sentence
//   5. documents            — chunking, grounding, "here is what I understood"
//   6. persona              — one voice, in the prompt and in the reply
//   7. missed calls         — the rescue, once, and never over a customer
//   8. providers            — timeout → fallback, stickiness, late responses
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Keys for all three providers must exist before config is read: the point of
// the provider tests is the chain, and the chain is empty without keys.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-fixes-'));
process.env.DATA_DIR = dir;
process.env.TMP_DIR = path.join(dir, 'tmp');
process.env.SESSION_FOLDER = path.join(dir, 'sessions');
process.env.MY_NUMBER = '923001234567';
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
process.env.DEBOUNCE_MS = '20';
process.env.MIN_DELAY_MS = '1';
process.env.MAX_DELAY_MS = '5';
process.env.TYPING_CPS = '100000';
process.env.NOTIFY_NEW_CHATS = 'false';
process.env.QUIET_HOURS = '';
process.env.VOICE_REPLY_MODE = 'off';
process.env.ENABLE_WEB = 'false';
process.env.CONFIG_DIR = path.join(dir, 'config');

const db = await import('../src/utils/db.js');
await db.initDB();

const profile = await import('../src/services/profile.js');
const guard = await import('../src/core/replyGuard.js');
const scope = await import('../src/core/scope.js');
const stick = await import('../src/services/languageStick.js');
const channel = await import('../src/core/replyChannel.js');
const docs = await import('../src/services/documents.js');
const brain = await import('../src/core/brain.js');
const llm = await import('../src/core/llm.js');
const trace = await import('../src/services/providerTrace.js');
const calls = await import('../src/services/calls.js');
const envModule = await import('../src/config/env.js');

const PROFILE = {
  owner: { name: 'Fix Owner', number: '923001234567', voice: 'we' },
  business: { name: 'Fix Cafe', currency: 'PKR', hours: 'Daily 12:00–23:00' },
  catalog: {
    items: [
      { name: 'Chicken Karahi', kind: 'product', price: 1450 },
      { name: 'E-commerce store', kind: 'service', min: 120000, max: 350000 },
    ],
  },
  policies: { payment: '50% to start, 50% on delivery.', revisions: 'Two revision rounds per deliverable.' },
  bot: { firstPerson: 'we' },
};

function writeProfile(patch = {}) {
  const cfgDir = process.env.CONFIG_DIR;
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'owner.json'), JSON.stringify({ ...PROFILE, ...patch }, null, 2));
  profile.reloadProfile();
}

writeProfile();

// ── 1. price integrity ──────────────────────────────────────

test('a number that exists nowhere in the business facts is refused', () => {
  const allowed = guard.allowedFacts({});
  assert.ok(allowed.numbers.has('1450'));
  assert.ok(guard.checkClaims('Karahi is 1450 PKR.', { allowed, chat: null }).length === 0);
  const problems = guard.checkClaims('Karahi is 1234 PKR.', { allowed, chat: null });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /1234/);
});

test('a range that contradicts an earlier one in the same chat is refused', () => {
  const chat = '923005550001';
  guard.clearClaims(chat);
  guard.rememberClaims(chat, 'The store is 120000 to 350000 PKR.');
  const allowed = guard.allowedFacts({ chat });
  const changed = guard.checkClaims('With extras it is 120000 – 180000 PKR.', { allowed, chat });
  assert.ok(changed.some((p) => /range changed/.test(p)), changed.join('; '));
  // Saying the same range again is fine.
  const same = guard.checkClaims('Still 120000 to 350000 PKR.', { allowed, chat });
  assert.equal(same.length, 0, same.join('; '));
});

test('percentages and terms come from the policies, not from the model', () => {
  const allowed = guard.allowedFacts({});
  assert.ok(allowed.percents.has('50'));
  assert.equal(guard.checkClaims('Payment is 50% to start, 50% on delivery.', { allowed, chat: null }).length, 0);
});

test('a reply with an invented number is replaced by a safe line in the right language', () => {
  const verdict = guard.guardReply({ text: 'It is 98765 PKR.', langInfo: { code: 'en' }, chat: null });
  assert.equal(verdict.ok, false);
  assert.match(guard.safeLine('ur'), /[\u0600-\u06FF]/);
  assert.match(guard.safeLine('roman-ur'), /check/);
});

// ── 2. sticky language ──────────────────────────────────────

function seedTurn(number, role, content, kind = 'text') {
  db.run('INSERT INTO messages (number, role, kind, content, created_at) VALUES (?,?,?,?,?)', [
    number,
    role,
    kind,
    content,
    new Date().toISOString(),
  ]);
}

test('a short message never changes the conversation language', () => {
  const number = '923005550002';
  seedTurn(number, 'user', 'I need a website with online ordering and payments please');
  seedTurn(number, 'user', 'The deadline is end of next month for the launch');
  db.upsertContact(number, { language: 'en' });
  const lang = stick.replyLanguage(number, 'Yes');
  assert.equal(lang.code, 'en');
  assert.equal(lang.sticky, true);
  assert.equal(lang.source, 'conversation');
});

test('Roman Urdu stays Roman Urdu behind a one-word answer', () => {
  const number = '923005550003';
  seedTurn(number, 'user', 'Bhai karahi ka rate kya hai aaj ke din');
  seedTurn(number, 'user', 'Delivery karo mere ghar par shaam ko theek hai');
  const lang = stick.replyLanguage(number, 'haan');
  assert.equal(lang.code, 'roman-ur');
});

test('a forwarded document does not vote on the language', () => {
  const number = '923005550004';
  seedTurn(number, 'user', 'میں ایک ویب سائٹ بنوانا چاہتا ہوں جس میں آن لائن آرڈر ہو');
  seedTurn(number, 'user', 'My requirement document says the store must support card payments and delivery', 'document');
  const lang = stick.replyLanguage(number, '', { kind: 'document' });
  assert.equal(lang.code, 'ur');
});

// ── 3. one reply per customer batch ─────────────────────────

test('the reply channel sends once and blocks the second pipeline', async () => {
  channel._resetForTests();
  const sent = [];
  const ch = channel.createReplyChannel({
    chat: '923005550005',
    batch: 'batch-1',
    transport: {},
    jid: '923005550005@s.whatsapp.net',
    sendTyping: async (_t, _j, text) => {
      sent.push(text);
      return { key: { id: `m${sent.length}` } };
    },
  });
  await ch.say('First answer');
  const second = await ch.say('Second answer from another pipeline');
  assert.equal(sent.length, 1);
  assert.equal(second, null);
  assert.equal(ch.blocked.length, 1);
  assert.ok(db.all("SELECT * FROM events WHERE type = 'duplicate_reply_blocked'").length >= 1);
});

test('a batch that was already answered is not answered twice', async () => {
  channel._resetForTests();
  const first = channel.beginBatch('923005550006', 'msg-42');
  assert.equal(first.skip, false);
  channel.markAnswered('923005550006', 'msg-42');
  assert.equal(channel.beginBatch('923005550006', 'msg-42').skip, true);
  assert.equal(channel.beginBatch('923005550006', 'msg-43').skip, false);
});

// ── 4. scope guard, and nothing cut mid-sentence ────────────

test('counting to 100, jokes and homework are refused and redirected', () => {
  for (const text of ['Say 1 to 100', 'tell me a joke', 'write my homework for me', 'write me some python code']) {
    const verdict = scope.classifyScope(text);
    assert.equal(verdict.offTopic, true, text);
  }
  for (const text of ['how much is the karahi?', 'I want to book a table for four', 'is the burger in stock?']) {
    assert.equal(scope.classifyScope(text).offTopic, false, text);
  }
  const refusal = scope.scopeRefusal('en');
  assert.match(refusal, /orders|bookings|prices/i);
  assert.doesNotMatch(refusal, /^1, 2, 3/);
});

test('a reply that stops mid-list or mid-sentence is a cut, a finished one is not', () => {
  assert.equal(guard.endsMidSentence('The platter has 1, 2, 3, 4, 5, 6,').cut, true);
  assert.equal(guard.endsMidSentence('It comes with naan and').cut, true);
  assert.equal(guard.endsMidSentence('It comes with (naan and salad').cut, true);
  assert.equal(guard.endsMidSentence('The platter has chicken, kebab and naan.').cut, false);
  assert.equal(guard.endsMidSentence('Got it').cut, false);
  assert.equal(guard.endsMidSentence('واہ، بہت اچھا').cut, false);
});

// ── 5. documents ────────────────────────────────────────────

test('a long document is split into overlapping chunks, not truncated', () => {
  const body = Array.from({ length: 400 }, (_, i) => `Requirement ${i}: the store must support checkout.`).join('\n');
  const chunks = docs.chunkText(body, { size: 2000, overlap: 200, maxChunks: 50 });
  assert.ok(chunks.length > 3, `expected several chunks, got ${chunks.length}`);
  assert.ok(chunks.every((c) => c.length <= 2000));
  assert.ok(chunks.join('').includes('Requirement 399'));
});

test('a summary may not contain a number the document does not', () => {
  const source = 'The brief says the budget is 120000 PKR and delivery is in 6 weeks.';
  const kept = docs.stripUngrounded('• Budget 120000 PKR\n• Delivery in 6 weeks\n• Budget 45000 PKR', source);
  assert.match(kept, /120000/);
  assert.doesNotMatch(kept, /45000/);
});

test('a document is answered with "here is what I understood" and a question', () => {
  const line = docs.understoodReply('• catalogue\n• checkout', 'en');
  assert.match(line, /Here is what I understood/);
  assert.match(line, /Is that right\?/);
  const ur = docs.understoodReply('• فہرست', 'ur');
  assert.match(ur, /[\u0600-\u06FF]/);
});

// ── 6. persona ──────────────────────────────────────────────

test('the prompt carries one voice, and the reply scanner catches mixed voices', () => {
  const prompt = brain.systemPrompt({ dossier: { number: '923001234567', category: 'client' }, langInfo: { code: 'en' } });
  assert.match(prompt, /use "we"/);
  assert.match(prompt, /never "I"/);
  writeProfile({ bot: { firstPerson: 'i' } });
  const iPrompt = brain.systemPrompt({ dossier: { number: '923001234567', category: 'client' }, langInfo: { code: 'en' } });
  assert.match(iPrompt, /use "I"/);
  writeProfile();

  assert.equal(guard.checkPersona('The platter is 1450 PKR and we can add naan.').length, 0);
  const mixed = guard.checkPersona('I will check with our kitchen and come back to you.');
  assert.equal(mixed.length, 1);
  assert.match(mixed[0], /mixes/);
});

// ── 7. missed calls ─────────────────────────────────────────

function callSock() {
  const sent = [];
  return {
    sent,
    can: () => true,
    async sendMessage(jid, payload) {
      sent.push({ jid, payload });
      return { key: { id: `C${sent.length}` } };
    },
    async sendPresenceUpdate() {},
    async readMessages() {},
  };
}

test('the rescue waits 60 seconds by default', () => {
  const { config } = envModule;
  assert.equal(config.calls.delaySeconds, 60);
  assert.equal(config.calls.enabled, true);
});

test('a missed call is rescued once, and a second rescue for the same call is refused', async () => {
  calls.__resetCalls();
  db.setSetting('calls_enabled', true);
  const sock = callSock();
  const number = '923005550007';
  db.upsertContact(number, { jid: `${number}@s.whatsapp.net`, category: 'lead' });
  const first = await calls.handleMissedCall(sock, number, { id: 'call-a', reason: 'timeout' });
  assert.equal(first.sent, true);
  const before = sock.sent.length;
  const again = await calls.handleMissedCall(sock, number, { id: 'call-a', reason: 'timeout' });
  assert.equal(again.sent, false);
  assert.equal(sock.sent.length, before, 'no second rescue for the same call');
});

test('the rescue is dropped when the customer writes first', async () => {
  calls.__resetCalls();
  const sock = callSock();
  const number = '923005550008';
  db.upsertContact(number, { jid: `${number}@s.whatsapp.net`, category: 'lead' });
  const callId = 'call-b';
  db.recordCall({ id: callId, number, status: 'offer' });
  // The customer messages us after the call started.
  await new Promise((r) => setTimeout(r, 15));
  seedTurn(number, 'user', 'Hi, I just called you — can you tell me the price of the karahi?');
  const res = await calls.handleMissedCall(sock, number, { id: callId, reason: 'timeout' });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'customer wrote first');
  assert.equal(sock.sent.length, 0);
});

test('a pending rescue timer is cancelled when the customer writes', async () => {
  calls.__resetCalls();
  const sock = callSock();
  const number = '923005550009';
  db.upsertContact(number, { jid: `${number}@s.whatsapp.net`, category: 'lead' });
  await calls.handleCallEvents(sock, [{ id: 'call-c', from: number, status: 'offer', video: false }]);
  assert.equal(calls.pendingCalls().length, 1);
  const cancelled = calls.cancelCallRescue(number, 'customer wrote first');
  assert.equal(cancelled, 1);
  assert.equal(calls.pendingCalls().length, 0);
  assert.equal(sock.sent.filter((m) => String(m.jid).startsWith(number)).length, 0);
});

// ── 8. providers ────────────────────────────────────────────

const GEMINI_OK = {
  candidates: [{ content: { parts: [{ text: 'Gemini answered.' }] } }],
  usageMetadata: { totalTokenCount: 21 },
};
const OPENROUTER_OK = {
  choices: [{ message: { content: 'OpenRouter answered.' } }],
  usage: { total_tokens: 11 },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('a timed-out primary falls back, and the new provider sticks for that chat', async () => {
  llm._resetProviderState();
  trace._resetForTests();
  const seen = [];
  llm.__setFetch(async (url) => {
    seen.push(String(url));
    if (String(url).includes('api.groq.com')) {
      const err = new Error('provider timed out');
      err.name = 'TimeoutError';
      throw err;
    }
    if (String(url).includes('generativelanguage')) return jsonResponse(GEMINI_OK);
    return jsonResponse(OPENROUTER_OK);
  });

  const first = await llm.chat({ messages: [{ role: 'user', content: 'hello' }], chatKey: '923005550010', kind: 'reply' });
  assert.equal(first.provider, 'gemini');
  assert.equal(first.text, 'Gemini answered.');

  // Second call in the same chat goes straight to Gemini: the switch sticks.
  seen.length = 0;
  const second = await llm.chat({ messages: [{ role: 'user', content: 'again' }], chatKey: '923005550010', kind: 'reply' });
  assert.equal(second.provider, 'gemini');
  assert.equal(seen.filter((u) => u.includes('api.groq.com')).length, 0, 'the timed-out provider is not retried first');

  // A different chat starts from the top of the chain again.
  seen.length = 0;
  await llm.chat({ messages: [{ role: 'user', content: 'other chat' }], chatKey: '923005550011', kind: 'reply' });
  assert.ok(seen[0].includes('api.groq.com'), 'another conversation is not pinned to this chat’s provider');

  const rows = trace.last(5);
  assert.ok(rows.some((r) => r.provider === 'gemini' && r.ms >= 0));
  assert.match(trace.formatLast({ limit: 5 }), /gemini\//);
  llm.__setFetch(null);
});

test('OpenRouter is last, and only an allowlisted model is used', async () => {
  llm._resetProviderState();
  const seen = [];
  llm.__setFetch(async (url, opts) => {
    seen.push(String(url));
    if (String(url).includes('api.groq.com')) return jsonResponse({ choices: [{ message: { content: 'groq ok' } }] });
    if (String(url).includes('generativelanguage')) return jsonResponse(GEMINI_OK);
    const body = JSON.parse(opts.body || '{}');
    assert.ok(llm.openrouterModels().includes(body.model), `unlisted model ${body.model}`);
    return jsonResponse(OPENROUTER_OK);
  });

  const chain = [];
  llm.__setFetch(async (url) => {
    chain.push(String(url));
    if (String(url).includes('api.groq.com')) throw Object.assign(new Error('nope'), { status: 500 });
    if (String(url).includes('generativelanguage')) throw Object.assign(new Error('nope'), { status: 500 });
    return jsonResponse(OPENROUTER_OK);
  });
  const res = await llm.chat({ messages: [{ role: 'user', content: 'hi' }], chatKey: '923005550012' });
  assert.equal(res.provider, 'openrouter');
  assert.ok(chain.length >= 2);
  assert.ok(chain[chain.length - 1].includes('openrouter.ai'), 'OpenRouter answered last');
  llm.__setFetch(null);
});

test('a late answer from a superseded request is discarded instead of sent', async () => {
  llm._resetProviderState();
  let release = null;
  llm.__setFetch(async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    if (String(body.messages?.[0]?.content || '').includes('slow')) {
      await new Promise((r) => {
        release = r;
      });
    }
    return jsonResponse({ choices: [{ message: { content: body.messages?.[0]?.content || 'ok' } }] });
  });

  const slow = llm.chat({
    messages: [{ role: 'user', content: 'slow' }],
    chatKey: '923005550013',
    singleFlight: true,
  });
  await new Promise((r) => setTimeout(r, 10));
  const fast = await llm.chat({
    messages: [{ role: 'user', content: 'fast' }],
    chatKey: '923005550013',
    singleFlight: true,
  });
  assert.equal(fast.text, 'fast');
  release();
  await assert.rejects(slow, (err) => err.stale === true);
  llm.__setFetch(null);
});

test('every provider gets the same explicit output budget', async () => {
  llm._resetProviderState();
  const budgets = [];
  llm.__setFetch(async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    budgets.push(body.max_tokens || body.generationConfig?.maxOutputTokens);
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  });
  await llm.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 1000, chatKey: '923005550014' });
  await llm.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 1000, chatKey: '923005550015' });
  assert.deepEqual(budgets, [1000, 1000]);
  llm.__setFetch(null);
});

// ── the owner-facing surfaces ───────────────────────────────

test('.debug last shows provider, model, latency and tokens', async () => {
  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const res = await handleOwnerCommand({}, '923001234567@s.whatsapp.net', '.debug last', '923001234567');
  assert.equal(res.handled, true);
  assert.match(res.reply, /gemini|groq|openrouter/);
  assert.match(res.reply, /ms/);
});

test('.calls shows the rescue timeline', async () => {
  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const number = '923005550016';
  db.upsertContact(number, { jid: `${number}@s.whatsapp.net`, category: 'lead' });
  db.recordCall({ id: 'call-timeline', number, status: 'offer' });
  db.updateCall('call-timeline', { status: 'handled', outcome: 'timeout → text' });
  const res = await handleOwnerCommand({}, '923001234567@s.whatsapp.net', '.calls', '923001234567');
  assert.equal(res.handled, true);
  assert.match(res.reply, /Recent calls/);
  assert.match(res.reply, /→/);
  assert.match(res.reply, /rescue|Rescue/);
});
