import { billingEnabled } from './env.js';
import { initCatalog } from './billing/catalog.js';
import { accountCapacity, openSubscription, subscription, warnLimit } from './billing/subscriptions.js';
import { eraseBilling } from './billing/privacy.js';
// platform/provisioning.js
// Turning "a customer signed up" into "a working assistant", one recorded step
// at a time.
//
// The platform does not know how a tenant is laid out: `createTenant()` from
// scripts/tenant.js does, and it is called as-is. What the platform adds is the
// bookkeeping around it — which account owns the folder, which step last
// succeeded, and what to try again after a failure.
//
// Rules:
//   • every step is idempotent; running provisioning twice must not create a
//     second tenant, a second set of secrets, or a second profile;
//   • a failure leaves `status='failed'` and the failing step's number, so the
//     retry starts where the last attempt stopped;
//   • secrets are generated here, written 0600 into the tenant's .env, stored
//     server-side, and returned to the caller exactly once;
//   • one WhatsApp number belongs to one tenant, always.

import { numberId } from './numberIdentity.js';
import crypto from 'node:crypto';
import { get, all, run, transaction, billingTransaction } from './db.js';
import { recordAudit, notify } from './audit.js';
import { applyEntitlements, startTrial, defaultPlan } from './plans.js';
import { validSlug as validateSlug } from '../src/services/validation.js';

const STEPS = ['allocate', 'create', 'secrets', 'profile', 'entitlements', 'finalise'];
export const PROVISION_STEPS = STEPS;

/** Where the work happens. Tests replace `create` and `writeProfile`. */
export const provisionHooks = {
  create: null, // async ({slug, name, number, template, port}) => {slug, dir, port}
  readProfile: null,
  writeProfile: null,
  signupProfile: null,
};

export function setProvisionHooks(next = {}) {
  for (const key of Object.keys(provisionHooks)) {
    if (typeof next[key] === 'function') provisionHooks[key] = next[key];
  }
  return provisionHooks;
}

export function resetProvisionHooks() {
  for (const key of Object.keys(provisionHooks)) provisionHooks[key] = null;
}

async function admin() {
  return import('../src/services/adminPanel.js');
}

function normaliseNumber(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  return digits;
}

