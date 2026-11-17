#!/usr/bin/env node
// scripts/doctor.js
// "Why isn't it working?" — checks every dependency and provider in one go.
// Usage: npm run doctor

import fs from 'node:fs';
import path from 'node:path';
import { config, describeConfig } from '../src/config/env.js';

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
  ok('Key present');
  try {
    const res = await timedFetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${config.keys.gemini}`);
    if (!res.ok) {
      bad(`Gemini API returned ${res.status}`);
      if (res.status === 400 || res.status === 403) problems.push('GEMINI_API_KEY is invalid or blocked.');
      return;
    }
    const data = await res.json();
    const names = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace('models/', ''));
    ok(`${names.length} usable models`);
    for (const model of config.vision.geminiModels) {
      info(`${names.includes(model) ? '✅' : '❌'} ${model}`);
    }
    if (!config.vision.geminiModels.some((m) => names.includes(m))) {
      notes.push(`None of your GEMINI_VISION_MODELS are available. Available example: ${names.slice(0, 5).join(', ')}`);
    }
  } catch (err) {
    warn(`Could not reach Gemini: ${err.message}`);
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

async function main() {
  console.log('\n\x1b[1m🩺 WhatsApp Assistant — self check\x1b[0m');
  console.log('\n' + describeConfig());

  await checkNode();
  await checkFiles();
  await checkOwner();
  await checkGroq();
  await checkGemini();
  await checkOpenRouter();
  await checkMedia();
  await checkMemory();
  await checkWhatsApp();

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
