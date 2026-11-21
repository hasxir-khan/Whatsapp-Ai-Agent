#!/usr/bin/env node
// scripts/install-hooks.js
// `npm run hooks` writes the git hooks that keep private data out of history.
//
// A hook is just a file in .git/hooks — it is not copied by a clone and it is
// not versioned, so every clone has to install it once. `npm install` does it
// automatically (prepare script); this file is what that script runs, and what
// you run again after a fresh clone if the prepare script was skipped.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

const PRE_COMMIT = `#!/bin/sh
# Installed by \`npm run hooks\` (scripts/install-hooks.js). Do not edit by hand.
# Blocks a commit whose staged content carries a key, a phone number listed in
# .private-prefixes, a .env file, a session folder or a database dump.
node scripts/scan-secrets.js --staged || {
  echo ""
  echo "Commit blocked by scan-secrets. Nothing was committed."
  exit 1
}
`;

function gitDir() {
  const out = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
  return path.isAbsolute(out) ? out : path.join(ROOT, out);
}

function install() {
  const dir = path.join(gitDir(), 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'pre-commit');

  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, 'utf8');
    if (!existing.includes('scan-secrets')) {
      // Somebody else's hook: keep it, run ours first, then theirs.
      const backup = path.join(dir, 'pre-commit.before-scan-secrets');
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, existing, 'utf8');
      fs.writeFileSync(target, `${PRE_COMMIT}\n# ── the hook that was here before ──\n${existing}`, 'utf8');
      fs.chmodSync(target, 0o755);
      console.log('✔ pre-commit installed (your previous hook still runs after it)');
      return target;
    }
  }

  fs.writeFileSync(target, PRE_COMMIT, 'utf8');
  fs.chmodSync(target, 0o755);
  console.log('✔ pre-commit installed — a commit with a secret or a private number is refused');
  console.log('  Undo with: rm .git/hooks/pre-commit');
  return target;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    install();
  } catch (err) {
    // Not a git checkout (a tarball, a Docker build): nothing to install, and
    // that is not an error worth failing an npm install over.
    console.log(`hooks: skipped (${err.message.split('\n')[0]})`);
  }
}

export { install, PRE_COMMIT };
