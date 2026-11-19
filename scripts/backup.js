#!/usr/bin/env node
// scripts/backup.js
// One file you can move to another machine and restore in one command.
//
//   node scripts/backup.js <slug>                 # a tenant
//   node scripts/backup.js default                # this installation
//   node scripts/backup.js <slug> --with-keys     # include .env (see below)
//   node scripts/backup.js <slug> --out ~/backups
//
// What goes in: the SQLite database (contacts, leads, bookings, orders, the
// knowledge base), config/owner.json, tenant.json, templates overrides — the
// things that are expensive to lose.
//
// What does not: `.env` (API keys and tokens) unless you ask with --with-keys,
// and `sessions/` (the WhatsApp login) unless --with-sessions. A backup with
// keys in it is a liability; a backup without them restores into a tenant whose
// .env you already have. The archive is a gzipped JSON bundle, so it works the
// same on Linux, macOS and Windows with no tar/zip dependency.

import fs from 'node:fs';
import { ensurePrivateDir, resolveInside, tightenFile, writePrivateFile } from '../src/services/validation.js';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

/** Where a slug's files live: `default` is the install itself. */
export function tenantDir(slug, root = process.cwd()) {
  if (!slug || slug === 'default' || slug === 'owner' || slug === 'root') return root;
  return path.join(root, 'tenants', slug);
}

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/**
 * Build the bundle in memory. Exported so a test can check the contents
 * without touching the filesystem contract.
 */
export function buildBundle({ slug = 'default', dir, withKeys = false, withSessions = false, now = new Date() } = {}) {
  if (!dir || !fs.existsSync(dir)) throw new Error(`No such tenant directory: ${dir}`);

  const files = {};
  const skipped = [];

  // The database — the only file that really matters.
  const dbFile = path.join(dir, 'data', 'assistant.db');
  if (fs.existsSync(dbFile)) files['data/assistant.db'] = fs.readFileSync(dbFile).toString('base64');
  else skipped.push('data/assistant.db (not created yet)');

  // Business knowledge.
  for (const rel of ['config/owner.json', 'tenant.json', 'config/templates']) {
    const full = path.join(dir, rel);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) {
      for (const inner of walk(full)) {
        files[`${rel}/${inner}`] = fs.readFileSync(path.join(full, inner)).toString('base64');
      }
    } else {
      files[rel] = fs.readFileSync(full).toString('base64');
    }
  }

  // Optional, and off by default for good reasons.
  if (withKeys) {
    if (fs.existsSync(path.join(dir, '.env'))) files['.env'] = fs.readFileSync(path.join(dir, '.env')).toString('base64');
  } else {
    skipped.push('.env (contains API keys — use --with-keys)');
  }

  if (withSessions) {
    for (const inner of walk(path.join(dir, 'sessions'))) {
      files[`sessions/${inner}`] = fs.readFileSync(path.join(dir, 'sessions', inner)).toString('base64');
    }
  } else if (fs.existsSync(path.join(dir, 'sessions'))) {
    skipped.push('sessions/ (WhatsApp login — use --with-sessions)');
  }

  return {
    format: 'wa-assistant-backup',
    version: 1,
    slug,
    createdAt: now.toISOString(),
    withKeys,
    withSessions,
    files,
    skipped,
  };
}

export function writeArchive(bundle, outDir = path.join(REPO, 'backups')) {
  // A backup is the whole tenant in one file — keys included when asked. It gets
  // a 0700 folder and a 0600 file, so another user on the box cannot read it.
  ensurePrivateDir(outDir);
  const stamp = bundle.createdAt.replace(/[:.]/g, '-').slice(0, 19);
  const file = resolveInside(outDir, `${bundle.slug}-${stamp}.json.gz`);
  writePrivateFile(file, zlib.gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8')));
  return file;
}

export function readArchive(file) {
  const raw = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  const bundle = JSON.parse(raw);
  if (bundle.format !== 'wa-assistant-backup') throw new Error('Not a backup made by this script');
  return bundle;
}

/** Restore into a directory, keeping a copy of whatever it overwrites. */
export function restoreArchive(bundle, { dir, keepExisting = true, now = new Date() } = {}) {
  ensurePrivateDir(dir);
  const restored = [];
  const saved = [];

  for (const [rel, b64] of Object.entries(bundle.files || {})) {
    // Never let a crafted archive write outside the tenant folder. One rule,
    // shared with the admin panel and the CLI.
    let target;
    try {
      target = resolveInside(dir, rel);
    } catch {
      throw new Error(`Refusing to write outside the tenant folder: ${rel}`);
    }
    if (target === path.resolve(dir)) throw new Error(`Refusing to write to the tenant folder itself: ${rel}`);

    if (keepExisting && fs.existsSync(target)) {
      const bak = `${target}.before-restore-${now.toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(target, bak);
      tightenFile(bak);
      saved.push(path.relative(dir, bak));
    }
    writePrivateFile(target, Buffer.from(b64, 'base64'));
    restored.push(rel);
  }
  return { restored, saved };
}

function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.filter((a) => !a.startsWith('--'));
  const slug = positional[0];

  if (!slug) {
    console.log(`\n${c.bold('Backup a tenant')}\n`);
    console.log('  node scripts/backup.js <slug> [--with-keys] [--with-sessions] [--out DIR]\n');
    console.log(`  ${c.dim('Use "default" for this installation. Keys are excluded unless you ask.')}\n`);
    process.exit(1);
  }

  const dir = tenantDir(slug);
  if (!fs.existsSync(dir)) {
    console.error(c.red(`\nNo such tenant: ${slug} (${dir})\n`));
    process.exit(1);
  }

  const outIdx = args.indexOf('--out');
  const outDir = outIdx > -1 ? path.resolve(args[outIdx + 1]) : path.join(REPO, 'backups');

  const bundle = buildBundle({
    slug,
    dir,
    withKeys: flags.includes('--with-keys'),
    withSessions: flags.includes('--with-sessions'),
  });
  const file = writeArchive(bundle, outDir);

  const bytes = fs.statSync(file).size;
  console.log(`\n${c.bold('💾 Backup')}\n`);
  console.log(`  ${c.green('written')} ${file} (${(bytes / 1024).toFixed(1)} KB)`);
  console.log(`  files: ${Object.keys(bundle.files).length}`);
  for (const s of bundle.skipped) console.log(`  ${c.yellow('skipped')} ${s}`);
  console.log(`\n  Restore: node scripts/restore.js ${path.basename(file)} --slug ${slug}\n`);
  if (bundle.withKeys) {
    console.log(`  ${c.yellow('⚠ This archive contains .env (API keys). Keep it private.')}\n`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('backup.js')) main();

export default { buildBundle, writeArchive, readArchive, restoreArchive, tenantDir };
