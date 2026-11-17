#!/usr/bin/env node
// scripts/doctor.js
// "Why isn't it working?" — checks every dependency and provider in one go.
// Usage: npm run doctor

import fs from 'node:fs';
import path from 'node:path';
import { config, describeConfig, teamMembers } from '../src/config/env.js';
import { GEMINI_BASE, geminiHeadersWith, authHeadersFor, isKeyError, explainGeminiError, maskKey, keyFormat } from '../src/utils/gemini.js';

const ok = (m) => console.log(`  ✅ ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);
const info = (m) => console.log(`     ${m}`);

const problems = [];
const notes = [];

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function checkNode() {
  section('Runtime');
  const major = parseInt(process.version.slice(1).split('.')[0], 10);
  if (major >= 20) ok(`Node ${process.version}`);
  else {
    bad(`Node ${process.version} — need 20 or newer`);
    problems.push('Upgrade Node to 20+ (Baileys and fetch need it).');
  }
  if (process.platform === 'win32') notes.push('On Windows, run the bot in WSL or a Linux VPS — Baileys is happiest there.');
}

async function checkFiles() {
  section('Files');
  if (fs.existsSync(path.join(config.root, '.env'))) ok('.env found');
  else {
    warn('.env not found — using defaults from config/owner.json');
    notes.push('Copy .env.example to .env and add your keys.');
  }

  for (const file of ['config/owner.example.json', 'config/owner.json', 'config/countries.json']) {
    if (fs.existsSync(path.join(config.root, file))) ok(file);
    else {
      bad(`${file} missing`);
      problems.push(`Restore ${file} from the repo.`);
    }
  }

  const services = config.owner.profile?.owner?.services?.length || 0;
  if (services >= 3) ok(`${services} services in your price list`);
  else {
    warn(`Only ${services} services configured`);
    notes.push('Add your services + price ranges to config/owner.json so quotes are accurate.');
  }
}

async function checkOwner() {
  section('Identity');
  if (/^\d{10,15}$/.test(config.owner.number)) ok(`MY_NUMBER = +${config.owner.number}`);
  else {
    bad(`MY_NUMBER looks wrong: "${config.owner.number}"`);
    problems.push('Set MY_NUMBER in international format, e.g. 923169896229.');
  }
  const services = config.owner.profile?.owner?.services || [];
  info(`Owner: ${config.owner.name} · brand: ${config.owner.profile?.owner?.brand || '—'}`);
  info(`Timezone: ${config.timezone} · currency: ${config.owner.profile?.currency?.base || 'PKR'}`);
  info(`Price book: ${services.length} services, ${config.owner.profile?.owner?.addons?.length || 0} add-ons`);
}

async function timedFetch(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkGroq() {
  section('Groq (chat + speech-to-text)');
  if (!config.keys.groq) {
    warn('GROQ_API_KEY not set');
    notes.push('Get a free key at https://console.groq.com/keys — it powers chat and voice-note transcription.');
    return;
  }
  ok('Key present');
  try {
    const res = await timedFetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${config.keys.groq}` },
    });
    if (res.status === 401) {
      bad('Key rejected (401)');
      problems.push('Your GROQ_API_KEY is invalid.');
      return;
    }
    const data = await res.json();
    const ids = (data.data || []).map((m) => m.id);
    ok(`${ids.length} models available`);
    for (const model of config.llm.groqModels) {
      info(`${ids.includes(model) ? '✅' : '❌'} chat model ${model}`);
    }
    for (const model of [config.stt.model, config.stt.fallbackModel]) {
      info(`${ids.includes(model) ? '✅' : '❌'} speech model ${model}`);
    }
    if (!ids.includes(config.stt.model)) notes.push(`Whisper model ${config.stt.model} not listed — set WHISPER_MODEL to one that is.`);
    if (!ids.some((id) => config.llm.groqModels.includes(id))) {
      notes.push('None of your GROQ_MODELS exist any more — run `node -e` to list models and update .env.');
    }
    const tts = ids.filter((id) => /tts|orpheus/i.test(id));
    info(tts.length ? `TTS models: ${tts.join(', ')}` : 'no TTS models on this account (Edge voice is used instead)');
  } catch (err) {
    warn(`Could not reach Groq: ${err.message}`);
    notes.push('If you are offline, the bot still connects to WhatsApp but cannot answer.');
  }
}

