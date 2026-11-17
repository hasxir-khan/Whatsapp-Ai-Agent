// Phase 1 — how the business profile reaches the model, the quote engine and
// the owner's commands. Flags off must mean byte-identical old behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate } from './helpers.js';

const dataDir = isolate('business-prompt');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
process.env.MY_NUMBER = '923169896229';

const writeProfile = (obj) => {
  fs.writeFileSync(path.join(configDir, 'owner.json'), JSON.stringify(obj, null, 2));
};

const restaurant = {
  business: {
    name: 'Burger Point',
    type: 'Restaurant',
    city: 'Islamabad',
    hours: 'Daily 12:00–23:00',
    languages: ['en', 'ur'],
    delivery: 'Within 5 km, 45–60 minutes',
  },
  catalog: {
    items: [
      { name: 'Zinger Burger', kind: 'product', price: 650, duration: 12, stock: 25 },
      { name: 'Family Platter', kind: 'product', price: 3200, duration: 30, stock: 0 },
      { name: 'Mint Margarita', kind: 'product', price: 350, duration: 5, stock: 40 },
    ],
  },
  tone: { style: 'warm and quick, like a good waiter', emoji: 'light', avoid: ['corporate language'] },
  goals: { primary: 'take the order', target: 'order confirmed in under 5 messages' },
  escalation: { when: 'a complaint about a wrong order', number: '923005556677', topics: ['refund'] },
  faqs: [{ q: 'Do you deliver?', a: 'Yes — within 5 km, 45–60 minutes.' }],
  features: { businessProfile: true, catalog: true, ownerEditing: true },
};

// ── flags off: the old prompt, untouched ───────────────────
test('with every flag off the prompt has no business block', async () => {
  writeProfile({ features: {} });
  const { systemPrompt } = await import('../src/core/brain.js');
  const { reloadProfile } = await import('../src/services/profile.js');
  reloadProfile();

  const prompt = systemPrompt({ dossier: {}, chatType: 'client' });
  assert.doesNotMatch(prompt, /THE BUSINESS/);
  assert.doesNotMatch(prompt, /CATALOG/);
  assert.doesNotMatch(prompt, /ESCOLATION|ESCALATION/);
  assert.match(prompt, /YOUR EMPLOYER/, 'the original knowledge block is still there');
});

test('with catalog off the prompt lists no products', async () => {
  writeProfile({ ...restaurant, features: { businessProfile: true, catalog: false } });
  const { systemPrompt } = await import('../src/core/brain.js');
  const { reloadProfile } = await import('../src/services/profile.js');
  reloadProfile();

  const prompt = systemPrompt({ dossier: {}, chatType: 'client' });
  assert.match(prompt, /THE BUSINESS/);
  assert.doesNotMatch(prompt, /Zinger Burger/);
});

// ── flags on: the profile reaches the model ────────────────
test('the business block carries identity, hours and delivery', async () => {
  writeProfile(restaurant);
  const { systemPrompt } = await import('../src/core/brain.js');
  const { reloadProfile } = await import('../src/services/profile.js');
  reloadProfile();

  const prompt = systemPrompt({ dossier: {}, chatType: 'client' });
  assert.match(prompt, /Burger Point/);
  assert.match(prompt, /type: Restaurant/);
  assert.match(prompt, /city: Islamabad/);
  assert.match(prompt, /Daily 12:00–23:00/);
  assert.match(prompt, /Within 5 km, 45–60 minutes/);
  assert.match(prompt, /languages spoken: en, ur/);
});

