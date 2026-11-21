// src/services/keyChain.js
// Which AI key answers, and what happens when one stops working.
//
// A tenant may hold up to three keys per provider (primary, backup, backup).
// They all arrive the same way — environment variables, in order:
//
//   GROQ_API_KEY, GROQ_API_KEY_2, GROQ_API_KEY_3
//   GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3
//   OPENROUTER_API_KEY, OPENROUTER_API_KEY_2, OPENROUTER_API_KEY_3
//
// The platform writes them into the *process environment* when it starts a
// tenant (never into a file), which is why this module reads `process.env` at
// call time and nothing else.
//
// Two rules make this useful rather than decorative:
//   • a key that is wrong stays out of the rotation (401/403), because retrying
//     it burns a customer's turn and teaches nobody anything;
//   • a key that is merely tired (429, 5xx, a timeout) is cooled down for a
//     while and then tried again — no health pings, no synthetic calls, just
//     what real traffic already told us.
//
// `LLM_KEY_SOURCE=platform` is the one setting this module refuses: the
// platform-managed key pool does not exist yet, and pretending it does would
// take a working assistant offline with a confusing error.

import { config } from '../config/env.js';

export const PROVIDERS = ['groq', 'gemini', 'openrouter'];
export const KEY_SLOTS = 3;

