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
//   node scripts/tenant.js new "Burger Point" --number 923001112233 --template restaurant
//   node scripts/tenant.js setup burger-point            # interactive business wizard
//   node scripts/tenant.js learn burger-point ./menu.pdf # feed it the real documents
//   node scripts/tenant.js list
//   node scripts/tenant.js keys ayesha-designs GROQ_API_KEY=gsk_...
//   node scripts/tenant.js show ayesha-designs
//   node scripts/tenant.js rm ayesha-designs --yes
//   node scripts/run-all.js          # run every tenant at once

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { buildProfileFromTemplate, isTemplate, listTemplates, TEMPLATE_IDS } from '../src/services/templates.js';
import { runSetup } from './wizard.js';

// Where the users live: whatever folder you ran the command from.
const ROOT = process.cwd();
// Overridable so the admin panel (and its tests) can point at a folder of their
// own without a second implementation of "where tenants live".
const TENANTS = path.resolve(process.env.TENANTS_DIR || path.join(ROOT, 'tenants'));
// Where the code lives: this script's folder, so child processes still work
// when the manager is run from somewhere else.
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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
/**
 * Create one tenant. Throws on bad input and returns the result — the CLI below
 * and the admin panel both call this, so there is exactly one implementation of
 * "what a tenant looks like".
 */