async function checkGemini() {
  section('Google Gemini (images + video)');
  if (!config.keys.gemini) {
    warn('GEMINI_API_KEY not set — images/videos will not be understood');
    notes.push('Free key: https://aistudio.google.com/api-keys (needed for "see my video").');
    return;
  }

  const format = keyFormat(config.keys.gemini);
  ok(`Key present: ${maskKey(config.keys.gemini)} (${format === 'current' ? 'AQ. — current format' : format === 'legacy' ? 'AIza — legacy format, still valid' : 'unrecognised format'})`);
  if (format === 'unknown') {
    notes.push('Gemini keys start with "AQ." (current) or "AIza" (legacy). Yours looks truncated — re-copy the whole key.');
  }

  // 1. Is the key accepted at all? Try the configured auth style, then the other.
  const styles = config.geminiAuthStyle === 'bearer' ? ['bearer', 'key'] : ['key', 'bearer'];
  let workingStyle = null;
  let lastFailure = null;

  try {
    for (const style of styles) {
      const res = await timedFetch(`${GEMINI_BASE}/models?pageSize=1`, { headers: geminiHeadersWith(style) });
      const body = await res.text();
      if (res.ok) {
        workingStyle = style;
        break;
      }
      lastFailure = { status: res.status, body };
      // Only an auth failure is worth retrying with another auth style.
      if (!isKeyError(res.status, body)) break;
    }

    if (!workingStyle) {
      const { status, body } = lastFailure || { status: 0, body: '' };
      bad(explainGeminiError(status, body));
      if (isKeyError(status, body)) {
        problems.push('GEMINI_API_KEY was rejected by Google — replace it in .env.');
        notes.push(
          'The key was refused, not the model: it may be revoked, deleted, restricted to other APIs, or from a project without the Gemini API enabled. Mint a new one at https://aistudio.google.com/api-keys (they start with "AQ.").'
        );
      }
      return;
    }

    ok(`Key accepted by Google (${workingStyle === 'key' ? 'x-goog-api-key' : 'Authorization: Bearer'} auth)`);
    if (workingStyle !== config.geminiAuthStyle) {
      notes.push(`This key needs a different auth style. Add \x1b[1mGEMINI_AUTH_STYLE=${workingStyle}\x1b[0m to .env`);
    }

    const data = JSON.parse(await (await timedFetch(`${GEMINI_BASE}/models?pageSize=200`, { headers: geminiHeadersWith(workingStyle) })).text());
    const names = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace('models/', ''));
    if (names.length) info(`${names.length} models on this key, e.g. ${names.slice(0, 4).join(', ')}`);

    // 2. Can we actually generate with the models we plan to use?
    const chain = [...new Set([...config.vision.geminiModels, ...config.llm.geminiModels])];
    info(`model chain: ${chain.join(' → ')}`);

    let working = null;
    for (const model of chain.slice(0, 4)) {
      const modelRes = await timedFetch(
        `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: geminiHeadersWith(workingStyle, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'reply with the single word: ok' }] }],
            generationConfig: { maxOutputTokens: 5, temperature: 0 },
          }),
        },
        20000
      );
      const modelBody = await modelRes.text();

      if (modelRes.ok) {
        ok(`${model} works`);
        working = working || model;
        try {
          const j = JSON.parse(modelBody);
          const answer = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text).join('').trim();
          if (answer) info(`it answered: "${answer.slice(0, 40)}"`);
        } catch {
          /* the answer text is a bonus, not a requirement */
        }
        break;
      }

      if (isKeyError(modelRes.status, modelBody)) {
        bad(explainGeminiError(modelRes.status, modelBody));
        problems.push('GEMINI_API_KEY was rejected by Google — replace it in .env.');
        return;
      }
      if (modelRes.status === 404 || modelRes.status === 400) {
        info(`❌ ${model} — not available on this key`);
        continue;
      }
      if (modelRes.status === 429) {
        warn(`${model} is rate-limited right now (free tier). It usually still works later.`);
        break;
      }
      bad(`${model} — ${explainGeminiError(modelRes.status, modelBody)}`);
      break;
    }

    if (!working) {
      problems.push(
        `None of your Gemini models responded. Set GEMINI_VISION_MODEL to one from this list and retry: ${names.slice(0, 6).join(', ') || '(none listed)'}`
      );
    }
  } catch (err) {
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|network|timed out/i.test(err.message)) {
      warn(`Could not reach Gemini from this machine (${err.message.split('\n')[0]})`);
      notes.push('No internet / firewall on this box — the key cannot be verified offline. Run `npm run doctor` on the machine that runs the bot.');
    } else {
      warn(`Gemini check failed: ${err.message.split('\n')[0]}`);
    }
  }
}

async function checkOpenRouter() {
  if (!config.keys.openrouter) return;
  section('OpenRouter (vision fallback)');
  ok('Key present');
  try {
    const res = await timedFetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${config.keys.openrouter}` },
    });
    ok(res.ok ? 'reachable' : `returned ${res.status}`);
  } catch (err) {
    warn(`Could not reach OpenRouter: ${err.message}`);
  }
}

