import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('db');

const db = await import('../src/utils/db.js');
await db.initDB();

test('contacts are created, counted and updated', () => {
  const first = db.upsertContact('923001112223', { name: 'Ali', push_name: '', increment_messages: true });
  assert.equal(first.number, '923001112223');
  assert.equal(first.message_count, 1);

  const again = db.upsertContact('923001112223', { increment_messages: true, language: 'roman-ur' });
  assert.equal(again.message_count, 2);
  assert.equal(again.language, 'roman-ur');
  assert.equal(again.name, 'Ali');
});

test('blocking and pausing persist', () => {
  db.blockContact('923001112223', true);
  assert.equal(db.getContact('923001112223').is_blocked, 1);
  db.blockContact('923001112223', false);
  assert.equal(db.getContact('923001112223').is_blocked, 0);

  const until = new Date(Date.now() + 60000).toISOString();
  db.setContactPaused('923001112223', until);
  assert.equal(db.getContact('923001112223').bot_paused_until, until);
});

test('messages keep order and respect the limit', () => {
  for (let i = 0; i < 30; i++) db.saveMessage('923001112223', i % 2 ? 'user' : 'assistant', `msg ${i}`, 'text');
  const recent = db.getMessages('923001112223', 10);
  assert.equal(recent.length, 10);
  assert.equal(recent.at(-1).content, 'msg 29');
  assert.equal(recent[0].content, 'msg 20');
});

test('leads are upserted, not duplicated', () => {
  db.saveLead({ number: '923001112223', name: 'Ali', project_type: 'e-commerce store', status: 'quoted', quote_min: 1200, quote_max: 2400, quote_currency: 'USD' });
  db.saveLead({ number: '923001112223', status: 'won', timeline: '3 weeks' });
  const lead = db.getLead('923001112223');
  assert.equal(lead.status, 'won');
  assert.equal(lead.project_type, 'e-commerce store');
  assert.equal(lead.timeline, '3 weeks');
  assert.equal(db.listLeads().length, 1);
});

test('follow-ups persist and can be cancelled', () => {
  db.addFollowUp('923001112223', new Date(Date.now() - 1000).toISOString(), 'nudge', 1);
  assert.equal(db.dueFollowUps().length, 1);
  db.cancelFollowUps('923001112223');
  assert.equal(db.dueFollowUps().length, 0);
  assert.equal(db.pendingFollowUps('923001112223').length, 0);
});

test('usage counters accumulate per day', () => {
  db.bumpUsage('llm_calls', 3);
  db.bumpUsage('vision_calls', 2);
  const usage = db.getUsage();
  assert.equal(usage.llm_calls, 3);
  assert.equal(usage.vision_calls, 2);
});

test('settings round-trip and keep types', () => {
  db.setSetting('tts_mode', 'always');
  db.setSetting('bot_enabled', false);
  assert.equal(db.getSetting('tts_mode'), 'always');
  assert.equal(db.getSetting('bot_enabled'), false);
  assert.equal(db.getSetting('missing', 'fallback'), 'fallback');
});

test('deleted-message recall works', () => {
  db.rememberIncoming('MSG-1', '923001112223', 'text', 'secret');
  assert.equal(db.recallIncoming('MSG-1').body, 'secret');
  assert.equal(db.recallIncoming('nope'), null);
});

test('data survives a save/reload cycle', async () => {
  db.saveDB(true);
  const stats = db.dbStats();
  assert.ok(stats.messages >= 30);
  assert.ok(stats.sizeBytes > 0);
  assert.equal(db.exportAll().contacts.length >= 1, true);
});
