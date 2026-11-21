// platform/plans.js
// Plans are entitlements, not billing. There is no payment code in this folder
// and `price` is a label the owner edits by hand.
//
// What a plan actually does, and where:
//   • `llm_calls_day` → `TENANT_DAILY_LLM_CALLS` in the tenant's .env. The bot
//     already compares that number with today's usage and, when it is reached,
//     answers the customer politely and waits (src/core/brain.js
//     fallbackReply). The plan moves the ceiling; it does not add a second one.
//   • premium feature flags → `features.*` in the tenant's owner.json. Core
//     features are left alone: a free tenant must still be a working bot.
//   • `voice_minutes: 0` → `VOICE_REPLY_MODE=off`, the switch the bot already
//     reads for voice replies.
//   • trial expiry → the tenant is *paused* (process stopped, status recorded),
//     never deleted, and the owner is told on the platform.
//
// `conversations_month`, `agents` and `numbers` are checked where a change is
// requested (wizard step, extra number, extra agent) so an account cannot step
// over its plan silently.

import {retention} from '../src/services/reportContract.js';
import { run, get, all } from './db.js';
import { PLAN_SEEDS } from './schema.js';
import { trialDays } from './env.js';
import { readTenantEnv, writeTenantEnvValue, readTenantProfile, writeTenantProfile } from '../src/services/adminPanel.js';
import { recordAudit, notify } from './audit.js';

/**
 * The flags a plan may take away. Everything else is core: turning it off for a
 * cheap plan would break a bot the customer is already using.
 */
export const PREMIUM_FEATURES = new Set([
  'bookingAgent', 'followUpAgent', 'growthApproval', 'analystAgent', 'closerAgent',
  'reviewAgent', 'reactivationAgent', 'contentAgent', 'visualSearch', 'pdfInvoices',
  'selfHealing', 'multiAgent', 'marketingAgents', 'businessBrain', 'reasoning',
  'sourceLinks', 'mcpTools', 'mcpWriteTools', 'cloudApi', 'liveInbox', 'conversationControl',
]);

const CONVERSATION_LIMIT_KEY = 'conversations_month';

export function seedPlans() {
  for (const seed of PLAN_SEEDS) {
    const existing = get('SELECT id FROM plans WHERE id = ?', [seed.id]);
    if (existing) continue;
    run('INSERT INTO plans (id, name, trial_days, price, limits, features, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      seed.id,
      seed.name,
      seed.trial_days,
      seed.price,
      JSON.stringify(seed.limits),
      JSON.stringify(seed.features),
      new Date().toISOString(),
    ]);
  }
  return listPlans().length;
}

export function listPlans() {
  return all('SELECT * FROM plans ORDER BY price ASC, id ASC').map(hydrate);
}

function hydrate(row) {
  if (!row) return null;
  let limits = {};
  let features = [];
  try {
    limits = JSON.parse(row.limits || '{}');
  } catch {
    limits = {};
  }
  try {
    features = JSON.parse(row.features || '[]');
  } catch {
    features = [];
  }
  // Older/customised rows keep their overrides. Unknown plans grant no clips.
  limits.videos_month ??= PLAN_SEEDS.find((seed) => seed.id === row.id)?.limits.videos_month ?? 0;
  limits.dashboard_days = retention({ id: row.id, limits });
  return { ...row, limits, features, trial_days: Number(row.trial_days) || 0, price: Number(row.price) || 0 };
}

export function getPlan(id) {
  return hydrate(get('SELECT * FROM plans WHERE id = ?', [String(id || '')]));
}

export function defaultPlan() {
  return getPlan('free') || listPlans()[0] || null;
}

/** The plan a tenant is on, with the plan row's usable shape. */
export function planForTenant(slug) {
  const tenant = get('SELECT * FROM tenants WHERE slug = ?', [String(slug)]);
  if (!tenant) return null;
  return { tenant, plan: getPlan(tenant.plan_id) || defaultPlan() };
}

/**
 * Write a plan's entitlements into the tenant's own config.
 * Only the keys the plan is responsible for are touched — an owner's own
 * settings (keys, tone, catalog) are never rewritten here.
 */
