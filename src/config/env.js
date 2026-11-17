// src/config/env.js
// Central, validated configuration. Everything is optional — the bot degrades
// gracefully when a provider or feature is not configured.

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

// A tenant may point at its own env file; the default install uses ./.env
dotenv.config({ path: process.env.ENV_FILE || '.env' });

const ROOT = process.cwd();

// ── tenant (multi-user) ─────────────────────────────────────
// Every user of this bot can run completely isolated: their own .env (keys),
// their own config/owner.json (business knowledge), their own WhatsApp session
// and their own database. The default install is tenant "default".
const TENANT = (process.env.TENANT || 'default').trim();
const CONFIG_DIR = path.resolve(ROOT, process.env.CONFIG_DIR || './config');

// ── tiny parsers ────────────────────────────────────────────
const toBool = (v, def = false) =>
  v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on', 'y'].includes(String(v).trim().toLowerCase());

const toInt = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

const toNum = (v, def) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
};

const toList = (v, def = []) =>
  v === undefined || v === ''
    ? def
    : String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

/** Normalise any phone input ("+92 316 9896229", "0316-9896229") to 923169896229 */
export function normalizePhone(input) {
  if (!input) return '';
  let digits = String(input).replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) digits = `92${digits.slice(1)}`; // Pakistani local
  return digits;
}

export const DEFAULT_OWNER_NUMBER = '923169896229';

// ── owner / persona knowledge base ──────────────────────────
function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base;
  if (typeof base !== 'object' || base === null) return override ?? base;
  if (typeof override !== 'object' || override === null) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`⚠️  Could not parse ${file}: ${err.message}`);
    return null;
  }
}

/**
 * Loads config/owner.example.json → config/owner.json → config/owner.local.json
 * so the user can keep personal details out of git.
 */
export function loadOwnerProfile() {
  // The schema always comes from the repo; the business knowledge comes from
  // whichever config directory this tenant uses.
  const schemaDir = path.join(ROOT, 'config');
  const dir = CONFIG_DIR;
  const base = readJsonIfExists(path.join(schemaDir, 'owner.example.json')) || {};
  const custom = readJsonIfExists(path.join(dir, 'owner.json')) || {};
  const local =
    readJsonIfExists(path.join(dir, 'owner.local.json')) ||
    (dir !== schemaDir ? null : readJsonIfExists(path.join(schemaDir, 'owner.local.json'))) ||
    {};
  const profile = deepMerge(deepMerge(base, custom), local);

  // Env overrides for the handful of things people change most often
  profile.owner = profile.owner || {};
  profile.owner.name = process.env.MY_NAME || profile.owner.name || 'Hashir';
  profile.owner.brand = process.env.MY_BRAND || profile.owner.brand || 'HasDevs';
  profile.owner.timezone = process.env.MY_TIMEZONE || profile.owner.timezone || 'Asia/Karachi';
  profile.owner.location = process.env.MY_LOCATION || profile.owner.location || 'Pakistan';
  if (process.env.MY_PERSONALITY) profile.bot.persona = process.env.MY_PERSONALITY;
  if (process.env.MY_BIO) profile.owner.bio = process.env.MY_BIO;

  return profile;
}

/**
 * Runtime reload of the business profile.
 *
 * Modules like brain.js capture `profile.owner` at import time, so replacing
 * the object would leave them pointing at stale data. This mutates the live
 * objects in place instead: edit a price from WhatsApp, and the next reply
 * already uses it.
 */
function mergeInPlace(target, source) {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    const bothPlain =
      current && value && typeof current === 'object' && typeof value === 'object' &&
      !Array.isArray(current) && !Array.isArray(value);
    if (bothPlain) mergeInPlace(current, value);
    else target[key] = value;
  }
  return target;
}

export function reloadProfile() {
  const fresh = loadOwnerProfile();
  const target = config.owner?.profile;
  if (!target) return fresh;
  mergeInPlace(target, fresh);

  config.owner.name = fresh.owner?.name || config.owner.name || 'Hashir';
  config.owner.pushName = process.env.MY_PUSHNAME || config.owner.name;
  if (config.bot) {
    config.bot.name = fresh.bot?.name || `${config.owner.name}'s Assistant`;
    config.bot.persona = fresh.bot?.persona || '';
    config.bot.disclosure = fresh.bot?.disclosure;
    config.bot.maxBubbles = toInt(process.env.MAX_BUBBLES, toInt(fresh.bot?.maxBubbles, 3));
    config.bot.pretendHuman = toBool(process.env.PRETEND_HUMAN, fresh.bot?.pretendHuman ?? false);
  }
  return fresh;
}