async function checkTeamAndCalls() {
  section('Team & calls');

  const team = teamMembers();
  if (team.length) {
    ok(`${team.length} teammate(s): ${team.map((m) => `${m.name} (${m.role})`).join(', ')}`);
    const dupes = team.map((m) => m.number).filter((n, i, arr) => arr.indexOf(n) !== i);
    if (dupes.length) {
      bad(`duplicate team numbers: ${[...new Set(dupes)].join(', ')}`);
      problems.push('Two teammates share a number in config/owner.json — one entry per person.');
    }
    if (team.some((m) => m.number === config.owner.number)) {
      problems.push('A teammate has the owner\'s own number. Remove that entry — the owner is always authorised.');
    }
  } else {
    warn('no teammates configured — the bot is single-user');
    notes.push('Add people to config/owner.json → owner.team, e.g. {"number":"92300…","name":"Ayesha","role":"sales"}');
  }

  if (!config.calls.enabled) {
    warn('missed-call rescue is off');
  } else {
    ok(`missed calls answered in chat after ${config.calls.delaySeconds}s (mode: ${config.calls.mode})`);
    info('WhatsApp Web cannot carry live call audio — the assistant replies in chat instead.');
  }
}

async function checkMedia() {
  section('Media');
  const { hasFfmpeg, ffmpegPath } = await import('../src/services/ffmpeg.js');
  if (hasFfmpeg()) ok(`ffmpeg: ${ffmpegPath()}`);
  else {
    warn('ffmpeg not found — voice replies become audio files; video frames unavailable');
    notes.push('Install ffmpeg (apt install ffmpeg) or `npm i ffmpeg-static` for real voice notes and frame extraction.');
  }

  const { visionEnabled, visionProviders, videoNativeEnabled } = await import('../src/services/vision.js');
  if (visionEnabled()) ok(`vision: ${visionProviders().join(', ')}${videoNativeEnabled() ? ' (native video)' : ''}`);
  else bad('no vision provider — images and video will not be understood');

  const { sttEnabled } = await import('../src/services/transcription.js');
  if (sttEnabled()) ok('voice-note transcription ready');
  else bad('voice-note transcription unavailable (needs GROQ_API_KEY)');

  const { ttsEnabled, ttsStatus } = await import('../src/services/tts.js');
  if (ttsEnabled()) ok(`voice replies: ${ttsStatus().mode} via ${ttsStatus().providers.join(', ')}`);
  else warn('voice replies disabled (VOICE_REPLY_MODE=off)');
}

async function checkMemory() {
  section('Memory (SQLite)');
  try {
    const { initDB, dbStats } = await import('../src/utils/db.js');
    await initDB();
    const stats = dbStats();
    ok(`database ready — ${stats.contacts} contacts, ${stats.messages} messages, ${stats.leads} leads`);
    info(`file: ${stats.file} (${(stats.sizeBytes / 1024).toFixed(0)} KB)`);
  } catch (err) {
    bad(`database failed: ${err.message}`);
    problems.push('Delete ./data and restart if the database file is corrupt.');
  }
}

async function checkWhatsApp() {
  section('WhatsApp session');
  const dir = config.paths.sessions;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  if (files.length) ok(`existing session (${files.length} files) — no QR needed`);
  else if (config.session.pairingNumber) warn(`no session yet — pairing code will be requested for +${config.session.pairingNumber}`);
  else warn('no session yet — a QR will be printed on first start');

  if (config.session.backupEnv) ok('WA_SESSION restore blob present');
}

