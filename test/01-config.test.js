import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('config');

const { config, normalizePhone, assertConfig } = await import('../src/config/env.js');

test('normalises Pakistani and international numbers', () => {
  assert.equal(normalizePhone('+92 316 9896229'), '923169896229');
  assert.equal(normalizePhone('0316-9896229'), '923169896229');
  assert.equal(normalizePhone('0092 316 9896229'), '923169896229');
  assert.equal(normalizePhone('923169896229'), '923169896229');
});

test('owner number and jid are correct', () => {
  assert.equal(config.owner.number, '923169896229');
  assert.equal(config.owner.jid, '923169896229@s.whatsapp.net');
  assert.equal(config.owner.name, 'Hashir');
});

test('business knowledge loads with a price book', () => {
  const services = config.owner.profile.owner.services;
  assert.ok(services.length >= 5, 'expected several services');
  const ids = services.map((s) => s.id);
  for (const id of ['landing', 'ecommerce', 'webapp', 'mobile', 'ai_bot']) {
    assert.ok(ids.includes(id), `missing service ${id}`);
  }
  assert.ok(config.owner.profile.owner.addons.length >= 5);
  assert.ok(config.owner.profile.intake.fields.length >= 8);
});

test('defaults keep the bot polite and private', () => {
  assert.equal(config.bot.pretendHuman, false);
  assert.equal(config.owner.profile.bot.pretendHuman, false);
  assert.equal(config.server.host, '0.0.0.0');
  assert.ok(config.limits.dailyLlmCalls > 0);
});

test('assertConfig passes with a groq key', () => {
  assert.deepEqual(assertConfig(), []);
});