// ── main config object ──────────────────────────────────────
const ownerNumber = normalizePhone(process.env.MY_NUMBER || process.env.OWNER_NUMBER || DEFAULT_OWNER_NUMBER);
const ownerProfile = loadOwnerProfile();
const ownerName = ownerProfile.owner?.name || 'Hashir';

export const config = {
  root: ROOT,

  tenant: {
    slug: TENANT,
    isTenant: TENANT !== 'default',
    configDir: CONFIG_DIR,
  },

  owner: {
    number: ownerNumber,
    jid: `${ownerNumber}@s.whatsapp.net`,
    name: ownerName,
    pushName: process.env.MY_PUSHNAME || ownerName,
    profile: ownerProfile,
  },

  bot: {
    name: ownerProfile.bot?.name || `${ownerName}'s Assistant`,
    pretendHuman: toBool(process.env.PRETEND_HUMAN, ownerProfile.bot?.pretendHuman ?? false),
    disclosure: ownerProfile.bot?.disclosure,
    persona: ownerProfile.bot?.persona || '',
    maxBubbles: toInt(process.env.MAX_BUBBLES, toInt(ownerProfile.bot?.maxBubbles, 3)),
    replyLanguageMode: process.env.REPLY_LANGUAGE_MODE || 'mirror', // mirror | owner | english
  },

  keys: {
    groq: process.env.GROQ_API_KEY || '',
    gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
    openrouter: process.env.OPENROUTER_API_KEY || '',
  },

  // ── growth agents (Phase 3) ──────────────────────────────
  // Everything proactive goes through one safety layer; these are its limits.
  growth: {
    // Max proactive messages to one person in a rolling 24 hours.
    contactCap: toInt(process.env.GROWTH_CONTACT_CAP, 1),
    // Max proactive messages per process per day. Meta's Cloud API tolerates
    // more; Baileys is an unofficial client and a burst is how numbers get
    // flagged, so the default is deliberately lower there.
    dailyCap: toInt(process.env.GROWTH_DAILY_CAP, 30),
    baileysCap: toInt(process.env.GROWTH_BAILEYS_CAP, 12),
    // Default quiet window, in the business's timezone.
    quietStart: process.env.GROWTH_QUIET_START || '21:00',
    quietEnd: process.env.GROWTH_QUIET_END || '09:00',
    // Follow-up agent
    followUpMinScore: toInt(process.env.GROWTH_MIN_SCORE, 40),
    followUpAfterHours: toList(process.env.GROWTH_FOLLOWUP_HOURS, ['24', '72']).map((n) => toInt(n, 24)),
    followUpMax: toInt(process.env.GROWTH_FOLLOWUP_MAX, 2),
  },

  // Weekly owner report: which day and what time, in the business timezone.
  analyst: {
    day: process.env.ANALYST_DAY || 'mon',
    time: process.env.ANALYST_TIME || '09:00',
  },

  // Review agent: how long after a finished job we ask for feedback.
  review: {
    afterHours: toInt(process.env.REVIEW_AFTER_HOURS, 24),
  },

  // Closer agent: how many times we may push back on one objection.
  closer: {
    maxAttempts: toInt(process.env.CLOSER_MAX_ATTEMPTS, 2),
  },

  // Optional: push bookings into a Google Calendar. Both are best-effort —
  // with no credentials, bookings simply live in SQLite.
  calendar: {
    id: process.env.GOOGLE_CALENDAR_ID || '',
    serviceAccountFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE || '',
    // Optional shared secret for a personal OAuth refresh-token setup.
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
  },

  // ── how the bot talks to WhatsApp ────────────────────────
  // "baileys" (default, unchanged, free, needs a phone) or "cloud" (Meta's
  // official API, no phone needed, requires a Meta app + a public webhook).
  transport: (process.env.TRANSPORT || 'baileys').trim().toLowerCase() === 'cloud' ? 'cloud' : 'baileys',

  cloud: {
    phoneId: process.env.CLOUD_PHONE_ID || '',
    token: process.env.CLOUD_TOKEN || '',
    verifyToken: process.env.CLOUD_VERIFY_TOKEN || '',
    appSecret: process.env.CLOUD_APP_SECRET || '',
    apiVersion: process.env.CLOUD_API_VERSION || 'v21.0',
    // Webhook path is per tenant: /webhook/<slug>
    slug: TENANT,
    // Optional: an approved template to use when the 24-hour window is closed.
    template: process.env.CLOUD_TEMPLATE_NAME
      ? { name: process.env.CLOUD_TEMPLATE_NAME, language: process.env.CLOUD_TEMPLATE_LANG || 'en' }
      : null,
  },

  // Free-tier embeddings for the knowledge base (Phase 2 RAG).
  embed: {
    enabled: toBool(process.env.EMBEDDINGS, true),
    model: process.env.EMBED_MODEL || '',
    rpm: toInt(process.env.EMBED_RPM, 60),
    batchSize: toInt(process.env.EMBED_BATCH_SIZE, 20),
  },

  // Retrieval settings. Keep the timeout short: a slow lookup must never
  // delay a customer's reply.
  rag: {
    topK: toInt(process.env.RAG_TOP_K, 4),
    minScore: toNum(process.env.RAG_MIN_SCORE, 0.5),
    timeoutMs: toInt(process.env.RAG_TIMEOUT_MS, 2500),
  },

  paths: {
    config: CONFIG_DIR,
    data: path.resolve(ROOT, process.env.DATA_DIR || './data'),
    sessions: path.resolve(ROOT, process.env.SESSION_FOLDER || './sessions'),
    tmp: path.resolve(ROOT, process.env.TMP_DIR || './tmp'),
    qr: path.resolve(
      ROOT,
      process.env.QR_PATH || (TENANT === 'default' ? './qr.png' : `./qr-${TENANT}.png`)
    ),
  },

  server: {
    enabled: toBool(process.env.ENABLE_WEB, true),
    port: toInt(process.env.PORT, 3000),
    host: process.env.HOST || '0.0.0.0',
  },

  // How the Gemini key is presented: "key" → x-goog-api-key header,
  // "bearer" → Authorization: Bearer, for keys Google issues that way.
  geminiAuthStyle: (process.env.GEMINI_AUTH_STYLE || 'key').toLowerCase() === 'bearer' ? 'bearer' : 'key',

  llm: {
    // provider preference order; only providers with a key are used
    providers: toList(process.env.LLM_PROVIDERS, ['groq', 'gemini', 'openrouter']),
    groqModels: toList(process.env.GROQ_MODELS, [
      process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-20b',
    ]),
    // cheap model for JSON extraction / summaries
    groqSmallModels: toList(process.env.GROQ_SMALL_MODELS, [
      process.env.GROQ_SMALL_MODEL || 'openai/gpt-oss-20b',
      'llama-3.1-8b-instant',
      'openai/gpt-oss-120b',
    ]),
    // Newest free-tier model first, then progressively older ones. If Google
    // retires or renames one, the next in the chain is tried automatically.
    geminiModels: toList(process.env.GEMINI_MODELS, [
      process.env.GEMINI_MODEL || 'gemini-4-hydrogen',
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-3-flash-preview',
      'gemini-2.5-flash',
    ]),
    openrouterTextModels: toList(process.env.OPENROUTER_MODELS, [
      'meta-llama/llama-3.3-70b-instruct:free',
      'google/gemini-2.0-flash-exp:free',
    ]),
    temperature: toNum(process.env.LLM_TEMPERATURE, 0.7),
    maxTokens: toInt(process.env.LLM_MAX_TOKENS, 700),
    historyTurns: toInt(process.env.HISTORY_TURNS, 16),
  },

  vision: {
    providers: toList(process.env.VISION_PROVIDERS, ['gemini', 'openrouter', 'groq']),
    geminiModels: toList(process.env.GEMINI_VISION_MODELS, [
      process.env.GEMINI_VISION_MODEL || 'gemini-4-hydrogen',
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-3-flash-preview',
      'gemini-2.5-flash',
    ]),
    openrouterModels: toList(process.env.OPENROUTER_VISION_MODELS, [
      process.env.OPENROUTER_VISION_MODEL || 'google/gemini-2.0-flash-exp:free',
      'qwen/qwen2.5-vl-72b-instruct:free',
      'meta-llama/llama-4-maverick:free',
    ]),
    groqModels: toList(process.env.GROQ_VISION_MODELS, [
      process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
    ]),
    maxImageBytes: toInt(process.env.MAX_IMAGE_MB, 16) * 1024 * 1024,
    maxVideoBytes: toInt(process.env.MAX_VIDEO_MB, 48) * 1024 * 1024,
    videoFrames: toInt(process.env.VIDEO_FRAMES, 6),
  },

  stt: {
    enabled: toBool(process.env.STT_ENABLED, true),
    model: process.env.WHISPER_MODEL || 'whisper-large-v3-turbo',
    fallbackModel: process.env.WHISPER_FALLBACK_MODEL || 'whisper-large-v3',
    // '' = auto-detect language (best for foreign clients)
    language: process.env.STT_LANGUAGE || '',
    maxSeconds: toInt(process.env.MAX_AUDIO_SECONDS, 600),
  },

  tts: {
    // off | on_request | match_voice | always
    mode: (process.env.VOICE_REPLY_MODE || 'on_request').toLowerCase(),
    providers: toList(process.env.TTS_PROVIDERS, ['edge', 'groq']),
    edgeVoice: process.env.TTS_VOICE || '',
    groqModelEnglish: process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-v1-english',
    groqVoice: process.env.GROQ_TTS_VOICE || 'troy',
    maxChars: toInt(process.env.TTS_MAX_CHARS, 600),
    ffmpegPath: process.env.FFMPEG_PATH || '',
  },

  behavior: {
    debounceMs: toInt(process.env.DEBOUNCE_MS, 2200),
    handoffMinutes: toInt(process.env.HANDOFF_MINUTES, 45),
    typingSpeedCharsPerSec: toNum(process.env.TYPING_CPS, 11),
    minDelayMs: toInt(process.env.MIN_DELAY_MS, 900),
    maxDelayMs: toInt(process.env.MAX_DELAY_MS, 9000),
    readReceipts: toBool(process.env.READ_RECEIPTS, true),
    quietHours: process.env.QUIET_HOURS || '', // e.g. "01:00-07:00" — empty = never quiet
    deferQuietHours: toBool(process.env.DEFER_QUIET_HOURS, false),
    autoBlockScam: toBool(process.env.AUTO_BLOCK_SCAM, false),
    escalateToOwner: toBool(process.env.ESCALATE_TO_OWNER, true),
    followUpHours: toInt(process.env.FOLLOWUP_HOURS, 20),
    followUpMax: toInt(process.env.FOLLOWUP_MAX, 2),
    summaryEvery: toInt(process.env.SUMMARY_EVERY, 12),
    ownerCommands: toBool(process.env.OWNER_COMMANDS, true),
    notifyNewChats: toBool(process.env.NOTIFY_NEW_CHATS, true),
  },

  // ── missed-call handling ──────────────────────────────────
  // The WhatsApp Web protocol cannot carry audio into a live call, so the
  // assistant "picks up" the conversation in chat (voice note + text) when a
  // call goes unanswered.
  calls: {
    enabled: toBool(process.env.CALLS_ENABLED, true),
    delaySeconds: toInt(process.env.CALL_FALLBACK_SECONDS, 60),
    // auto | voice_note | text
    mode: (process.env.CALL_FALLBACK_MODE || 'auto').toLowerCase(),
    // auto | formal | casual  (auto follows the client's own register)
    tone: (process.env.CALL_FALLBACK_TONE || 'auto').toLowerCase(),
    maxPerNumberPerDay: toInt(process.env.CALL_FALLBACK_MAX_PER_DAY, 3),
    notifyOwner: toBool(process.env.CALL_NOTIFY_OWNER, true),
  },

  limits: {
    // Keeps a $0 Groq/Gemini free tier comfortably inside its daily quota
    dailyLlmCalls: toInt(process.env.DAILY_LLM_CALLS, 700),
    dailyVisionCalls: toInt(process.env.DAILY_VISION_CALLS, 150),
    dailyTtsChars: toInt(process.env.DAILY_TTS_CHARS, 20000),
    maxDocChars: toInt(process.env.MAX_DOC_CHARS, 12000),
    maxHistoryRows: toInt(process.env.MAX_HISTORY_ROWS, 40),
  },

  report: {
    hour: toInt(process.env.REPORT_HOUR, 9),
    enabled: toBool(process.env.DAILY_REPORT, true),
  },

  sheets: {
    id: process.env.GOOGLE_SHEET_ID || '',
    serviceAccount: process.env.GOOGLE_SERVICE_ACCOUNT || '',
  },

  session: {
    pairingNumber: normalizePhone(process.env.PAIRING_NUMBER || ''),
    backupEnv: process.env.WA_SESSION || '',
    printBackup: toBool(process.env.PRINT_SESSION_BACKUP, false),
  },

  dryRun: toBool(process.env.DRY_RUN, false),
  logLevel: process.env.LOG_LEVEL || 'info',
  timezone: process.env.MY_TIMEZONE || ownerProfile.owner?.timezone || 'Asia/Karachi',
};

