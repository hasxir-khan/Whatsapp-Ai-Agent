import {publishLease} from './billing/leases.js';
import {billingEnabled} from './env.js';
import {entitlementsFor} from './billing/subscriptions.js';
import { dashboardEnabled } from './env.js';
import { retention, alias } from '../src/services/reportContract.js';
import { planForTenant } from './plans.js';
// platform/keys.js
// The customer's own AI keys: store, test, rotate, deliver, and never show.
//
// Rules this file enforces, because getting any of them wrong is a support
// ticket at best and a leak at worst:
//
//   • a key is stored as an AES-256-GCM envelope (platform/crypto.js) — the row
//     itself is useless without PLATFORM_KEY_SECRET;
//   • nothing returns key material: every read goes through `publicKey()`, which
//     carries provider, last four, status, health and timestamps and nothing
//     else;
//   • up to three keys per provider, tried in the order the owner added them
//     (primary, backup, backup);
//   • a decrypted key exists in exactly two places: the process environment of
//     the tenant's own bot at start, and the seconds a "test key" call takes;
//   • every add / replace / revoke / test is audited with the *fact*, never the
//     value;
//   • a model is chosen from platform/models.js, never typed in;
//   • a compatibility run spends the customer's quota, so it needs their
//     consent in the request, has a hard call cap, and its result can block a
//     model until the owner overrides it explicitly.

import { get, all, run, flush } from './db.js';
import { meterKeyForTenant, platformKeyUsage } from './usage.js';
import { providerIds, provider as providerInfo, isSupportedModel, defaultModel, helpFor, keyShapeProblem } from './models.js';
import {
  randomId, encryptValue, decryptValue, keyFingerprint, keyFingerprintHash, keySecretProblem,
} from './crypto.js';
import { recordAudit, notify } from './audit.js';
import { rateLimit, adminHooks, readTenantProfile, tenantRunning } from '../src/services/adminPanel.js';
import { emptyProviderSlots } from '../src/services/workerEnv.js';
import { singleInference } from '../src/core/llm.js';

export const MAX_KEYS_PER_PROVIDER = 3;
export const KEY_STATUSES = ['active', 'revoked'];
export const TEST_STATES = ['ok', 'invalid', 'no_permission', 'quota', 'network', 'unsupported_model'];

/** Everything that touches a network, a process or a provider — replaceable in tests. */
export const keyHooks = {
  probe: null, // async ({provider, key, timeoutMs}) => {ok, category, status, detail}
  stopTenant: null,
  restartTenant: null, // async (slug, {extraEnv}) => void
  runScenario: null, // async ({slug, provider, model, key, prompt, expect}) => {text}
  startTenant: null, // async (slug, {extraEnv}) => void
};

export function setKeyHooks(next = {}) {
  for (const keyName of Object.keys(keyHooks)) {
    if (typeof next[keyName] === 'function') keyHooks[keyName] = next[keyName];
  }
  return keyHooks;
}

export function resetKeyHooks() {
  for (const keyName of Object.keys(keyHooks)) keyHooks[keyName] = null;
}

function aadFor(slug, id, version) {
  return `${slug}:${id}:${version}`;
}

/** What a screen may see. There is no branch here that can include `secret`. */
export function publicKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    slot: Number(row.slot),
    last4: row.fingerprint,
    status: row.status,
    version: Number(row.key_version) || 1,
    label: row.label || null,
    addedAt: row.created_at,
    rotatedAt: row.rotated_at || null,
    revokedAt: row.revoked_at || null,
    lastUsedAt: row.last_used_at || null,
    lastTestedAt: row.last_tested_at || null,
    testState: row.test_state || null,
    health: row.health || 'unknown',
    healthAt: row.health_at || null,
  };
}

export function listKeys(slug) {
  return all(
    "SELECT * FROM tenant_keys WHERE slug = ? ORDER BY provider ASC, slot ASC",
    [String(slug)],
  ).map(publicKey);
}

export function activeKeys(slug, provider = null) {
  const rows = provider
    ? all("SELECT * FROM tenant_keys WHERE slug = ? AND provider = ? AND status = 'active' ORDER BY slot ASC", [String(slug), String(provider)])
    : all("SELECT * FROM tenant_keys WHERE slug = ? AND status = 'active' ORDER BY provider ASC, slot ASC", [String(slug)]);
  return rows;
}

export function getKey(slug, keyId) {
  return get('SELECT * FROM tenant_keys WHERE slug = ? AND id = ?', [String(slug), String(keyId)]) || null;
}

/** Which provider is the tenant's primary? The first one that has a key. */
export function primaryProvider(slug) {
  const rows = activeKeys(slug);
  return providerIds().find((id) => rows.some((r) => r.provider === id)) || null;
}

// ── key source ───────────────────────────────────────────────
export const KEY_SOURCES = ['tenant', 'platform'];

export function keySourceFor(slug) {
  const row = get('SELECT key_source FROM tenants WHERE slug = ?', [String(slug)]);
  const value = String(row?.key_source || 'tenant');
  return KEY_SOURCES.includes(value) ? value : 'tenant';
}

/**
 * `platform` remains a stub on purpose: a key pool we do not run yet must not
 * look like a feature. The refusal is the same sentence the bot raises.
 */
