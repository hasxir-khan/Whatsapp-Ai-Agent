// Multi-user: every new user gets an isolated folder, their own keys, their own
// business profile and their own database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const CLI = path.join(ROOT, 'scripts', 'tenant.js');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-tenants-'));

const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: work, encoding: 'utf8' });
const dirOf = (slug) => path.join(work, 'tenants', slug);

test('new tenant creates an isolated workspace', () => {
  const result = run('new', 'Ayesha Designs', '--number', '+92 300 1112233', '--brand', 'Ayesha');
  assert.equal(result.status, 0, result.stderr);

  for (const sub of ['config', 'data', 'sessions', 'tmp']) {
    assert.ok(fs.existsSync(path.join(dirOf('ayesha-designs'), sub)), `missing ${sub}/`);
  }

  const env = fs.readFileSync(path.join(dirOf('ayesha-designs'), '.env'), 'utf8');
  assert.match(env, /MY_NUMBER=923001112233/);
  assert.match(env, /MY_BRAND=Ayesha/);
  assert.match(env, /PORT=3001/);
  assert.match(env, /GROQ_API_KEY=/);

  const profile = JSON.parse(fs.readFileSync(path.join(dirOf('ayesha-designs'), 'config', 'owner.json'), 'utf8'));
  assert.equal(profile.owner.name, 'Ayesha Designs');
  assert.ok(Array.isArray(profile.owner.services) && profile.owner.services.length >= 3);

  const meta = JSON.parse(fs.readFileSync(path.join(dirOf('ayesha-designs'), 'tenant.json'), 'utf8'));
  assert.equal(meta.slug, 'ayesha-designs');
  assert.equal(meta.enabled, true);
});

test('a duplicate slug is refused instead of overwriting a user', () => {
  const again = run('new', 'Ayesha Designs', '--number', '923001112233');
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already exists/i);
});

test('keys are written per tenant, and never leak to another', () => {
  run('new', 'Bilal Studio', '--number', '923004445566');

  const set = run('keys', 'bilal-studio', 'GROQ_API_KEY=gsk_bilal_123456789', 'GEMINI_API_KEY=AQ.bilal_key_0001');
  assert.equal(set.status, 0, set.stderr);

  const bilal = fs.readFileSync(path.join(dirOf('bilal-studio'), '.env'), 'utf8');
  assert.match(bilal, /gsk_bilal_123456789/);

  const ayesha = fs.readFileSync(path.join(dirOf('ayesha-designs'), '.env'), 'utf8');
  assert.doesNotMatch(ayesha, /gsk_bilal/, 'other users must not receive these keys');

  const listing = run('keys', 'bilal-studio').stdout;
  assert.match(listing, /gsk_…789/, 'keys are shown masked');
  assert.doesNotMatch(listing, /gsk_bilal_123456789/);
});

test('list shows every user with their port and key count', () => {
  const out = run('list').stdout;
  assert.match(out, /ayesha-designs/);
  assert.match(out, /bilal-studio/);
  assert.match(out, /3001/);
});

test('deleting a tenant needs explicit confirmation', () => {
  const refused = run('rm', 'bilal-studio');
  assert.notEqual(refused.status, 0);
  assert.ok(fs.existsSync(dirOf('bilal-studio')), 'nothing is deleted without --yes');

  const removed = run('rm', 'bilal-studio', '--yes');
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.existsSync(dirOf('bilal-studio')), false);
});

test('the app loads that tenant\'s own business profile', () => {
  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { config } from ${JSON.stringify(path.join(ROOT, 'src', 'config', 'env.js'))};
       console.log(JSON.stringify({
         tenant: config.tenant.slug,
         name: config.owner.name,
         brand: config.owner.profile.owner.brand,
         services: config.owner.profile.owner.services.length,
         dbDir: config.paths.data,
       }));`,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        TENANT: 'ayesha-designs',
        CONFIG_DIR: path.join(dirOf('ayesha-designs'), 'config'),
        DATA_DIR: path.join(dirOf('ayesha-designs'), 'data'),
        SESSION_FOLDER: path.join(dirOf('ayesha-designs'), 'sessions'),
        TMP_DIR: path.join(dirOf('ayesha-designs'), 'tmp'),
        ENV_FILE: path.join(dirOf('ayesha-designs'), '.env'),
      },
    }
  );

  assert.equal(probe.status, 0, probe.stderr);
  const info = JSON.parse(probe.stdout.trim().split('\n').pop());
  assert.equal(info.tenant, 'ayesha-designs');
  assert.equal(info.name, 'Ayesha Designs');
  assert.equal(info.brand, 'Ayesha');
  assert.ok(info.services >= 3);
  assert.match(info.dbDir, /ayesha-designs/);
});

test('the default install still works exactly as before', () => {
  const probe = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import { config } from ${JSON.stringify(path.join(ROOT, 'src', 'config', 'env.js'))}; console.log(config.tenant.slug)`],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TENANT: '', CONFIG_DIR: '' } }
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim().split('\n').pop(), 'default');
});
