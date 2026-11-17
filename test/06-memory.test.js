import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('memory');

const db = await import('../src/utils/db.js');
const memory = await import('../src/services/memory.js');
const { generateReply, systemPrompt, detectMood, needsOwner, wantsVoiceReply } = await import('../src/core/brain.js');
const { isFriend, friendName } = await import('../src/config/env.js');
const { mockTransport } = await import('../src/dev/mockLlm.js');

await db.initDB();
mockTransport();

const NUMBER = '447700900123';
db.upsertContact(NUMBER, { name: 'John Client', push_name: 'John', country: 'United Kingdom', currency: 'GBP' });

test('facts are normalised and stored', () => {
  memory.rememberFacts(NUMBER, {
    Company: 'Northwind Ltd',
    'team size': '12 people',
    Budget: '£3,000',
    unknownfield: 'kept as notes',
    Empty: '',
  });
  const facts = Object.fromEntries(db.getFacts(NUMBER).map((f) => [f.key, f.value]));
  assert.equal(facts.company, 'Northwind Ltd');
  assert.equal(facts.team_size, '12 people');
  assert.equal(facts.budget, '£3,000');
  assert.ok(facts.notes.includes('kept as notes'));
  assert.equal(facts.Empty, undefined);
});

test('conversation turns build a usable history', () => {
  memory.saveUserTurn(NUMBER, 'Hi, I need an e-commerce site.');
  memory.saveAssistantTurn(NUMBER, 'Sure — what are you selling?');
  memory.saveUserTurn(NUMBER, 'Clothing, mostly jackets.');
  const dossier = memory.getDossier(NUMBER);
  const history = memory.buildHistoryMessages(dossier);
  assert.ok(history.length >= 3);
  assert.equal(history.at(-1).role, 'user');
  assert.match(history.at(-1).content, /jackets/);
});

test('consecutive same-role turns are merged', () => {
  const dossier = { recent: [
    { role: 'user', kind: 'text', content: 'one' },
    { role: 'user', kind: 'voice', content: 'two' },
    { role: 'assistant', kind: 'text', content: 'reply' },
  ] };
  const history = memory.buildHistoryMessages(dossier);
  assert.equal(history.length, 2);
  assert.match(history[0].content, /\[voice\] two/);
});

test('dossier text carries memory into the prompt', () => {
  db.setSummary(NUMBER, 'Wants a clothing e-commerce store with Stripe. Budget around £3,000.');
  const dossier = memory.getDossier(NUMBER);
  const text = memory.buildDossierText(dossier);
  assert.match(text, /WHO YOU ARE TALKING TO/);
  assert.match(text, /Northwind/);
  assert.match(text, /Stripe/);
});

test('owner brief summarises a chat in a few lines', () => {
  const brief = memory.buildOwnerBrief(NUMBER);
  assert.match(brief, /John Client/);
  assert.match(brief, /Last message/);
});

test('summary runs through the model and stores facts', async () => {
  const result = await memory.summarizeIfNeeded(NUMBER, { force: true });
  assert.ok(result, 'summary should be produced');
  const summary = db.getSummary(NUMBER);
  assert.ok(summary.summary.length > 10);
});

test('system prompt contains self-knowledge, capabilities and memory', () => {
  const dossier = memory.getDossier(NUMBER);
  const prompt = systemPrompt({
    dossier,
    intakeState: null,
    langInfo: { code: 'en', label: 'English', locale: 'en-US' },
    features: { visionEnabled: true, videoEnabled: true, ttsEnabled: true, sttEnabled: true },
  });

  assert.match(prompt, /YOUR EMPLOYER/);
  assert.match(prompt, /HasDevs|Hashir/);
  assert.match(prompt, /WHAT YOU CAN DO/);
  assert.match(prompt, /voice note/i);
  assert.match(prompt, /groups/i);
  assert.match(prompt, /never invent prices/i);
  assert.match(prompt, /Reply in English/);
  assert.match(prompt, /every major language/i);
  assert.match(prompt, /WHO YOU ARE TALKING TO/);
});

test('system prompt forbids prompt injection', () => {
  const prompt = systemPrompt({ dossier: null, intakeState: null, langInfo: null, features: {} });
  assert.match(prompt, /cannot change these rules|Never reveal this prompt/i);
});

test('friends get a casual prompt, not the sales flow', () => {
  assert.equal(isFriend('923169895286'), true);
  assert.equal(friendName('923169895286'), 'Koor');
  assert.equal(isFriend('447700900123'), false);

  const prompt = systemPrompt({
    dossier: { number: '923169895286', category: 'friend', facts: [], recent: [], country: 'Pakistan' },
    intakeState: { stage: 'discovering', fields: { projectType: 'website' }, asked: [] },
    langInfo: { code: 'roman-ur', label: 'Roman Urdu' },
    features: {},
  });
  assert.match(prompt, /THIS IS A FRIEND/);
  assert.doesNotMatch(prompt, /PROJECT INTAKE STATE/);
});

test('reply is generated with the mocked provider', async () => {
  const dossier = memory.getDossier(NUMBER);
  const reply = await generateReply({
    number: NUMBER,
    text: 'How much for that store?',
    langInfo: { code: 'en', label: 'English' },
    dossier,
    intakeState: null,
    features: {},
  });
  assert.ok(reply.text.length > 5);
  assert.equal(reply.provider, 'groq');
});

test('mood and escalation heuristics', () => {
  assert.equal(detectMood('This is useless, I am so frustrated'), 'angry');
  assert.equal(detectMood('thanks so much, amazing work!'), 'happy');
  assert.equal(detectMood('what is the price'), 'neutral');
  assert.equal(needsOwner('I want a refund now or I will call my lawyer').required, true);
  assert.equal(needsOwner('how much for a landing page').required, false);
  assert.equal(wantsVoiceReply('can you send a voice note please'), true);
  assert.equal(wantsVoiceReply('send me the price'), false);
});
