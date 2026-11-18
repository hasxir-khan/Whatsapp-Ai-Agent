// test/50-secrets.test.js
// The pre-commit scanner, tested the only way a guard can be trusted: stage a
// secret in a throwaway repository and watch the commit get refused.
//
// Every case here is a real mistake somebody makes — a key pasted into .env and
// committed, a session folder added by `git add .`, a friend's number left in a
// fixture — so the test asserts the *reason* as well as the exit code.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCANNER = path.join(ROOT, 'scripts', 'scan-secrets.js');
const INSTALL = path.join(ROOT, 'scripts', 'install-hooks.js');

/** A disposable repo that has the scanner in it, the way a checkout would. */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-secrets-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(SCANNER, path.join(dir, 'scripts', 'scan-secrets.js'));
  fs.copyFileSync(INSTALL, path.join(dir, 'scripts', 'install-hooks.js'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return {
    dir,
    git,
    write(file, body) {
      const target = path.join(dir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
      return target;
    },
    stage(...files) {
      git('add', '-f', ...files);
    },
    scan(...args) {
      const res = spawnSync('node', [path.join(dir, 'scripts', 'scan-secrets.js'), ...args], {
        cwd: dir,
        encoding: 'utf8',
      });
      return { code: res.status, out: `${res.stdout}${res.stderr}` };
    },
  };
}

test('the scanner refuses a staged API key and says which file', () => {
  const box = sandbox();
  box.write('src/keys.js', "export const GROQ = 'gsk_" + 'A'.repeat(40) + "';\n"); // scan-secrets:allow
  box.stage('src/keys.js');

  const res = box.scan('--staged');
  assert.equal(res.code, 1, 'a key must block the commit');
  assert.match(res.out, /src\/keys\.js:1/);
  assert.match(res.out, /Groq API key/);
  assert.doesNotMatch(res.out, /AAAAAAAAAAAAAAAAAAAAAAAA/, 'the value itself is never printed');
});

test('the scanner refuses a .env file, a session folder and a database', () => {
  for (const [file, reason] of [
    ['.env', /\.env file/],
    ['sessions/creds.json', /session folder/],
    ['data/assistant.db', /runtime data/],
    ['config/owner.json', /owner profile/],
    ['backups/2026-11-17.json.gz', /backup/],
    ['posters/poster-instagram.pdf', /poster/],
  ]) {
    const box = sandbox();
    box.write(file, '{}\n');
    box.stage(file);
    const res = box.scan('--staged');
    assert.equal(res.code, 1, `${file} must be refused`);
    assert.match(res.out, reason, `${file} should be reported as ${reason}`);
  }
});

test('.env.example is the template, so it is allowed', () => {
  const box = sandbox();
  box.write('.env.example', 'MY_NUMBER=923001234567\nGROQ_API_KEY=\n');
  box.stage('.env.example');
  assert.equal(box.scan('--staged').code, 0);
});

test('a clean commit passes', () => {
  const box = sandbox();
  box.write('src/plain.js', 'export const price = 550;\n');
  box.stage('src/plain.js');
  const res = box.scan('--staged');
  assert.equal(res.code, 0);
  assert.match(res.out, /clean/);
});

test('the owner\'s own prefixes are read from the gitignored file', () => {
  const box = sandbox();
  fs.writeFileSync(path.join(box.dir, '.private-prefixes'), '# mine\n9234\n447700\n');

  box.write('src/fixture.js', "const friend = '+92 345 5566778';\n"); // scan-secrets:allow
  box.stage('src/fixture.js');
  const blocked = box.scan('--staged');
  assert.equal(blocked.code, 1, 'a number with a listed prefix is refused');
  assert.match(blocked.out, /private number \(9234/);
  assert.doesNotMatch(blocked.out, /3455566778/, 'the number itself is only shown masked');

  // A different number — the fake one the tests use everywhere — still passes.
  box.write('src/fixture.js', "const owner = '923001234567';\n");
  box.stage('src/fixture.js');
  assert.equal(box.scan('--staged').code, 0);
});

test('a fixture that must contain a fake key can say so, explicitly', () => {
  const box = sandbox();
  box.write('test/x.test.js', "const fake = 'gsk_" + '1'.repeat(40) + "'; // scan-secrets:allow\n");
  box.stage('test/x.test.js');
  assert.equal(box.scan('--staged').code, 0, 'the pragma is per line and deliberate');
});

test('--all scans the tree and --history walks every commit', () => {
  const box = sandbox();
  box.write('src/clean.js', 'export const ok = true;\n');
  box.git('add', '-A');
  box.git('commit', '-q', '-m', 'clean');

  assert.equal(box.scan('--all').code, 0);
  assert.equal(box.scan('--history').code, 0);

  // A key that was committed and then deleted is still in history — which is
  // exactly the leak this project had, so the scanner has to see it.
  box.write('src/leak.js', "module.exports = { key: 'sk-" + 'B'.repeat(40) + "' };\n"); // scan-secrets:allow
  box.git('add', '-A');
  box.git('commit', '-q', '-m', 'oops');
  fs.unlinkSync(path.join(box.dir, 'src/leak.js'));
  box.git('add', '-A');
  box.git('commit', '-q', '-m', 'remove');

  assert.equal(box.scan('--all').code, 0, 'the working tree is clean again');
  const history = box.scan('--history');
  assert.equal(history.code, 1, 'but history still carries it');
  assert.match(history.out, /src\/leak\.js/);
  assert.match(history.out, /OpenAI-style key/);
});

test('npm run hooks writes an executable pre-commit that blocks a commit', () => {
  const box = sandbox();
  assert.equal(box.scan('--staged').code, 0, 'nothing staged yet');

  execFileSync('node', [path.join(box.dir, 'scripts', 'install-hooks.js')], { cwd: box.dir, encoding: 'utf8' });
  const hook = path.join(box.dir, '.git', 'hooks', 'pre-commit');
  assert.ok(fs.existsSync(hook), 'the hook exists');
  assert.ok(fs.statSync(hook).mode & 0o111, 'and it is executable');
  assert.match(fs.readFileSync(hook, 'utf8'), /scan-secrets\.js --staged/);

  // The real thing: a commit with a key in it is refused by git itself.
  box.write('src/leak.js', "export const k = 'gsk_" + 'C'.repeat(40) + "';\n"); // scan-secrets:allow
  box.git('add', '-f', 'src/leak.js');
  const commit = spawnSync('git', ['commit', '-m', 'leak'], { cwd: box.dir, encoding: 'utf8' });
  assert.notEqual(commit.status, 0, 'git refused the commit');
  assert.match(`${commit.stdout}${commit.stderr}`, /scan-secrets|Commit blocked/);

  // And a clean one goes through, so the hook is not just "always fail".
  box.git('restore', '--staged', 'src/leak.js');
  fs.unlinkSync(path.join(box.dir, 'src/leak.js'));
  box.write('src/fine.js', 'export const fine = 1;\n');
  box.git('add', '-A');
  const clean = spawnSync('git', ['commit', '-m', 'fine'], { cwd: box.dir, encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
});

test('an existing hook is kept and still runs after ours', () => {
  const box = sandbox();
  const hook = path.join(box.dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho existing-hook\n');
  fs.chmodSync(hook, 0o755);

  execFileSync('node', [path.join(box.dir, 'scripts', 'install-hooks.js')], { cwd: box.dir, encoding: 'utf8' });
  const body = fs.readFileSync(hook, 'utf8');
  assert.match(body, /scan-secrets\.js --staged/);
  assert.match(body, /echo existing-hook/, 'the previous hook was not overwritten');
  assert.ok(fs.existsSync(path.join(box.dir, '.git', 'hooks', 'pre-commit.before-scan-secrets')));
});

test('this repository is clean, and its own scanner is allowed to contain patterns', () => {
  const res = spawnSync('node', [SCANNER, '--all'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /clean/);
});
