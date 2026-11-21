// Phase 1 — the universal business profile: parsing catalog entries, merging
// with the legacy price list, and writing edits back to owner.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate } from './helpers.js';

const dataDir = isolate('profile');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;

const P = await import('../src/services/profile.js');
const { config } = await import('../src/config/env.js');

// A restaurant-shaped tenant, written the way a template would write it.
const seed = {
  business: { name: 'Burger Point', type: 'Restaurant', city: 'Islamabad', hours: 'Daily 12:00–23:00', languages: ['en', 'ur'] },
  catalog: {
    items: [
      { name: 'Zinger Burger', kind: 'product', price: 650, duration: 12, stock: 25 },
      { name: 'Family Platter', kind: 'product', price: 3200, duration: 30, stock: 0 },
      { name: 'Website', kind: 'service', min: 60000, max: 180000, days: '10–21' },
      { name: 'Table booking', kind: 'service', price: 0 },
    ],
  },
  tone: { style: 'warm and quick', avoid: [] },
  goals: { primary: 'take the order' },
  escalation: { when: 'a complaint', number: '923005556677' },
  faqs: [{ q: 'Do you deliver?', a: 'Yes, within 5 km.' }],
  features: { businessProfile: true, catalog: true, ownerEditing: true },
  owner: { name: 'Burger Point', brand: 'Burger Point', services: [], addons: [] },
};
fs.writeFileSync(path.join(configDir, 'owner.json'), JSON.stringify(seed, null, 2));
P.reloadProfile();

test('normalises a fixed price into a min/max range', () => {
  const item = P.normalizeItem({ name: 'Zinger Burger', price: '650', duration: '12 min' });
  assert.equal(item.min, 650);
  assert.equal(item.max, 650);
  assert.equal(item.price, 650);
  assert.equal(item.duration, 12);
  assert.equal(item.kind, 'service');
});

test('normalises a range, and a duration written as hours', () => {
  const item = P.normalizeItem({ name: 'Website', min: 60000, max: 180000, duration: '2 h', kind: 'service' });
  assert.equal(item.min, 60000);
  assert.equal(item.max, 180000);
  assert.equal(item.duration, 120);
});

test('keeps products and their stock', () => {
  const item = P.normalizeItem({ name: 'Shawl', kind: 'product', price: 3200, stock: 6 });
  assert.equal(item.kind, 'product');
  assert.equal(item.stock, 6);
});

test('the feature flags ignore the // comment keys', () => {
  const flags = P.features();
  assert.equal(flags.businessProfile, true);
  assert.equal(flags.catalog, true);
  assert.ok(!('//' in flags));
});

test('effective services merge catalog and legacy, skip free items', () => {
  const services = P.effectiveServices();
  const names = services.map((s) => s.name);

  assert.ok(names.includes('Zinger Burger'), 'products are quotable');
  assert.ok(names.includes('Website'), 'ranged services are quotable');
  assert.ok(!names.includes('Table booking'), 'a free placeholder never becomes a quote');
  assert.equal(services.find((s) => s.name === 'Website').min, 60000);
});

test('legacy owner.services still work when a catalog exists', () => {
  const legacy = P.effectiveServices().length;
  P.savePatch({
    owner: {
      services: [{ id: 'legacy', name: 'Legacy design', keywords: ['legacy'], min: 1000, max: 2000, days: '2' }],
    },
  });
  const after = P.effectiveServices().find((s) => s.id === 'legacy');
  assert.ok(after, 'legacy service is still quoted');
  assert.equal(P.effectiveServices().length, legacy + 1);
});

test('set() writes only the changed key and keeps everything else', () => {
  P.setPath('business.city', 'Rawalpindi');
  const onDisk = JSON.parse(fs.readFileSync(path.join(configDir, 'owner.json'), 'utf8'));

  assert.equal(onDisk.business.city, 'Rawalpindi');
  assert.equal(onDisk.business.name, 'Burger Point', 'untouched keys survive');
  assert.equal(onDisk.catalog.items.length, 4, 'catalog untouched');
  assert.equal(P.business().city, 'Rawalpindi', 'and it is live without a restart');
});

test('set() refuses an unknown feature flag', () => {
  assert.throws(() => P.setPath('features.magicMode', true), /Unknown flag/);
});

test('addService appends to the catalog and is quotable immediately', () => {
  const added = P.addService({ name: 'Garlic Mayo Dip', price: 150 });
  assert.equal(added.name, 'Garlic Mayo Dip');
  assert.ok(P.effectiveServices().some((s) => s.name === 'Garlic Mayo Dip'));

  // adding the same name again edits instead of duplicating
  P.addService({ name: 'Garlic Mayo Dip', price: 200 });
  const items = P.catalogItems().filter((i) => i.name === 'Garlic Mayo Dip');
  assert.equal(items.length, 1);
  assert.equal(P.effectiveServices().find((s) => s.name === 'Garlic Mayo Dip').min, 200);
});

test('addService requires a price', () => {
  assert.throws(() => P.addService({ name: 'Mystery item' }), /price/);
});

test('addFaq appends and does not duplicate the same question', () => {
  P.addFaq('Do you deliver?', 'Yes, within 5 km.');
  P.addFaq('Do you deliver?', 'Yes — 5 km, 45 minutes.');
  const faqs = P.faqList().filter((f) => f.q === 'Do you deliver?');
  assert.equal(faqs.length, 1);
  assert.match(faqs[0].a, /45 minutes/);
});

test('coerceValue turns obvious numbers and booleans into types', () => {
  assert.equal(P.coerceValue('15000'), 15000);
  assert.equal(P.coerceValue('true'), true);
  assert.equal(P.coerceValue('yes'), true);
  assert.equal(P.coerceValue('Daily 12:00–23:00'), 'Daily 12:00–23:00');
});

test('validateProfile catches broken price lists', () => {
  const bad = {
    business: { name: '', type: '', city: '', hours: '' },
    catalog: { items: [{ name: 'No price' }, { name: 'Negative', price: -5 }, { name: 'Backwards', min: 100, max: 50 }] },
    faqs: [{ q: 'only a question' }],
    features: { magic: true },
  };
  const { errors, warnings } = P.validateProfile(bad);
  const text = [...errors, ...warnings].join(' | ');

  assert.match(text, /no price/i);
  assert.match(text, /negative price/i);
  assert.match(text, /max below min/i);
  assert.match(text, /needs both q and a/i);
  assert.match(text, /unknown feature flag "magic"/);
});

test('a valid profile produces no errors', () => {
  const { errors } = P.validateProfile();
  assert.deepEqual(errors, []);
});

test('foreign-currency catalog prices convert to PKR for quoting', () => {
  P.savePatch({ currency: { base: 'USD', fxToPkr: { USD: 280 } } });
  assert.equal(P.toPkrAmount(100), 28000);
  P.savePatch({ currency: { base: 'PKR' } });
  assert.equal(P.toPkrAmount(100), 100);
});

test('reloadProfile updates the live object modules already hold', () => {
  const held = config.owner.profile.owner; // same reference brain.js captured
  P.setPath('owner.bio', 'Burgers, wraps and very good fries.');
  assert.equal(held.bio, 'Burgers, wraps and very good fries.', 'no stale copy after an edit');

  // MY_NAME in .env still wins over the profile, as it always has
  process.env.MY_NAME = 'Test Owner';
  P.reloadProfile();
  assert.equal(config.owner.profile.owner.name, 'Test Owner');
});
