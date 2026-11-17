#!/usr/bin/env node
// scripts/restore.js
// Put a backup back. The only dangerous command in this repo, so it is careful:
//
//   node scripts/restore.js backups/ayesha-2026-06-10T09-00-00.json.gz --slug ayesha
//   node scripts/restore.js <archive> --slug ayesha --into ./tenants/ayesha-copy
//   node scripts/restore.js <archive> --slug ayesha --dry-run
//
// Every file it overwrites is first copied to `<file>.before-restore-<time>`,
// so a mistaken restore is one `mv` away from being undone.

import fs from 'node:fs';
import path from 'node:path';
import { readArchive, restoreArchive, tenantDir } from './backup.js';

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.filter((a) => !a.startsWith('--'));
  const archive = positional[0];

  const getArg = (name) => {
    const i = args.indexOf(`--${name}`);
    return i > -1 ? args[i + 1] : null;
  };

  if (!archive) {
    console.log(`\n${c.bold('Restore a backup')}\n`);
    console.log('  node scripts/restore.js <archive.json.gz> --slug <slug> [--into DIR] [--dry-run]\n');
    process.exit(1);
  }
  if (!fs.existsSync(archive)) {
    console.error(c.red(`\nNo such archive: ${archive}\n`));
    process.exit(1);
  }

  const bundle = readArchive(archive);
  const slug = getArg('slug') || bundle.slug || 'default';
  const dir = getArg('into') ? path.resolve(getArg('into')) : tenantDir(slug);

  console.log(`\n${c.bold('♻️  Restore')}\n`);
  console.log(`  archive : ${archive}`);
  console.log(`  made    : ${bundle.createdAt} · ${Object.keys(bundle.files).length} files`);
  console.log(`  into    : ${dir}`);
  if (bundle.withKeys) console.log(`  ${c.yellow('contains .env — keys will be restored too')}`);

  if (flags.includes('--dry-run')) {
    console.log('\n  dry run — nothing written:\n');
    for (const rel of Object.keys(bundle.files)) console.log(`    ${rel}`);
    console.log('');
    return;
  }

  const { restored, saved } = restoreArchive(bundle, { dir });
  console.log(`\n  ${c.green('restored')} ${restored.length} files`);
  for (const rel of restored) console.log(`    ${rel}`);
  if (saved.length) {
    console.log(`\n  ${c.dim('previous versions kept:')}`);
    for (const rel of saved) console.log(`    ${rel}`);
  }
  if (!bundle.files['.env']) {
    console.log(`\n  ${c.yellow('No .env in this archive — the tenant still needs its API keys.')}`);
    console.log(`  ${c.dim(`node scripts/tenant.js keys ${slug} GROQ_API_KEY=...`)}`);
  }
  console.log(`\n  Start it: ${c.dim(`node scripts/run-all.js  (or npm start)`)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith('restore.js')) main();

export default { main };
