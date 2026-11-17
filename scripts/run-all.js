#!/usr/bin/env node
// scripts/run-all.js
// Runs every tenant (every user of this bot) side by side, each in its own
// process with its own keys, WhatsApp session, database and dashboard port.
//
//   node scripts/run-all.js
//   node scripts/run-all.js --only ayesha-designs
//
// One crash never takes the others down: each tenant restarts on its own.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const TENANTS = path.join(ROOT, 'tenants');

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > -1 ? process.argv[i + 1] : null;
})();

const colors = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m', '\x1b[31m'];
const reset = '\x1b[0m';

function tenants() {
  if (!fs.existsSync(TENANTS)) return [];
  return fs
    .readdirSync(TENANTS)
    .filter((d) => fs.existsSync(path.join(TENANTS, d, 'tenant.json')))
    .map((d) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(TENANTS, d, 'tenant.json'), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((t) => t && t.enabled !== false)
    .filter((t) => !only || t.slug === only);
}

const list = tenants();
if (!list.length) {
  console.log('\nNo tenants to run.');
  console.log('Create one first:  node scripts/tenant.js new "Business Name" --number 923001112233\n');
  process.exit(0);
}

let shuttingDown = false;
const children = new Map();

function envFor(t) {
  const dir = path.join(TENANTS, t.slug);
  return {
    ...process.env,
    TENANT: t.slug,
    ENV_FILE: path.join(dir, '.env'),
    CONFIG_DIR: path.join(dir, 'config'),
    DATA_DIR: path.join(dir, 'data'),
    SESSION_FOLDER: path.join(dir, 'sessions'),
    TMP_DIR: path.join(dir, 'tmp'),
    PORT: String(t.port || 3000),
    ENABLE_WEB: 'true',
    LOG_LEVEL: process.env.LOG_LEVEL || 'warn',
  };
}

function start(t, index, restarts = 0) {
  const color = colors[index % colors.length];
  const tag = `${color}[${t.slug}]${reset}`;
  const dir = path.join(TENANTS, t.slug);

  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: envFor(t),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  children.set(t.slug, child);

  const pipe = (stream, isErr) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const out = `${tag} ${line}`;
        if (isErr) console.error(out);
        else console.log(out);
      }
    });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);

  child.on('exit', (code) => {
    children.delete(t.slug);
    if (shuttingDown) return;

    const wait = Math.min(60000, 2000 * 2 ** Math.min(5, restarts));
    console.error(`${tag} exited (${code}) — restarting in ${Math.round(wait / 1000)}s`);
    setTimeout(() => start(t, index, restarts + 1), wait).unref?.();
  });

  console.log(`${tag} started · dashboard http://localhost:${t.port}`);
}

console.log(`\n\x1b[1mRunning ${list.length} user${list.length > 1 ? 's' : ''}\x1b[0m`);
for (const t of list) console.log(`  • ${t.name} (+${t.number}) → port ${t.port}`);
console.log('');

list.forEach((t, i) => start(t, i));

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} — stopping ${children.size} bot(s)…`);
  for (const child of children.values()) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(0), 2500).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
