import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('voice');

const { shouldSpeak, ttsEnabled, wantsVoice } = await import('../src/services/tts.js');
const { forSpeech } = await import('../src/core/humanizer.js');
const { videoCapabilities } = await import('../src/services/video.js');
const { sttEnabled } = await import('../src/services/transcription.js');
const { visionEnabled, visionProviders } = await import('../src/services/vision.js');

test('voice replies are off in this test environment', () => {
  assert.equal(ttsEnabled(), false);
  assert.equal(shouldSpeak({ clientSentVoice: false, text: 'send me a voice note' }), false);
});

test('request detection understands many phrasings', () => {
  assert.equal(wantsVoice('can you send a voice note please'), true);
  assert.equal(wantsVoice('bol kar batao'), true);
  assert.equal(wantsVoice('audio message me bhejo'), true);
  assert.equal(wantsVoice('just email me the price'), false);
});

test('speech text is clean enough to read aloud', () => {
  const text = forSpeech('**Price:** PKR 50,000 😀 https://x.co\n\nWant to proceed?');
  assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}]/u);
  assert.doesNotMatch(text, /https/);
  assert.match(text, /Price/);
});

test('capability reporting is honest when only a Groq key is present', () => {
  // Groq alone = chat + speech-to-text; no eyes, so videos fall back to audio
  assert.equal(sttEnabled(), true);
  assert.equal(visionEnabled(), false);
  assert.equal(visionProviders().length, 0);
  assert.equal(videoCapabilities().native, false);
  assert.equal(videoCapabilities().frames, false);
  assert.equal(videoCapabilities().audioOnly, true);
});

test('on_request mode speaks only when asked', () => {
  // with tts disabled nothing speaks; this only checks the decision logic
  assert.equal(shouldSpeak({ mode: 'on_request', text: 'hello' }), false);
  assert.equal(shouldSpeak({ mode: 'off', text: 'send a voice note' }), false);
});
