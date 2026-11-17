// Phase 1 — industry templates and the setup wizard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolate } from './helpers.js';

const dataDir = isolate('templates');
const ROOT = process.cwd();
const CLI = path.join(ROOT, 'scripts', 'tenant.js');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-templates-'));
process.env.CONFIG_DIR = path.join(dataDir, 'config');

const T = await import('../src/services/templates.js');
const P = await import('../src/services/profile.js');

const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: work, encoding: 'utf8' });
const dirOf = (slug) => path.join(work, 'tenants', slug);
const ownerJson = (slug) => JSON.parse(fs.readFileSync(path.join(dirOf(slug), 'config', 'owner.json'), 'utf8'));

test('every industry template loads with a price list and FAQs', () => {
  const list = T.listTemplates();
  assert.equal(list.length, 8, 'eight industries shipped');

  for (const meta of list) {
    const t = T.loadTemplate(meta.id);
    assert.ok(t.business?.type, `${meta.id} has a business type`);
    assert.ok(t.catalog?.items?.length >= 3, `${meta.id} has at least three items`);
    assert.ok(t.faqs?.length >= 2, `${meta.id} has FAQs`);
    assert.ok(t.features?.businessProfile === true, `${meta.id} opts into the profile`);
    for (const item of t.catalog.items) {
      assert.ok(item.name, `${meta.id} item has a name`);
      const hasPrice = typeof item.price === 'number' || typeof item.min === 'number';
      assert.ok(hasPrice, `${meta.id}/${item.name} has a price or range`);
    }
  }
});

test('an unknown template raises a helpful error', () => {
  assert.throws(() => T.loadTemplate('spaceport'), /Available: restaurant/);
});

test('building a profile from a template fills the business block', () => {
  const profile = T.buildProfileFromTemplate('salon', {
    name: 'Glow Studio',
    number: '923001112233',
    city: 'Lahore',
    currency: 'PKR',
    languages: ['en', 'ur'],
  });

  assert.equal(profile.business.name, 'Glow Studio');
  assert.equal(profile.business.type, 'Salon');
  assert.equal(profile.business.city, 'Lahore');
  assert.deepEqual(profile.business.languages, ['en', 'ur']);
  assert.equal(profile.escalation.number, '923001112233', 'escalation defaults to the owner number');
  assert.equal(profile.features.businessProfile, true);
  assert.equal(profile.features.booking, false, 'later phases stay off');
  assert.deepEqual(profile.owner.services, [], 'the catalog is the single price list');
  assert.ok(profile.catalog.items.length > 0);
});

test('template profiles pass validation', () => {
  for (const meta of T.listTemplates()) {
    const profile = T.buildProfileFromTemplate(meta.id, { name: 'Test Biz', number: '923001112233' });
    const { errors } = P.validateProfile(profile);
    assert.deepEqual(errors, [], `${meta.id}: ${errors.join('; ')}`);
  }
});

test('a tenant created with --template gets that template, not the starter', () => {
  const result = run('new', 'Burger Point', '--number', '923004445566', '--template', 'restaurant', '--port', '3021');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /from the restaurant template/);

  const saved = ownerJson('burger-point');
  assert.equal(saved.business.type, 'Restaurant');
  assert.ok(saved.catalog.items.some((i) => i.name === 'Chicken Karahi'));
  assert.equal(saved.features.catalog, true);
  assert.equal(saved.owner.services.length, 0);
});

test('an unknown --template stops before writing anything', () => {
  const result = run('new', 'Bad Biz', '--number', '923004445577', '--template', 'spaceship');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown template/);
  assert.ok(!fs.existsSync(dirOf('bad-biz')), 'no half-created tenant');
});

test('the wizard runs non-interactively and writes a valid profile', () => {
  const result = run(
    'setup', 'burger-point',
    '--non-interactive', '--type', 'clinic', '--city', 'Rawalpindi',
    '--currency', 'PKR', '--hours', 'Mon–Sat 10:00–20:00'
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Saved/);

  const saved = ownerJson('burger-point');
  assert.equal(saved.business.type, 'Clinic');
  assert.equal(saved.business.city, 'Rawalpindi');
  assert.equal(saved.business.hours, 'Mon–Sat 10:00–20:00');
  assert.ok(saved.catalog.items.some((i) => i.name === 'General consultation'));
  assert.ok(fs.existsSync(path.join(dirOf('burger-point'), 'config', 'owner.json.bak')), 'previous profile backed up');
});

test('the wizard refuses to run for a tenant that does not exist', () => {
  const result = run('setup', 'ghost-biz', '--non-interactive');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No tenant/);
});

test('templates command lists the industries', () => {
  const result = run('templates');
  assert.equal(result.status, 0);
  for (const id of T.TEMPLATE_IDS) assert.match(result.stdout, new RegExp(id));
});
