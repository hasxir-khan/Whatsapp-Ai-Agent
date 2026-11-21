// Fleet doctor: one command that checks every user of this installation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const CLI = path.join(ROOT, 'scripts', 'tenant.js');
const DOCTOR = path.join(ROOT, 'scripts', 'doctor.js');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-fleet-'));

// a bare workspace: no owner install, just two tenants created by the CLI
const tenant = (...args) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: work, encoding: 'utf8' });

const doctor = (...args) =>
  spawnSync(process.execPath, [DOCTOR, ...args], { cwd: work, encoding: 'utf8' });

const fleet = (...args) => {
  const out = doctor('all', '--json', ...args);
  return { status: out.status, data: JSON.parse(out.stdout), raw: out.stdout };
};

test('setup: two users, same number, clashing port', () => {
  assert.equal(tenant('new', 'Alpha Co', '--number', '923001112233', '--port', '3001').status, 0);
  assert.equal(tenant('new', 'Beta Co', '--number', '923001112233', '--port', '3000').status, 0);
});

test('fleet check lists every user and flags real problems', () => {
  const out = doctor('all');
  const text = out.stdout;

  assert.match(text, /Fleet check/);
  assert.match(text, /alpha-co/);
  assert.match(text, /beta-co/);

  // both tenants share a number → that is a real, dangerous misconfiguration
  assert.match(text, /same number as/i);
  // beta wants port 3000, which the owner install uses
  assert.match(text, /port 3000 already used/i);
  // no keys yet
  assert.match(text, /no GROQ_API_KEY/);
  // not logged in yet
  assert.match(text, /not logged in/i);

  assert.equal(out.status, 1, 'a broken fleet must exit non-zero');
});

test('adding keys clears that complaint for that user only', () => {
  tenant('keys', 'alpha-co', 'GROQ_API_KEY=gsk_alpha_123456789');
  const { data } = fleet();
  const alpha = data.users.find((u) => u.slug === 'alpha-co');
  const beta = data.users.find((u) => u.slug === 'beta-co');

  assert.equal(alpha.hasGroq, true);
  assert.ok(!alpha.issues.some((i) => /GROQ_API_KEY/.test(i)), 'alpha is fixed');

  assert.equal(beta.hasGroq, false);
  assert.ok(beta.issues.some((i) => /GROQ_API_KEY/.test(i)), 'beta is untouched');
});

test('a clean fleet passes', () => {
  // give both real-looking keys and distinct numbers/ports
  tenant('keys', 'alpha-co', 'GEMINI_API_KEY=AQ.alpha_fake_key_0000000000');
  tenant('keys', 'beta-co', 'GROQ_API_KEY=gsk_beta_9876543210', 'GEMINI_API_KEY=AQ.beta_fake_key_00000000000');

  const betaMeta = JSON.parse(fs.readFileSync(path.join(work, 'tenants', 'beta-co', 'tenant.json'), 'utf8'));
  betaMeta.number = '923004445566';
  betaMeta.port = 3002;
  fs.writeFileSync(path.join(work, 'tenants', 'beta-co', 'tenant.json'), JSON.stringify(betaMeta, null, 2));

  // pretend both are logged in
  for (const slug of ['alpha-co', 'beta-co']) {
    fs.mkdirSync(path.join(work, 'tenants', slug, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(work, 'tenants', slug, 'sessions', 'creds.json'), '{}');
  }

  const { data } = fleet();
  const alpha = data.users.find((u) => u.slug === 'alpha-co');
  const beta = data.users.find((u) => u.slug === 'beta-co');

  for (const user of [alpha, beta]) {
    assert.equal(user.loggedIn, true);
    assert.equal(user.hasGroq, true);
    assert.equal(user.hasGemini, true);
    assert.ok(!user.issues.some((i) => /same number|already used|logged in/i), user.issues.join(', '));
  }
  assert.equal(alpha.number, '923001112233');
  assert.equal(beta.number, '923004445566');
  assert.notEqual(alpha.port, beta.port);
});

test('live mode reports unreachable providers instead of pretending', () => {
  const out = doctor('all', '--live');
  const text = out.stdout;
  assert.match(text, /live API calls/);
  // this sandbox has no route to the providers
  assert.match(text, /groq:(unreachable|ok|missing)/);
  assert.match(text, /gemini:(unreachable|ok|missing|rejected)/);
});

test('a brand-new install is "not set up yet", not a failure', () => {
  // Exactly the state a fresh clone is in: no owner.json, no keys, no session,
  // no number. Nothing is wrong — so the command must not exit 1 and scare
  // somebody who has just unpacked the project.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bare-'));
  const out = spawnSync(process.execPath, [DOCTOR, 'all'], { cwd: bare, encoding: 'utf8' });

  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /setup note/);
  assert.match(out.stdout, /not configured yet/);
  assert.doesNotMatch(out.stdout, /problem/);

  const json = spawnSync(process.execPath, [DOCTOR, 'all', '--json'], { cwd: bare, encoding: 'utf8' });
  const data = JSON.parse(json.stdout);
  assert.equal(data.healthy, true, 'nothing is broken');
  assert.deepEqual(data.blockers, []);
  assert.ok(data.issues.length > 0, 'the setup notes are still listed');
});