/** `My Café!` → `my-cafe`; collisions get `-2`, `-3`. */
export function allocateSlug(name, { taken = [] } = {}) {
  const base =
    String(name || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'assistant';
  const used = new Set([...taken.map((s) => String(s)), ...all('SELECT slug FROM tenants').map((r) => r.slug)]);
  let candidate = base;
  let n = 2;
  while (used.has(candidate) || !validateSlug(candidate)) {
    const suffix = `-${n}`;
    candidate = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    n += 1;
    if (n > 500) return { ok: false, error: 'slug_exhausted' };
  }
  return { ok: true, slug: candidate };
}

/** Which tenant (if any) already claims this WhatsApp number. */
export const businessNumberId = (digits) => numberId(digits, get('SELECT salt FROM number_identity_salt').salt);

export function numberOwner(number, { ignoreSlug = null } = {}) {
  const digits = normaliseNumber(number);
  if (!digits) return null;
  const row = get('SELECT slug, account_id, status FROM tenants WHERE number = ?', [businessNumberId(digits)]);
  if (row && row.slug !== ignoreSlug) return row;
  return null;
}

function secret(bits = 32) {
  return crypto.randomBytes(bits).toString('base64url');
}

export function getTenantSecret(slug, name) {
  const row = get('SELECT value FROM tenant_secrets WHERE slug = ? AND name = ?', [String(slug), String(name)]);
  return row?.value || null;
}

export function listTenantSecrets(slug) {
  return all('SELECT name, created_at FROM tenant_secrets WHERE slug = ?', [String(slug)]);
}

function storeSecret(slug, name, value, now) {
  const existing = get('SELECT value FROM tenant_secrets WHERE slug = ? AND name = ?', [slug, name]);
  if (existing) return null; // never rotate behind the owner's back
  run('INSERT INTO tenant_secrets (slug, name, value, created_at) VALUES (?, ?, ?, ?)', [
    slug,
    name,
    value,
    new Date(now).toISOString(),
  ]);
  return value;
}

export function getTenant(slug) {
  return get('SELECT * FROM tenants WHERE slug = ?', [String(slug)]) || null;
}

/** Every tenant an account may see, with the role that grants it. */
export function tenantsForAccount(accountId, { role = null } = {}) {
  const rows = all(
    `SELECT t.*, m.role AS member_role FROM tenants t
     JOIN memberships m ON m.slug = t.slug
     WHERE m.account_id = ? ORDER BY t.created_at ASC`,
    [String(accountId)]
  );
  return role ? rows.filter((row) => row.member_role === role) : rows;
}

/** A tenant the caller may read — or null. This is the only door ACL uses. */
export function tenantForAccount(accountId, slug) {
  const row = get(
    `SELECT t.*, m.role AS member_role FROM tenants t
     JOIN memberships m ON m.slug = t.slug
     WHERE m.account_id = ? AND t.slug = ?`,
    [String(accountId), String(slug)]
  );
  return row || null;
}

export function isTenantOwner(accountId, slug) {
  return tenantForAccount(accountId, slug)?.member_role === 'owner';
}

function setProgress(slug, { status, step, error = null, extra = {} }) {
  const fields = { status, provision_step: step, provision_error: error, updated_at: new Date().toISOString() };
  const sets = ['status = ?', 'provision_step = ?', 'provision_error = ?', 'updated_at = ?'];
  const params = [fields.status, fields.provision_step, fields.provision_error, fields.updated_at];
  for (const [key, value] of Object.entries(extra)) {
    sets.push(`${key} = ?`);
    params.push(value);
  }
  params.push(slug);
  run(`UPDATE tenants SET ${sets.join(', ')} WHERE slug = ?`, params);
}

/**
 * Create the tenant record (step 0). Safe to call twice: the second call returns
 * the row that already exists.
 */
export function beginProvisioning({ accountId, slug, name, number, template = null, planId = null, now = Date.now() }) {
  const existing = getTenant(slug);
  if (existing) return { ok: true, tenant: existing, created: false };
  const stamp = new Date(Number(now)).toISOString();
  transaction(() => {
    run(
      `INSERT INTO tenants (slug, account_id, name, number, plan_id, status, provision_step, template, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'provisioning', 0, ?, ?, ?)`,
      [slug, accountId, name, businessNumberId(number), planId, template, stamp, stamp]
    );
    run('INSERT INTO memberships (account_id, slug, role, created_at) VALUES (?, ?, ?, ?)', [
      accountId,
      slug,
      'owner',
      stamp,
    ]);
  });
  return { ok: true, tenant: getTenant(slug), created: true };
}

/**
 * Run every step that has not succeeded yet.
 * `resume` is the same function: a failed tenant is retried by calling this again.
 */
export async function provisionTenant({
  accountId,
  name,
  number,
  template = null,
  planId = null,
  city = '',
  languages = null,
  hours = '',
  currency = 'PKR',
  slug: wantedSlug = null,
  profileDraft = null,
  ip = null,
  now = Date.now(),
} = {}) {
  if (/[\r\n\x00]/.test(name)) return { ok: false, error: 'invalid_business_name' };
  const digits = normaliseNumber(number);
  if (!/^\d{10,15}$/.test(digits)) {
    return { ok: false, error: 'bad_number', message: 'A WhatsApp number needs 10–15 digits, international format.' };
  }
  const conflict = numberOwner(digits, { ignoreSlug: wantedSlug || null });
  if (conflict) {
    return {
      ok: false,
      error: 'number_in_use',
      message: 'That WhatsApp number already belongs to another assistant on this platform.',
    };
  }

  let slug = wantedSlug;
  if (!slug) {
    const allocated = allocateSlug(name);
    if (!allocated.ok) return allocated;
    slug = allocated.slug;
  }
  if (!validateSlug(slug)) return { ok: false, error: 'bad_slug' };

  if (billingEnabled() && !getTenant(slug)) {
    initCatalog(now);
    const cap = accountCapacity(accountId);
    if (cap.used >= Math.min(cap.tenants, cap.numbers)) {
      const first = get('SELECT slug FROM tenants WHERE account_id=? ORDER BY created_at LIMIT 1', [accountId]);
      if (first) warnLimit(first.slug, 'numbers');
      return { ok: false, error: 'plan_limit', status: 409 };
    }
  }
  const begun = beginProvisioning({ accountId, slug, name, number: digits, template, now });
  if (!begun.ok) return begun;
  const tenant = begun.tenant;
  if (tenant.account_id !== accountId) return { ok: false, error: 'slug_taken' };
  if (tenant.number !== businessNumberId(digits))
    return { ok: false, error: 'bad_number', message: 'Use the original business number.' };
  if (['active', 'provisioned'].includes(tenant.status) && Number(tenant.provision_step) >= STEPS.length) {
    return { ok: true, tenant, alreadyProvisioned: true, secrets: [] };
  }

  const secretsShown = [];
  let startStep = Number(tenant.provision_step) || 0;

  for (let index = startStep; index < STEPS.length; index += 1) {
    const step = STEPS[index];
    try {
      if (step === 'allocate') {
        // Nothing to do on disk: the slug is already ours.
      } else if (step === 'create') {
        const create = provisionHooks.create || (await import('../scripts/tenant.js')).createTenant;
        const adminModule = await admin();
        let onDisk = null;
        try {
          onDisk = adminModule.describeTenant(slug); // null when there is no folder
        } catch {
          onDisk = null;
        }
        if (!onDisk) {
          const created = await create({
            name,
            platformManaged: true,
            slug,
            number: digits,
            template: template || undefined,
            city: city || undefined,
            hours: hours || undefined,
            languages: languages ? [].concat(languages).join(',') : undefined,
            currency: currency || undefined,
          });
          setProgress(slug, { status: 'provisioning', step: index + 1, extra: { port: created?.port || null } });
        } else {
          setProgress(slug, { status: 'provisioning', step: index + 1, extra: { port: Number(onDisk.port) || null } });
        }
      } else if (step === 'secrets') {
        const env = (await admin()).readTenantEnv(slug);
        const wanted = {
          DASHBOARD_TOKEN: secret(24),
          PLATFORM_TENANT_TOKEN: secret(24),
          PLATFORM_USAGE_JOURNAL: '1',
        };
        for (const [key, value] of Object.entries(wanted)) {
          if (env[key]) continue; // already written by an earlier attempt
          const stored = storeSecret(slug, key, value, now);
          if (!stored) continue;
          (await admin()).writeTenantEnvValue(slug, key, stored);
          // Only real credentials are handed back, and only once.
          if (key === 'DASHBOARD_TOKEN') secretsShown.push({ name: key, value: stored });
        }
        setProgress(slug, { status: 'provisioning', step: index + 1 });
      } else if (step === 'profile') {
        const writeProfile = provisionHooks.writeProfile || (await admin()).writeTenantProfile;
        const readProfile = provisionHooks.readProfile || (await admin()).readTenantProfile;
        let profile;
        try {
          profile = await readProfile(slug);
        } catch {
          profile = null;
        }
        if (!profile) throw new Error('profile_missing');
        const merged = mergeWizardIntoProfile(profile, profileDraft || {});
        const written = await writeProfile(slug, merged);
        if (!written?.ok) throw new Error(`profile_rejected:${(written?.errors || []).slice(0, 3).join('; ')}`);
        setProgress(slug, { status: 'provisioning', step: index + 1 });
      } else if (step === 'entitlements') {
        const applied = applyEntitlements(slug, planId || tenant.plan_id || defaultPlan()?.id || null);
        if (!applied.ok) throw new Error(`entitlements_failed:${applied.error || 'unknown'}`);
        setProgress(slug, { status: 'provisioning', step: index + 1 });
      } else if (step === 'finalise') {
        const planRow = getTenant(slug);
        const plan = planRow.plan_id || defaultPlan()?.id || 'free';
        const trial = billingEnabled()
          ? { plan: 'free', trialEndsAt: openSubscription(slug, { now }).trial_end }
          : startTrial({ slug, accountId, number: digits, now, trialing: true });
        if (billingEnabled()) run('UPDATE tenants SET trial_ends_at=? WHERE slug=?', [trial.trialEndsAt, slug]);
        run('UPDATE tenants SET plan_id = ?, status = ?, provision_error = NULL, updated_at = ? WHERE slug = ?', [
          trial.plan || plan,
          'provisioned',
          new Date(Number(now)).toISOString(),
          slug,
        ]);
        run('UPDATE tenants SET provision_step = ? WHERE slug = ?', [STEPS.length, slug]);
        recordAudit({
          action: 'tenant_provisioned',
          accountId,
          tenant: slug,
          detail: { plan: trial.plan, template: template || null },
          ip,
        });
        notify({
          accountId,
          tenant: slug,
          kind: 'provisioning',
          title: 'Your assistant is ready to set up',
          body: 'Finish the setup wizard, then connect your WhatsApp number.',
        });
      }
    } catch (err) {
      // Validation/child errors may quote tenant profile values. Persist the
      // bounded step, never the command output or user's field values.
      const message = `Could not complete ${step}. Check the tenant files, then retry this step.`;
      setProgress(slug, { status: 'failed', step: index, error: `step ${step}: ${message}` });
      recordAudit({
        action: 'tenant_provision_failed',
        accountId,
        tenant: slug,
        detail: { step, error: message },
        ip,
        ok: false,
      });
      return { ok: false, error: 'provision_failed', step, message, slug, secrets: secretsShown };
    }
  }

  return { ok: true, slug, tenant: getTenant(slug), secrets: secretsShown };
}

/** Retry a failed provisioning from where it stopped. */
export async function retryProvisioning(slug, { accountId = null, ip = null, number = null } = {}) {
  const tenant = getTenant(slug);
  if (!tenant || (accountId && !isTenantOwner(accountId, slug))) return { ok: false, error: 'no_tenant' };
  if (
    number &&
    (!/^\d{10,15}$/.test(normaliseNumber(number)) || businessNumberId(normaliseNumber(number)) !== tenant.number)
  )
    return { ok: false, error: 'bad_number' };
  if (tenant.status !== 'failed') return { ok: true, tenant, skipped: true };
  return provisionTenant({
    accountId: tenant.account_id,
    name: tenant.name,
    number: (await admin()).readTenantEnv(slug).MY_NUMBER || number,
    template: tenant.template,
    planId: tenant.plan_id,
    slug,
    ip,
  });
}

/**
 * Overlay what the wizard collected onto the profile `createTenant` wrote.
 * Only the fields the wizard owns are touched; templates keep everything else.
 */
export function mergeWizardIntoProfile(profile, draft = {}) {
  const next = JSON.parse(JSON.stringify(profile || {}));
  next.business = next.business && typeof next.business === 'object' ? next.business : {};
  const b = draft.business || {};
  if (b.name) next.business.name = String(b.name).slice(0, 120);
  if (b.type) next.business.type = String(b.type).slice(0, 60);
  if (b.city) next.business.city = String(b.city).slice(0, 80);
  if (b.hours) next.business.hours = String(b.hours).slice(0, 200);
  if (b.languages !== undefined) {
    // Passed through even when it is the wrong shape: profile.js is the thing
    // that decides, and silently dropping it would hide the mistake.
    next.business.languages = Array.isArray(b.languages)
      ? b.languages.map((l) => String(l).slice(0, 20)).slice(0, 6)
      : b.languages;
  }
  if (b.tone)
    next.tone = { ...(next.tone || {}), ...(typeof b.tone === 'object' ? b.tone : { style: String(b.tone) }) };
  if (draft.payment) {
    const old = next.business.payment || {};
    next.business.payment = {
      ...old,
      ...draft.payment,
      ...(draft.payment.bank ? { bank: { ...old.bank, ...draft.payment.bank } } : {}),
    };
  }
  if (Array.isArray(draft.services)) next.owner = { ...next.owner, services: draft.services.slice(0, 200) };
  if (Array.isArray(draft.catalog)) {
    next.catalog = { ...(next.catalog || {}), items: draft.catalog.slice(0, 200) };
  }
  if (Array.isArray(draft.faqs)) next.faqs = draft.faqs.slice(0, 100);
  if (draft.conversation && typeof draft.conversation === 'object') {
    next.business.conversation = { ...(next.business.conversation || {}), ...draft.conversation };
  }
  if (draft.intake && typeof draft.intake === 'object') {
    next.business.intake = draft.intake;
  }
  if (Array.isArray(draft.replyTiming)) next.business.replyTiming = draft.replyTiming;
  return next;
}

/** Remove a tenant completely (account deletion). Returns what was removed. */
export async function destroyTenant(slug, { accountId = null, ip = null, guard = null } = {}) {
  const { withWorker, stopKeyWorker } = await import('./keys.js');
  return withWorker(slug, () => removeStoppedTenant(slug, accountId, ip, stopKeyWorker, guard));
}

async function removeStoppedTenant(slug, accountId, ip, stop, guard) {
  const tenant = getTenant(slug);
  if (!tenant) return { ok: false, error: 'no_tenant' };
  if (accountId && tenant.account_id !== accountId) return { ok: false, error: 'not_owner' };
  if (guard && !guard()) return { ok: false, error: 'export_or_final_state_required' };
  const adminModule = await admin();
  let removedFiles = false;
  try {
    await stop(slug);
    if (guard && !guard()) return { ok: false, error: 'export_or_final_state_required' };
    adminModule.deleteTenantFromPanel(slug, slug);
    removedFiles = true;
  } catch (err) {
    if (err.message !== 'not_found') return { ok: false, error: 'tenant_cleanup_failed' };
  }
  (await import('./reportStore.js')).eraseReports(slug);
  const forget = subscription(slug) ? billingTransaction : transaction;
  return forget(() => {
    eraseBilling(slug);
    run('DELETE FROM tenants WHERE slug = ?', [slug]);
    run('DELETE FROM memberships WHERE slug = ?', [slug]);
    run('DELETE FROM wizard_drafts WHERE slug = ?', [slug]);
    run('DELETE FROM tenant_secrets WHERE slug = ?', [slug]);
    for (const table of ['tenant_keys', 'settings_undo', 'compatibility_runs'])
      run(`DELETE FROM ${table} WHERE slug = ?`, [slug]);
    run('DELETE FROM usage_events WHERE tenant = ?', [slug]);
    recordAudit({
      action: 'tenant_destroyed',
      accountId: accountId || tenant.account_id,
      tenant: slug,
      detail: { files: removedFiles },
      ip,
    });
    return { ok: true, removedFiles };
  });
}

export { STEPS as provisionStepNames };
export default {
  provisionTenant,
  retryProvisioning,
  beginProvisioning,
  allocateSlug,
  numberOwner,
  getTenant,
  tenantForAccount,
  tenantsForAccount,
  isTenantOwner,
  getTenantSecret,
  listTenantSecrets,
  mergeWizardIntoProfile,
  destroyTenant,
  setProvisionHooks,
  resetProvisionHooks,
};