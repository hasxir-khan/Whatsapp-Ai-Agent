#!/usr/bin/env node
// scripts/scan-secrets.js
// A commit that carries a key, a phone number or a session folder is a leak
// that cannot be undone by deleting the file later: it stays in history, in
// pull-request diffs and in everybody's clone. So the check happens *before*
// the commit exists.
//
//   node scripts/scan-secrets.js              # what is staged right now (the hook)
//   node scripts/scan-secrets.js --all        # every tracked file in the tree
//   node scripts/scan-secrets.js --history    # every blob in every commit
//   node scripts/scan-secrets.js --all --history
//
// Exit code: 0 when clean, 1 when something was found. Values are never printed
// in full — a secret echoed into a CI log is still a leaked secret.
//
// Two escape hatches, both deliberate:
//   • a line containing `scan-secrets:allow` is skipped (test fixtures that must
//     contain a fake key, and this file's own pattern list);
//   • `.private-prefixes` (gitignored) lists the owner's phone prefixes, so the
//     scanner can block their friends' numbers without knowing them in advance.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ALLOW = /scan-secrets:allow/;

// ── what a secret looks like ─────────────────────────────────
const KEY_PATTERNS = [
  { name: 'Groq API key', re: /gsk_[A-Za-z0-9]{20,}/g },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{30,}/g },
  { name: 'Gemini API key', re: /AQ\.[A-Za-z0-9_-]{30,}/g },
  { name: 'OpenAI-style key', re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{32,}/g },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: 'Slack token', re: /xox[baprs]-[0-9A-Za-z-]{10,}/g },
  { name: 'Hugging Face token', re: /hf_[A-Za-z0-9]{30,}/g },
  { name: 'Meta system-user token', re: /EAA[A-Za-z0-9]{60,}/g },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'JSON Web Token', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: 'Google service account', re: /"private_key"\s*:\s*"-----BEGIN/ },
  { name: 'WhatsApp session blob', re: /WA_SESSION\s*=\s*[A-Za-z0-9+/=]{80,}/g },
];