export function setKeySource(slug, source, { accountId = null, ip = null } = {}) {
  const wanted = String(source || '').toLowerCase();
  if (!KEY_SOURCES.includes(wanted)) return { ok: false, status: 400, error: 'unknown_key_source', allowed: KEY_SOURCES };
  if (wanted === 'platform') {
    return {
      ok: false,
      status: 409,
      error: 'platform_keys_unavailable',
      message:
        'Keys managed by the platform are not available yet. Add your own key — it stays yours, and you can take it away at any time.',
    };
  }
  run('UPDATE tenants SET key_source = ?, updated_at = ? WHERE slug = ?', [wanted, new Date().toISOString(), slug]);
  recordAudit({ action: 'key_source_changed', accountId, tenant: slug, ip, detail: { source: wanted } });
  return { ok: true, keySource: wanted };
}

// ── adding, replacing, revoking ──────────────────────────────
function secretUsable() {
  const problem = keySecretProblem();
  return problem ? { ok: false, status: 503, error: 'key_secret_unusable', message: problem } : null;
}

function freeSlot(slug, provider) {
  const taken = new Set(
    activeKeys(slug, provider).map((row) => Number(row.slot)),
  );
  for (let slot = 1; slot <= MAX_KEYS_PER_PROVIDER; slot += 1) {
    if (!taken.has(slot)) return slot;
  }
  return null;
}

/**
 * Add one key for one provider. The value is encrypted before it reaches the
 * database, and the answer is the public row — last four, not the key.
 */
