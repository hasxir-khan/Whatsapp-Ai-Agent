// Phase 7 Part 2 — the tenant's own key chain (bot side).
//
// What this file defends: a primary/backup key pair really falls back, a key
// that was rejected is not retried while a backup exists, one key alone is
// still tried (a 429 must not become a minute of silence), every failure has a
// category a human can act on, the provider that answered is the one recorded
// in usage, and `llm.keySource: platform` is refused with a sentence instead of
// a shrug.
//
// No network: the provider is a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, fakeSock } from './helpers.js';
import path from 'node:path';

const dataDir = isolate('keychain');
process.env.CONFIG_DIR = path.join(dataDir, 'config');
process.env.ENV_FILE = path.join(dataDir, '.env');
process.env.REPLY_TIMING = 'off';
process.env.DEFER_QUIET_HOURS = 'false';
process.env.GROQ_API_KEY = 'gsk_primary_FIXTURE_1111';
process.env.GROQ_API_KEY_2 = 'gsk_backup_FIXTURE_2222';
process.env.GEMINI_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';

const db = await import('../src/utils/db.js');
await db.initDB();
const llm = await import('../src/core/llm.js');
const keys = await import('../src/services/keyChain.js');
const usageEvents = await import('../src/services/usageEvents.js');

function ok(text = 'hello') {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      choices: [{ message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }),
  };
}

function fail(status, body = '') {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => body,
  };
}

const ask = (over = {}) => llm.chat({ messages: [{ role: 'user', content: 'hi' }], ...over });

test('the primary answers, and usage says which slot it was', async () => {
  keys.__resetKeyChain();
  const calls = [];
  llm.__setFetch(async (url, options) => {
    calls.push(options.headers.Authorization);
    return ok('primary');
  });
  try {
    const res = await ask();
    assert.equal(res.text, 'primary');
    assert.equal(res.keySlot, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /gsk_primary_FIXTURE_1111/);
  } finally {
    llm.__setFetch(null);
  }
});

test('a rejected primary falls through to the backup, and is not retried', async () => {
  keys.__resetKeyChain();
  const used = [];
  llm.__setFetch(async (url, options) => {
    const key = options.headers.Authorization;
    used.push(key.includes('primary') ? 'primary' : 'backup');
    if (key.includes('primary')) return fail(401, 'invalid api key');
    return ok('backup answered');
  });
  try {
    const first = await ask();
    assert.equal(first.text, 'backup answered');
    assert.equal(first.keySlot, 2);
    assert.deepEqual(used, ['primary', 'backup']);

    // Second call: the rejected key is skipped, so only the backup is dialled.
    const second = await ask();
    assert.equal(second.text, 'backup answered');
    assert.deepEqual(used, ['primary', 'backup', 'backup'], 'the invalid key is not dialled again');
    const status = keys.keyStatus('groq');
    assert.equal(status[0].state, 'invalid');
    assert.equal(status[1].state, 'active');
  } finally {
    llm.__setFetch(null);
    keys.__resetKeyChain();
  }
});

test('a rate-limited primary is skipped for the backup, and recovers afterwards', async () => {
  keys.__resetKeyChain();
  const used = [];
  let primaryLimited = true;
  llm.__setFetch(async (url, options) => {
    const isPrimary = options.headers.Authorization.includes('primary');
    used.push(isPrimary ? 'primary' : 'backup');
    if (isPrimary && primaryLimited) return fail(429, 'rate limit reached');
    return ok(isPrimary ? 'primary again' : 'backup answered');
  });
  try {
    const first = await ask();
    assert.equal(first.text, 'backup answered');
    assert.deepEqual(used, ['primary', 'backup']);
    assert.equal(keys.keyStatus('groq')[0].state, 'rate_limited');

    // Within the cooldown the backup answers without dialling the primary.
    const second = await ask();
    assert.equal(second.text, 'backup answered');
    assert.deepEqual(used, ['primary', 'backup', 'backup']);

    // After the cooldown — real traffic, not a health ping — the primary is back.
    primaryLimited = false;
    keys.note('groq', 1, 'rate_limited', { now: Date.now() - 10 * 60000, retryAfterMs: 1000 });
    const third = await ask();
    assert.equal(third.text, 'primary again');
    assert.equal(third.keySlot, 1);
    assert.deepEqual(used.slice(-1), ['primary']);
  } finally {
    llm.__setFetch(null);
    keys.__resetKeyChain();
  }
});

test('a single key is still tried even after a 429 — no silent minute', async () => {
  keys.__resetKeyChain();
  const env = { GROQ_API_KEY: 'gsk_only_FIXTURE_9999' };
  keys.note('groq', 1, 'rate_limited', { reason: 'busy' });
  const available = keys.availableKeys('groq', { env: { ...env, GROQ_API_KEY_2: '' } });
  assert.equal(available.length, 1, 'the only key is still a candidate');
  keys.__resetKeyChain();
});