export function createTenant(opts = {}) {
  const name = String(opts.name || '').trim();
  if (!name) throw new Error('Usage: node scripts/tenant.js new "Business Name" --number 923001112233');

  const slug = opts.slug ? slugify(opts.slug) : slugify(name);
  if (!validSlug(slug)) throw new Error('Could not make a slug from that name. Pass --slug something-simple');

  const number = normalizePhone(opts.number || '');
  if (!/^\d{10,15}$/.test(number)) {
    throw new Error('Pass the WhatsApp number this user will run the bot on: --number 923001112233 (international, no +)');
  }
  if (readTenant(slug)) throw new Error(`Tenant "${slug}" already exists.`);

  if (opts.template && !isTemplate(opts.template)) {
    throw new Error(`Unknown template "${opts.template}". Available: ${TEMPLATE_IDS.join(', ')}`);
  }

  const dir = tenantDir(slug);
  for (const sub of ['config', 'data', 'sessions', 'tmp']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }

  const port = Number(opts.port) || nextPort();
  const brand = opts.brand || name;
  const timezone = opts.timezone || 'Asia/Karachi';
  const template = opts.template || null;

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

# ── Transport ───────────────────────────────────────────────
# baileys (default, free) or cloud (Meta's official API — see README)
TRANSPORT=baileys
# CLOUD_PHONE_ID=
# CLOUD_TOKEN=
# CLOUD_VERIFY_TOKEN=
# CLOUD_APP_SECRET=

# ── Growth agents (Phase 3) — off until you switch them on ──
# In config/owner.json: features.bookingAgent, features.followUpAgent,
# features.growthApproval (true = drafts wait for .approve).
# GROWTH_CONTACT_CAP=1           # proactive messages per person per 24h
# GROWTH_DAILY_CAP=30            # per day, whole assistant
# GROWTH_BAILEYS_CAP=12          # lower ceiling when running on Baileys
# GROWTH_QUIET_START=21:00       # no proactive messages in this window
# GROWTH_QUIET_END=09:00
# GROWTH_MIN_SCORE=40            # follow up only above this lead score
# GROWTH_FOLLOWUP_HOURS=24,72    # silence, in hours
# GROWTH_FOLLOWUP_MAX=2

# ── Analyst / closer / review agents (Phase 3 part 2) ───────
# In config/owner.json: features.analystAgent, features.closerAgent,
# features.reviewAgent (all off by default).
# ANALYST_DAY=mon                # weekly report day, business timezone
# ANALYST_TIME=09:00
# REVIEW_AFTER_HOURS=24          # wait after .done before asking for feedback
# CLOSER_MAX_ATTEMPTS=2

# ── Reactivation / content agents (Phase 3 part 3) ──────────
# In config/owner.json: features.reactivationAgent, features.contentAgent.
# REACTIVATION_AFTER_DAYS=45
# REACTIVATION_MAX_CYCLES=2
# REACTIVATION_COOLDOWN_DAYS=180
# CONTENT_DAY=wed
# CONTENT_TIME=10:00
# TENANT_DAILY_LLM_CALLS=250      # this tenant's own daily AI budget

# ── PDF documents + self-healing (Phase 4) ──────────────────
# In config/owner.json: features.pdfInvoices, features.selfHealing.
# INVOICE_KEEP_DAYS=90
# SELF_HEALING_WINDOW_MINUTES=30
# SELF_HEALING_MAX_PER_DAY=3

# ── Live inbox (Phase 4) ────────────────────────────────────
# config/owner.json: features.liveInbox.
# DASHBOARD_TOKEN=long-random-string   # required on anything public
# PUBLIC_URL=https://bot.yourdomain.com  # for the .inbox link

# ── Google Calendar (optional) ──────────────────────────────
# Bookings live in SQLite either way; this only mirrors them.
# GOOGLE_CALENDAR_ID=
# GOOGLE_SERVICE_ACCOUNT_FILE=./secrets/service-account.json
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_REFRESH_TOKEN=

# ── Dashboard ───────────────────────────────────────────────
ENABLE_WEB=true
PORT=${port}
`
  );

  const profile = template
    ? buildProfileFromTemplate(template, {
        name,
        brand,
        number,
        timezone,
        city: opts.city || '',
        currency: opts.currency || 'PKR',
        languages: opts.languages
          ? String(opts.languages).split(',').map((s) => s.trim()).filter(Boolean)
          : undefined,
        hours: opts.hours || '',
      })
    : starterProfile({ name, brand, number, timezone });

  fs.writeFileSync(path.join(dir, 'config', 'owner.json'), `${JSON.stringify(profile, null, 2)}\n`);

  return { slug, name, number, port, dir, template };
}

function cmdNew(args, flags) {
  let created;
  try {
    created = createTenant({
      name: flags.name || args.join(' ').trim(),
      slug: flags.slug,
      number: flags.number,
      template: flags.template,
      port: flags.port,
      brand: flags.brand,
      timezone: flags.timezone,
      city: flags.city,
      currency: flags.currency,
      languages: flags.languages,
      hours: flags.hours,
    });
  } catch (err) {
    die(err.message);
  }
  const { slug, name, number, port, template } = created;
  console.log(
    `\n${c.green('✔')} Tenant ${c.bold(slug)} created for ${c.bold(name)} (+${number})` +
      (template ? ` ${c.dim(`from the ${template} template`)}` : '')
  );
  console.log(`
  ${c.bold('1.')} Add this user's API keys (free):
       ${c.dim('node scripts/tenant.js keys ' + slug + ' GROQ_API_KEY=gsk_...')}
       ${c.dim('node scripts/tenant.js keys ' + slug + ' GEMINI_API_KEY=AQ...')}

  ${c.bold('2.')} Tell it about the business:
       ${c.dim(`node scripts/tenant.js setup ${slug}`)}   ${c.dim('# 10 questions')}
       ${c.dim(`node scripts/tenant.js learn ${slug} menu.pdf`)}   ${c.dim('# or feed it documents')}
       ${c.dim(path.join('tenants', slug, 'config', 'owner.json'))}   ${c.dim('# or edit by hand')}

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
    const child = spawn(process.execPath, [path.join(REPO, 'src', 'index.js')], {
      cwd: REPO,
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
// Everything below runs only when this file is executed. The admin panel
// imports createTenant() from here, and importing must never read argv.
function main() {
const [, , command = 'help', ...rest] = process.argv;
const flags = {};
const positional = [];
function cmdSetup(slug, flags) {
  const t = readTenant(slug);
  if (!t) die(`No tenant "${slug}". Create it first: node scripts/tenant.js new "Name" --number 923...`);

  const dir = tenantDir(slug);
  return runSetup({
    dir,
    tenant: { name: t.name, number: t.number, timezone: t.timezone || 'Asia/Karachi' },
    flags,
  }).then((result) => {
    if (!result.saved) process.exit(1);
  });
}

function cmdLearn(slug, target, flags) {
  const t = readTenant(slug);
  if (!t) die(`No tenant "${slug}". Try: node scripts/tenant.js list`);

  const dir = tenantDir(slug);
  const args = [path.join(REPO, 'scripts', 'learn.js')];
  // Resolve a relative file against where the user ran the command, since the
  // child process runs from the repo folder.
  if (target) args.push(/^https?:\/\//i.test(target) ? target : path.resolve(ROOT, target));
  if (flags.name) args.push('--name', String(flags.name));
  if (flags.reindex) args.push('--reindex');
  if (flags.force) args.push('--force');

  const child = spawnSync(process.execPath, args, {
    cwd: REPO,
    stdio: 'inherit',
    env: {
      ...process.env,
      TENANT: slug,
      ENV_FILE: path.join(dir, '.env'),
      CONFIG_DIR: path.join(dir, 'config'),
      DATA_DIR: path.join(dir, 'data'),
      SESSION_FOLDER: path.join(dir, 'sessions'),
      TMP_DIR: path.join(dir, 'tmp'),
      ENABLE_WEB: 'false',
    },
  });
  process.exit(child.status || 0);
}

function cmdTemplates() {
  const templates = listTemplates();
  console.log(`\n${c.bold('Industry templates')}\n`);
  for (const t of templates) {
    console.log(`  ${t.emoji} ${c.bold(t.id.padEnd(12))} ${t.label}`);
    console.log(`     ${c.dim(t.description)}`);
    console.log(`     ${c.dim(`${t.items} example items · ${t.faqs} FAQs · good for ${t.goodFor}`)}`);
  }
  console.log(`\n  Use one: ${c.dim('node scripts/tenant.js new "My Business" --number 923001112233 --template restaurant')}`);
  console.log(`  Or run the wizard: ${c.dim('node scripts/tenant.js setup <slug>')}\n`);
}

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

  case 'setup':
  case 'wizard': {
    const slug = positional[0];
    if (!slug) die('Usage: node scripts/tenant.js setup <slug> [--non-interactive --type salon --city Islamabad]');
    cmdSetup(slug, flags);
    break;
  }

  case 'learn':
  case 'ingest': {
    const slug = positional[0];
    const target = positional[1];
    if (!slug || (!target && !flags.reindex)) {
      die('Usage: node scripts/tenant.js learn <slug> <file|url> [--name "Title"]\n       node scripts/tenant.js learn <slug> --reindex [--force]');
    }
    cmdLearn(slug, target, flags);
    break;
  }

  case 'templates':
  case 'template':
    cmdTemplates();
    break;

  default:
    console.log(`
${c.bold('Multi-user manager')}

  ${c.dim('node scripts/tenant.js new "Business Name" --number 923001112233 [--template restaurant] [--port 3001]')}
  ${c.dim('node scripts/tenant.js setup <slug>')}          ${c.dim('# business wizard')}
  ${c.dim('node scripts/tenant.js learn <slug> <file|url>')} ${c.dim('# knowledge base')}
  ${c.dim('node scripts/tenant.js templates')}
  ${c.dim('node scripts/tenant.js list')}
  ${c.dim('node scripts/tenant.js show <slug> [--start]')}
  ${c.dim('node scripts/tenant.js keys <slug> [KEY=VALUE ...]')}
  ${c.dim('node scripts/tenant.js rm <slug> --yes')}

  Each user gets their own keys, business profile, WhatsApp session and database.
  Run them all together with: ${c.bold('node scripts/run-all.js')}
`);
}
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) main();
