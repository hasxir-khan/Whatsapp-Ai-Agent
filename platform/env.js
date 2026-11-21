// platform/env.js
// Settings for the customer platform. Read at call time, never captured at
// import time, so a test (or a host that injects env late) always sees the
// current answer.
//
// The platform is a *separate layer*: it never replaces a bot module, it calls
// the ones that already exist. With PLATFORM_ENABLED unset the routes answer
// 404 and the bot behaves exactly as it did before this folder existed.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config/env.js';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Is the control plane switched on? Off unless PLATFORM_ENABLED says otherwise. */
export function platformEnabled() {
  return TRUTHY.has(String(process.env.PLATFORM_ENABLED || '').trim().toLowerCase());
}

export const billingEnabled = () =>
  platformEnabled() && TRUTHY.has(String(process.env.PLATFORM_BILLING || '').toLowerCase());

export const dashboardEnabled = () =>
  platformEnabled() && TRUTHY.has(String(process.env.PLATFORM_DASHBOARD || '').toLowerCase());

/**
 * Where the platform keeps its own state. Deliberately outside every tenant
 * folder: the platform database must never be reachable from a bot process.
 */
export function platformDir() {
  return path.resolve(process.env.PLATFORM_DIR || path.join(config.root, 'platform', 'data'));
}

export function platformDbFile() {
  return path.join(platformDir(), 'platform.db');
}

/**
 * The secret every platform session, one-time code and CSRF value is signed
 * with. Without it the platform refuses to serve anything private — the same
 * rule the admin panel applies to ADMIN_TOKEN.
 */
export function platformSecret() {
  return String(process.env.PLATFORM_SECRET || '').trim();
}

/** On but unusable: a clear message beats an open door. */
export function platformMisconfigured() {
  return platformEnabled() && (!platformSecret() || !!transportProblem());
}

export function platformPort() {
  return Number(process.env.PLATFORM_PORT) || 3200;
}

/** Public origin used in links and Cloud API webhook URLs. */
export function platformPublicUrl() {
  return String(process.env.PLATFORM_PUBLIC_URL || '').replace(/\/$/, '');
}

/** TLS can terminate at the host proxy. Trust the operator's public URL, not
 * the request Host or forwarded protocol supplied by an Internet client. */
export function secureOrigin() {
  try { return new URL(platformPublicUrl()).protocol === 'https:'; } catch { return false; }
}
export function transportProblem() {
  if (process.env.NODE_ENV?.toLowerCase() !== 'production' || secureOrigin() || process.env.PLATFORM_ALLOW_HTTP === '1') return null;
  return 'Production requires an https PLATFORM_PUBLIC_URL. Only set PLATFORM_ALLOW_HTTP=1 for an explicitly insecure deployment.';
}

export function sessionMinutes() {
  return Math.max(5, Number(process.env.PLATFORM_SESSION_MINUTES) || 720);
}

/** How long a signup/reset code lives, and how many guesses it allows. */
export const OTP = {
  minutes: Math.max(1, Number(process.env.PLATFORM_OTP_MINUTES) || 10),
  maxAttempts: Math.max(1, Number(process.env.PLATFORM_OTP_ATTEMPTS) || 5),
  digits: 6,
};

/** Terms/privacy versions. Bumping one asks every account to accept it again. */
export const CONSENT = {
  terms: String(process.env.PLATFORM_TERMS_VERSION || '2026-01'),
  privacy: String(process.env.PLATFORM_PRIVACY_VERSION || '2026-01'),
};

/** Trial length when a plan does not override it. */
export function trialDays() {
  const n = Number(process.env.PLATFORM_TRIAL_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : 14;
}

/** Optional extra guard on signup: disposable mail domains. */
export function blockDisposableDomains() {
  return TRUTHY.has(String(process.env.PLATFORM_BLOCK_DISPOSABLE || '').toLowerCase());
}

export function ensurePlatformDir() {
  const dir = platformDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort on filesystems without modes */
  }
  return dir;
}

/** The `_help` block from owner.example.json: the wizard's "fill in your own". */
export function helpTexts() {
  const file = path.join(config.root, 'config', 'owner.example.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed?._help || {};
  } catch {
    return {};
  }
}

export default {
  platformEnabled,
  platformDir,
  platformDbFile,
  platformSecret,
  platformMisconfigured,
  platformPort,
  platformPublicUrl,
  sessionMinutes,
  OTP,
  CONSENT,
  trialDays,
  blockDisposableDomains,
  ensurePlatformDir,
  helpTexts,
};
