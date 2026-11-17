// The demo's one honest question: is a real key here, or not?
// Real key → the model answers. No key → only the deterministic parts answer,
// and both the terminal and the inbox say so instead of pretending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { aiMode, aiModeLabel } = await import('../src/dev/demoAi.js');

test('a real Groq key means real AI', () => {
  assert.deepEqual(aiMode({ GROQ_API_KEY: 'gsk_1234567890abcdef' }), { mode: 'real', provider: 'Groq' });
});

test('a real Gemini key works too, including the AQ. format', () => {
  assert.deepEqual(aiMode({ GEMINI_API_KEY: 'AQ.Ab8RN6JkLmNoPqRsT' }), { mode: 'real', provider: 'Gemini' });
});

test('Groq wins when both are set', () => {
  assert.equal(aiMode({ GROQ_API_KEY: 'gsk_1234567890abcdef', GEMINI_API_KEY: 'AQ.Ab8RN6JkLmNoPqRsT' }).provider, 'Groq');
});

test('no key means canned mode, not a broken start', () => {
  assert.deepEqual(aiMode({}), { mode: 'canned', provider: null });
  assert.deepEqual(aiMode({ GROQ_API_KEY: '', GEMINI_API_KEY: '   ' }), { mode: 'canned', provider: null });
});

test('the demo’s own placeholders are never mistaken for a real key', () => {
  for (const key of ['demo-key-never-used', 'mock-groq-key', 'mock-gemini-key', 'your-key-here-please', 'short']) {
    assert.equal(aiMode({ GROQ_API_KEY: key }).mode, 'canned', `${key} must not count as real`);
    assert.equal(aiMode({ GEMINI_API_KEY: key }).mode, 'canned', `${key} must not count as real`);
  }
});

test('the label says which mode is running and never leaks the key', () => {
  const real = aiModeLabel({ mode: 'real', provider: 'Groq' });
  assert.match(real, /Real AI — Groq/);

  const canned = aiModeLabel({ mode: 'canned', provider: null });
  assert.match(canned, /No API key/);
  assert.match(canned, /canned/);
  assert.match(canned, /GROQ_API_KEY/);
  for (const text of [real, canned]) assert.doesNotMatch(text, /gsk_|AQ\./);
});

test('the demo script mocks the model only when there is no key', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'scripts', 'demo.js'), 'utf8');
  // the mock import must sit behind the canned-mode branch…
  assert.match(src, /if \(AI\.mode === 'canned'\) \{\s*\n\s*await import\('\.\.\/src\/dev\/mockLlm\.js'\)/, 'mock must be conditional');
  // …and it must read .env before deciding, so a key the user already has is used
  assert.match(src, /dotenv\.config/);
  assert.match(src, /const AI = aiMode\(process\.env\)/);
});