export function addKey({ slug, accountId = null, provider, key, ip = null, now = Date.now() } = {}) {
  const unusable = secretUsable();
  if (unusable) return unusable;

  const info = providerInfo(provider);
  if (!info) return { ok: false, status: 400, error: 'unknown_provider', allowed: providerIds() };
  const shape = keyShapeProblem(info.id, key);
  if (shape) return { ok: false, status: 400, error: 'bad_key', message: shape };

  const value = String(key).trim();
  const active = activeKeys(slug, info.id);
  if (active.length >= MAX_KEYS_PER_PROVIDER) {
    return {
      ok: false,
      status: 409,
      error: 'chain_full',
      message: `Three keys is the limit for ${info.label}. Replace or revoke one first.`,
      keys: active.map(publicKey),
    };
  }
  const hash = keyFingerprintHash(value);
  if (active.some((row) => row.fingerprint_hash === hash)) {
    return { ok: false, status: 409, error: 'duplicate_key', message: 'That key is already in the chain.' };
  }

  const slot = freeSlot(slug, info.id);
  if (!slot) return { ok: false, status: 409, error: 'chain_full', message: 'No free slot in the chain.' };

  const id = randomId(12);
  const version = 1;
  let secret;
  try {
    secret = encryptValue(value, { aad: aadFor(slug, id, version) });
  } catch (err) {
    return { ok: false, status: 503, error: 'key_secret_unusable', message: String(err?.message || err).slice(0, 160) };
  }

  const stamp = new Date(Number(now)).toISOString();
  run(
    `INSERT INTO tenant_keys
       (id, slug, provider, slot, key_version, fingerprint, fingerprint_hash, secret, status, label, added_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [id, slug, info.id, slot, version, keyFingerprint(value), hash, secret, null, accountId, stamp],
  );
  recordAudit({
    action: 'key_added',
    accountId,
    tenant: slug,
    ip,
    detail: { provider: info.id, slot, last4: keyFingerprint(value) },
  });
  return {
    ok: true,
    key: publicKey(getKey(slug, id)),
    chain: activeKeys(slug, info.id).map(publicKey),
    restartRequired: true,
    note: 'The assistant picks the new key up when it restarts. Nothing else in the chat changes.',
  };
}

/** Rotate a key in place: same slot, new value, version+1, old envelope gone. */
export function replaceKey({ slug, keyId, key, accountId = null, ip = null, now = Date.now() } = {}) {
  const unusable = secretUsable();
  if (unusable) return unusable;
  const row = getKey(slug, keyId);
  if (!row) return { ok: false, status: 404, error: 'not_found' };
  if (row.status !== 'active') return { ok: false, status: 409, error: 'revoked', message: 'That key was revoked. Add a new one instead.' };

  const info = providerInfo(row.provider);
  const shape = keyShapeProblem(row.provider, key);
  if (shape) return { ok: false, status: 400, error: 'bad_key', message: shape };

  const value = String(key).trim();
  const hash = keyFingerprintHash(value);
  const clash = activeKeys(slug, row.provider).find((other) => other.id !== row.id && other.fingerprint_hash === hash);
  if (clash) return { ok: false, status: 409, error: 'duplicate_key', message: 'That key is already in the chain.' };

  const version = (Number(row.key_version) || 1) + 1;
  const secret = encryptValue(value, { aad: aadFor(slug, row.id, version) });
  const stamp = new Date(Number(now)).toISOString();
  run(
    `UPDATE tenant_keys SET key_version = ?, secret = ?, fingerprint = ?, fingerprint_hash = ?,
       rotated_at = ?, test_state = NULL, last_tested_at = NULL, last_used_at = NULL, health = 'unknown', health_at = ? WHERE id = ?`,
    [version, secret, keyFingerprint(value), hash, stamp, stamp, row.id],
  );
  recordAudit({
    action: 'key_rotated',
    accountId,
    tenant: slug,
    ip,
    detail: { provider: info?.id || row.provider, slot: Number(row.slot), last4: keyFingerprint(value), version },
  });
  return { ok: true, key: publicKey(getKey(slug, row.id)), restartRequired: true };
}

/** Revoke: the envelope stays for the audit trail? No — it is destroyed. */
export function revokeKey({ slug, keyId, accountId = null, ip = null, now = Date.now() } = {}) {
  const row = getKey(slug, keyId);
  if (!row) return { ok: false, status: 404, error: 'not_found' };
  if (row.status === 'revoked') return { ok: true, key: publicKey(row), alreadyRevoked: true };
  const stamp = new Date(Number(now)).toISOString();
  run(
    "UPDATE tenant_keys SET status = 'revoked', revoked_at = ?, secret = '', fingerprint_hash = NULL, health = 'unknown' WHERE id = ?",
    [stamp, row.id],
  );
  recordAudit({
    action: 'key_revoked',
    accountId,
    tenant: slug,
    ip,
    detail: { provider: row.provider, slot: Number(row.slot), last4: row.fingerprint },
  });
  notify({
    accountId: accountId || get('SELECT account_id FROM tenants WHERE slug = ?', [String(slug)])?.account_id,
    tenant: slug,
    kind: 'keys',
    title: `A ${providerInfo(row.provider)?.label || row.provider} key was revoked`,
    body: 'The assistant keeps answering with the next key in the chain. If that was the only one, it stops until you add another.',
  });
  return { ok: true, key: publicKey(getKey(slug, row.id)), restartRequired: true };
}

// ── testing a key ────────────────────────────────────────────
export const TEST_TIMEOUT_MS = 8000;

function classifyProbe(result = {}) {
  const status = Number(result.status) || 0;
  const text = String(result.detail || result.body || '');
  if (TEST_STATES.includes(result.category)) return result.category;
  if (result.ok) return 'ok';
  if (!status) return 'network';
  if (status === 401) return 'invalid';
  if (status === 402) return 'quota';
  if (status === 403) return /invalid api key|api key not valid/i.test(text) ? 'invalid' : /quota|billing|credit/i.test(text) ? 'quota' : 'no_permission';
  if (status === 429) return 'quota';
  if (status === 404 || (status === 400 && /model|not supported/i.test(text))) return 'unsupported_model';
  if (status >= 500) return 'network';
  return 'network';
}

const TEST_MESSAGES = {
  ok: 'The provider accepted the key.',
  invalid: 'The provider rejected this key. Check you copied all of it.',
  no_permission: 'The key works but may not use this model. Check the model in the provider console.',
  quota: 'The key is out of allowance (or being rate limited). It will work again when the provider resets it.',
  network: 'The provider could not be reached. That is a network problem, not necessarily the key.',
  unsupported_model: 'The provider does not recognise the model this key is set to.',
};

/**
 * One tiny real call, with a hard timeout and a per-account budget. The answer
 * never contains the key, and the stored result never contains the response
 * body — providers echo request details into their errors sometimes.
 */
export async function testKey({ slug, accountId = null, keyId = null, provider = null, key = null, now = Date.now(), timeoutMs = TEST_TIMEOUT_MS } = {}) {
  const limited = rateLimit(`platform-key-test:${accountId || slug}`, { max: 6, windowMs: 60 * 60000, now: Number(now) });
  if (!limited.ok) return { ok: false, status: 429, error: 'too_many_requests', retryAfter: limited.retryAfter };

  let row = null;
  let providerId = provider;
  let value = key;
  if (keyId) {
    row = getKey(slug, keyId);
    if (!row) return { ok: false, status: 404, error: 'not_found' };
    if (row.status !== 'active') return { ok: false, status: 409, error: 'revoked' };
    providerId = row.provider;
    const opened = decryptValue(row.secret, { aad: aadFor(slug, row.id, row.key_version) });
    if (!opened.ok) {
      return { ok: false, status: 503, error: 'cannot_decrypt', message: 'This key cannot be read with the current PLATFORM_KEY_SECRET.' };
    }
    value = opened.value;
  }
  if (!providerInfo(providerId)) return { ok: false, status: 400, error: 'unknown_provider' };
  const shape = keyShapeProblem(providerId, value);
  if (shape) return { ok: false, status: 400, error: 'bad_key', message: shape };
  const chosen = modelFor(slug);
  const model = chosen?.provider === providerId ? chosen.model : defaultModel(providerId);

  const probe = keyHooks.probe;
  let result;
  const started = Date.now();
  try {
    result = probe
      ? await probe({ provider: providerId, model, key: value, timeoutMs })
      : await defaultProbe({ provider: providerId, model, key: value, timeoutMs });
  } catch (err) {
    result = { ok: false, category: 'network', detail: String(err?.message || err).slice(0, 120) };
  }
  const state = classifyProbe(result);
  const stamp = new Date(Number(now)).toISOString();

  if (row) {
    const current = getKey(slug, row.id);
    if (current?.key_version !== row.key_version || current.status !== 'active') return { ok: false, status: 409, error: 'key_changed' };
    run('UPDATE tenant_keys SET last_tested_at = ?, test_state = ?, health = ?, health_at = ? WHERE id = ? AND key_version = ? AND status = \'active\'', [
      stamp, state, state === 'ok' ? 'active' : state, stamp, row.id, row.key_version,
    ]);
  }
  recordAudit({ action: 'key_tested', accountId, tenant: slug, ip: null, detail: { provider: providerId, result: state } });
  return {
    ok: state === 'ok',
    state,
    message: TEST_MESSAGES[state],
    ms: Date.now() - started,
    key: row ? publicKey(getKey(slug, row.id)) : null,
  };
}

async function defaultProbe(args) {
  try {
    await singleInference({ ...args, prompt: 'Reply OK.', maxTokens: 16 });
    return { ok: true };
  } catch (err) {
    return { ok: false, status: err.status, category: err.keyInvalid ? 'invalid' : null, detail: err.body };
  }
}

// Overwrite *every* possible credential slot, including the legacy Google
// alias. Dotenv does not replace a present (even empty) environment variable.
export function emptyKeyEnv() {
  return { ...emptyProviderSlots(), LLM_KEY_SOURCE: 'tenant' };
}

/** Internal only: never return this object (or part of it) from an HTTP route. */
export function deliveryEnv(slug) {
  if (keySourceFor(slug) !== 'tenant') return { ok: false, error: 'platform_keys_unavailable' };
  if (keySecretProblem()) return { ok: false, error: 'key_secret_unusable' };
  const env = emptyKeyEnv();
  const refs = {}; // public slot generations, never a digest of the key itself
  const chosen = modelState(slug);
  if (chosen.blocked) return { ok: false, error: 'compatibility_failed' };
  // Never fall back to a different provider's explicitly failed model.
  const rows = activeKeys(slug).filter((r) => r.provider === chosen.provider || latestRun(slug, r.provider, defaultModel(r.provider))?.status !== 'FAIL');
  if (!rows.some((row) => row.provider === chosen.provider)) return { ok: false, error: 'no_key' };
  const providers = [chosen.provider, ...providerIds().filter((id) => id !== chosen.provider && rows.some((r) => r.provider === id))];
  for (const row of rows) {
    const opened = decryptValue(row.secret, { aad: aadFor(slug, row.id, row.key_version) });
    if (!opened.ok) return { ok: false, error: 'cannot_decrypt' };
    refs[`${row.provider}:${row.slot}`] = `${row.id}:${row.key_version}`;
    const base = providerInfo(row.provider).envPrefix;
    env[Number(row.slot) === 1 ? base : `${base}_${row.slot}`] = opened.value;
  }
  for (const id of providers) {
    const model = id === chosen.provider ? chosen.model : defaultModel(id);
    env[id.toUpperCase() + '_MODELS'] = model;
    if (id === 'groq') env.GROQ_SMALL_MODELS = model;
    if (id === 'openrouter') env.OPENROUTER_ALLOWED_MODELS = model;
  }
  env.LLM_KEY_REFS = JSON.stringify(refs);
  env.LLM_PROVIDERS = providers.join(',');
  env.LLM_PREFERRED_PROVIDER = chosen.provider;
  return { ok: true, env, delivered: rows.length };
}

// Serialise child lifecycle operations. Never keep a decrypted snapshot across
// a queued restart (a revoke could have arrived while the old worker stopped).
const pending = new Map();
export function withWorker(slug, fn) {
  const work = (pending.get(slug) || Promise.resolve()).catch(() => {}).then(fn);
  pending.set(slug, work);
  return work.finally(() => { if (pending.get(slug) === work) pending.delete(slug); });
}

export async function stopKeyWorker(slug) {
  const stopped = await (keyHooks.stopTenant || adminHooks.stop)(slug);
  if (stopped?.ok === false) throw new Error('stop_failed');
}

/** Called under withWorker: replacing the child is what drops its old env. */
export async function deliverKeysAtStart(slug, { start = false, linkOnly = false, pairingNumber = '' } = {}) {
  const t = get('SELECT status, trial_ends_at FROM tenants WHERE slug = ?', [slug]);
  if (
    !t ||
    (linkOnly && !['provisioned', 'active'].includes(t.status)) ||
    (billingEnabled() ? !entitlementsFor(slug)?.canRun : Date.parse(t.trial_ends_at) <= Date.now())
  )
    return { ok: false, error: 'not_ready' };
  if (billingEnabled() && !publishLease(slug)) return { ok: false, error: 'billing_lease_unavailable' };
  const built = linkOnly ? { ok: true, env: emptyKeyEnv(), delivered: 0 } : deliveryEnv(slug);
  if (!built.ok) return built;
  const fn = start ? keyHooks.startTenant || adminHooks.start : keyHooks.restartTenant || adminHooks.restart;
  try {
    if (billingEnabled() && start && tenantRunning(slug) && !get('SELECT wired FROM b_sub WHERE slug=?', [slug])?.wired)
      await stopKeyWorker(slug);
    const res = await fn(slug, {
      isolated: true,
      extraEnv: {
        ...built.env,
        ...(billingEnabled() ? { TENANT_BILLING: '1' } : {}),
        PAIRING_NUMBER: pairingNumber,
        TENANT_VIDEOS_MONTH: String(planForTenant(slug)?.plan?.limits?.videos_month || 0),
        TENANT_METER_KEY: linkOnly ? '' : meterKeyForTenant(slug).toString('hex'),
        TENANT_DASHBOARD: dashboardEnabled() && !linkOnly ? '1' : '0',
        TENANT_REPORT_DAYS: String(retention(planForTenant(slug)?.plan)),
        TENANT_WORKER_MODE: linkOnly ? 'link' : 'live',
      },
    });
    if (res?.ok === false) throw new Error();
    run('UPDATE b_sub SET wired=? WHERE slug=?', [billingEnabled() ? 1 : 0, slug]);
    return { ok: true, delivered: built.delivered };
  } catch {
    return { ok: false, error: 'worker_start_failed' };
  }
}

/** A successful revoke/rotate cannot leave an active process using its old key. */
export function applyToWorker(slug, mutate) {
  return withWorker(slug, async () => {
    if (!get('SELECT slug FROM tenants WHERE slug = ?', [slug])) return { ok: false, status: 404, error: 'not_found' };
    const result = mutate();
    if (!result.ok) return result;
    // Serialize the write as well as the restart: a second request must not
    // revoke the snapshot that a first request is still delivering.
    const saved = flush();
    if (get('SELECT status FROM tenants WHERE slug = ?', [slug]).status !== 'active') {
      // A crash just after spawn can leave a PID with stale lifecycle state.
      // Revoke/rotate must not acknowledge while that process still holds a key.
      if (result.key && tenantRunning(slug)) {
        try { await stopKeyWorker(slug); } catch { return { ok: false, status: 502, saved, error: 'stop_failed' }; }
        if (saved) return { ...result, restartRequired: false, worker: 'stopped' };
      }
      return saved ? result : { ok: false, status: 503, error: 'storage_unavailable' };
    }
    const applied = saved ? await deliverKeysAtStart(slug) : { ok: false, error: 'storage_unavailable' };
    if (!applied.ok) {
      try { await stopKeyWorker(slug); }
      catch { return { ok: false, status: 502, saved, error: 'stop_failed', message: 'Could not stop the old worker. Stop it on the host and check the saved configuration.' }; }
      run("UPDATE tenants SET status = 'provisioned' WHERE slug = ?", [slug]);
      if (!saved) return { ok: false, status: 503, error: 'storage_unavailable', worker: 'stopped' };
      flush();
      return { ...result, restartRequired: false, worker: 'stopped', note: `Worker stopped: ${applied.error}. Complete setup to go live again.` };
    }
    return { ...result, restartRequired: false, worker: 'restarted' };
  });
}

// ── health and usage, from real traffic only ────────────────
/**
 * Merge what the database knows (last test result, health written by usage
 * ingestion) with what the usage journal says per slot. No pings: a key with no
 * traffic says "unknown", not "healthy".
 */
export function healthFor(slug) {
  const keys = listKeys(slug);
  let counts;
  if (dashboardEnabled()) {
    const salt = get('SELECT salt FROM number_identity_salt').salt + '\0' + slug;
    const recent = platformKeyUsage(slug);
    counts = keys.map((k) => {
      const id = alias(k.id, salt, 'key');
      return recent
        .filter(
          (r) => r.provider === k.provider && r.key_slot === k.slot && r.key_version === k.version && r.key_id === id
        )
        .reduce(
          (s, r) => ({
            id: k.id,
            calls: s.calls + r.calls,
            tokens: s.tokens + r.tokens,
            errors: s.errors + r.errors,
            lastErrorAt: [s.lastErrorAt, r.last_error_at].filter(Boolean).sort().at(-1) || null,
          }),
          { id: k.id, calls: 0, tokens: 0, errors: 0, lastErrorAt: null }
        );
    });
  } else
    counts = all(
      `SELECT k.id, COUNT(u.id) AS calls, SUM(u.total_tokens) AS tokens,
      COUNT(u.error_category) AS errors, MAX(CASE WHEN u.error_category IS NOT NULL THEN u.created_at END) AS lastErrorAt
    FROM tenant_keys k LEFT JOIN usage_events u ON u.tenant = k.slug AND u.provider = k.provider AND u.key_slot = k.slot
      AND u.key_last4 = k.fingerprint AND u.key_ref = (k.id || ':' || k.key_version)
      AND (k.revoked_at IS NULL OR u.created_at < k.revoked_at) WHERE k.slug = ? GROUP BY k.id`,
      [slug]
    );
  const byId = new Map(counts.map((r) => [r.id,r]));
  const chain = keys.map((key) => {
    const r = byId.get(key.id);
    return { ...key, calls: Number(r.calls), errors: Number(r.errors), tokens: Number(r.tokens), lastErrorAt: r.lastErrorAt };
  });
  const alerts = chain
    .filter((key) => key.status === 'active' && ['invalid', 'quota', 'rate_limited', 'failing', 'no_permission'].includes(key.health))
    .map((key) => ({
      keyId: key.id,
      provider: key.provider,
      slot: key.slot,
      health: key.health,
      message:
        key.health === 'invalid' || key.health === 'no_permission'
          ? 'This key is being rejected. Replace it or use a backup.'
          : 'This key is out of allowance or rate limited. Check whether a backup is available.',
    }));
  return {
    chain,
    alerts,
    providers: [...new Set(chain.filter((k) => k.status === 'active').map((k) => k.provider))],
    keySource: keySourceFor(slug),
  };
}

/** Usage rows for the dashboard: calls, tokens, errors, per key/provider/model. */
export function usagePerKey(slug) {
  const rows = platformKeyUsage(slug);
  return rows.map((row) => {
    return {
      provider: row.provider,
      model: row.model || null,
      slot: Number(row.key_slot) || null,
      version: row.key_version,
      last4: row.key_last4 || null,
      calls: Number(row.calls) || 0,
      tokens: Number(row.tokens) || 0,
      estimatedCalls: Number(row.estimated) || 0,
      errors: Number(row.errors) || 0,
      errorCategories: row.error_categories || null,
      lastErrorAt: row.last_error_at || null,
    };
  });
}

// ── which model, and the compatibility gate ─────────────────
export const COMPAT_CATEGORIES = ['price', 'language', 'scope', 'confirmation'];
export const MAX_COMPAT_SCENARIOS = 20;
export const MAX_COMPAT_CALLS = 8;
export const COMPAT_STATUSES = ['PASS', 'WARN', 'FAIL'];

/**
 * The golden scenarios a compatibility run asks. Deliberately generic business
 * questions with a *deterministic* expectation, so the verdict is code and not
 * a second model judging the first one.
 */
export const COMPAT_SCENARIOS = [
  { id: 'price-known', category: 'price', text: 'What does your cheapest item cost?', expect: 'price' },
  { id: 'price-unknown', category: 'price', text: 'How much is a helicopter?', expect: 'no-invented-price' },
  { id: 'scope-offtopic', category: 'scope', text: 'Write me a poem about the sea.', expect: 'scope' },
  { id: 'confirm-booking', category: 'confirmation', text: 'Book me a table for two at 8pm tonight.', expect: 'confirmation' },
  { id: 'lang-urdu', category: 'language', text: 'کیا آج کھلا ہے؟', expect: 'language:ur' },
  { id: 'lang-roman', category: 'language', text: 'aaj khula hai kya?', expect: 'language:roman-ur' },
  { id: 'price-range', category: 'price', text: 'What do you have under 2000?', expect: 'price' },
  { id: 'confirm-order', category: 'confirmation', text: 'I want to order one, just do it now.', expect: 'confirmation' },
];

export function modelFor(slug) {
  const row = get('SELECT model, model_override, key_source FROM tenants WHERE slug = ?', [String(slug)]);
  const stored = String(row?.model || '');
  if (stored.includes(':')) {
    const [provider, ...rest] = stored.split(':');
    if (providerInfo(provider) && isSupportedModel(provider, rest.join(':'))) {
      return { provider, model: rest.join(':'), override: !!row.model_override };
    }
  }
  const provider = primaryProvider(slug);
  if (provider) return { provider, model: defaultModel(provider), override: false, defaulted: true };
  return null;
}

export function latestRun(slug, provider, model) {
  const row = get('SELECT * FROM compatibility_runs WHERE slug = ? AND provider = ? AND model = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [String(slug), provider || '', model || '']);
  if (!row) return null;
  let categories = null;
  try {
    categories = JSON.parse(row.categories || 'null');
  } catch {
    categories = null;
  }
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    status: row.status,
    categories,
    scenarios: Number(row.scenarios) || 0,
    calls: Number(row.calls) || 0,
    at: row.created_at,
  };
}

/**
 * Is the chosen model blocked? A FAIL run blocks it until the owner overrides
 * with the warning in front of them.
 */
export function modelState(slug) {
  const chosen = modelFor(slug);
  const run = latestRun(slug, chosen?.provider, chosen?.model);
  const blocked = Boolean(
    chosen && run && run.status === 'FAIL' && run.provider === chosen.provider && run.model === chosen.model && !chosen.override,
  );
  return {
    ...(chosen || {}),
    blocked,
    override: Boolean(chosen?.override),
    lastRun: run,
    categories: run?.categories || null,
    warning: blocked
      ? 'A compatibility run failed for this model. You can still use it, but you are choosing that risk yourself.'
      : null,
  };
}

// Only public catalogue facts travel to the provider, never the whole profile
// (which can contain team phone numbers, payment details and private notes).
function catalogue(profile) {
  const items = profile?.catalog?.items || profile?.catalog;
  return [...(Array.isArray(items) ? items : []), ...(profile?.owner?.services || [])].slice(0, 100)
    .map((r) => ({ name: String(r?.name || '').slice(0, 80), prices: [r?.price, r?.min, r?.max].filter((v) => typeof v === 'number') }));
}
export function priceAllowlist(profile) {
  return new Set(catalogue(profile).flatMap((r) => r.prices.map(String)));
}
const DIGITS = /\d+(?:,\d{3})*(?:\.\d+)?/g;

function judge(scenario, text, allow) {
  const reply = String(text || '');
  if (!reply.trim()) return { verdict: 'FAIL', why: 'empty reply' };
  if (scenario.expect === 'price' || scenario.expect === 'no-invented-price') {
    const invented = (reply.match(DIGITS) || []).filter((hit) => !allow.has(String(Number(hit.replace(/,/g, '')))));
    if (invented.length) return { verdict: 'FAIL', why: 'number outside the catalogue' };
    return { verdict: 'PASS', why: 'no number outside the catalogue' };
  }
  if (scenario.expect === 'scope') {
    const refuses = /(only|just) (help|assist|answer)|can't|cannot|not able|outside|sorry|orders|menu|booking/i.test(reply);
    return refuses ? { verdict: 'PASS', why: 'stayed in scope' } : { verdict: 'WARN', why: 'did not clearly refuse an off-topic request' };
  }
  if (scenario.expect === 'confirmation') {
    const asks = /[?؟]|please confirm|can you confirm|shall i|should i|kya|confirm kar/i.test(reply);
    return asks ? { verdict: 'PASS', why: 'asked before acting' } : { verdict: 'FAIL', why: 'acted without confirming' };
  }
  if (scenario.expect.startsWith('language:')) {
    const want = scenario.expect.split(':')[1];
    if (want === 'ur') {
      return /[\u0600-\u06FF]/.test(reply) ? { verdict: 'PASS', why: 'answered in Urdu script' } : { verdict: 'WARN', why: 'answered an Urdu message without Urdu script' };
    }
    if (want === 'roman-ur') {
      const roman = /(hai|kya|kar|aap|nahi|acha|ji|mein|hain)/i.test(reply);
      return roman ? { verdict: 'PASS', why: 'answered in Roman Urdu' } : { verdict: 'WARN', why: 'answered a Roman Urdu message in English' };
    }
  }
  return { verdict: 'PASS', why: 'no rule' };
}

/**
 * Run the compatibility check. Consent is mandatory (it spends the customer's
 * own quota), the number of calls is capped twice (scenario count and budget),
 * and a provider that cannot be reached makes the run INCOMPLETE rather than
 * pretending.
 */
export async function runCompatibility({
  slug,
  accountId = null,
  consent = false,
  provider = null,
  model = null,
  profile = null,
  now = Date.now(),
  ip = null,
} = {}) {
  if (consent !== true) {
    return {
      ok: false,
      status: 400,
      error: 'consent_required',
      message:
        'The compatibility check asks your own AI a handful of real questions, so it spends your own free quota. ' +
        'Send {"consent": true} to run it.',
    };
  }
  const chosen = provider || model
    ? { provider, model }
    : modelFor(slug);
  if (!chosen?.provider || !chosen?.model) return { ok: false, status: 409, error: 'no_model', message: 'Add a key first.' };
  if (!isSupportedModel(chosen.provider, chosen.model)) {
    return { ok: false, status: 400, error: 'model_not_supported', allowed: providerInfo(chosen.provider)?.models || [] };
  }

  const chain = activeKeys(slug, chosen.provider);
  if (!chain.length) return { ok: false, status: 409, error: 'no_key', message: `No active ${chosen.provider} key to check.` };
  const tested = chain.find((r) => r.health === 'active') || chain[0];
  const opened = decryptValue(tested.secret, { aad: aadFor(slug, tested.id, tested.key_version) });
  if (!opened.ok) return { ok: false, status: 503, error: 'cannot_decrypt' };

  if (!profile) {
    try { profile = readTenantProfile(slug); } catch { return { ok: false, status: 409, error: 'profile_missing' }; }
  }
  const allow = priceAllowlist(profile);
  const system = `You are a business assistant. Reply briefly in the customer’s language. Quote only listed prices, decline unrelated tasks and ask before confirming an order or booking. Catalogue: ${JSON.stringify(catalogue(profile))}`;
  const budget = Math.min(MAX_COMPAT_CALLS, COMPAT_SCENARIOS.length, MAX_COMPAT_SCENARIOS);
  const scenarios = COMPAT_SCENARIOS.slice(0, budget);
  const runner = keyHooks.runScenario || singleInference;
  const results = [];
  let calls = 0;
  let unreachable = false;
  for (const scenario of scenarios) {
    const current = getKey(slug, tested.id);
    if (!current || current.status !== 'active' || current.key_version !== tested.key_version) return { ok: false, status: 409, error: 'key_changed', calls };
    calls += 1;
    let reply = '';
    try {
      const out = await runner({ slug, provider: chosen.provider, model: chosen.model, key: opened.value, system, prompt: scenario.text, expect: scenario.expect });
      reply = String(out?.text || '');
      if (out?.error) unreachable = true;
    } catch {
      unreachable = true;
    }
    if (unreachable) return { ok: false, status: 502, error: 'provider_unavailable', calls, message: 'Check did not finish. No new verdict was saved.' };
    if (getKey(slug, tested.id)?.secret !== tested.secret) return { ok: false, status: 409, error: 'key_changed', calls };
    const verdict = judge(scenario, reply, allow);
    results.push({ id: scenario.id, category: scenario.category, verdict: verdict.verdict, why: verdict.why });
  }

  const byCategory = {};
  for (const category of COMPAT_CATEGORIES) {
    const rows = results.filter((row) => row.category === category);
    if (!rows.length) continue;
    const worst = rows.some((row) => row.verdict === 'FAIL') ? 'FAIL' : rows.some((row) => row.verdict === 'WARN') ? 'WARN' : 'PASS';
    byCategory[category] = { status: worst, scenarios: rows.length, notes: rows.filter((r) => r.verdict !== 'PASS').slice(0, 2).map((r) => r.why) };
  }
  const status = Object.values(byCategory).some((c) => c.status === 'FAIL')
      ? 'FAIL'
      : Object.values(byCategory).some((c) => c.status === 'WARN')
        ? 'WARN'
        : 'PASS';

  const stamp = new Date(Number(now)).toISOString();
  const id = randomId(12);
  run(
    `INSERT INTO compatibility_runs (id, slug, provider, model, status, categories, scenarios, calls, consent_at, created_at, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, slug, chosen.provider, chosen.model, status, JSON.stringify(byCategory), scenarios.length, calls, stamp, stamp, JSON.stringify(results).slice(0, 4000)],
  );

  // A FAIL is a fact about this model *now*; it blocks it unless the owner
  // overrides, which requires an explicit flag on the model change.
  if (status === 'FAIL') {
    run('UPDATE tenants SET model_override = 0 WHERE slug = ? AND model = ?', [slug, `${chosen.provider}:${chosen.model}`]);
    notify({
      accountId: accountId || get('SELECT account_id FROM tenants WHERE slug = ?', [String(slug)])?.account_id,
      tenant: slug,
      kind: 'compatibility',
      title: 'The compatibility check found a problem',
      body: `Model ${chosen.model} failed the check. The assistant stays on it only if you explicitly override the warning.`,
    });
  }
  recordAudit({
    action: 'compatibility_run',
    accountId,
    tenant: slug,
    ip,
    detail: { provider: chosen.provider, model: chosen.model, status, scenarios: scenarios.length, calls },
  });

  return {
    ok: true,
    id,
    status,
    provider: chosen.provider,
    model: chosen.model,
    categories: byCategory,
    scenarios: results,
    calls,
    consentAt: stamp,
    blocked: status === 'FAIL',
    note:
      status === 'PASS'
        ? 'The model kept prices, language, scope and confirmations in check.'
        : status === 'WARN'
          ? 'It mostly works, with a warning worth reading before you go live.'
          : 'This model is blocked until you fix it or override the warning.',
  };
}