/**
 * Friends, family and anyone who should get the casual version of the
 * assistant instead of the client/sales flow.
 */
export function isFriend(number) {
  const friends = config.owner.profile?.owner?.friends || [];
  const digits = normalizePhone(number);
  return friends.some((f) => normalizePhone(f.number) === digits);
}

export function friendName(number) {
  const friends = config.owner.profile?.owner?.friends || [];
  const digits = normalizePhone(number);
  const match = friends.find((f) => normalizePhone(f.number) === digits);
  return match?.name || null;
}

// ════════════════════════════════════════════════════════════
// Team (multi-operator)
// ════════════════════════════════════════════════════════════
const ROLE_PERMISSIONS = {
  owner: ['*'],
  admin: ['*'],
  manager: ['leads', 'chats', 'quotes', 'pause', 'resume', 'assign', 'report', 'calls', 'intakes'],
  sales: ['leads', 'chats', 'quotes', 'pause', 'resume', 'calls', 'intakes'],
  support: ['chats', 'pause', 'resume', 'calls', 'intakes'],
};

export function teamMembers() {
  const team = config.owner.profile?.owner?.team || [];
  return team
    .map((m) => ({ ...m, number: normalizePhone(m.number || '') }))
    .filter((m) => m.number);
}

export function teamMember(number) {
  const digits = normalizePhone(number);
  return teamMembers().find((m) => m.number === digits) || null;
}

