#!/usr/bin/env node
// scripts/tenant.js
// Multi-user manager. Every user of this bot gets an isolated folder:
//
//   tenants/<slug>/
//     .env              their own API keys + their WhatsApp number
//     tenant.json       metadata (name, port, enabled)
//     config/owner.json their business knowledge (services, prices, policies)
//     data/             their own database (clients, leads, memory)
//     sessions/         their own WhatsApp login
//
// Usage:
//   node scripts/tenant.js new "Ayesha Designs" --number 923001112233
//   node scripts/tenant.js list
//   node scripts/tenant.js keys ayesha-designs GROQ_API_KEY=gsk_...
//   node scripts/tenant.js show ayesha-designs
//   node scripts/tenant.js rm ayesha-designs --yes
//   node scripts/run-all.js          # run every tenant at once

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const TENANTS = path.join(ROOT, 'tenants');

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

const die = (msg) => {
  console.error(`${c.red('✖')} ${msg}`);
  process.exit(1);
};

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

const validSlug = (s) => /^[a-z0-9][a-z0-9-]{1,31}$/.test(s);

const normalizePhone = (input) => {
  let d = String(input || '').replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0') && d.length === 11) d = `92${d.slice(1)}`;
  return d;
};

function tenantDir(slug) {
  return path.join(TENANTS, slug);
}