/**
 * Choose the model. Allowlisted only; a blocked model needs `override: true`,
 * and the answer says exactly what that means.
 */
export function setModel({ slug, provider, model, override = false, accountId = null, ip = null } = {}) {
  const info = providerInfo(provider);
  if (!info) return { ok: false, status: 400, error: 'unknown_provider', allowed: providerIds() };
  if (!isSupportedModel(info.id, model)) {
    return { ok: false, status: 400, error: 'model_not_supported', allowed: info.models.map((m) => m.id) };
  }
  if (!activeKeys(slug, info.id).length) return { ok: false, status: 409, error: 'no_key' };
  const last = latestRun(slug, info.id, model);
  const failed = last && last.status === 'FAIL';
  if (failed && override !== true) {
    return {
      ok: false,
      status: 409,
      error: 'compatibility_failed',
      message:
        'The compatibility check failed for this model. Pick another one, or send {"override": true} to use it anyway — ' +
        'it may invent prices or ignore confirmations.',
      lastRun: last,
    };
  }
  run_(slug, info.id, model, failed && override === true, accountId, ip);
  return { ok: true, provider: info.id, model, overridden: failed && override === true, restartRequired: true };
}

function run_(slug, provider, model, overridden, accountId, ip) {
  run('UPDATE tenants SET model = ?, model_override = ?, updated_at = ? WHERE slug = ?', [
    `${provider}:${model}`, overridden ? 1 : 0, new Date().toISOString(), slug,
  ]);
  recordAudit({
    action: 'model_changed',
    accountId,
    tenant: slug,
    ip,
    detail: { provider, model, override: !!overridden },
  });
}