test('failure categories are what the owner can act on', () => {
  assert.equal(keys.classifyError({ status: 401 }), 'invalid');
  assert.equal(keys.classifyError({ status: 403, body: 'invalid api key' }), 'invalid');
  assert.equal(keys.classifyError({ status: 403, body: 'quota exceeded for key' }), 'quota');
  assert.equal(keys.classifyError({ status: 402 }), 'quota');
  assert.equal(keys.classifyError({ status: 429, body: 'rate limit reached' }), 'rate_limited');
  assert.equal(keys.classifyError({ status: 429, body: 'You exceeded your current quota' }), 'quota');
  assert.equal(keys.classifyError({ status: 503 }), 'failing');
  assert.equal(keys.classifyError({ name: 'TimeoutError', message: 'aborted' }), 'failing');
  // A model problem is not a key problem — the model fallback owns it.
  assert.equal(keys.classifyError({ status: 404, body: 'model not found' }), null);
  assert.equal(keys.classifyError({ status: 400, body: 'invalid argument' }), null);
});

test('every key rejected is one honest error, not a provider shrug', async () => {
  keys.__resetKeyChain();
  llm.__setFetch(async () => fail(401, 'invalid api key'));
  try {
    await assert.rejects(
      () => ask(),
      (err) => {
        assert.equal(err.allKeysFailed, true);
        assert.match(err.message, /no usable key/);
        assert.equal(err.provider, 'groq');
        return true;
      },
    );
    let attempts = 0;
    llm.__setFetch(async () => { attempts++; return fail(401); });
    await assert.rejects(ask(), (err) => err.allKeysFailed);
    assert.equal(attempts, 0, 'an already rejected chain does not retry every credential');
    // …and the state says why, with both keys named by their last four.
    const status = keys.keyStatus('groq');
    assert.deepEqual(status.map((row) => row.state), ['invalid', 'invalid']);
    assert.deepEqual(status.map((row) => row.last4), ['1111', '2222']);
  } finally {
    llm.__setFetch(null);
    keys.__resetKeyChain();
  }
});

test('the customer gets a holding line, and the owner is told once', async () => {
  keys.__resetKeyChain();
  db.setSetting('ai_down_alerted_at', '');
  llm.__setFetch(async () => fail(401, 'invalid api key'));
  const { handleIncoming, drainBatches } = await import('../src/handlers/messageHandler.js');
  const sock = fakeSock();
  try {
    for (const number of ['447700900123', '447700900124']) {
      const jid = number + '@s.whatsapp.net';
      await handleIncoming(sock, {id: 'outage-' + number, number, chat: jid, kind:'text', text:'Could you explain the custom packaging options?'});
      await drainBatches({ timeoutMs: 6500 });
      const reply = sock.sent.filter((m) => m.jid === jid && m.payload.text).at(-1);
      assert.ok(reply, 'customer got a reply');
      assert.match(reply.payload.text, /sorry|limit|glitch|trouble/i);
      assert.ok(reply.payload.text.length < 220);
    }
    const alerts = sock.sent.filter((m) => m.jid === sock.user.id.replace(':1@','@') && m.payload.text?.includes('none of the AI keys'));
    assert.equal(alerts.length, 1, 'one owner alert for two different customers during the outage');
    assert.match(alerts[0].payload.text, /1111: invalid/);
    assert.ok(!alerts[0].payload.text.includes(process.env.GROQ_API_KEY));
  } finally {
    llm.__setFetch(null);
    keys.__resetKeyChain();
    db.setSetting('ai_down_alerted_at', '');
  }
});

test('usage rows carry the slot that answered', async () => {
  keys.__resetKeyChain();
  const recorded = [];
  usageEvents.setUsageRecorder((event) => recorded.push(event));
  llm.__setFetch(async (url, options) => (
    options.headers.Authorization.includes('primary') ? fail(401, 'nope') : ok('backup')
  ));
  try {
    await ask({ kind: 'chat' });
    assert.equal(recorded.length, 2);
    assert.equal(recorded[0].keySlot, 1);
    assert.equal(recorded[0].errorCategory, 'invalid');
    assert.equal(recorded[0].totalTokens, 0);
    assert.equal(recorded[1].keySlot, 2);
    assert.equal(recorded[1].keyLast4, '2222');
    assert.equal(recorded[0].provider, 'groq');
  } finally {
    llm.__setFetch(null);
    usageEvents.setUsageRecorder(null);
    keys.__resetKeyChain();
  }
});

test('llm.keySource = platform is refused with a sentence, not a shrug', async () => {
  process.env.LLM_KEY_SOURCE = 'platform';
  try {
    await assert.rejects(
      () => ask(),
      (err) => {
        assert.equal(err.code, 'platform_keys_unavailable');
        assert.match(err.messageForOwner, /does not offer that yet/);
        assert.match(err.messageForOwner, /llm\.keySource/);
        return true;
      },
    );
  } finally {
    delete process.env.LLM_KEY_SOURCE;
  }
});

test('the profile decides the key source, and tenant is the default', () => {
  delete process.env.LLM_KEY_SOURCE;
  assert.equal(keys.keySource(), 'tenant');
});

test('three slots are the ceiling, and the env names are the documented ones', () => {
  assert.deepEqual(keys.slotNames('groq'), ['GROQ_API_KEY', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3']);
  assert.deepEqual(keys.slotNames('gemini'), ['GEMINI_API_KEY', 'GEMINI_API_KEY_2', 'GEMINI_API_KEY_3']);
  assert.deepEqual(keys.slotNames('openrouter'), ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2', 'OPENROUTER_API_KEY_3']);
  const rows = keys.configuredKeys('groq', {
    env: { GROQ_API_KEY: 'a', GROQ_API_KEY_2: 'b', GROQ_API_KEY_3: 'c', GROQ_API_KEY_4: 'd' },
  });
  assert.equal(rows.length, 3, 'a fourth key is not a thing');
});
