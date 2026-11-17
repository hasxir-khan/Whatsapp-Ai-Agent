import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('humanizer');

const {
  polish, splitIntoBubbles, humanDelay, forSpeech, isRepetitive, ownerClock,
} = await import('../src/core/humanizer.js');
const { config } = await import('../src/config/env.js');

// Tests boot with tiny delays; restore the production pacing for this check.
config.behavior.minDelayMs = 900;
config.behavior.maxDelayMs = 9000;
config.behavior.typingSpeedCharsPerSec = 11;

test('polish removes the robot tells', () => {
  const out = polish('As an AI language model, I cannot browse.\n\n**Here’s** the plan:\n- item one\n- item two');
  assert.doesNotMatch(out, /as an AI language model/i);
  assert.match(out, /\*Here’s\*/);
  assert.match(out, /• item one/);
});

test('short replies stay a single bubble', () => {
  const bubbles = splitIntoBubbles('Hey! Sure, that works 👍');
  assert.equal(bubbles.length, 1);
});

test('long replies are split into at most 3 bubbles', () => {
  const long = Array.from({ length: 14 }, (_, i) => `Sentence number ${i + 1} explaining a detail about the project.`).join(' ');
  const bubbles = splitIntoBubbles(long);
  assert.ok(bubbles.length >= 2 && bubbles.length <= 3, `got ${bubbles.length}`);
  for (const b of bubbles) assert.ok(b.length <= 700);
});

test('bullet lists survive splitting', () => {
  const text = 'Scope:\n• Login\n• Payments\n• Admin panel\n\nTimeline is 3 weeks and price is PKR 60,000.';
  const bubbles = splitIntoBubbles(text);
  assert.ok(bubbles.join('\n').includes('• Payments'));
});

test('typing delay scales with reply length and stays bounded', () => {
  const short = humanDelay({ replyText: 'ok', incomingText: 'hi' });
  const long = humanDelay({ replyText: 'x'.repeat(400), incomingText: 'hi there, how are you doing today?' });
  assert.ok(short >= 800, `short was ${short}`);
  assert.ok(long > short);
  assert.ok(long <= 9500, `long was ${long}`);
});

test('speech text strips emojis, urls and markdown', () => {
  const s = forSpeech('Here is the link https://example.com 😀 *bold* text');
  assert.doesNotMatch(s, /https/);
  assert.doesNotMatch(s, /😀/);
  assert.doesNotMatch(s, /\*/);
});

test('repetition detector catches the same opening', () => {
  const prev = ['Sure! I can do that for you. The price is PKR 50,000.'];
  assert.equal(isRepetitive('Sure! I can do that for you. The timeline is 3 weeks.', prev), true);
  assert.equal(isRepetitive('Different answer entirely, about hosting.', prev), false);
});

test('owner clock returns a wall time', () => {
  const clock = ownerClock(new Date('2026-01-01T10:30:00Z'));
  assert.ok(clock.hour >= 0 && clock.hour <= 23);
  assert.ok(clock.minutes >= 0 && clock.minutes < 1440);
});