function readTenant(slug) {
  const file = path.join(tenantDir(slug), 'tenant.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function allTenants() {
  if (!fs.existsSync(TENANTS)) return [];
  return fs
    .readdirSync(TENANTS)
    .filter((d) => fs.existsSync(path.join(TENANTS, d, 'tenant.json')))
    .map((d) => readTenant(d))
    .filter(Boolean);
}

function readEnv(slug) {
  const file = path.join(tenantDir(slug), '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function writeEnvValue(slug, key, value) {
  const file = path.join(tenantDir(slug), '.env');
  if (!fs.existsSync(file)) die(`No .env for ${slug}. Create the tenant first.`);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let found = false;
  const next = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  fs.writeFileSync(file, next.join('\n'));
}

const mask = (v) => {
  if (!v) return '';
  if (v.length <= 10) return `${v.slice(0, 2)}…`;
  return `${v.slice(0, 4)}…${v.slice(-3)}`;
};

function nextPort() {
  const used = new Set(allTenants().map((t) => Number(t.port) || 0));
  let port = 3001;
  while (used.has(port)) port += 1;
  return port;
}

// ── commands ────────────────────────────────────────────────
function cmdNew(args, flags) {
  const name = flags.name || args.join(' ').trim();
  if (!name) die('Usage: node scripts/tenant.js new "Business Name" --number 923001112233');

  const slug = flags.slug ? slugify(flags.slug) : slugify(name);
  if (!validSlug(slug)) die('Could not make a slug from that name. Pass --slug something-simple');

  const number = normalizePhone(flags.number || '');
  if (!/^\d{10,15}$/.test(number)) {
    die('Pass the WhatsApp number this user will run the bot on: --number 923001112233 (international, no +)');
  }
  if (readTenant(slug)) die(`Tenant "${slug}" already exists.`);

  const dir = tenantDir(slug);
  for (const sub of ['config', 'data', 'sessions', 'tmp']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }

  const port = Number(flags.port) || nextPort();
  const brand = flags.brand || name;
  const timezone = flags.timezone || 'Asia/Karachi';

  const tenant = {
    slug,
    name,
    brand,
    number,
    port,
    timezone,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'tenant.json'), `${JSON.stringify(tenant, null, 2)}\n`);

  fs.writeFileSync(
    path.join(dir, '.env'),
    `# ${name} — secrets for this WhatsApp assistant.
# This file is private: it is gitignored, and only this tenant reads it.

# ── Identity ────────────────────────────────────────────────
MY_NUMBER=${number}
MY_NAME=${name}
MY_BRAND=${brand}
MY_TIMEZONE=${timezone}

# ── AI keys (free) — add your own ───────────────────────────
# Groq: console.groq.com/keys         (chat + voice-note transcription)
GROQ_API_KEY=
# Google AI Studio: aistudio.google.com/api-keys   (images + video)
GEMINI_API_KEY=
# Optional vision fallback
OPENROUTER_API_KEY=

# ── Dashboard ───────────────────────────────────────────────
ENABLE_WEB=true
PORT=${port}
`
  );

  fs.writeFileSync(
    path.join(dir, 'config', 'owner.json'),
    `${JSON.stringify(starterProfile({ name, brand, number, timezone }), null, 2)}\n`
  );

  console.log(`\n${c.green('✔')} Tenant ${c.bold(slug)} created for ${c.bold(name)} (+${number})`);
  console.log(`
  ${c.bold('1.')} Add this user's API keys (free):
       ${c.dim('node scripts/tenant.js keys ' + slug + ' GROQ_API_KEY=gsk_...')}
       ${c.dim('node scripts/tenant.js keys ' + slug + ' GEMINI_API_KEY=AQ...')}

  ${c.bold('2.')} Replace the starter services and prices in:
       ${c.dim(path.join('tenants', slug, 'config', 'owner.json'))}

  ${c.bold('3.')} Start this user's bot and scan the QR:
       ${c.dim('node scripts/tenant.js show ' + slug + ' --start')}
       ${c.dim('node scripts/run-all.js   # or run everybody at once')}

  Dashboard for this user: ${c.dim(`http://localhost:${port}`)}
`);
}

function starterProfile({ name, brand, timezone }) {
  return {
    owner: {
      name,
      brand,
      role: 'Founder',
      timezone,
      location: 'Pakistan',
      bio: `EDIT ME — one or two sentences about ${brand}, written in the first person. This is what the assistant uses to introduce you.`,
      availability: 'Mon–Sat, 10:00–22:00',
      replyTime: 'usually within a few hours',
      currency: 'PKR',
      timezone_note: 'Prices below are in PKR; foreign clients are converted automatically.',
      services: [
        {
          id: 'website',
          name: 'Business website',
          keywords: ['website', 'site', 'web', 'landing'],
          min: 20000,
          max: 60000,
          days: '7–15',
          includes: ['design', 'responsive build', 'basic SEO', 'contact form'],
          stack: ['Next.js', 'Node.js'],
        },
        {
          id: 'app',
          name: 'Mobile app',
          keywords: ['app', 'android', 'ios', 'mobile'],
          min: 80000,
          max: 250000,
          days: '30–60',
          includes: ['UI/UX', 'cross-platform build', 'API', 'store submission'],
          stack: ['Flutter', 'Node.js'],
        },
        {
          id: 'automation',
          name: 'Automation / AI bot',
          keywords: ['automation', 'bot', 'ai', 'chatbot', 'whatsapp'],
          min: 30000,
          max: 120000,
          days: '14–30',
          includes: ['workflow design', 'integration', 'testing', 'handover'],
          stack: ['Node.js', 'n8n', 'LLM APIs'],
        },
      ],
      addons: [],
      payment: { terms: 'EDIT ME — e.g. 50% advance, 50% on delivery', methods: ['Bank transfer'] },
      policies: {
        revisions: 'EDIT ME — how many revision rounds are included',
        support: 'EDIT ME — post-delivery support window',
      },
      portfolio: [],
      faqs: [],
      team: [],
      friends: [],
    },
    bot: {
      name: `${brand} Assistant`,
      formality: 'auto',
      persona:
        'Warm, sharp and slightly informal. Short WhatsApp messages, natural rhythm, no corporate script.',
    },
    currency: { base: 'PKR', symbol: 'Rs' },
  };
}

function cmdList() {
  const tenants = allTenants();
  if (!tenants.length) {
    console.log(`\nNo tenants yet. Create the first user:\n  ${c.dim('node scripts/tenant.js new "Ayesha Designs" --number 923001112233')}\n`);
    return;
  }
  console.log(`\n${c.bold('Users')} ${c.dim(`(${tenants.length})`)}\n`);
  console.log(`  ${'SLUG'.padEnd(24)} ${'NAME'.padEnd(22)} ${'NUMBER'.padEnd(15)} KEYS      SESSION  PORT`);
  for (const t of tenants) {
    const env = readEnv(t.slug);
    const keys = [env.GROQ_API_KEY, env.GEMINI_API_KEY].filter(Boolean).length;
    const session = fs.existsSync(path.join(tenantDir(t.slug), 'sessions', 'creds.json'));
    console.log(
      `  ${t.slug.padEnd(24)} ${String(t.name).slice(0, 20).padEnd(22)} ${String(t.number).padEnd(15)} ` +
        `${(keys ? c.green(`${keys} key${keys > 1 ? 's' : ''}`) : c.yellow('none')).padEnd(18)} ` +
        `${(session ? c.green('yes') : c.dim('no')).padEnd(16)} ${t.port}`
    );
  }
  console.log(`\n  Run everybody: ${c.dim('node scripts/run-all.js')}\n`);
}

function cmdShow(slug, flags) {
  const t = readTenant(slug);
  if (!t) die(`No tenant "${slug}". Try: node scripts/tenant.js list`);

  const dir = tenantDir(slug);
  const env = readEnv(slug);
  const dbFile = path.join(dir, 'data', 'assistant.db');
  const session = fs.existsSync(path.join(dir, 'sessions', 'creds.json'));

  console.log(`\n${c.bold(t.name)} ${c.dim(`(${slug})`)}`);
  console.log(`  WhatsApp number : +${t.number}`);
  console.log(`  Dashboard       : http://localhost:${t.port}`);
  console.log(`  Folder          : ${dir}`);
  console.log(`  Business profile: ${path.join(dir, 'config', 'owner.json')}`);
  console.log(`  Database        : ${fs.existsSync(dbFile) ? dbFile : c.dim('(created on first start)')}`);
  console.log(`  Session         : ${session ? c.green('logged in') : c.yellow('not logged in — QR on first start')}`);
  console.log(`  Groq key        : ${env.GROQ_API_KEY ? c.green(mask(env.GROQ_API_KEY)) : c.yellow('missing')}`);
  console.log(`  Gemini key      : ${env.GEMINI_API_KEY ? c.green(mask(env.GEMINI_API_KEY)) : c.yellow('missing')}`);

  if (flags.start) {
    console.log(`\nStarting ${t.name}… scan the QR in the terminal (or open /qr.png on port ${t.port})\n`);
    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        TENANT: slug,
        ENV_FILE: path.join(dir, '.env'),
        CONFIG_DIR: path.join(dir, 'config'),
        DATA_DIR: path.join(dir, 'data'),
        SESSION_FOLDER: path.join(dir, 'sessions'),
        TMP_DIR: path.join(dir, 'tmp'),
        PORT: String(t.port),
        ENABLE_WEB: 'true',
      },
    });
    child.on('exit', (code) => process.exit(code || 0));
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    return;
  }
  console.log('');
}