// ════════════════════════════════════════════════════════════
// Fleet check — every user in one pass
// ════════════════════════════════════════════════════════════
function readEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {
    /* no env file */
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

async function liveGroq(key) {
  if (!key) return { state: 'missing' };
  try {
    const res = await timedFetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) return { state: 'ok' };
    if (res.status === 401 || res.status === 403) return { state: 'rejected', detail: `HTTP ${res.status}` };
    return { state: 'error', detail: `HTTP ${res.status}` };
  } catch (err) {
    return { state: 'unreachable', detail: err.message.split('\n')[0] };
  }
}

async function liveGemini(key) {
  if (!key) return { state: 'missing' };
  try {
    const res = await timedFetch(`${GEMINI_BASE}/models?pageSize=1`, { headers: authHeadersFor(key) });
    if (res.ok) return { state: 'ok' };
    const body = await res.text();
    return { state: isKeyError(res.status, body) ? 'rejected' : 'error', detail: `HTTP ${res.status}` };
  } catch (err) {
    return { state: 'unreachable', detail: err.message.split('\n')[0] };
  }
}

async function checkFleet({ live = false, json = false } = {}) {
  const tenantsDir = path.join(process.cwd(), 'tenants');
  const rows = [];

  // the owner install counts as a user too
  const rootEnv = readEnvFile(path.join(process.cwd(), '.env'));
  const rootProfile = readJson(path.join(process.cwd(), 'config', 'owner.json'));
  rows.push({
    slug: 'default',
    name: rootProfile?.owner?.name || rootEnv.MY_NAME || 'owner install',
    number: rootProfile?.owner?.number || rootEnv.MY_NUMBER || '',
    port: rootEnv.PORT || '3000',
    dir: process.cwd(),
    env: rootEnv,
    profile: rootProfile,
    builtin: true,
  });

  if (fs.existsSync(tenantsDir)) {
    for (const slug of fs.readdirSync(tenantsDir)) {
      const dir = path.join(tenantsDir, slug);
      const meta = readJson(path.join(dir, 'tenant.json'));
      if (!meta) continue;
      rows.push({
        slug: meta.slug || slug,
        name: meta.name || slug,
        number: meta.number || '',
        port: String(meta.port || ''),
        dir,
        env: readEnvFile(path.join(dir, '.env')),
        profile: readJson(path.join(dir, 'config', 'owner.json')),
        meta,
        builtin: false,
      });
    }
  }

  if (!json) {
    console.log(
      `\n\x1b[1m🩺 Fleet check\x1b[0m — ${rows.length} user${rows.length === 1 ? '' : 's'}${live ? ' · live API calls' : ''}\n`
    );
  }

  const issues = [];
  const report = [];
  const seenNumbers = new Map();
  const seenPorts = new Map();

  // The owner install keeps its price list in owner.example.json (owner.json
  // only overrides), so fall back to the schema file for that row.
  const schema = readJson(path.join(process.cwd(), 'config', 'owner.example.json'));

  for (const row of rows) {
    const services =
      row.profile?.owner?.services?.length ||
      (row.builtin ? schema?.owner?.services?.length || 0 : 0);
    const session = fs.existsSync(path.join(row.dir, 'sessions', 'creds.json')) ||
      fs.existsSync(path.join(row.dir, 'sessions', 'creds'));
    const dbBytes = sizeOf(path.join(row.dir, 'data', 'assistant.db'));
    const groq = row.env.GROQ_API_KEY || (row.builtin ? config.keys.groq : '');
    const gemini = row.env.GEMINI_API_KEY || (row.builtin ? config.keys.gemini : '');

    const local = [];
    if (!row.profile) local.push('no config/owner.json — it has no business knowledge');
    else if (services === 0) local.push('no services in the price list — it cannot quote');
    if (!groq) local.push('no GROQ_API_KEY — voice notes cannot be transcribed');
    if (!gemini) local.push('no GEMINI_API_KEY — it cannot see images or video');
    if (!session) local.push('not logged in — QR needed on first start');
    if (!row.number) local.push('no WhatsApp number configured');

    if (row.number) {
      const key = String(row.number).replace(/\D/g, '');
      if (seenNumbers.has(key)) {
        local.push(`same number as ${seenNumbers.get(key)} — two bots on one number disconnect each other`);
      } else {
        seenNumbers.set(key, row.slug);
      }
    }
    if (row.port) {
      if (seenPorts.has(row.port)) {
        local.push(`port ${row.port} already used by ${seenPorts.get(row.port)}`);
      } else {
        seenPorts.set(row.port, row.slug);
      }
    }

    const rowLive = { groq: { state: groq ? 'unchecked' : 'missing' }, gemini: { state: gemini ? 'unchecked' : 'missing' } };
    if (live) {
      rowLive.groq = await liveGroq(groq);
      rowLive.gemini = await liveGemini(gemini);
      if (rowLive.groq.state === 'rejected') local.push('Groq rejected the key');
      if (rowLive.gemini.state === 'rejected') local.push('Gemini rejected the key');
    }

    for (const problem of local) issues.push(`${row.slug}: ${problem}`);

    report.push({
      slug: row.slug,
      name: row.name,
      number: row.number || null,
      port: row.port || null,
      builtin: !!row.builtin,
      services,
      hasGroq: !!groq,
      hasGemini: !!gemini,
      loggedIn: session,
      dbBytes,
      live: live ? { groq: rowLive.groq.state, gemini: rowLive.gemini.state } : null,
      issues: local,
    });

    const keysLabel = `${groq ? 'G' : '·'}${gemini ? 'M' : '·'}`;
    const liveLabel = live
      ? ` · groq:${rowLive.groq.state} gemini:${rowLive.gemini.state}`
      : '';

    if (!json) {
      console.log(
        `  ${local.length ? '\x1b[33m▲\x1b[0m' : '\x1b[32m✔\x1b[0m'} ${row.slug.padEnd(22)} ` +
          `${String(row.name).slice(0, 22).padEnd(24)} +${String(row.number || '—').padEnd(14)} ` +
          `port ${String(row.port || '—').padEnd(6)} keys:${keysLabel} ` +
          `services:${String(services).padEnd(3)} session:${session ? 'yes' : 'no '} db:${kb(dbBytes).padEnd(8)}${liveLabel}`
      );
      for (const problem of local) console.log(`      \x1b[2m↳ ${problem}\x1b[0m`);
    }
  }

  if (!json) console.log('');
  if (json) {
    console.log(JSON.stringify({ users: report, healthy: issues.length === 0, issues }, null, 2));
    process.exit(issues.length ? 1 : 0);
  }

  if (issues.length) {
    console.log(`  \x1b[33m${issues.length} issue${issues.length === 1 ? '' : 's'} across the fleet\x1b[0m`);
    console.log('  Fix per user: node scripts/tenant.js keys <slug> GROQ_API_KEY=...');
    console.log('  Full detail : node scripts/tenant.js show <slug>\n');
    process.exit(1);
  }

  console.log('  \x1b[32mAll users look healthy.\x1b[0m');
  console.log('  Start everybody: node scripts/run-all.js\n');
}

