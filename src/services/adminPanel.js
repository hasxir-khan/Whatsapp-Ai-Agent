// src/services/adminPanel.js
// Phase 4 Part 3 — a control panel for every tenant, and the rules that keep it
// from being the most dangerous page on the box.
//
// What makes this file different from the live inbox:
//   • the inbox shows conversations; this can create tenants, delete them, read
//     their business profile and write their API keys. A leaked link here is a
//     leaked fleet.
//   • so: its own ADMIN_TOKEN (never DASHBOARD_TOKEN), constant-time compare,
//     a session cookie signed with that token, CSRF on every mutation, a rate
//     limit on login and on create/delete, and an audit row for every action.
//   • no token configured means the panel does not exist: 404, not 401. An
//     unconfigured feature must never be an open one.
//   • the panel never returns a secret. Keys are write-only and come back
//     masked; .env, session files and the database are never served.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { config, reloadProfile } from '../config/env.js';
import { featureOn, validateProfile } from './profile.js';
import { run, all, get } from '../utils/db.js';
import { SLUG_RE as SHARED_SLUG_RE, validSlug as sharedValidSlug, validPort } from './validation.js';

export const COOKIE = 'wa_admin';
export const CSRF_COOKIE = 'wa_admin_csrf';
export const SLUG_RE = SHARED_SLUG_RE;
export { validPort };

const UPLOAD_TYPES = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_EXTENSIONS = Object.keys(UPLOAD_TYPES);

// ── the switch ───────────────────────────────────────────────
/** On only when the flag is on for this tenant *and* a token exists. */
export function adminEnabled() {
  return featureOn('adminPanel') && !!adminToken();
}

export function adminToken() {
  return String(config.admin?.token || '');
}

/** True when the flag is on but nobody can log in — doctor's job to shout about. */
export function adminMisconfigured() {
  return featureOn('adminPanel') && !adminToken();
}

// ── crypto ───────────────────────────────────────────────────
/** Constant-time string compare that does not leak length through timing. */
export function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const right = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(left, right);
}

function hmac(payload) {
  return hmacWith(adminToken(), payload);
}

/**
 * The signing primitive, parameterised by secret so the dashboard can reuse it
 * instead of growing a second cookie format. `label` keeps a session issued for
 * one surface from being accepted by the other even if the secrets matched.
 */
export function hmacWith(secret, payload) {
  return crypto.createHmac('sha256', String(secret || '')).update(payload).digest('base64url');
}

/** A signed, expiring session value: `<expiry>.<signature>`. */
export function issueSessionFor(secret, { label = 'admin', minutes = 720, now = Date.now() } = {}) {
  const ttl = Math.max(5, Number(minutes) || 720);
  const expiry = now + ttl * 60000;
  return { value: `${expiry}.${hmacWith(secret, `${label}.${expiry}`)}`, expiresAt: expiry };
}

export function sessionValidFor(secret, value, { label = 'admin', now = Date.now() } = {}) {
  const [rawExpiry, signature] = String(value || '').split('.');
  const expiry = Number(rawExpiry);
  if (!Number.isFinite(expiry) || expiry < now) return false;
  if (!signature || !secret) return false;
  return safeEqual(signature, hmacWith(secret, `${label}.${expiry}`));
}

/** A signed, expiring session value: `<expiry>.<signature>`. */
export function issueSession(now = Date.now()) {
  const minutes = Math.max(5, Number(config.admin?.sessionMinutes) || 720);
  return issueSessionFor(adminToken(), { label: 'admin', minutes, now });
}