export function isTeam(number) {
  return !!teamMember(number);
}

/** Is this the owner, or someone acting with the owner's rights? */
export function isOwnerOrAdmin(number) {
  if (normalizePhone(number) === config.owner.number) return true;
  const member = teamMember(number);
  return member?.role === 'admin';
}

export function teamPermissions(number) {
  if (normalizePhone(number) === config.owner.number) return new Set(['*']);
  const member = teamMember(number);
  if (!member) return new Set();
  const rolePerms = ROLE_PERMISSIONS[member.role] || ROLE_PERMISSIONS.support;
  const extra = Array.isArray(member.permissions) ? member.permissions : [];
  return new Set([...rolePerms, ...extra]);
}

export function can(number, permission) {
  const perms = teamPermissions(number);
  return perms.has('*') || perms.has(permission);
}

/** Human-readable summary of what is configured — printed at boot. */
export function describeConfig() {
  const has = (v) => (v ? '✅' : '—');
  return [
    `Tenant       : ${config.tenant.slug}${config.tenant.isTenant ? ` (${path.relative(ROOT, config.tenant.configDir)})` : ' (owner install)'}`,
    `Owner        : ${config.owner.name} (+${config.owner.number})`,
    `Groq key     : ${has(config.keys.groq)}   (chat + Whisper)`,
    `Gemini key   : ${has(config.keys.gemini)}   (images + video)`,
    `OpenRouter   : ${has(config.keys.openrouter)}   (vision fallback)`,
    `Voice replies: ${config.tts.mode} via ${config.tts.providers.join(' > ')}`,
    `Transport    : ${config.transport === 'cloud' ? `Cloud API (webhook /webhook/${config.cloud.slug})` : 'Baileys (QR / pairing code)'}`,
    `Missed calls: ${config.calls.enabled ? `answered in chat after ${config.calls.delaySeconds}s` : 'off'}`,
    `Team         : ${(config.owner.profile?.owner?.team || []).length} teammate(s) + owner`,
    `Dashboard    : ${config.server.enabled ? `http://0.0.0.0:${config.server.port}` : 'disabled'}`,
  ].join('\n');
}

export function assertConfig() {
  const problems = [];
  if (!config.keys.groq && !config.keys.gemini && !config.keys.openrouter) {
    problems.push('No AI key found. Set GROQ_API_KEY (free at console.groq.com) — that alone is enough to run.');
  }
  if (!config.owner.number) problems.push('MY_NUMBER is empty. Set it to your WhatsApp number in international format.');
  if (config.transport === 'cloud') {
    if (!config.cloud.phoneId) problems.push('TRANSPORT=cloud needs CLOUD_PHONE_ID (Meta → WhatsApp → API setup).');
    if (!config.cloud.token) problems.push('TRANSPORT=cloud needs CLOUD_TOKEN (a permanent system-user token).');
    if (!config.cloud.verifyToken) problems.push('TRANSPORT=cloud needs CLOUD_VERIFY_TOKEN (any word you choose; Meta echoes it back).');
    if (!config.cloud.appSecret) problems.push('TRANSPORT=cloud needs CLOUD_APP_SECRET — without it webhooks cannot be verified and will be refused.');
  }
  return problems;
}

export default config;