async function main() {
  // `npm run doctor -- gemini` runs only the checks whose name matches.
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).toLowerCase());
  const only = args.filter((a) => !a.startsWith('--')).join(' ').toLowerCase().trim();
  const want = (...names) => !only || names.some((n) => n.includes(only) || only.includes(n));

  // Fleet mode: validate every user of this installation in one pass.
  if (['all', 'fleet', 'tenants', 'users'].includes(only)) {
    await checkFleet({ live: flags.includes('live'), json: flags.includes('json') });
    return;
  }

  console.log('\n\x1b[1m🩺 WhatsApp Assistant — self check\x1b[0m');
  if (only) console.log(`\n\x1b[2monly: ${only}\x1b[0m`);
  console.log('\n' + describeConfig());

  if (want('runtime')) await checkNode();
  if (want('files')) await checkFiles();
  if (want('identity', 'owner')) await checkOwner();
  if (want('groq')) await checkGroq();
  if (want('gemini', 'google')) await checkGemini();
  if (want('openrouter')) await checkOpenRouter();
  if (want('team', 'calls')) await checkTeamAndCalls();
  if (want('media', 'ffmpeg', 'vision')) await checkMedia();
  if (want('memory', 'db', 'database')) await checkMemory();
  if (want('whatsapp', 'session')) await checkWhatsApp();

  section('Summary');
  if (problems.length) {
    console.log('  Blocking issues:');
    for (const p of problems) console.log(`   ❌ ${p}`);
  } else {
    console.log('  ✅ No blocking issues.');
  }
  if (notes.length) {
    console.log('\n  Suggestions:');
    for (const note of notes) console.log(`   • ${note}`);
  }
  console.log('\n  Next: npm start   (or npm run chat to test the brain without WhatsApp)\n');
  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => {
  console.error('Doctor crashed:', err);
  process.exit(1);
});