function cmdKeys(slug, pairs = []) {
  const t = readTenant(slug);
  if (!t) die(`No tenant "${slug}". Try: node scripts/tenant.js list`);
  if (!pairs.length) {
    const env = readEnv(slug);
    console.log(`\n${c.bold('Keys for ' + slug)}`);
    for (const key of ['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) {
      console.log(`  ${key.padEnd(20)} ${env[key] ? c.green(mask(env[key])) : c.dim('not set')}`);
    }
    console.log(`\n  Set one: ${c.dim(`node scripts/tenant.js keys ${slug} GROQ_API_KEY=gsk_...`)}\n`);
    return;
  }
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 1) die(`Expected KEY=VALUE, got "${pair}"`);
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) die(`Invalid key name "${key}"`);
    writeEnvValue(slug, key, value);
    console.log(`${c.green('✔')} ${slug}: ${key} set (${mask(value)})`);
  }
}

function cmdRm(slug, flags) {
  const t = readTenant(slug);
  if (!t) die(`No tenant "${slug}".`);
  if (!flags.yes) {
    die(`This deletes ${path.join('tenants', slug)} — clients, leads, session and keys.\n  Re-run with --yes if that is what you want.`);
  }
  fs.rmSync(tenantDir(slug), { recursive: true, force: true });
  console.log(`${c.green('✔')} Deleted tenant ${slug}.`);
}

// ── arg parsing ─────────────────────────────────────────────
const [, , command = 'help', ...rest] = process.argv;
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const name = a.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  } else {
    positional.push(a);
  }
}

switch (command) {
  case 'new':
  case 'add':
    cmdNew(positional, flags);
    break;

  case 'list':
  case 'ls':
    cmdList();
    break;

  case 'show':
    cmdShow(positional[0] || '', flags);
    break;

  case 'keys':
  case 'key': {
    const slug = positional[0];
    if (!slug) die('Usage: node scripts/tenant.js keys <slug> GROQ_API_KEY=...');
    cmdKeys(slug, positional.slice(1));
    break;
  }

  case 'rm':
  case 'remove':
    cmdRm(positional[0] || '', flags);
    break;

  default:
    console.log(`
${c.bold('Multi-user manager')}

  ${c.dim('node scripts/tenant.js new "Business Name" --number 923001112233 [--brand X] [--port 3001]')}
  ${c.dim('node scripts/tenant.js list')}
  ${c.dim('node scripts/tenant.js show <slug> [--start]')}
  ${c.dim('node scripts/tenant.js keys <slug> [KEY=VALUE ...]')}
  ${c.dim('node scripts/tenant.js rm <slug> --yes')}

  Each user gets their own keys, business profile, WhatsApp session and database.
  Run them all together with: ${c.bold('node scripts/run-all.js')}
`);
}