test('tone, goals and escalation are rendered without comment keys', async () => {
  writeProfile(restaurant);
  const { systemPrompt } = await import('../src/core/brain.js');
  const { reloadProfile } = await import('../src/services/profile.js');
  reloadProfile();

  const prompt = systemPrompt({ dossier: {}, chatType: 'client' });
  assert.match(prompt, /House style — style: warm and quick/);
  assert.match(prompt, /primary: take the order/);
  assert.match(prompt, /Hand this to a human when: a complaint about a wrong order/);
  assert.match(prompt, /923005556677/);
  assert.doesNotMatch(prompt, /\/\//, 'comment keys never leak into the prompt');
});

test('the catalog block quotes exact prices and marks stock', async () => {
  writeProfile(restaurant);
  const { systemPrompt } = await import('../src/core/brain.js');
  const { reloadProfile } = await import('../src/services/profile.js');
  reloadProfile();

  const prompt = systemPrompt({ dossier: {}, chatType: 'client' });
  assert.match(prompt, /Zinger Burger: 650 PKR · 12 min · 25 left/);
  assert.match(prompt, /Family Platter: 3,200 PKR · 30 min · out of stock/);
  assert.match(prompt, /the only prices and stock you may quote/);
  assert.match(prompt, /instead of guessing a price/);
});

// ── the quote engine reads the catalog ─────────────────────
test('a restaurant quote comes from its own price list', async () => {
  writeProfile(restaurant);
  const { reloadProfile } = await import('../src/services/profile.js');
  reloadProfile();
  const { buildQuote } = await import('../src/core/pricing.js');

  const quote = buildQuote({ projectType: 'Zinger Burger order', extra: '2 zinger burgers' }, '923001112233');
  assert.ok(['Zinger Burger', 'Family Platter', 'Mint Margarita'].includes(quote.serviceName), quote.serviceName);
  assert.ok(quote.pkrMax >= 350 && quote.pkrMax <= 5000, `price stayed inside the menu: ${quote.pkrMin}-${quote.pkrMax}`);
});

test('catalog ranges are quoted as ranges, not invented numbers', async () => {
  writeProfile({
    ...restaurant,
    catalog: { items: [{ name: 'Website', kind: 'service', min: 60000, max: 180000, days: '10–21' }] },
  });
  const { reloadProfile } = await import('../src/services/profile.js');
  reloadProfile();
  const { buildQuote } = await import('../src/core/pricing.js');

  const quote = buildQuote({ projectType: 'website' }, '923001112233');
  assert.equal(quote.serviceName, 'Website');
  assert.ok(quote.pkrMax >= 60000 && quote.pkrMax <= 400000);
});

// ── owner commands ─────────────────────────────────────────
const OWNER_JID = '923169896229@s.whatsapp.net';
const cmd = async (text) => {
  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const res = await handleOwnerCommand({}, OWNER_JID, text);
  return res.reply || '';
};

test('.profile summarises the business', async () => {
  writeProfile(restaurant);
  const { reloadProfile } = await import('../src/services/profile.js');
  reloadProfile();
  const reply = await cmd('.profile');
  assert.match(reply, /Burger Point/);
  assert.match(reply, /Price list: 3 items/);
  assert.match(reply, /Features on: businessProfile, catalog, ownerEditing/);
});

test('.addservice adds a quotable item in one message', async () => {
  writeProfile(restaurant);
  const { reloadProfile } = await import('../src/services/profile.js');
  reloadProfile();

  const reply = await cmd('.addservice Garlic Mayo Dip | 150');
  assert.match(reply, /Added/);
  assert.match(reply, /150 PKR/);

  const disk = JSON.parse(fs.readFileSync(path.join(configDir, 'owner.json'), 'utf8'));
  assert.ok(disk.catalog.items.some((i) => i.name === 'Garlic Mayo Dip'));
});

test('.addfaq saves a question and answer', async () => {
  const reply = await cmd('.addfaq Do you deliver at night? | Yes, till 11pm');
  assert.match(reply, /Saved FAQ/);
  const disk = JSON.parse(fs.readFileSync(path.join(configDir, 'owner.json'), 'utf8'));
  assert.ok(disk.faqs.some((f) => f.q === 'Do you deliver at night?'));
});

test('.set edits one setting and takes effect immediately', async () => {
  const reply = await cmd('.set business.hours Daily 12:00–02:00');
  assert.match(reply, /Live now/);

  const { systemPrompt } = await import('../src/core/brain.js');
  const prompt = systemPrompt({ dossier: {}, chatType: 'client' });
  assert.match(prompt, /Daily 12:00–02:00/, 'the next reply already uses it');
});

test('.services lists the price list with stock', async () => {
  const reply = await cmd('.services');
  assert.match(reply, /Price list/);
  assert.match(reply, /Zinger Burger/);
  assert.match(reply, /out of stock/);
});

test('owner editing can be turned on from off (bootstrap works)', async () => {
  writeProfile({ ...restaurant, features: { businessProfile: true, catalog: true, ownerEditing: false } });
  const { reloadProfile } = await import('../src/services/profile.js');
  reloadProfile();

  const blocked = await cmd('.addservice Test item | 100');
  assert.match(blocked, /editing is off/i);

  const enabled = await cmd('.set features.ownerEditing true');
  assert.match(enabled, /Live now/);

  const allowed = await cmd('.addservice Test item | 100');
  assert.match(allowed, /Added/);
});

test('config commands are owner-only', async () => {
  writeProfile(restaurant);
  const { reloadProfile } = await import('../src/services/profile.js');
  reloadProfile();

  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const res = await handleOwnerCommand({}, OWNER_JID, '.set business.city Lahore', '923001112233');
  assert.match(res.reply, /owner-only/);

  const disk = JSON.parse(fs.readFileSync(path.join(configDir, 'owner.json'), 'utf8'));
  assert.notEqual(disk.business.city, 'Lahore', 'a non-owner cannot rewrite the business profile');
});