export function applyEntitlements(slug, planId = null) {
  const row = get('SELECT * FROM tenants WHERE slug = ?', [String(slug)]);
  if (!row) return { ok: false, error: 'no_tenant' };
  const plan = getPlan(planId || row.plan_id) || defaultPlan();
  if (!plan) return { ok: false, error: 'no_plan' };

  const changed = { env: [], features: [] };
  const current = readTenantEnv(slug);
  const writes = {
    PLAN_ID: plan.id,
    TENANT_REPORT_DAYS: String(retention(plan)),
    TENANT_DAILY_LLM_CALLS: String(plan.limits.llm_calls_day || 0),
    TENANT_MAX_CONVERSATIONS: String(plan.limits[CONVERSATION_LIMIT_KEY] || 0),
    TENANT_MAX_AGENTS: String(plan.limits.agents || 0),
    TENANT_MAX_NUMBERS: String(plan.limits.numbers || 0),
    TENANT_VIDEOS_MONTH: String(plan.limits.videos_month || 0),
    TENANT_VOICE_MINUTES: String(plan.limits.voice_minutes || 0),
  };
  // No voice allowance means no voice replies: an existing switch, not a new
  // one. The marker is what lets a later upgrade put the switch back without
  // overruling an owner who chose "off" themselves.
  if (!plan.limits.voice_minutes) {
    writes.VOICE_REPLY_MODE = 'off';
    writes.TENANT_VOICE_FORCED = '1';
  } else if (current.VOICE_REPLY_MODE === 'off' && current.TENANT_VOICE_FORCED === '1') {
    writes.VOICE_REPLY_MODE = 'match_voice';
    writes.TENANT_VOICE_FORCED = '';
  }

  for (const [key, value] of Object.entries(writes)) {
    if (current[key] === value) continue;
    try {
      writeTenantEnvValue(slug, key, value);
    } catch {
      // A tenant with no .env on this machine cannot take entitlements. That is a
      // provisioning problem to report, not an exception to throw at a request.
      return { ok: false, error: 'tenant_files_unavailable', key };
    }
    changed.env.push(key);
  }

  // Premium flags: exactly the plan's allowlist, applied to premium keys only.
  const allowed = new Set(plan.features);
  let profile = null;
  try {
    profile = readTenantProfile(slug);
  } catch {
    profile = null;
  }
  if (profile && typeof profile === 'object') {
    profile.features = profile.features && typeof profile.features === 'object' ? profile.features : {};
    let dirty = false;
    const want = {};
    for (const key of PREMIUM_FEATURES) {
      const value = allowed.has(key);
      if (profile.features[key] !== value) {
        want[key] = value;
        dirty = true;
      }
    }
    if (dirty) {
      Object.assign(profile.features, want);
      const written = writeTenantProfile(slug, profile);
      if (written.ok) changed.features = Object.keys(want);
      else return { ok: false, error: 'profile_rejected', errors: written.errors };
    }
  }

  run('UPDATE tenants SET plan_id = ?, updated_at = ? WHERE slug = ?', [plan.id, new Date().toISOString(), slug]);
  return { ok: true, plan: plan.id, changed };
}

/** Assign a plan by hand (admin panel, support, a paid upgrade later). */
export function assignPlan({ slug, planId, accountId = null, ip = null, now = Date.now(), extendTrial = false }) {
  const plan = getPlan(planId);
  if (!plan) return { ok: false, error: 'unknown_plan', plans: listPlans().map((p) => p.id) };
  const tenant = get('SELECT * FROM tenants WHERE slug = ?', [String(slug)]);
  if (!tenant) return { ok: false, error: 'no_tenant' };

  const applied = applyEntitlements(slug, plan.id);
  if (!applied.ok) return applied;

  const fields = { plan_id: plan.id, updated_at: new Date().toISOString() };
  if (extendTrial || tenant.status === 'draft') {
    const days = Number(plan.trial_days) || trialDays();
    fields.trial_ends_at = new Date(Number(now) + days * 86400000).toISOString();
  }
  // A paused tenant whose plan is restored is allowed to run again; whether the
  // process starts is the supervisor's business, not this function's.
  if (tenant.status === 'paused' && tenant.paused_reason === 'trial_expired' && (plan.id !== 'free' || extendTrial)) {
    fields.status = 'provisioned'; // an upgrade unlocks Go live; it does not bypass readiness
    fields.paused_reason = null;
  }
  run('UPDATE tenants SET plan_id = ?, trial_ends_at = ?, status = COALESCE(?, status), paused_reason = ?, updated_at = ? WHERE slug = ?', [
    fields.plan_id, fields.trial_ends_at || (plan.id !== 'free' ? null : tenant.trial_ends_at), fields.status || null, fields.status === 'provisioned' ? null : tenant.paused_reason, fields.updated_at, slug,
  ]);

  recordAudit({
    action: 'plan_assigned',
    accountId: accountId || tenant.account_id,
    tenant: slug,
    detail: { plan: plan.id, before: tenant.plan_id },
    ip,
  });
  notify({
    accountId: accountId || tenant.account_id,
    tenant: slug,
    kind: 'plan',
    title: `Plan: ${plan.name}`,
    body: `Your assistant is on the ${plan.name} plan.`,
  });
  return { ok: true, plan: plan.id, changed: applied.changed };
}

/** Start (or skip) a trial for a freshly provisioned tenant. */
export function startTrial({ slug, accountId, number = null, now = Date.now(), trialing = true }) {
  const plan = defaultPlan();
  const days = Number(plan?.trial_days) || trialDays();
  const ends = trialing ? new Date(Number(now) + days * 86400000).toISOString() : null;
  run('UPDATE tenants SET plan_id = ?, trial_ends_at = ?, updated_at = ? WHERE slug = ?', [
    plan?.id || 'free', ends, new Date().toISOString(), slug,
  ]);
  applyEntitlements(slug, plan?.id || 'free');
  if (!trialing) {
    notify({
      accountId,
     tenant: slug,
      kind: 'plan',
      title: 'No free trial on this number',
      body: 'This WhatsApp number has already used a free trial, so the assistant starts on the free plan limits.',
    });
  }
  return { ok: true, plan: plan?.id || 'free', trialEndsAt: ends, trialing };
}

