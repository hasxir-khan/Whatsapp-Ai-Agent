// Gemini plumbing: key handling, model chain, and honest error messages.
//
// The key must never appear in a URL, a bad key must not trigger a pointless
// retry of every model, and a missing model must fall through to the next one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Configure before anything imports src/config/env.js
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-gemini-'));
process.env.DATA_DIR = dir;
process.env.MIN_DELAY_MS = '5';
process.env.MAX_DELAY_MS = '40';
process.env.TYPING_CPS = '2000';
process.env.VOICE_REPLY_MODE = 'off';
process.env.DRY_RUN = '1';
process.env.GEMINI_API_KEY = 'AQ.test-key-abcdefghijklmnop';
process.env.LLM_PROVIDERS = 'gemini';
delete process.env.GROQ_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const { config } = await import('../src/config/env.js');
const db = await import('../src/utils/db.js');
await db.initDB();
const llm = await import('../src/core/llm.js');
const { analyzeImage, visionProviders } = await import('../src/services/vision.js');
const { isKeyError, maskKey, explainGeminiError, geminiHeaders, geminiHeadersWith, keyFormat } = await import(
  '../src/utils/gemini.js'
);

const KEY = config.keys.gemini;

function fakeResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text);
    },
  };
}

const geminiAnswer = (text) => ({
  candidates: [{ content: { parts: [{ text }] } }],
  usageMetadata: { totalTokenCount: 12 },
});

test('key formats: AQ. is current, AIza is legacy, anything else is suspicious', () => {
  assert.equal(keyFormat('AQ.Ab8RN6EXAMPLE-not-a-real-key-0000000000'), 'current');
  assert.equal(keyFormat('AIzaSyD-1234567890abcdefghijklmnop'), 'legacy');
  assert.equal(keyFormat('gsk_1234567890'), 'unknown');
  assert.equal(keyFormat(''), 'unknown');
});

test('new-format keys (AQ.…) are accepted by config', () => {
  assert.equal(KEY, 'AQ.test-key-abcdefghijklmnop');
  assert.equal(llm.hasLLM(), true);
  assert.deepEqual(visionProviders(), ['gemini']);
});

test('gemini-4-hydrogen is the first model tried, for chat and vision', () => {
  assert.equal(config.llm.geminiModels[0], 'gemini-4-hydrogen');
  assert.equal(config.vision.geminiModels[0], 'gemini-4-hydrogen');
});

test('chat sends the key in a header, never in the URL', async () => {
  const calls = [];
  llm.__setFetch(async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return fakeResponse(200, geminiAnswer('hello there'));
  });

  const result = await llm.chat({ messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(result.text, 'hello there');
  assert.equal(result.provider, 'gemini');
  assert.equal(result.model, 'gemini-4-hydrogen');
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].url.includes('key='), 'key must not be in the URL');
  assert.ok(!calls[0].url.includes(KEY), 'key must not be in the URL');
  assert.equal(calls[0].headers['x-goog-api-key'], KEY);
  assert.match(calls[0].url, /models\/gemini-4-hydrogen:generateContent$/);
  llm.__setFetch(null);
});

test('vision sends the key in a header and returns the description', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    return fakeResponse(200, geminiAnswer('A black jacket on a mannequin.'));
  };

  try {
    const out = await analyzeImage({
      buffer: Buffer.from('fake-image-bytes'),
      mimetype: 'image/jpeg',
      caption: 'what do you think?',
    });
    assert.equal(out.provider, 'gemini');
    assert.match(out.description, /jacket/);
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].url.includes('key='));
    assert.equal(calls[0].headers['x-goog-api-key'], KEY);
    assert.match(calls[0].url, /gemini-4-hydrogen:generateContent/);
  } finally {
    globalThis.fetch = original;
  }
});

test('an invalid key fails fast instead of retrying every model', async () => {
  let calls = 0;
  llm.__setFetch(async () => {
    calls += 1;
    return fakeResponse(400, {
      error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' },
    });
  });

  await assert.rejects(
    () => llm.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    (err) => {
      assert.match(err.message, /rejected the API key/i);
      assert.match(err.message, /aistudio\.google\.com/);
      return true;
    }
  );
  assert.equal(calls, 1, `expected one attempt, got ${calls}`);
  llm.__setFetch(null);
});

test('an unknown model falls through to the next one in the chain', async () => {
  const tried = [];
  llm.__setFetch(async (url) => {
    const model = String(url).match(/models\/([^:]+):/)[1];
    tried.push(model);
    if (model === 'gemini-4-hydrogen') {
      return fakeResponse(404, { error: { code: 404, message: 'models/gemini-4-hydrogen is not found' } });
    }
    return fakeResponse(200, geminiAnswer('fallback worked'));
  });

  const result = await llm.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.text, 'fallback worked');
  assert.deepEqual(tried, ['gemini-4-hydrogen', 'gemini-3.8-flash']);
  llm.__setFetch(null);
});

test('auth style is configurable and never sends two credentials', () => {
  const asKey = geminiHeaders();
  assert.equal(asKey['x-goog-api-key'], KEY);
  assert.equal(asKey.Authorization, undefined);

  const asBearer = geminiHeadersWith('bearer');
  assert.equal(asBearer.Authorization, `Bearer ${KEY}`);
  assert.equal(asBearer['x-goog-api-key'], undefined);

  // extra headers are preserved either way
  assert.equal(geminiHeadersWith('bearer', { 'Content-Type': 'application/json' })['Content-Type'], 'application/json');
  assert.equal(config.geminiAuthStyle, 'key');
});

test('error classification and key masking', () => {
  assert.equal(isKeyError(400, '{"error":{"message":"API key not valid"}}'), true);
  assert.equal(isKeyError(401, ''), true);
  assert.equal(isKeyError(404, 'model not found'), false);
  assert.equal(isKeyError(429, ''), false);

  assert.match(explainGeminiError(404, ''), /no such model/i);
  assert.match(explainGeminiError(429, ''), /quota/i);
  assert.match(explainGeminiError(500, ''), /their side/i);

  const masked = maskKey('AQ.Ab8RN6EXAMPLE-secret-tail_xYQ');
  assert.ok(!masked.includes('secret-tail'), 'mask must hide the middle of the key');
  assert.match(masked, /^AQ\.A…/);
});