// Files that must never be committed, whatever is inside them.
const BLOCKED_PATHS = [
  // .env.example is the template; .env and .env.local are the secrets.
  { name: '.env file', re: /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[A-Za-z0-9_-]+)?$/ },
  { name: 'WhatsApp session folder', re: /(^|\/)(sessions?|auth_info|baileys_store)\//i },
  { name: 'database / runtime data', re: /(^|\/)(data|tenants|tmp)\// },
  { name: 'owner profile', re: /(^|\/)config\/owner\.json$/ },
  { name: 'MCP server list', re: /(^|\/)config\/mcp\.servers\.json$/ },
  { name: 'generated invoice', re: /(^|\/)invoices\// },
  { name: 'printed poster or QR', re: /(^|\/)posters\// },
  { name: 'backup archive', re: /(^|\/)backups?\// },
  { name: 'compressed database dump', re: /\.(json\.gz|sqlite3?|db\.gz)$/ },
  { name: 'machine-local override', re: /\.local\.json$/ },
  { name: 'eval report', re: /(^|\/)eval-report\.json$/ },
];

// The tags this scan itself is allowed to contain: the pattern list above is
// full of things that look like keys.
const SELF = path.join('scripts', 'scan-secrets.js');

function loadPrefixes(root) {
  const file = path.join(root, '.private-prefixes');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .map((line) => line.replace(/\D/g, ''))
    .filter((line) => line.length >= 4);
}

/** Mask a match so a log line cannot become the leak. */
function mask(value) {
  const text = String(value);
  if (text.length <= 8) return `${text.slice(0, 2)}…`;
  return `${text.slice(0, 4)}…${text.length} chars`;
}

/** Phone-shaped runs, normalised: '+92 300 1234567' → '923001234567'. */
function phoneCandidates(text) {
  const out = [];
  const re = /(?<![\d])(?:\+?\d[\d\s()\-]{8,18}\d)(?![\d])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) out.push({ digits, at: m.index });
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function isBinary(buffer) {
  return buffer.includes(0) || buffer.subarray(0, 4096).includes(0);
}

/**
 * Scan one blob of text.
 * @returns {Array<{category:string, line:number, sample:string}>}
 */
export function scanText(text, { prefixes = [], file = '' } = {}) {
  const findings = [];
  if (!text || isBinary(Buffer.from(text.slice(0, 8192)))) return findings;

  const lines = text.split('\n');
  const allowed = new Set();
  lines.forEach((line, i) => {
    if (ALLOW.test(line)) allowed.add(i + 1);
  });

  for (const { name, re } of KEY_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const line = lineOf(text, m.index);
      if (allowed.has(line)) continue;
      findings.push({ category: name, line, sample: mask(m[0]) });
    }
  }

  if (prefixes.length && file !== SELF) {
    for (const { digits, at } of phoneCandidates(text)) {
      const hit = prefixes.find((p) => digits.startsWith(p));
      if (!hit) continue;
      const line = lineOf(text, at);
      if (allowed.has(line)) continue;
      findings.push({ category: `private number (${hit.slice(0, 4)}…)`, line, sample: mask(digits) });
    }
  }

  return findings;
}

export function pathFinding(file) {
  for (const { name, re } of BLOCKED_PATHS) {
    if (re.test(file)) return { category: name, line: 0, sample: file };
  }
  return null;
}

// ── git plumbing ─────────────────────────────────────────────
function git(args, { binary = false } = {}) {
  return execFileSync('git', args, {
    cwd: root(),
    encoding: binary ? 'buffer' : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

let cachedRoot = null;
function root() {
  if (cachedRoot) return cachedRoot;
  cachedRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  return cachedRoot;
}

function stagedFiles() {
  return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function readStaged(file) {
  try {
    return git(['show', `:${file}`], { binary: true }).toString('utf8');
  } catch {
    return '';
  }
}

function trackedFiles() {
  return git(['ls-files']).split('\n').map((l) => l.trim()).filter(Boolean);
}

function scanPairs(pairs, prefixes, label) {
  const results = [];
  for (const { file, text, commit } of pairs) {
    const pathHit = pathFinding(file);
    if (pathHit) results.push({ ...pathHit, file, commit, label });
    if (text) {
      for (const f of scanText(text, { prefixes, file })) results.push({ ...f, file, commit, label });
    }
  }
  return results;
}

function report(results) {
  if (!results.length) return 0;
  const seen = new Set();
  console.error('\n✖ scan-secrets: this commit would publish something private.\n');
  for (const r of results) {
    const key = `${r.file}:${r.line}:${r.category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const where = r.commit ? `${r.commit.slice(0, 7)} ${r.file}` : r.file;
    const at = r.line ? `:${r.line}` : '';
    console.error(`  ${where}${at}  ${r.category}${r.sample && r.sample !== r.file ? `  (${r.sample})` : ''}`);
  }
  console.error('\n  Fix: unstage the file (git restore --staged <file>), add it to .gitignore,');
  console.error('  rotate the key if it was ever pushed, or — for a test fixture that must');
  console.error('  contain a fake key — put `scan-secrets:allow` on that line.\n');
  return 1;
}

function main(argv) {
  const opts = new Set(argv.slice(2));
  const prefixes = loadPrefixes(root());
  let results = [];

  if (opts.has('--staged')) {
    const pairs = stagedFiles().map((file) => ({ file, text: readStaged(file) }));
    results = results.concat(scanPairs(pairs, prefixes, 'staged'));
  }

  if (opts.has('--all')) {
    const pairs = trackedFiles().map((file) => {
      let text = '';
      try {
        const raw = fs.readFileSync(path.join(root(), file));
        text = isBinary(raw) ? '' : raw.toString('utf8');
      } catch {
        text = '';
      }
      return { file, text };
    });
    results = results.concat(scanPairs(pairs, prefixes, 'tree'));
  }

  if (opts.has('--history')) {
    const commits = git(['rev-list', '--all']).split('\n').filter(Boolean);
    for (const commit of commits) {
      const listing = git(['ls-tree', '-r', '-z', commit]);
      for (const record of listing.split('\0')) {
        if (!record.trim()) continue;
        const [meta, file] = record.split('\t');
        if (!meta || !file) continue;
        const [, type, sha] = meta.split(' ');
        if (type !== 'blob') continue;
        let text = '';
        try {
          const raw = git(['cat-file', '-p', sha], { binary: true });
          text = isBinary(raw) ? '' : raw.toString('utf8');
        } catch {
          text = '';
        }
        for (const f of scanPairs([{ file, text }], prefixes, 'history')) {
          results.push({ ...f, commit });
        }
      }
    }
  }

  if (!opts.has('--staged') && !opts.has('--all') && !opts.has('--history')) {
    // The hook calls it with no arguments: staged content is the useful default.
    const pairs = stagedFiles().map((file) => ({ file, text: readStaged(file) }));
    results = scanPairs(pairs, prefixes, 'staged');
  }

  const code = report(results);
  if (code === 0) {
    const scope = opts.has('--history') ? 'tree and history' : opts.has('--all') ? 'tree' : 'staged content';
    console.log(`✔ scan-secrets: ${scope} clean (${prefixes.length} private prefix${prefixes.length === 1 ? '' : 'es'} loaded)`);
  }
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