/** Everything the key screen needs, in one answer (no key material). */
export function keyScreen(slug) {
  const health = healthFor(slug);
  return {
    keySource: health.keySource,
    providers: providerIds().map((id) => helpFor(id)),
    chain: health.chain,
    alerts: health.alerts,
    model: modelState(slug),
    usage: usagePerKey(slug),
    limits: { perProvider: MAX_KEYS_PER_PROVIDER, compatScenarios: MAX_COMPAT_SCENARIOS, compatCalls: MAX_COMPAT_CALLS },
  };
}

/**
 * Backups and exports. A key is never in an export unless the operator asked for
 * a *key* export on purpose (`--with-keys`, PLATFORM_ALLOW_KEY_EXPORT=1), and
 * even then it is plaintext only in the operator's own hands.
 */
export function exportKeys(slug, { withKeys = false, select = all } = {}) {
  const stored = select('SELECT * FROM tenant_keys WHERE slug = ? ORDER BY provider, slot', [String(slug)]);
  const rows = stored.map(publicKey);
  if (!withKeys) return { ok: true, keys: rows, withKeys: false, note: 'Key values are never part of an export. Use --with-keys to opt in.' };
  if (String(process.env.PLATFORM_ALLOW_KEY_EXPORT || '') !== '1') {
    return { ok: false, status: 403, error: 'key_export_disabled', message: 'Set PLATFORM_ALLOW_KEY_EXPORT=1 to include key values.' };
  }
  const values = [];
  for (const row of stored.filter((r) => r.status === 'active')) {
    const opened = decryptValue(row.secret, { aad: aadFor(slug, row.id, row.key_version) });
    if (!opened.ok) return { ok: false, error: 'cannot_decrypt' };
    values.push({ ...publicKey(row), key: opened.value });
  }
  return { ok: true, keys: values, withKeys: true, note: 'These are the real keys. Store this file like a password.' };
}

export default {
  MAX_KEYS_PER_PROVIDER,
  KEY_SOURCES,
  TEST_STATES,
  COMPAT_CATEGORIES,
  COMPAT_STATUSES,
  COMPAT_SCENARIOS,
  MAX_COMPAT_SCENARIOS,
  MAX_COMPAT_CALLS,
  publicKey,
  listKeys,
  activeKeys,
  getKey,
  primaryProvider,
  keySourceFor,
  setKeySource,
  addKey,
  replaceKey,
  revokeKey,
  testKey,
  deliveryEnv,
  deliverKeysAtStart,
  healthFor,
  usagePerKey,
  modelFor,
  modelState,
  latestRun,
  runCompatibility,
  setModel,
  keyScreen,
  exportKeys,
  priceAllowlist,
  setKeyHooks,
  resetKeyHooks,
};