const ENV_NAME = {
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/** Where the key for `provider`, slot 1–3, lives. */
export function envNameFor(provider, slot = 1) {
  const base = ENV_NAME[provider];
  if (!base) return null;
  return slot <= 1 ? base : `${base}_${slot}`;
}

/** Slots a provider could hold, whether or not they are filled. */
export function slotNames(provider) {
  return Array.from({ length: KEY_SLOTS }, (_, i) => envNameFor(provider, i + 1)).filter(Boolean);
}

/**
 * `tenant` (the customer's own keys — the only option today) or `platform`
 * (a stub that refuses). Read from the tenant profile first, so a customer can
 * change it without a deploy, with the env var as the platform's override.
 */
export function keySource() {
  const fromEnv = String(process.env.LLM_KEY_SOURCE || '').trim().toLowerCase();
  if (fromEnv) return fromEnv;
  try {
    // The merged owner.json (config.owner.profile) is the tenant's own config,
    // so a customer can switch this without a deploy.
    const fromProfile = String(config.owner?.profile?.llm?.keySource || '').trim().toLowerCase();
    if (fromProfile) return fromProfile;
  } catch {
    /* no profile loaded is not an error here */
  }
  return 'tenant';
}

export class PlatformKeysUnavailable extends Error {
  constructor() {
    super('platform_key_source_unavailable');
    this.name = 'PlatformKeysUnavailable';
    this.code = 'platform_keys_unavailable';
    this.messageForOwner =
      'This assistant is set to use keys managed by the platform, and the platform does not offer that yet. ' +
      'Add your own key (Settings → AI keys), or set llm.keySource back to "tenant".';
  }
}

/** Throw the clear refusal instead of answering with "No AI provider configured". */
export function assertKeySource() {
  if (keySource() === 'platform') throw new PlatformKeysUnavailable();
}

// ── health ───────────────────────────────────────────────────
/**
 * What a key is doing right now:
 *   active       — answered recently, or never tried
 *   rate_limited — 429; skipped until the retry-after window passes
 *   quota        — the provider says this key's allowance is gone (402/403 quota)
 *   failing      — 5xx or a timeout; skipped for a short while, then tried again
 *   invalid      — 401/403 key rejection; never tried again in this process
 */
export const KEY_STATES = ['active', 'rate_limited', 'quota', 'failing', 'invalid'];

const COOLDOWN = {
  rate_limited: 60000,
  quota: 15 * 60000,
  failing: 30000,
};

/** provider → slot → {state, at, until, reason} */
const health = new Map();
/** provider → slot → ISO time of the last successful call with that key. */
const lastOk = new Map();

function bucket(provider) {
  if (!health.has(provider)) health.set(provider, new Map());
  return health.get(provider);
}

export function note(provider, slot, state, { reason = null, retryAfterMs = null, now = Date.now() } = {}) {
  if (!ENV_NAME[provider]) return null;
  const at = new Date(Number(now)).toISOString();
  if (state === 'active') {
    bucket(provider).delete(slot);
    if (!lastOk.has(provider)) lastOk.set(provider, new Map());
    lastOk.get(provider).set(slot, at);
    return { state, at, until: null, reason: null };
  }
  // `invalid` has no cooldown: a rejected key is not "try again in a minute",
  // it is "stop using this one". The state itself is what excludes it.
  const base = COOLDOWN[state];
  const until = state === 'invalid'
    ? null
    : Number(now) + (retryAfterMs != null ? Number(retryAfterMs) : base ?? COOLDOWN.failing);
  const entry = { state, at, until, reason: reason ? String(reason).slice(0, 120) : null };
  bucket(provider).set(slot, entry);
  return entry;
}

/** Forget everything this process learned. */
export function __resetKeyChain() {
  health.clear();
  lastOk.clear();
}

function isHealthy(entry, now) {
  if (!entry) return true;
  if (entry.state === 'invalid') return false;
  return entry.until === null || Number(now) >= Number(entry.until);
}

/**
 * One key's value.
 *
 * Slot 1 falls back to `config.keys.<provider>` because that is the in-process
 * truth the rest of the bot already uses (`GOOGLE_API_KEY` counts as a Gemini
 * key there, and the offline mock installs keys by assigning to it). Slots 2–3
 * only ever come from the environment, which is where the platform puts them.
 */
function valueFor(provider, slot, env) {
  const name = envNameFor(provider, slot);
  const fromEnv = String(env?.[name] || '').trim();
  if (fromEnv) return fromEnv;
  if (slot === 1) return String(config?.keys?.[provider] || '').trim();
  return '';
}

/** Filled slots, ignoring health. Routing asks this; calling asks `availableKeys`. */
export function configuredKeys(provider, { env = process.env } = {}) {
  const out = [];
  for (let slot = 1; slot <= KEY_SLOTS; slot += 1) {
    const value = valueFor(provider, slot, env);
    if (value) out.push({ slot, name: envNameFor(provider, slot), key: value });
  }
  return out;
}

/**
 * The keys a provider may be called with, best first.
 *
 * A key that is cooling down (429/quota/5xx) or was rejected (401/403) is
 * skipped **only when another key can take its turn**. With a single key —
 * which is what most tenants have — the only key is still tried, because
 * refusing to call it would turn one rate limit into a minute of silence. A
 * tenant with a backup gets the strict behaviour: the bad key is not touched
 * again until it is replaced or its cooldown passes.
 */
export function availableKeys(provider, { env = process.env, now = Date.now() } = {}) {
  const all = configuredKeys(provider, { env });
  const map = health.get(provider) || new Map();
  const healthy = all.filter((entry) => isHealthy(map.get(entry.slot), now));
  if (!healthy.length) return all.length === 1 ? all : []; // don't re-dial an entire rejected/cooling chain
  // Slot order *is* the owner's order: primary, then backups. Anything still
  // cooling was already dropped above, so this cannot put a tired key first.
  return healthy.sort((a, b) => a.slot - b.slot);
}

/** Every key a provider has, with what we know about it — the dashboard's view. */
export function keyStatus(provider, { env = process.env, now = Date.now() } = {}) {
  const map = health.get(provider) || new Map();
  return configuredKeys(provider, { env }).map(({ slot, key: value }) => {
    const entry = map.get(slot) || null;
    // `until` is a Date-safe value or null: "never" is expressed by the state,
    // never by an Infinity that would blow up a toISOString().
    const until = entry?.until != null && Number.isFinite(Number(entry.until)) ? new Date(Number(entry.until)).toISOString() : null;
    const cooling = entry && !isHealthy(entry, now);
    return {
      slot,
      state: cooling ? entry.state : 'active',
      since: entry?.at || null,
      until: cooling ? until : null,
      reason: cooling ? entry.reason : null,
      lastOkAt: lastOk.get(provider)?.get(slot) || null,
      last4: String(value).slice(-4),
    };
  });
}

export function healthSnapshot({ env = process.env, now = Date.now() } = {}) {
  const out = {};
  for (const provider of PROVIDERS) {
    const rows = keyStatus(provider, { env, now });
    if (rows.length) out[provider] = rows;
  }
  return out;
}

export function hasAnyKey({ env = process.env } = {}) {
  return PROVIDERS.some((p) => configuredKeys(p, { env }).length > 0);
}

/**
 * Turn a provider error into a category a human can act on. Everything that is
 * not about the key returns null, so the model-fallback logic stays in charge
 * of those.
 */
export function classifyError(err) {
  if (!err) return null;
  const status = Number(err.status) || 0;
  const body = String(err.body || err.message || '');
  if (err.keyInvalid || status === 401) return 'invalid';
  if (status === 402) return 'quota';
  if (status === 403) {
    // 403 is either "this key may not use that model" (a model problem) or
    // "this key's allowance is gone" (a key problem).
    if (/quota|exceeded|billing|credit/i.test(body)) return 'quota';
    return /permission|not (allowed|authorized)|forbidden|invalid api key|api key not valid|unauthenticated/i.test(body)
      ? 'invalid'
      : null;
  }
  if (status === 429) {
    return /quota|exceeded your current|daily limit|billing|credit/i.test(body) ? 'quota' : 'rate_limited';
  }
  if (status >= 500) return 'failing';
  if (!status && (/timeout|aborted|ECONN|ENOTFOUND|fetch failed|network/i.test(body) || err.name === 'TimeoutError')) {
    return 'failing';
  }
  return null;
}

/** One line the owner can act on. */
export function adviceFor(state) {
  if (state === 'invalid') return 'The key was rejected. Replace it — a backup answers meanwhile.';
  if (state === 'quota') return 'This key is out of allowance until the provider resets it.';
  if (state === 'rate_limited') return 'The provider is rate limiting this key; it cools down on its own.';
  if (state === 'failing') return 'The provider answered with an error. It is retried after a short pause.';
  return 'Working.';
}

export default {
  PROVIDERS,
  KEY_SLOTS,
  KEY_STATES,
  envNameFor,
  slotNames,
  keySource,
  assertKeySource,
  PlatformKeysUnavailable,
  availableKeys,
  configuredKeys,
  keyStatus,
  healthSnapshot,
  hasAnyKey,
  classifyError,
  note,
  adviceFor,
  __resetKeyChain,
};