// ── limits, checked where a change is requested ─────────────
/**
 * Would `request` fit in the tenant's plan? Returns `{ok, reason, limit, used}`
 * so the caller can say what the ceiling is instead of "not allowed".
 */
export function checkEntitlement(slug, what, { used = 0, add = 1 } = {}) {
  const found = planForTenant(slug);
  if (!found) return { ok: false, reason: 'no_tenant' };
  const { plan } = found;
  const map = {
    agents: plan.limits.agents,
    numbers: plan.limits.numbers,
    conversations: plan.limits[CONVERSATION_LIMIT_KEY],
  };
  const limit = map[what];
  if (limit === undefined) return { ok: false, reason: 'unknown_entitlement', what };
  if (!limit) return { ok: true, unlimited: true, limit };
  const total = Number(used) + Number(add);
  return { ok: total <= limit, limit, used: Number(used), requested: total };
}

/** A plan whose allowance has run out for this month, if any. */
export function monthlyAllowanceLeft(slug, conversationsThisMonth = null) {
  const found = planForTenant(slug);
  if (!found) return null;
  if (conversationsThisMonth === null) return null;
  const limit = found.plan.limits[CONVERSATION_LIMIT_KEY] || 0;
  if (!limit) return { limit: 0, used: conversationsThisMonth, left: null };
  return { limit, used: conversationsThisMonth, left: Math.max(0, limit - conversationsThisMonth) };
}

// ── trial expiry: pause, never delete ───────────────────────
/**
 * Process control is injected: the platform calls the supervisor the admin panel
 * already uses, and a test can replace it without spawning a bot.
 */
export const planHooks = {
  stop: null,
  start: null,
};

export function setPlanHooks(next = {}) {
  if (typeof next.stop === 'function') planHooks.stop = next.stop;
  if (typeof next.start === 'function') planHooks.start = next.start;
  return planHooks;
}

export function resetPlanHooks() {
  planHooks.stop = null;
  planHooks.start = null;
}

async function stopTenantProcess(slug) {
  if (planHooks.stop) return planHooks.stop(slug);
  const admin = await import('../src/services/adminPanel.js');
  return admin.adminHooks.stop(slug);
}

/**
 * Pause every tenant whose trial has run out. Idempotent: a tenant already
 * paused is skipped, and the row stays for the owner to upgrade.
 */
export async function expireTrials({ now = Date.now(), stop = null } = {}) {
  const expired = all(
    "SELECT * FROM tenants WHERE trial_ends_at IS NOT NULL AND trial_ends_at <= ? AND status IN ('active','draft','provisioned')",
    [new Date(Number(now)).toISOString()],
  );
  const paused = [];
  const { withWorker } = await import('./keys.js');
  for (const candidate of expired) await withWorker(candidate.slug, async () => {
    const tenant = get('SELECT * FROM tenants WHERE slug = ?', [candidate.slug]);
    if (!tenant || tenant.status === 'paused' || !(Date.parse(tenant.trial_ends_at) <= now)) return;
    const stopFn = stop || stopTenantProcess;
    let stopped;
    try { stopped = (await stopFn(tenant.slug))?.ok !== false; } catch { stopped = false; }
    if (!stopped) { recordAudit({ action: 'trial_stop_failed', tenant: tenant.slug, ok: false }); return; }
    run('UPDATE tenants SET status = ?, paused_reason = ?, updated_at = ? WHERE slug = ?', [
      'paused', 'trial_expired', new Date(Number(now)).toISOString(), tenant.slug,
    ]);
    // The bot is off, so the message is on the platform — and the audit trail
    // says exactly what happened, when, and why.
    notify({
      accountId: tenant.account_id,
      tenant: tenant.slug,
      kind: 'trial_expired',
      title: 'Your trial has ended — your assistant is paused',
      body:
        'Nothing was deleted. Messages are still stored and the settings are intact. ' +
        'Pick a plan to switch the assistant back on.',
    });
    recordAudit({
      action: 'trial_expired',
      accountId: tenant.account_id,
      tenant: tenant.slug,
      detail: { stopped, plan: tenant.plan_id },
    });
    paused.push({ slug: tenant.slug, stopped });
  });
  return { paused, checked: expired.length };
}

export default {
  seedPlans,
  listPlans,
  getPlan,
  defaultPlan,
  planForTenant,
  applyEntitlements,
  assignPlan,
  startTrial,
  checkEntitlement,
  monthlyAllowanceLeft,
  expireTrials,
  setPlanHooks,
  resetPlanHooks,
  PREMIUM_FEATURES,
};