export function sessionValid(value, now = Date.now()) {
  return sessionValidFor(adminToken(), value, { label: 'admin', now });
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req?.headers?.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/**
 * Who is this, and how did they prove it?
 * Bearer is for scripts; the cookie is for the browser. Nothing else counts —
 * in particular a `?token=` in the URL, which ends up in logs and history.
 */
export function verifyRequest(req) {
  const token = adminToken();
  if (!token) return { ok: false, reason: 'no_token' };

  const header = String(req?.headers?.authorization || '');
  if (header.startsWith('Bearer ') && safeEqual(header.slice(7).trim(), token)) {
    return { ok: true, via: 'bearer' };
  }

  const cookies = parseCookies(req);
  if (cookies[COOKIE] && sessionValid(cookies[COOKIE])) {
    return { ok: true, via: 'cookie', csrf: cookies[CSRF_COOKIE] || '' };
  }
  return { ok: false, reason: 'unauthorised' };
}

/**
 * CSRF for cookie-authenticated mutations. A bearer token cannot be sent by a
 * browser cross-site, so it does not need this; a cookie can, so it does.
 */
export function csrfOk(req, auth, body = null) {
  if (!auth || auth.via !== 'cookie') return true;

  const sent = String(req?.headers?.['x-admin-csrf'] || body?.csrf || '');
  if (sent && auth.csrf && safeEqual(sent, auth.csrf)) return true;

  // Fallback: same-origin. A cross-site form post cannot fake Origin.
  const origin = String(req?.headers?.origin || '');
  const referer = String(req?.headers?.referer || '');
  const host = String(req?.headers?.host || '');
  if (!host) return false;
  const check = (value) => {
    try {
      return new URL(value).host === host;
    } catch {
      return false;
    }
  };
  if (origin && check(origin)) return true;
  if (!origin && referer && check(referer)) return true;
  return false;
}

// ── rate limits ──────────────────────────────────────────────
const buckets = new Map();

export function resetRateLimits() {
  buckets.clear();
}

/**
 * Sliding window. `max` requests per `windowMs` per key, with the remaining
 * time handed back so the UI can say something useful.
 */
export function rateLimit(key, { max = 60, windowMs = 60000, now = Date.now() } = {}) {
  const stamps = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (stamps.length >= max) {
    const retryAfter = Math.ceil((windowMs - (now - stamps[0])) / 1000);
    buckets.set(key, stamps);
    return { ok: false, retryAfter: Math.max(1, retryAfter), remaining: 0 };
  }
  stamps.push(now);
  buckets.set(key, stamps);
  return { ok: true, remaining: max - stamps.length };
}

export function clientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req?.socket?.remoteAddress || 'unknown';
}

export const LIMITS = {
  login: { max: 5, windowMs: 15 * 60000 },
  create: { max: 10, windowMs: 60 * 60000 },
  delete: { max: 5, windowMs: 60 * 60000 },
  upload: { max: 20, windowMs: 60 * 60000 },
  api: { max: 240, windowMs: 60000 },
};

// ── audit ────────────────────────────────────────────────────
/**
 * Every action that changes something, and every refused attempt worth knowing
 * about. Never contains a secret: `detail` is built by the caller from names.
 */
export function audit(action, { slug = null, detail = null, ip = null, ok = true } = {}) {
  try {
    run('INSERT INTO admin_audit (created_at, action, slug, detail, ip, ok) VALUES (?, ?, ?, ?, ?, ?)', [
      new Date().toISOString(),
      String(action).slice(0, 60),
      slug ? String(slug).slice(0, 60) : null,
      detail ? String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500) : null,
      ip ? String(ip).slice(0, 60) : null,
      ok ? 1 : 0,
    ]);
  } catch {
    /* never let bookkeeping break the action */
  }
}

export function recentAudit(limit = 50) {
  try {
    return all('SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?', [Math.min(200, Math.max(1, Number(limit) || 50))]);
  } catch {
    return [];
  }
}

// ── tenants on disk ──────────────────────────────────────────
export function tenantsRoot() {
  return path.resolve(process.env.TENANTS_DIR || path.join(config.root, 'tenants'));
}

export function validSlug(slug) {
  return sharedValidSlug(slug);
}

/** Resolve a tenant folder, refusing anything that could escape the root. */
export function tenantDir(slug) {
  if (!validSlug(slug)) throw new Error('invalid_slug');
  const root = tenantsRoot();
  const dir = path.resolve(root, slug);
  if (dir !== path.join(root, slug) || !dir.startsWith(root + path.sep)) throw new Error('invalid_slug');
  return dir;
}

function readTenantJson(slug) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tenantDir(slug), 'tenant.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function readTenantEnv(slug) {
  const file = path.join(tenantDir(slug), '.env');
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] !== '') out[m[1]] = m[2].trim();
  }
  return out;
}

