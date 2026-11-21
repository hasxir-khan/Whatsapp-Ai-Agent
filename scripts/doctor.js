#!/usr/bin/env node
// scripts/doctor.js
// "Why isn't it working?" — checks every dependency and provider in one go.
// Usage: npm run doctor

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, describeConfig, teamMembers } from '../src/config/env.js';
import { GEMINI_BASE, geminiHeadersWith, authHeadersFor, isKeyError, explainGeminiError, maskKey, keyFormat } from '../src/utils/gemini.js';
import { validateProfile, FEATURE_KEYS, effectiveCatalog, business, featureOn, profile as readProfile } from '../src/services/profile.js';
import { listTemplates } from '../src/services/templates.js';

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

  // A fresh clone has no owner.json: that is "not configured yet", not "broken".
  // The bot runs on the example profile until you write your own.
  for (const file of ['config/owner.example.json', 'config/countries.json']) {
    if (fs.existsSync(path.join(config.root, file))) ok(file);
    else {
      bad(`${file} missing`);
      problems.push(`Restore ${file} from the repo (it is tracked, so this means a damaged checkout).`);
    }
  }
  if (fs.existsSync(path.join(config.root, 'config/owner.json'))) ok('config/owner.json');
  else {
    warn('config/owner.json missing — you are running on the example profile');
    notes.push('Copy config/owner.example.json to config/owner.json (or run npm run setup) and put your business in it.');
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
  if (/^\d{10,15}$/.test(config.owner.number)) {
    // 920000000000 is the built-in default: a real looking number that is not
    // anybody's line. Good enough to boot, wrong to print on a poster.
    if (/^(\d)\1+$/.test(config.owner.number) || /^(0?0+|9+|2+)$/.test(config.owner.number) || /123456|0000000/.test(config.owner.number)) {
      warn(`MY_NUMBER looks like a placeholder (+${config.owner.number}) — fine for a demo, not a real line`);
      notes.push('Set MY_NUMBER in .env to your own number (international format, e.g. 923001234567).');
    } else {
      ok(`MY_NUMBER = +${config.owner.number}`);
    }
  } else {
    bad(`MY_NUMBER looks wrong: "${config.owner.number}"`);
    problems.push('Set MY_NUMBER in international format, e.g. 923001234567.');
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

async function checkBusiness() {
  section('Business profile');
  const profile = config.owner.profile || {};
  const b = business();
  const featureFlags = Object.entries(profile.features || {})
    .filter(([k, v]) => !k.startsWith('//') && v === true)
    .map(([k]) => k);

  if (b.name) ok(`Business: ${b.name}${b.type ? ` · ${b.type}` : ''}${b.city ? ` · ${b.city}` : ''}`);
  else info('No business block yet — the bot still works, it just knows less.');

  const items = effectiveCatalog();
  if (items.length) {
    ok(`Price list: ${items.length} items (${items.filter((i) => i.min !== null).length} priced)`);
  } else {
    info('No catalog items — quotes come from owner.services only.');
  }

  if (featureFlags.length) {
    ok(`Features on: ${featureFlags.join(', ')}`);
    const unknown = featureFlags.filter((f) => !FEATURE_KEYS.includes(f));
    if (unknown.length) {
      warn(`Unknown flags (ignored): ${unknown.join(', ')}`);
      notes.push(`Typo in features? Known flags: ${FEATURE_KEYS.join(', ')}`);
    }
  } else {
    info('All new features are off (defaults keep the original behaviour).');
  }

  // ── growth agents ─────────────────────────────────────────
  const growthFlags = ['bookingAgent', 'followUpAgent', 'closerAgent', 'reviewAgent', 'analystAgent', 'reactivationAgent', 'contentAgent'];
  const growthOn = growthFlags.filter((f) => featureOn(f));
  if (growthOn.length) {
    ok(`Growth agents on: ${growthOn.join(', ')}`);
    if (!featureOn('growthApproval')) warn('growthApproval is off — proactive messages will send without approval');
   } else {
    info('Growth agents are all off (defaults keep the original behaviour).');
  }

  // ── Phase 4: documents and the learning loop ───────────────
  const docFlags = ['pdfInvoices', 'selfHealing', 'liveInbox', 'injectionGuard'].filter((f) => featureOn(f));
  if (docFlags.length) ok(`Phase 4 features on: ${docFlags.join(', ')}`);
  for (const risk of growthSettingsWarnings(profile, process.env, { transport: config.transport })) {
    warn(risk);
    notes.push(risk);
  }

  // Conversation Control: the risky combinations, in the same place as the
  // growth ones. Pure function, so `test/36` can assert the wording.
  if (featureOn('conversationControl')) {
    const { conversationWarnings, conversationSettings } = await import('../src/services/conversation.js');
    const s = conversationSettings();
    ok(`Conversation Control: scope ${s.scope} · off-topic ${s.offTopic} · cool-down ${s.coolDownMinutes} min · cap ${s.dailyMessageCap}/day`);
    for (const risk of conversationWarnings(profile)) {
      warn(risk);
      notes.push(risk);
    }
  }

  const { errors, warnings } = validateProfile(profile);
  for (const w of warnings.slice(0, 6)) info(`note: ${w}`);
  for (const e of errors.slice(0, 8)) {
    bad(e);
    problems.push(`Business profile: ${e}`);
  }
  if (!errors.length) ok('Profile structure is valid');

  // custom agents (phase 6) — only when the owner switched them on
  if (featureOn('multiAgent')) {
    const { agentDiagnostics, listAgents, MAX_AGENTS } = await import('../src/services/agents.js');
    const diag = agentDiagnostics();
    for (const w of diag.warnings) {
      info(`note: ${w}`);
      notes.push(w);
    }
    for (const e of diag.errors) {
      bad(e);
      problems.push(`Agents: ${e}`);
    }
    const roster = listAgents();
    if (roster.length && !diag.errors.length) {
      ok(`Agents: ${roster.filter((a) => a.enabled).length}/${roster.length} on (${roster.map((a) => a.id).join(', ')}) · max ${MAX_AGENTS}`);
    }
  }

  // ── marketing team (phase 6, part 2) ────────────────────
  // Only checked when it is on: warnings about a feature someone never
  // switched on are noise, and this file is about real problems.
  {
    const M = await import('../src/services/marketing.js');
    if (M.marketingEnabled()) {
      const cfg = M.marketingConfig();
      const offersArr = (p) => (Array.isArray(p) ? p : []);
      const offers = offersArr(readProfile().business?.offers).length + offersArr(readProfile().offers).length;

      if (!cfg.approvalMode) {
        warn('Marketing: approvalMode is off — promos will send without you seeing the list first');
      }
      if (!offers) {
        warn('Marketing: no offers configured — .plan and .offer have nothing to work from');
      }
      if (!M.discountCap()) {
        warn('Marketing: no policies.maxDiscountPercent — every discount will come to you as a decision');
      }
      if (readProfile().business?.type && /clinic|hospital|doctor|dental|medical/i.test(String(readProfile().business.type))) {
        const { emergencyContact } = await import('../src/services/agentPacks.js');
        const c = emergencyContact();
        if (!c.configured) {
          warn('Clinic: no emergency number configured — emergency messages will say "local emergency number"');
        }
      }
      const reachable = M.promoSegments().reachable;
      ok(`Marketing: on · ${reachable} reachable contact${reachable === 1 ? '' : 's'} · one promo per contact every ${cfg.minDaysBetweenPromos} days`);
    } else if (readProfile().features?.marketingAgents) {
      warn('Marketing: features.marketingAgents is set but did not read as on — check the value is true, not "yes"');
    }
  }

  // industry templates must all load
  const templates = listTemplates();
  if (templates.length) {
    ok(`${templates.length} industry templates available (${templates.map((t) => t.id).join(', ')})`);
  } else {
    warn('No templates found in config/templates');
  }

  // tool calling
  if (featureOn('toolCalling')) {
    const { toolNames, SIDE_EFFECT_TOOLS } = await import('../src/core/tools.js');
    ok(`Tool calling on: ${toolNames().join(', ')}`);
    info(`Side effects (need a customer "yes"): ${[...SIDE_EFFECT_TOOLS].join(', ')}`);
  } else {
    info('Tool calling is off (.set features.toolCalling true to let it book and order)');
  }

  // transport
  {
    const { sessionSummary } = await import('../src/utils/sessionBackup.js');
    const { readLock } = await import('../src/services/instanceLock.js');
    const { BAILEYS_CAPABILITIES } = await import('../src/transport/baileys.js');
    const { CLOUD_CAPABILITIES } = await import('../src/transport/cloud.js');
    const { describeCapabilities } = await import('../src/transport/base.js');
    const isCloud = config.transport === 'cloud';
    const caps = isCloud ? CLOUD_CAPABILITIES : BAILEYS_CAPABILITIES;
    ok(`Transport: ${isCloud ? 'Cloud API (official)' : 'Baileys (default)'}`);
    const view = describeCapabilities(caps);
    info(`Supports: ${view.supported.join(', ')}`);
    if (view.unsupported.length) info(`Not on this transport: ${view.unsupported.join(', ')} — those features switch off instead of crashing`);

    if (isCloud) {
      const missing = ['phoneId', 'token', 'verifyToken', 'appSecret'].filter((k) => !config.cloud[k]);
      if (missing.length) {
        bad(`Cloud API is selected but missing: ${missing.map((m) => ({ phoneId: 'CLOUD_PHONE_ID', token: 'CLOUD_TOKEN', verifyToken: 'CLOUD_VERIFY_TOKEN', appSecret: 'CLOUD_APP_SECRET' }[m])).join(', ')}`);
        problems.push('Cloud API config incomplete');
      } else {
        ok(`Cloud API configured · webhook path /webhook/${config.cloud.slug}`);
        notes.push(`Register https://<your-tunnel>/webhook/${config.cloud.slug} in Meta → WhatsApp → Configuration`);
      }
      if (!featureOn('cloudApi')) {
        warn('features.cloudApi is off — the bot will refuse to start on the Cloud API until you set it (".set features.cloudApi true")');
      }
      info('24-hour rule: outside the window only an approved template goes out, otherwise the message is held for the owner');
      if (!config.cloud.template) info('No CLOUD_TEMPLATE_NAME set — closed-window replies will be held and reported instead of templated');
    } else {
      info('Missed-call rescue, read receipts, typing indicators and delete-for-everyone all work on Baileys');

      // The clash nobody notices until messages stop decrypting: Cloud API
      // credentials present while the bot is connected over Baileys. If they
      // point at the same number, two clients hold the same account.
      if (config.cloud.phoneId && config.cloud.token) {
        warn(
          'Cloud API credentials are set while TRANSPORT=baileys — if they belong to the SAME number, ' +
            'only one of the two may be connected. Unregister the Cloud app for that number, or move to TRANSPORT=cloud.'
        );
        notes.push('Two clients on one WhatsApp number is a classic cause of "Waiting for this message" on the other phone');
      }

      // Session facts a support conversation always needs.
      const session = sessionSummary();
      if (session.state === 'healthy') info(session.line);
      else warn(`${session.line} — the bot cannot connect until this is fixed`);
      const lock = readLock();
      if (lock?.pid) info(`Session lock: held by pid ${lock.pid} on ${lock.host || 'this host'} since ${new Date(lock.started_at || lock.startedAt).toLocaleString('en-GB')}`);
    }
  }

  // intent routing
  if (featureOn('managerAgent') || featureOn('manager')) {
    const { AGENTS } = await import('../src/core/manager.js');
    ok('Manager agent on — messages are routed to a specialist first');
    for (const [key, agent] of Object.entries(AGENTS)) {
      if (key === 'other') continue;
      info(`${agent.emoji} ${agent.label}: ${agent.tools?.join(', ') || 'all tools'}`);
    }
    info('Owner command .intents shows today\'s counts');
  } else {
    info('Manager agent is off (one brain answers everything). Turn on: .set features.managerAgent true');
  }

  // learned documents
  const dbFile = path.join(config.paths.data, 'assistant.db');
  if (fs.existsSync(dbFile)) {
    try {
      const { initDB, knowledgeStats } = await import('../src/utils/db.js');
      await initDB({ file: dbFile });
      const stats = knowledgeStats();
      if (stats.sources) ok(`Knowledge base: ${stats.sources} documents · ${stats.chunks} chunks`);
      else info('Knowledge base is empty — add documents with: node scripts/tenant.js learn <slug> <file|url>');

      if (stats.chunks) {
        const { embeddingStatus, embeddingsAvailable } = await import('../src/services/embeddings.js');
        const { knowledgeEmbeddingStats } = await import('../src/utils/db.js');
        const embed = embeddingStatus();
        const vectors = knowledgeEmbeddingStats();

        if (vectors.embedded) ok(`Vectors: ${vectors.embedded}/${vectors.chunks} chunks embedded (${embed.model})`);
        else if (embeddingsAvailable()) {
          warn(`Vectors: 0/${vectors.chunks} chunks embedded — queue them with: node scripts/tenant.js learn <slug> --reindex`);
        } else {
          warn('Vectors: no Gemini key — RAG falls back to keyword (BM25) search');
        }
        if (embed.cooling) info(`Embedding provider cooling down after an error: ${embed.lastError || 'rate limited'}`);
        if (featureOn('rag')) ok('features.rag is on — excerpts are injected into the prompt');
        else info('features.rag is off — documents are stored but not used in replies');
      }
    } catch (err) {
      warn(`Could not read the knowledge base: ${err.message}`);
    }
  } else {
    info('No database yet — it is created on first start.');
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

  const { allowedSpeech } = await import('../src/services/voicePolicy.js');
  const { configuredVoice, ttsEnabled } = await import('../src/services/tts.js');
  if (featureOn('voiceLanguagePolicy') || featureOn('videoUnderstanding')) {
    const missing = (msg) => {
      bad(msg);
      problems.push(msg);
    };
    const b = config.owner.profile.business;
    if (!allowedSpeech(b).length)
      missing('business.languages has no supported language — media replies require an allowlist');
    if (!hasFfmpeg()) missing('protected video and capped voice replies require ffmpeg');
    if (featureOn('videoUnderstanding') && !visionEnabled())
      missing('missing vision key — configure a frame vision provider');
    if (featureOn('voiceLanguagePolicy'))
      for (const code of allowedSpeech(b)) {
        if (!config.tts.providers.some((p) => configuredVoice(p, code)))
          warn(`missing TTS voice for ${code} — text only`);
      }
  }
  if (ttsEnabled()) ok(`voice replies: ${config.tts.mode} via ${config.tts.providers.join(', ')}`);
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

// ── growth settings audit ───────────────────────────────────
/**
 * Risky settings for the proactive agents. These are not errors — they are the
 * choices that cost money or goodwill when they are wrong.
 * @returns {string[]} plain-language warnings
 */
export function growthSettingsWarnings(profile = {}, env = {}, { transport = null } = {}) {
  const flags = profile.features || {};
  const business = profile.business || {};
  const warnings = [];
  const on = (k) => flags[k] === true;

  const anyAgent =
    on('bookingAgent') || on('followUpAgent') || on('closerAgent') || on('reviewAgent') ||
    on('reactivationAgent') || on('analystAgent') || on('contentAgent');

  if (anyAgent && flags.growthApproval === false) {
    warnings.push('growthApproval is off — every follow-up, win-back and review ask goes out without you seeing it first');
  }

  if (on('closerAgent') && (business.policies?.maxDiscountPercent == null)) {
    warnings.push('closerAgent is on but policies.maxDiscountPercent is not set — every discount request will come to you (which is safe, but slow)');
  }

  if (on('closerAgent')) {
    const pay = business.payment || {};
    const configured = pay.bank?.number || pay.jazzcash?.number || pay.easypaisa?.number || pay.stripeLink || pay.cod;
    if (!configured) warnings.push('closerAgent is on but business.payment is empty — a customer who says "order kar do" gets no way to pay');
  }

  if ((on('reviewAgent') || on('reactivationAgent')) && !business.reviewLink && on('reviewAgent')) {
    warnings.push('reviewAgent is on but business.reviewLink is empty — happy customers will be thanked, not sent anywhere');
  }

  // ── the web surface (pure, so it can be tested) ───────────────
  // Since the security pass, an empty token on a public bind does not expose the
  // dashboard — it disables it. That makes "the inbox is off" and "the box is
  // broken" look alike from outside, so the warning says exactly which routes
  // are live.
  {
    const host = String(env.HOST || '0.0.0.0');
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
    const demo = env.DEMO_MODE === '1';
    const webOff = String(env.ENABLE_WEB || 'true').toLowerCase() === 'false';
    if (on('liveInbox')) {
      if (webOff) warnings.push('liveInbox is on but ENABLE_WEB is false — the web server never starts, so there is no inbox to open');
      if (!env.DASHBOARD_TOKEN && (host === '0.0.0.0' || host === '::') && !demo) {
        warnings.push(`liveInbox listens on ${host} with no token — bind HOST=127.0.0.1 or set DASHBOARD_TOKEN`);
        warnings.push(
          'Dashboard disabled: no DASHBOARD_TOKEN on a public bind. Webhooks (/webhook/<slug>) and /health stay up, so the bot keeps answering customers; the dashboard, inbox, /api/status, /api/growth and /qr.png answer 404.'
        );
      }
      if (!env.DASHBOARD_TOKEN && loopback) {
        warnings.push('liveInbox has no DASHBOARD_TOKEN but the bind is loopback — fine for local use, set a token before exposing it');
      }
    }
  }

  const kind = String(transport || env.TRANSPORT || 'baileys').toLowerCase();
  const dailyCap = Number(env.GROWTH_DAILY_CAP || 30);
  const baileysCap = Number(env.GROWTH_BAILEYS_CAP || 12);
  if (kind === 'baileys' && baileysCap > 25) {
    warnings.push(`GROWTH_BAILEYS_CAP is ${baileysCap} on an unofficial client — bursts are how numbers get limited; 12 is the safe default`);
  }
  if (kind === 'baileys' && dailyCap > 50) {
    warnings.push(`GROWTH_DAILY_CAP is ${dailyCap} on Baileys — consider 30 or lower`);
  }
  if (kind === 'cloud' && !env.CLOUD_TEMPLATE_NAME) {
    warnings.push('No CLOUD_TEMPLATE_NAME — anything outside the 24-hour window will be held, including campaigns');
  }
  if (on('reactivationAgent') && !(business.offers?.length)) {
    warnings.push('reactivationAgent is on but business.offers is empty — win-back messages will only mention the catalogue');
  }

  // ── Phase 4 ───────────────────────────────────────────────
  if (on('pdfInvoices')) {
    const pay = business.payment || {};
    const configured = pay.bank?.number || pay.jazzcash?.number || pay.easypaisa?.number || pay.stripeLink || pay.cod;
    if (!configured) {
      warnings.push('pdfInvoices is on but business.payment is empty — the invoice will say "payment details will be shared separately"');
    }
    const logo = business.invoice?.logo || business.logo;
    if (logo) {
      try {
        const file = path.resolve(process.cwd(), logo);
        if (!fs.existsSync(file)) warnings.push(`business.invoice.logo points at ${logo}, which does not exist — the PDF will print without it`);
        else if (!/\.(png|jpe?g)$/i.test(file)) warnings.push(`business.invoice.logo is ${logo} — pdfkit can only embed PNG or JPG`);
      } catch {
        warnings.push('business.invoice.logo could not be read — the PDF will print without it');
      }
    }
    if (!business.name) warnings.push('pdfInvoices is on but business.name is empty — the document would say "Business"');
  }

  // ── the web surface, whatever the feature flags say ──────────
  // This is the only part of the bot that listens on a socket, and the only part
  // where "off" and "broken" look the same from outside. Spell out which
  // routes are live.
  {
    const host = String(env.HOST || '0.0.0.0');
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
    const webOff = String(env.ENABLE_WEB || 'true').toLowerCase() === 'false';
    if (webOff) {
      info('Web UI is off (ENABLE_WEB=false): no dashboard, and Cloud webhooks must be served by another process or the gateway.');
    } else if (env.DASHBOARD_TOKEN) {
      ok(`Web UI is private: DASHBOARD_TOKEN set, bind ${host} — dashboard, inbox, /api/status, /api/growth and /qr.png need the session.`);
    } else if (loopback || env.DEMO_MODE === '1') {
      warn(
        loopback
          ? `Web UI has no DASHBOARD_TOKEN but binds ${host} (loopback) — local-only use. Set DASHBOARD_TOKEN before exposing it.`
          : 'Web UI has no DASHBOARD_TOKEN and binds a public address in demo mode — fake data only, never real customers.'
      );
    } else {
      problems.push(
        'Dashboard disabled: no DASHBOARD_TOKEN on a public bind. Webhooks (/webhook/<slug>) and /health stay up, so the bot keeps answering customers; the dashboard, inbox, /api/status, /api/growth and /qr.png answer 404. Set DASHBOARD_TOKEN (recommended) or HOST=127.0.0.1 for local-only use.'
      );
    }
    // The per-flag warnings ("liveInbox is on but…") come from
    // growthSettingsWarnings(), which is the pure, tested copy of these rules.
  }

  if (on('adminPanel')) {
    const adminToken = String(env.ADMIN_TOKEN || '');
    if (!adminToken) {
      warnings.push('adminPanel is on but ADMIN_TOKEN is empty — every admin route answers 404, so the panel cannot be opened at all');
    } else if (adminToken.length < 16) {
      warnings.push('ADMIN_TOKEN is shorter than 16 characters — it protects every tenant on this box, so make it long and random');
    }
    if (adminToken && env.DASHBOARD_TOKEN && adminToken === env.DASHBOARD_TOKEN) {
      warnings.push('ADMIN_TOKEN is the same as DASHBOARD_TOKEN — a leaked inbox link would then also open the control panel');
    }
    const host = String(env.HOST || '0.0.0.0');
    const publicUrl = String(env.PUBLIC_URL || '');
    if ((host === '0.0.0.0' || host === '::') && !/^https:\/\//i.test(publicUrl)) {
      warnings.push('adminPanel is on and the server binds 0.0.0.0 with no https PUBLIC_URL — put it behind a tunnel (cloudflared) or bind HOST=127.0.0.1, never an open port');
    }
  }

  if (on('selfHealing')) {
    // The loop is useless if the notice cannot reach the owner: the proposal is
    // stored, the owner is never told, and rules quietly pile up in pending_rules.
    const ownerNumber = String(env.MY_NUMBER || '').replace(/\D/g, '');
    if (!ownerNumber || /^920{6,}$/.test(ownerNumber)) {
      warnings.push('selfHealing is on but MY_NUMBER is a placeholder — proposals are stored, but the "New rule learned" notice has nowhere to go');
    }
    if (Number(env.SELF_HEALING_MAX_PER_DAY || 3) > 5) {
      warnings.push(`SELF_HEALING_MAX_PER_DAY is ${env.SELF_HEALING_MAX_PER_DAY} — more proposals than you will actually review is noise, not learning`);
    }
  }
  // ── Phase 6 Part 3: the business brain ────────────────────
  if (on('businessBrain')) {
    const brain = profile.brain || {};
    const approval = profile.features?.growthApproval !== false;
    const autoRun = Array.isArray(brain.autoRun) ? brain.autoRun : [];

    if (on('reasoning') && !(env.GEMINI_API_KEY || env.GROQ_API_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.OPENROUTER_API_KEY)) {
      warnings.push('reasoning is on but no model key is set — the router falls back to the deterministic path, so complex turns get no plan');
    }
    if (!approval) {
      warnings.push('businessBrain is on with growthApproval off — a proposal could reach a customer before you see the draft');
    }
    if (autoRun.length && !approval) {
      warnings.push(`brain.autoRun lists ${autoRun.join(', ')} while growthApproval is off — those actions would send with no approval step at all`);
    }
    const goals = Array.isArray(profile.business?.goals) ? profile.business.goals.length : 0;
    if (!goals) {
      warnings.push('businessBrain is on but no goals are set — .goal add 20 orders by 2026-12-31 gives it something to measure against');
    }
    const cap = Number(brain.dailyReasoningCalls ?? 200);
    if (on('reasoning') && cap > 1000) {
      warnings.push(`brain.dailyReasoningCalls is ${cap} — on a free tier that is a day of quota, spent quietly`);
    }
    const minutes = Number(brain.minutesPerConversation ?? 6);
    if (!(minutes > 0)) {
      warnings.push('brain.minutesPerConversation is 0 — "time saved" will always read zero');
    }
  } else if (on('reasoning')) {
    warnings.push('reasoning is on but businessBrain is off — the router has nothing to verify against; turn on businessBrain or turn reasoning off');
  }

  return warnings;
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
  // A brand-new install has no profile, no keys, no session and no number. That
  // is "not set up yet", not "broken": it is a note with a next step, not a
  // failed check. Only things that are actually wrong — two users on one
  // number, a clashing port, a rejected key — make the command exit non-zero.
  const blockers = [];
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
    const setup = [];
    if (!row.profile) setup.push('no config/owner.json — it has no business knowledge');
    else if (services === 0) setup.push('no services in the price list — it cannot quote');
    if (!groq) setup.push('no GROQ_API_KEY — voice notes cannot be transcribed');
    if (!gemini) setup.push('no GEMINI_API_KEY — it cannot see images or video');
    if (!session) setup.push('not logged in — QR needed on first start');
    if (!row.number) setup.push('no WhatsApp number configured');
    local.push(...setup);
    for (const risk of growthSettingsWarnings(row.profile || {}, row.env || {}, { transport: row.env?.TRANSPORT || 'baileys' })) {
      local.push(risk);
      blockers.push(`${row.slug}: ${risk}`);
    }

    if (row.number) {
      const key = String(row.number).replace(/\D/g, '');
      if (seenNumbers.has(key)) {
        const clash = `same number as ${seenNumbers.get(key)} — two bots on one number disconnect each other`;
        local.push(clash);
        blockers.push(`${row.slug}: ${clash}`);
      } else {
        seenNumbers.set(key, row.slug);
      }
    }
    if (row.port) {
      if (seenPorts.has(row.port)) {
        const clash = `port ${row.port} already used by ${seenPorts.get(row.port)}`;
        local.push(clash);
        blockers.push(`${row.slug}: ${clash}`);
      } else {
        seenPorts.set(row.port, row.slug);
      }
    }

    const rowLive = { groq: { state: groq ? 'unchecked' : 'missing' }, gemini: { state: gemini ? 'unchecked' : 'missing' } };
    if (live) {
      rowLive.groq = await liveGroq(groq);
      rowLive.gemini = await liveGemini(gemini);
      if (rowLive.groq.state === 'rejected') {
        local.push('Groq rejected the key');
        blockers.push(`${row.slug}: Groq rejected the key`);
      }
      if (rowLive.gemini.state === 'rejected') {
        local.push('Gemini rejected the key');
        blockers.push(`${row.slug}: Gemini rejected the key`);
      }
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
      blockers: blockers.filter((b) => b.startsWith(`${row.slug}: `)).length,
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
    console.log(JSON.stringify({ users: report, healthy: blockers.length === 0, issues, blockers }, null, 2));
    process.exit(blockers.length ? 1 : 0);
  }

  if (issues.length && !blockers.length) {
    console.log(
      `  \x1b[33m${issues.length} setup note${issues.length === 1 ? '' : 's'}\x1b[0m — nothing is broken, this fleet is not configured yet.`
    );
  }
  if (blockers.length) {
    console.log(
      `  \x1b[31m${blockers.length} problem${blockers.length === 1 ? '' : 's'}\x1b[0m across the fleet` +
        (issues.length > blockers.length ? `, plus ${issues.length - blockers.length} setup note${issues.length - blockers.length === 1 ? '' : 's'}` : '')
    );
    console.log('  Fix per user: node scripts/tenant.js keys <slug> GROQ_API_KEY=...');
    console.log('  Full detail : node scripts/tenant.js show <slug>\n');
    process.exit(1);
  }

  console.log('  \x1b[32mAll users look healthy.\x1b[0m');
  console.log('  Start everybody: node scripts/run-all.js\n');
}

async function checkVisual() {
  const { visualSearchEnabled, catalogImageItems, catalogImagePath, thresholds, dailyCap } = await import('../src/services/visualSearch.js');
  if (!visualSearchEnabled()) return;

  section('Visual search');
  // What it will cost this machine, said before it costs it.
  ok('model: Xenova/clip-vit-base-patch32 · ~90 MB download on first use · ~800 MB RAM while loaded');

  let installed = false;
  try {
    // resolve, do not load: importing downloads nothing, but this catches the
    // common case of "flag on, package never installed".
    await import('@xenova/transformers');
    installed = true;
  } catch {
    installed = false;
  }
  if (installed) ok('@xenova/transformers is installed');
  else {
    warn('visualSearch is on but @xenova/transformers is not installed — every photo falls back to Gemini');
    notes.push('npm install @xenova/transformers   # local CLIP search, ~90 MB model on first use, $0 per call');
  }

  const images = catalogImageItems();
  if (!images.length) {
    warn('visualSearch is on but no catalogue item has an "image" — nothing to match against');
    notes.push('Add "image": "config/menu/karahi.jpg" to catalogue items, then: node scripts/tenant.js index-images <slug>');
  } else {
    const missing = images.filter((i) => i.missing);
    if (missing.length) {
      warn(`${missing.length} catalogue image(s) cannot be read — they will never match`);
      for (const item of missing.slice(0, 3)) notes.push(`  ${item.name}: ${item.image} (${item.missing})`);
    }
    // Containment is a security property, not a preference.
    for (const item of images.slice(0, 50)) {
      const resolved = catalogImagePath(item.image);
      if (resolved.ok && !resolved.file.startsWith(process.cwd())) {
        warn(`catalogue image outside this tenant folder: ${item.image}`);
      }
    }
  }

  const { high, low } = thresholds();
  if (low >= high) warn(`VISUAL_LOW_THRESHOLD (${low}) is not below VISUAL_HIGH_THRESHOLD (${high}) — nothing can ever be "ambiguous"`);
  if (low < 0.5) warn(`VISUAL_LOW_THRESHOLD is ${low} — that low will match unrelated products`);
  ok(`thresholds: high ${high} · low ${low} · daily cap ${dailyCap()} (calibrate on your own photos)`);
  if (dailyCap() === 0) warn('VISUAL_SEARCH_DAILY_CAP is 0 — the feature is on but every lookup is refused');
}

async function checkMcp() {
  const {
    mcpEnabled, mcpWriteEnabled, loadConfig, serversForTenant, mcpStatus, configPath,
  } = await import('../src/services/mcpClient.js');
  if (!mcpEnabled()) return;

  section('External tools (MCP)');
  const loaded = loadConfig();

  if (loaded.missing) {
    warn(`mcpTools is on but ${path.basename(configPath())} does not exist — no external tools will be offered`);
    notes.push(`Start from config/mcp.servers.example.json, copy it to ${configPath()}, and list your tenants under allowedTenants.`);
  } else if (loaded.errors.length) {
    for (const error of loaded.errors.slice(0, 6)) bad(`mcp config: ${error}`);
    notes.push('A config error switches that server off. Nothing runs half-configured.');
  }

  let installed = false;
  try {
    await import('@modelcontextprotocol/sdk/client/index.js');
    installed = true;
  } catch {
    installed = false;
  }
  if (installed) ok('@modelcontextprotocol/sdk is installed');
  else {
    warn('mcpTools is on but @modelcontextprotocol/sdk is not installed — external tools stay off');
    notes.push('npm install @modelcontextprotocol/sdk');
  }

  const mine = serversForTenant(config.tenant.slug);
  if (!loaded.servers.length && !loaded.errors.length) {
    ok('no servers configured — nothing to attack');
  } else if (!loaded.servers.length) {
    bad('every configured server was refused — nothing will run until the config is fixed');
  } else if (!mine.length) {
    warn(`no server lists this tenant (${config.tenant.slug}) in allowedTenants — all ${loaded.servers.length} are refused`);
  } else {
    ok(`${mine.length} server(s) allowed for this tenant: ${mine.map((s) => s.id).join(', ')}`);
  }

  const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  for (const server of loaded.servers) {
    if (!server.readOnly) {
      warn(`"${server.id}" is not marked readOnly — its tools can change things (needs mcpWriteTools + a customer yes)`);
    }
    if (runningAsRoot) {
      warn(`"${server.id}" would run as root (this process is root) — a tool server should run as a nobody user`);
    }
    if (Object.keys(server.env).length) {
      ok(`"${server.id}" passes ${Object.keys(server.env).join(', ')} (secrets are refused outright)`);
    }
    if (server.timeoutMs > 10_000) warn(`"${server.id}" timeout is ${server.timeoutMs} ms — a customer will notice`);
  }

  if (mcpWriteEnabled() && loaded.servers.every((s) => s.readOnly)) {
    notes.push('mcpWriteTools is on but every server is readOnly — nothing can write');
  }

  const status = mcpStatus(config.tenant.slug);
  ok(`calls today: ${status.usedToday}/${status.dailyCap}${status.writesEnabled ? ' · writes enabled' : ' · writes off'}`);
}

async function checkHealthAndPrivacy() {
  const {
    alertsEnabled, alertSettings, healthSnapshot, backupDir,
  } = await import('../src/services/health.js');
  const { privacyEnabled, retentionDays } = await import('../src/services/privacy.js');

  if (alertsEnabled()) {
    section('Reliability alerts');
    const settings = alertSettings();
    const snap = healthSnapshot();
    const failingBad = snap.failing.filter((f) => f.severity === 'bad');
    const failingWarn = snap.failing.filter((f) => f.severity !== 'bad');
    for (const entry of failingBad) bad(`now: ${entry.kind} — ${entry.detail}`);
    for (const entry of failingWarn) warn(`now: ${entry.kind} — ${entry.detail}`);
    if (!snap.failing.length) ok('nothing failing right now');

    const webhook = String(process.env.ALERT_WEBHOOK_URL || '').trim();
    if (webhook) ok(`second channel configured (${webhook.replace(/[?#].*$/, '')})`);
    else {
      warn('no ALERT_WEBHOOK_URL — if WhatsApp is the thing that is down, the alert cannot reach you');
      notes.push('Set ALERT_WEBHOOK_URL to any endpoint that accepts a POST (ntfy, Slack, a webhook.site URL).');
    }
    ok(`dedupe + cooldown: ${Math.round(settings.cooldownMs / 60000)} min · SLA ${settings.slaMinutes} min (business hours only)`);
    if (settings.slaMinutes < 5) warn(`SLA_ALERT_MINUTES is ${settings.slaMinutes} — that is chat noise, not an SLA`);
    if (!settings.includeContent) ok('SLA pings carry no message content');

    const dir = backupDir();
    if (!fs.existsSync(dir)) {
      warn(`no backup folder at ${dir} — backups stay "missing" until you run npm run backup`);
      notes.push('Add a cron: npm run backup → backups/, then copy it off the machine.');
    }
  }

  if (privacyEnabled() || retentionDays()) {
    section('Privacy');
    if (privacyEnabled()) {
      ok('privacyTools on: .export <number>, .forget <number> <number>');
    } else {
      warn('privacyTools is off — .export/.forget refuse until it is switched on');
    }
    if (retentionDays()) {
      ok(`retention: message bodies purged after ${retentionDays()} days (counts kept)`);
    } else {
      notes.push('PRIVACY_RETENTION_DAYS is unset — messages are kept forever (the default, on purpose).');
    }
  }
}

async function checkOrdersAndCrm() {
  const { orderTrackingEnabled, reminderSettings, reminderStats } = await import('../src/services/orders.js');
  const { crmEnabled, tagOverview } = await import('../src/services/crm.js');

  if (orderTrackingEnabled()) {
    section('Orders');
    const { firstHours, secondHours } = reminderSettings();
    if (secondHours <= firstHours) {
      warn(`the second reminder (${secondHours} h) is not later than the first (${firstHours} h) — only one will ever fire`);
    } else {
      ok(`payment reminders at ${firstHours} h and ${secondHours} h, then the order is left alone`);
    }
    const stats = reminderStats();
    if (stats.awaitingPayment) {
      ok(`${stats.awaitingPayment} order(s) awaiting payment, ${stats.remindedOnce} already reminded once`);
      if (stats.stopped) warn(`${stats.stopped} order(s) had both reminders — they need you, not another nudge`);
    }
  }

  if (crmEnabled()) {
    section('Mini CRM');
    const tags = tagOverview();
    if (!tags.length) {
      notes.push('crm is on but nobody is tagged yet: .tag 923001234567 vip, or let auto-tags build themselves.');
    } else {
      const manual = tags.filter((t) => !t.auto).length;
      ok(`${tags.length} tag(s) in use (${manual} owner-made, ${tags.length - manual} auto only)`);
    }
    if (!orderTrackingEnabled()) {
      notes.push('crm tags can filter campaigns, but orderTracking is off — vip and repeat are learned from orders.');
    }
  }
}

async function checkEval() {
  // The golden eval is a local report, not a server: the only thing worth
  // saying is whether it has ever run, how it went, and how long ago.
  const file = path.join(config.root, 'eval-report.json');
  section('Golden eval');

  if (!fs.existsSync(file)) {
    warn('the golden-chat eval has never run here');
    notes.push('Run `npm run eval` — offline, no keys, about ten seconds. It replays 44 recorded conversations and fails on a wrong price, a wrong language, a leaked tag or an unconfirmed order.');
    return;
  }

  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    warn('eval-report.json is not readable — run `npm run eval` again');
    return;
  }
  const s = report.summary || {};
  const when = new Date(report.generatedAt || fs.statSync(file).mtime);
  const days = Math.floor((Date.now() - when.getTime()) / 86_400_000);
  const ago = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;

  const line = `${s.pass ?? 0} pass · ${s.warn ?? 0} warn · ${s.fail ?? 0} fail, ${ago} (${report.mode || 'deterministic'}, score ${s.score ?? 0}%)`;
  if (s.fail) {
    warn(line);
    notes.push('The golden eval has failures — `npm run eval` lists them per scenario and per category.');
  } else {
    ok(line);
  }
  if (days >= 14) {
    notes.push(`The golden eval last ran ${ago}; it takes seconds and is the cheapest way to notice prompt drift.`);
  }
}

async function checkSourceLinks() {
  const L = await import('../src/services/sourceLinks.js');
  const b = business() || {};
  const number = L.whatsappNumber();

  section('Source links');

  // The number is the whole product: a poster with the wrong number on it is a
  // wasted printing bill, so it is checked even before the feature is used.
  // Deliberately a warning, not a blocker: a bot with a placeholder number still
  // runs, it just must not be printed on anything until it is replaced.
  if (!number) {
    warn('no WhatsApp number is configured — a QR or poster would have nothing to point at');
    notes.push('Set MY_NUMBER in .env to the business WhatsApp number (international format, e.g. 923001234567) before printing a QR.');
  } else if (L.placeholderNumber(number)) {
    warn(`+${number} looks like a placeholder — fine for testing, wrong on a poster`);
    notes.push('Replace MY_NUMBER with the real business number before you print a poster or a QR.');
  } else {
    ok(`links point at ${L.readableNumber(number)} (${b.whatsapp || b.whatsappNumber ? 'business.whatsapp' : 'MY_NUMBER'})`);
  }

  if (!L.sourceLinksEnabled()) {
    warn('features.sourceLinks is off — .link / .qr / .poster are disabled');
    notes.push('Turn it on with: .set features.sourceLinks true, then .link instagram');
    return;
  }

  const summary = L.sourceSummary();
  if (!summary.total) {
    ok('flag is on, nothing created yet');
    notes.push('Make your first one in WhatsApp: .link instagram — then .qr instagram or .poster instagram.');
    return;
  }

  const withChats = summary.sources.filter((row) => row.conversations > 0).length;
  ok(`${summary.total}/${summary.limit} source(s), ${withChats} bringing chats, ${summary.conversations} chat(s) total`);
  if (summary.stale.length) {
    warn(`${summary.stale.length} source(s) with no conversations after 14 days: ${summary.stale.join(', ')}`);
    notes.push('A source with nothing after two weeks is in the wrong place: move the poster, or stop printing it.');
  }
}

async function checkOwnerDecisions() {
  const D = await import('../src/services/decisionTeam.js');
  const P = await import('../src/services/paymentReview.js');
  const b = business() || {};
  const settings = D.decisionSettings();
  const flagsOn = P.paymentReviewOn() || P.ownerDecisionsOn();

  section('Owner decisions + payment review');

  if (!flagsOn) {
    ok('both flags are off — the bot behaves exactly as before');
    notes.push('Turn them on with: .set features.paymentReview true (proof reading) and .set features.ownerDecisions true (discounts, refunds, the team).');
    return;
  }

  if (!(b.payment?.account || b.payment?.accountTail || b.payment?.accountName)) {
    warn('no business.payment account is configured — the receiver check can only answer "unknown"');
    notes.push('Add business.payment.account (or accountTail and accountName) so a proof can be compared with your own account.');
  }

  if (!settings.members.length) {
    warn('no decision team: every request waits on the owner alone');
    notes.push('Add someone with: .team add Ayesha 923001112233 payments,chat — or accept that you are the only decision-maker.');
  } else {
    // A chain that names someone who cannot decide that type would strand the
    // request at the worst moment.
    for (const [type, chain] of Object.entries(settings.chains)) {
      for (const step of chain) {
        if (step.who === 'owner') continue;
        if (!D.canDecide(step.who, type)) {
          warn(`chain for ${type} names +${step.who}, who has no role that can decide it`);
          notes.push(`Give them the right role, or fix the chain: .chain ${type} owner:0,<number>:15`);
        }
      }
    }
  }

  const open = P.paymentsSummary();
  if (open.overdue) {
    warn(`${open.overdue} payment request(s) are past their deadline`);
    notes.push('Open them with .requests; a decision that sits is worse than a fast no.');
  } else if (open.pending || open.recheck) {
    ok(`${open.pending} waiting, ${open.recheck} on recheck, average decision ${open.avgDecisionMinutes === null ? 'n/a' : `${open.avgDecisionMinutes} min`}`);
  } else {
    ok('nothing waiting');
  }

  const { proofDir } = await import('../src/services/paymentProofs.js');
  try {
    const fs = await import('node:fs');
    if (fs.existsSync(proofDir())) {
      const mode = fs.statSync(proofDir()).mode & 0o777;
      if (mode & 0o077) warn(`the proof folder is ${mode.toString(8)} — it should be 700`);
      else ok('proof files live in the tenant folder, mode 700/600');
    } else {
      ok('no proofs stored yet');
    }
  } catch {
    /* a read-only filesystem is not an emergency */
  }

  if (!settings.expectedResponseMinutes) {
    notes.push('No expected response time is set, so the customer is never promised one. Set it with: .set business.decisions.expectedResponseMinutes 30');
  }
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

  if (want('platform') && (process.env.PLATFORM_ENABLED || only === 'platform')) {
    section('Customer platform');
    const { doctorDiagnostics, remedy } = await import('../platform/diagnostics.js');
    const check = await doctorDiagnostics();
    for (const code of check.errors) { bad(remedy[code]); problems.push(code); }
    for (const code of check.warnings) warn(remedy[code]);
    if (!check.enabled) info('Platform disabled.');
    else if (!check.errors.length && !check.warnings.length) ok('Configuration and stored key envelopes checked.');
  }
  if (want('runtime')) await checkNode();
  if (want('files')) await checkFiles();
  if (want('identity', 'owner')) await checkOwner();
  if (want('business', 'profile', 'catalog', 'features')) await checkBusiness();
  if (want('groq')) await checkGroq();
  if (want('gemini', 'google')) await checkGemini();
  if (want('openrouter')) await checkOpenRouter();
  if (want('team', 'calls')) await checkTeamAndCalls();
  if (want('media', 'ffmpeg', 'vision')) await checkMedia();
  if (want('memory', 'db', 'database')) await checkMemory();
  if (want('visual', 'images')) await checkVisual();
  if (want('mcp', 'tools', 'external')) await checkMcp();
  if (want('health', 'alerts', 'privacy')) await checkHealthAndPrivacy();
  if (want('orders', 'crm', 'tags')) await checkOrdersAndCrm();
  if (want('eval', 'golden')) await checkEval();
  if (want('links', 'sources', 'qr', 'poster')) await checkSourceLinks();
  if (want('decisions', 'payments', 'payment', 'proof', 'proofs')) await checkOwnerDecisions();
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

// Only run when invoked as a script. Importing this file (the tests do, to
// reach growthSettingsWarnings) must not print a report and must certainly not
// call process.exit() in the middle of somebody's test run.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error('Doctor crashed:', err);
    process.exit(1);
  });
}