export function writeTenantEnvValue(slug, key, value) {
  const file = path.join(tenantDir(slug), '.env');
  if (!fs.existsSync(file)) throw new Error('no_env');
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

/** `gsk_1234…abcd` — enough to recognise a key, useless to anyone else. */
export function maskSecret(value) {
  const raw = String(value || '');
  if (!raw) return null;
  if (raw.length <= 8) return '••••';
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}

function pidFile(slug) {
  return path.join(tenantDir(slug), 'run.pid');
}

function readPid(slug) {
  try {
    return Number(fs.readFileSync(pidFile(slug), 'utf8').trim()) || null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const lastMessageCache = new Map(); // slug -> { at, value }

/** The newest message in that tenant's own database, if it has one yet. */
function lastMessageAt(slug) {
  const cached = lastMessageCache.get(slug);
  if (cached && Date.now() - cached.at < 10000) return cached.value;
  let value = null;
  try {
    const file = path.join(tenantDir(slug), 'data', 'assistant.db');
    if (fs.existsSync(file)) {
      // Cheap and dependency-free: the mtime answers "when did this tenant last
      // do anything", which is what an operator actually wants on a list page.
      value = fs.statSync(file).mtime.toISOString();
    }
  } catch {
    value = null;
  }
  lastMessageCache.set(slug, { at: Date.now(), value });
  return value;
}

/** One row per tenant, safe to return to the browser: no keys, no secrets. */
export function listTenants() {
  const root = tenantsRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => validSlug(name) && fs.existsSync(path.join(root, name, 'tenant.json')))
    .map((slug) => describeTenant(slug))
    .filter(Boolean)
    .sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
}

export function envSummary(slug) {
  const env = readTenantEnv(slug);
  return {
    transport: (env.TRANSPORT || 'baileys').toLowerCase(),
    keys: {
      groq: maskSecret(env.GROQ_API_KEY),
      gemini: maskSecret(env.GEMINI_API_KEY),
      openrouter: maskSecret(env.OPENROUTER_API_KEY),
    },
    cloud: {
      phoneIdSet: !!env.CLOUD_PHONE_ID,
      tokenSet: !!env.CLOUD_TOKEN,
      verifyTokenSet: !!env.CLOUD_VERIFY_TOKEN,
    },
    dashboardTokenSet: !!env.DASHBOARD_TOKEN,
  };
}

export function describeTenant(slug) {
  const meta = readTenantJson(slug);
  if (!meta) return null;
  const dir = tenantDir(slug);
  const pid = readPid(slug);
  const env = envSummary(slug);
  const sessionLinked = fs.existsSync(path.join(dir, 'sessions', 'creds.json'));
  return {
    slug: meta.slug || slug,
    name: meta.name || slug,
    number: meta.number ? `+${meta.number}` : null,
    port: meta.port || null,
    timezone: meta.timezone || null,
    enabled: meta.enabled !== false,
    createdAt: meta.createdAt || null,
    transport: env.transport,
    running: pidAlive(pid),
    pid: pidAlive(pid) ? pid : null,
    session: env.transport === 'cloud' ? (env.cloud.tokenSet ? 'cloud configured' : 'no cloud token') : sessionLinked ? 'linked' : 'not linked',
    keys: env.keys,
    lastMessageAt: lastMessageAt(slug),
  };
}

// ── create / delete ──────────────────────────────────────────
/** Same function the CLI uses. There is one definition of "a tenant". */
export async function createTenantFromPanel({ name, number, template = null, slug = null, port = null } = {}) {
  process.env.TENANTS_DIR = tenantsRoot();
  const { createTenant } = await import('../../scripts/tenant.js');
  const created = createTenant({ name, number, template, slug, port });
  return describeTenant(created.slug);
}

export function deleteTenantFromPanel(slug, confirm) {
  if (!validSlug(slug)) throw new Error('invalid_slug');
  if (String(confirm || '') !== slug) throw new Error('confirmation_required');
  const dir = tenantDir(slug);
  if (!readTenantJson(slug)) throw new Error('not_found');
  const pid = readPid(slug);
  if (pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  lastMessageCache.delete(slug);
  return { deleted: slug };
}

// ── profile ──────────────────────────────────────────────────
export function readTenantProfile(slug) {
  const file = path.join(tenantDir(slug), 'config', 'owner.json');
  if (!fs.existsSync(file)) throw new Error('not_found');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Writes only through validateProfile(), so the panel cannot save a profile the
 * bot would refuse to load. The file is replaced atomically.
 */
export function writeTenantProfile(slug, profileObject) {
  if (!profileObject || typeof profileObject !== 'object' || Array.isArray(profileObject)) {
    return { ok: false, errors: ['profile must be a JSON object'] };
  }
  const check = validateProfile(profileObject);
  if (check.errors?.length) return { ok: false, errors: check.errors };

  const dir = tenantDir(slug);
  const file = path.join(dir, 'config', 'owner.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(profileObject, null, 2)}\n`);
  fs.renameSync(tmp, file);

  // If this process is serving that tenant, make it live immediately.
  let reloaded = false;
  if (config.tenant.slug === slug) {
    try {
      reloadProfile();
      reloaded = true;
    } catch {
      reloaded = false;
    }
  }
  return { ok: true, warnings: check.warnings || [], reloaded, bytes: fs.statSync(file).size };
}

// ── keys (write-only) ────────────────────────────────────────
const KEY_NAME = /^(GROQ_API_KEY|GEMINI_API_KEY|OPENROUTER_API_KEY)$/;
const KEY_VALUE = /^[A-Za-z0-9._-]{8,200}$/;

export function setTenantKeys(slug, pairs = {}) {
  const saved = [];
  for (const [name, value] of Object.entries(pairs)) {
    if (!KEY_NAME.test(name)) throw new Error(`unknown_key:${name}`);
    const clean = String(value ?? '').trim();
    if (!clean) throw new Error(`empty_key:${name}`);
    if (!KEY_VALUE.test(clean)) throw new Error(`bad_key_format:${name}`);
    writeTenantEnvValue(slug, name, clean);
    saved.push(name);
  }
  return { saved, masked: envSummary(slug).keys, restartRequired: true };
}

/** A tiny real call, so "test key" means something. */
export async function probeKey({ provider = 'groq', key = '', fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const clean = String(key || '').trim();
  if (!clean) return { ok: false, reason: 'empty_key' };
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no_fetch' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    if (provider === 'groq') {
      response = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${clean}` },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        signal: controller.signal,
      });
    } else if (provider === 'gemini') {
      response = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models', {
        method: 'GET',
        headers: { 'x-goog-api-key': clean },
        signal: controller.signal,
      });
    } else {
      return { ok: false, reason: 'unknown_provider' };
    }
    const status = Number(response?.status) || 0;
    return {
      ok: status >= 200 && status < 300,
      status,
      reason: status >= 200 && status < 300 ? 'works' : status === 401 || status === 403 ? 'rejected' : 'unexpected_status',
    };
  } catch (err) {
    return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

/** The key on disk, for a server-side probe. Never returned to the browser. */
export function tenantKeyFor(slug, provider = 'groq') {
  const env = readTenantEnv(slug);
  const name = provider === 'gemini' ? 'GEMINI_API_KEY' : provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'GROQ_API_KEY';
  return env[name] || '';
}

// ── knowledge upload ─────────────────────────────────────────
/** Basename only, safe charset, allowed extension, size limit. */
export function safeUploadName(name) {
  const base = path.basename(String(name || 'file'));
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+/, '').slice(-100);
  if (!cleaned) throw new Error('bad_filename');
  return cleaned;
}

export function uploadExtension(name) {
  const ext = path.extname(String(name || '')).slice(1).toLowerCase();
  return ext;
}

export function saveUpload(slug, { name, buffer } = {}) {
  const safe = safeUploadName(name);
  const ext = uploadExtension(safe);
  if (!MAX_UPLOAD_EXTENSIONS.includes(ext)) {
    return { ok: false, reason: 'type_not_allowed', allowed: MAX_UPLOAD_EXTENSIONS };
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, reason: 'empty_file' };
  if (buffer.length > UPLOAD_MAX_BYTES) return { ok: false, reason: 'too_large', limit: UPLOAD_MAX_BYTES };

  const dir = path.join(tenantDir(slug), 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${safe}`);
  if (!path.resolve(file).startsWith(path.resolve(dir) + path.sep)) return { ok: false, reason: 'bad_path' };
  fs.writeFileSync(file, buffer);
  return { ok: true, file, name: safe, bytes: buffer.length, type: UPLOAD_TYPES[ext] };
}

/**
 * Feed the file into the existing learn pipeline. Same tenant → in this
 * process, so the counts are real. Another tenant → the existing CLI command,
 * because its knowledge lives in *its* database.
 */
export async function ingestUpload(slug, file) {
  if (config.tenant.slug === slug) {
    const knowledge = await import('./knowledge.js');
    const res = await knowledge.ingestFile(file);
    return { ok: true, mode: 'inline', source: res.source, chunks: res.chunks, chars: res.chars };
  }
  const { spawnSync } = await import('node:child_process');
  const dir = tenantDir(slug);
  const repo = config.root;
  const child = spawnSync(
    process.execPath,
    [path.join(repo, 'scripts', 'tenant.js'), 'learn', slug, file],
    {
      cwd: repo,
      encoding: 'utf8',
      timeout: 120000,
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
    }
  );
  const output = `${child.stdout || ''}${child.stderr || ''}`.trim();
  const chunks = Number((output.match(/(\d+)\s+chunks?/i) || [])[1] || 0) || null;
  return { ok: child.status === 0, mode: 'cli', chunks, output: output.slice(-400) };
}

/**
 * Embed this tenant's catalogue images. Same tenant → in this process; another
 * tenant → the CLI, because its database is its own.
 */
export async function indexImagesFor(slug) {
  if (config.tenant.slug === slug) {
    const { indexCatalogImages, visualSearchEnabled } = await import('./visualSearch.js');
    if (!visualSearchEnabled()) return { ok: false, reason: 'visual_search_off', hint: '.set features.visualSearch true' };
    return { ok: true, mode: 'inline', ...(await indexCatalogImages()) };
  }
  const { spawnSync } = await import('node:child_process');
  const dir = tenantDir(slug);
  const repo = config.root;
  const child = spawnSync(process.execPath, [path.join(repo, 'scripts', 'tenant.js'), 'index-images', slug], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 300000,
    env: {
      ...process.env,
      TENANT: slug,
      TENANTS_DIR: tenantsRoot(),
      ENV_FILE: path.join(dir, '.env'),
      CONFIG_DIR: path.join(dir, 'config'),
      DATA_DIR: path.join(dir, 'data'),
      SESSION_FOLDER: path.join(dir, 'sessions'),
      TMP_DIR: path.join(dir, 'tmp'),
      ENABLE_WEB: 'false',
    },
  });
  const output = `${child.stdout || ''}${child.stderr || ''}`.trim();
  return { ok: child.status === 0, mode: 'cli', status: child.status, output: output.slice(-400) };
}

// ── process control ──────────────────────────────────────────
export function tenantEnv(slug) {
  const meta = readTenantJson(slug) || {};
  const dir = tenantDir(slug);
  return {
    ...process.env,
    TENANT: slug,
    TENANTS_DIR: tenantsRoot(),
    ENV_FILE: path.join(dir, '.env'),
    CONFIG_DIR: path.join(dir, 'config'),
    DATA_DIR: path.join(dir, 'data'),
    SESSION_FOLDER: path.join(dir, 'sessions'),
    TMP_DIR: path.join(dir, 'tmp'),
    PORT: String(meta.port || 3000),
    ENABLE_WEB: 'true',
    LOG_LEVEL: process.env.LOG_LEVEL || 'warn',
  };
}

export async function startTenant(slug, { spawnImpl = null } = {}) {
  const meta = readTenantJson(slug);
  if (!meta) throw new Error('not_found');
  const pid = readPid(slug);
  if (pidAlive(pid)) return { ok: true, alreadyRunning: true, pid };

  const spawnChild = spawnImpl || (await import('node:child_process')).spawn;
  const child = spawnChild(process.execPath, [path.join(config.root, 'src', 'index.js')], {
    cwd: config.root,
    env: tenantEnv(slug),
    detached: true,
    stdio: 'ignore',
  });
  child?.unref?.();
  if (child?.pid) fs.writeFileSync(pidFile(slug), String(child.pid));
  return { ok: true, started: true, pid: child?.pid || null };
}

export function stopTenant(slug) {
  if (!readTenantJson(slug)) throw new Error('not_found');
  const pid = readPid(slug);
  if (!pidAlive(pid)) {
    try {
      fs.rmSync(pidFile(slug), { force: true });
    } catch {
      /* nothing to clean */
    }
    return { ok: true, alreadyStopped: true };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  try {
    fs.rmSync(pidFile(slug), { force: true });
  } catch {
    /* ignore */
  }
  return { ok: true, stopped: true, pid };
}

export async function restartTenant(slug, opts) {
  stopTenant(slug);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return startTenant(slug, opts);
}

// ── QR / cloud ───────────────────────────────────────────────
/**
 * A QR for the browser. Two sources, both local:
 *   • this process is that tenant → botState has the live string;
 *   • a tenant started by run-all writes ./qr-<slug>.png next to the repo.
 */
export async function qrForTenant(slug) {
  if (!readTenantJson(slug)) throw new Error('not_found');
  const meta = readTenantJson(slug) || {};
  const transport = (readTenantEnv(slug).TRANSPORT || 'baileys').toLowerCase();

  if (transport === 'cloud') {
    const env = readTenantEnv(slug);
    const publicUrl = (env.PUBLIC_URL || process.env.PUBLIC_URL || '').replace(/\/$/, '');
    return {
      ok: true,
      transport,
      qr: null,
      webhookPath: `/webhook/${slug}`,
      webhookUrl: publicUrl ? `${publicUrl}/webhook/${slug}` : null,
      verifyTokenSet: !!env.CLOUD_VERIFY_TOKEN,
      appSecretSet: !!env.CLOUD_APP_SECRET,
      note: 'Cloud API does not use a QR. Point Meta at the webhook URL and set the same verify token.',
    };
  }

  // live, in this process
  if (config.tenant.slug === slug) {
    const { botState } = await import('../state.js');
    if (botState.qr && /^[A-Za-z0-9+/=]+$/.test(botState.qr)) {
      const QRCode = (await import('qrcode')).default;
      return { ok: true, transport, qr: await QRCode.toDataURL(botState.qr, { width: 320, margin: 1 }), status: botState.status };
    }
  }

  // written to disk by a child process (run-all / show --start)
  const candidates = [path.join(config.root, `qr-${slug}.png`), meta.slug === 'default' ? path.join(config.root, 'qr.png') : null]
    .filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const stat = fs.statSync(file);
        if (Date.now() - stat.mtimeMs < 5 * 60000) {
          return { ok: true, transport, qr: `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`, status: 'waiting_for_qr' };
        }
      }
    } catch {
      /* try the next one */
    }
  }
  const linked = fs.existsSync(path.join(tenantDir(slug), 'sessions', 'creds.json'));
  return { ok: true, transport, qr: null, status: linked ? 'linked' : 'not_started', note: linked ? 'This tenant is already linked.' : 'Start the tenant to get a QR.' };
}

// Process control is the one part a test must never do for real: spawning the
// actual bot would open a WhatsApp connection. So the routes call through this
// hook, and a test can replace it.
export const adminHooks = {
  start: startTenant,
  stop: stopTenant,
  restart: restartTenant,
};

export function setAdminHooks(next = {}) {
  for (const key of ['start', 'stop', 'restart']) {
    if (typeof next[key] === 'function') adminHooks[key] = next[key];
  }
  return adminHooks;
}

export function resetAdminHooks() {
  adminHooks.start = startTenant;
  adminHooks.stop = stopTenant;
  adminHooks.restart = restartTenant;
  return adminHooks;
}

export function auditCount(action = null) {
  try {
    return (
      (action
        ? get('SELECT COUNT(*) AS n FROM admin_audit WHERE action = ?', [action])
        : get('SELECT COUNT(*) AS n FROM admin_audit'))?.n || 0
    );
  } catch {
    return 0;
  }
}

export default {
  adminEnabled,
  adminMisconfigured,
  safeEqual,
  issueSession,
  sessionValid,
  verifyRequest,
  csrfOk,
  rateLimit,
  resetRateLimits,
  listTenants,
  describeTenant,
  createTenantFromPanel,
  deleteTenantFromPanel,
  readTenantProfile,
  writeTenantProfile,
  setTenantKeys,
  tenantKeyFor,
  probeKey,
  saveUpload,
  ingestUpload,
  startTenant,
  stopTenant,
  restartTenant,
  qrForTenant,
  indexImagesFor,
  audit,
  recentAudit,
};
