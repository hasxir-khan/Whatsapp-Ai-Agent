// platform/wizard.js
// The setup wizard: eight steps, each one saved, none of them a new validator.
//
// `profile.js` already owns what a profile may contain (`validateProfile`) and
// `adminPanel.writeTenantProfile` already refuses to write one the bot would not
// load. The wizard therefore composes a profile and asks those two — it never
// grows a second set of rules for hours, prices or languages.
//
// A draft is written after *every* step (the customer can close the tab), and
// the step number is kept so the browser can resume where it left off.

import { get, run } from './db.js';
import { tenantForAccount, isTenantOwner, mergeWizardIntoProfile } from './provisioning.js';
import { readTenantProfile, writeTenantProfile, saveUpload, ingestUpload, readTenantEnv } from '../src/services/adminPanel.js';
import { validateProfile } from '../src/services/profile.js';
import { listTemplates } from '../src/services/templates.js';
import { checkEntitlement } from './plans.js';
import { startTenantViaHook } from './connect.js';
import { helpTexts } from './env.js';
import { recordAudit, notify } from './audit.js';

export const STEPS = [
  { id: 1, key: 'business-type', title: 'What kind of business?', hint: 'Pick the closest template — everything can be edited later.' },
  { id: 2, key: 'business-details', title: 'Your business', hint: 'Name, city, languages, hours and tone.' },
  { id: 3, key: 'catalog', title: 'What you sell', hint: 'Products, services, prices, payment details and FAQs.' },
  { id: 4, key: 'documents', title: 'Documents', hint: 'Optional: a menu, price list or policy PDF the assistant can learn.' },
  { id: 5, key: 'agents', title: 'How it should behave', hint: 'Handover rules, the questions it must ask, reply timing.' },
  { id: 6, key: 'connect', title: 'Connect WhatsApp', hint: 'Scan the QR, or link with a phone number.' },
  { id: 7, key: 'test', title: 'Try it', hint: 'A sandbox chat. Nothing is sent to a real number.' },
  { id: 8, key: 'live', title: 'Go live', hint: 'Your assistant starts answering real customers.' },
];

export const STEP_IDS = STEPS.map((s) => s.id);

/** Replacement point for tests: no child process, no network. */
export const wizardHooks = {
  sandboxChat: null,
  start: null,
  stop: null,
  ingest: null,
};

export function setWizardHooks(next = {}) {
  for (const key of Object.keys(wizardHooks)) {
    if (typeof next[key] === 'function') wizardHooks[key] = next[key];
  }
  return wizardHooks;
}

export function resetWizardHooks() {
  for (const key of Object.keys(wizardHooks)) wizardHooks[key] = null;
}

function draftRow(slug) {
  return get('SELECT * FROM wizard_drafts WHERE slug = ?', [String(slug)]);
}

export function readDraft(slug) {
  const row = draftRow(slug);
  if (!row) return { step: 1, data: {}, updated_at: null };
  let data = {};
  try {
    data = JSON.parse(row.data || '{}');
  } catch {
    data = {};
  }
  return { step: Number(row.step) || 1, data, updated_at: row.updated_at };
}

export function stepFor(stepId) {
  return STEPS.find((s) => s.id === Number(stepId)) || null;
}

/** The part of a draft a given step owns. Used to reject writes for other steps. */
export function fieldsForStep(stepId) {
  const map = {
    1: ['template', 'businessType'],
    2: ['business'],
    3: ['catalog', 'services', 'faqs', 'payment'],
    4: ['documents'],
    5: ['conversation', 'intake', 'replyTiming', 'agents'],
    6: ['connect'],
    7: ['test'],
    8: ['live'],
  };
  return map[Number(stepId)] || [];
}

function mergeDraft(current, stepId, patch) {
  const next = { ...(current || {}) };
  const allowed = fieldsForStep(stepId);
  for (const [key, value] of Object.entries(patch || {})) {
    if (!allowed.includes(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && next[key] && typeof next[key] === 'object' && !Array.isArray(next[key])) {
      next[key] = { ...next[key], ...value };
    } else {
      next[key] = value;
    }
  }
  return next;
}

/**
 * Compose what would be written if this draft were saved, then validate it.
 * Returns `{ok, profile, errors, warnings}` — the caller decides whether to keep
 * the draft, but the rules are always profile.js's.
 */
export function previewProfile(slug, draft) {
  let base = null;
  try {
    base = readTenantProfile(slug);
  } catch {
    base = null;
  }
  if (!base) return { ok: false, errors: ['This assistant has no profile on disk yet.'], warnings: [] };

  const applied = mergeWizardIntoProfile(base, draft || {});
  // Step 1's template choice is a hint for createTenant, not a profile field.
  const check = validateProfile(applied);
  return { ok: !(check.errors || []).length, errors: check.errors || [], warnings: check.warnings || [], profile: applied };
}

/**
 * Save one step. `staff` accounts may look; only the owner may change anything.
 */
export function saveStep(slug, accountId, { step, patch = {}, now = Date.now() } = {}) {
  const membership = tenantForAccount(accountId, slug);
  if (!membership) return { ok: false, status: 404, error: 'not_found' };
  if (membership.member_role !== 'owner') {
    return { ok: false, status: 403, error: 'owner_only', message: 'Staff accounts can view the setup but not change it.' };
  }
  const stepDef = stepFor(step);
  if (!stepDef) return { ok: false, status: 400, error: 'unknown_step', steps: STEP_IDS };

  const current = readDraft(slug);
  const data = mergeDraft(current.data, stepDef.id, patch);
  const preview = previewProfile(slug, data);
  if (!preview.ok) {
    return {
      ok: false,
      status: 400,
      error: 'invalid',
      errors: preview.errors,
      warnings: preview.warnings,
      saved: false,
      step: current.step,
    };
  }

  // Validate first, then write — the tenant's own profile file, atomically.
  const written = writeTenantProfile(slug, preview.profile);
  if (!written.ok) {
    return { ok: false, status: 400, error: 'rejected', errors: written.errors || [], saved: false };
  }

  const stamp = new Date(Number(now)).toISOString();
  const existing = draftRow(slug);
  const nextStep = Math.max(Number(current.step) || 1, stepDef.id);
  if (existing) {
    run('UPDATE wizard_drafts SET step = ?, data = ?, updated_at = ? WHERE slug = ?', [
      nextStep, JSON.stringify(data), stamp, slug,
    ]);
  } else {
    run('INSERT INTO wizard_drafts (slug, step, data, updated_at) VALUES (?, ?, ?, ?)', [
      slug, nextStep, JSON.stringify(data), stamp,
    ]);
  }
  run('UPDATE tenants SET template = COALESCE(?, template), updated_at = ? WHERE slug = ?', [
    data.template || data.businessType || null, stamp, slug,
  ]);
  recordAudit({ action: 'wizard_step_saved', accountId, tenant: slug, detail: { step: stepDef.id } });

  return {
    ok: true,
    saved: true,
    step: stepDef.id,
    nextStep: STEPS.find((s) => s.id > stepDef.id)?.id || null,
    warnings: preview.warnings,
    updatedAt: stamp,
  };
}

/**
 * Documents go through `learn` exactly as they do in the admin panel: the same
 * 5 MB limit, the same extension whitelist, the same pipeline.
 */
export async function addDocument(slug, accountId, { name, buffer, now = Date.now() } = {}) {
  const membership = tenantForAccount(accountId, slug);
  if (!membership) return { ok: false, status: 404, error: 'not_found' };
  if (membership.member_role !== 'owner') return { ok: false, status: 403, error: 'owner_only' };

  const draft = readDraft(slug);
  const sofar = Array.isArray(draft.data.documents) ? draft.data.documents : [];
  if (sofar.length >= 20) {
    return { ok: false, status: 400, error: 'too_many_documents', message: 'Twenty documents is the limit for one assistant.' };
  }

  const saved = saveUpload(slug, { name, buffer });
  if (!saved.ok) {
    return {
      ok: false,
      status: 400,
      error: saved.reason,
      message:
        saved.reason === 'too_large'
          ? 'That file is bigger than 5 MB.'
          : saved.reason === 'type_not_allowed'
            ? `Allowed types: ${(saved.allowed || []).join(', ')}`
            : 'That file could not be read.',
    };
  }

  let ingested;
  try {
    ingested = wizardHooks.ingest ? await wizardHooks.ingest(slug, saved.file) : await ingestUpload(slug, saved.file);
  } catch (err) {
    return { ok: false, status: 500, error: 'ingest_failed', message: String(err?.message || 'The document could not be learned.').slice(0, 200) };
  }
  if (!ingested?.ok) {
    return { ok: false, status: 400, error: 'ingest_failed', message: 'The document was saved but could not be learned. Check its contents.', detail: ingested?.output || null };
  }

  const documents = [...sofar, { name: saved.name, bytes: saved.bytes, at: new Date(Number(now)).toISOString(), chunks: ingested.chunks || null }];
  const data = { ...draft.data, documents };
  const existing = draftRow(slug);
  const stamp = new Date(Number(now)).toISOString();
  if (existing) run('UPDATE wizard_drafts SET data = ?, updated_at = ? WHERE slug = ?', [JSON.stringify(data), stamp, slug]);
  else run('INSERT INTO wizard_drafts (slug, step, data, updated_at) VALUES (?, 4, ?, ?)', [slug, JSON.stringify(data), stamp]);
  recordAudit({ action: 'wizard_document_added', accountId, tenant: slug, detail: { bytes: saved.bytes, chunks: ingested.chunks || null } });

  return { ok: true, document: documents[documents.length - 1], documents: documents.length, mode: ingested.mode || 'inline' };
}

// ── sandbox test chat ────────────────────────────────────────
/**
 * The test chat runs the tenant's real brain with a transport that cannot send
 * anything: a child process with the tenant's own config, a fake socket, and a
 * contact number that WhatsApp will never issue. When no sandbox is available
 * the answer is honest ("not available here") rather than a fake reply.
 */
export async function sandboxChat(slug, accountId, { text, now = Date.now() } = {}) {
  const membership = tenantForAccount(accountId, slug);
  if (!membership) return { ok: false, status: 404, error: 'not_found' };
  const message = String(text || '').trim().slice(0, 500);
  if (!message) return { ok: false, status: 400, error: 'empty_message' };

  if (wizardHooks.sandboxChat) {
    const res = await wizardHooks.sandboxChat(slug, message);
    return { ok: true, ...res, sandbox: true };
  }

  const { runSandboxChat } = await import('./sandbox.js');
  const result = await runSandboxChat(slug, message, { now });
  if (!result.ok) {
    return {
      ok: false,
      status: 503,
      error: result.error || 'sandbox_unavailable',
      message:
        'The test chat needs the assistant’s own process environment. ' +
        'It is available from the platform app on the same machine.',
    };
  }
  return { ok: true, sandbox: true, ...result };
}

// ── go live ──────────────────────────────────────────────────
/**
 * The last step, and the only one that starts a process. Every precondition is
 * checked first so a half-configured bot never answers a real customer.
 */
export async function goLive(slug, accountId, { ip = null, now = Date.now() } = {}) {
  const membership = tenantForAccount(accountId, slug);
  if (!membership) return { ok: false, status: 404, error: 'not_found' };
  if (membership.member_role !== 'owner') return { ok: false, status: 403, error: 'owner_only' };

  const tenant = get('SELECT * FROM tenants WHERE slug = ?', [slug]);
  if (!tenant) return { ok: false, status: 404, error: 'not_found' };
  if (tenant.status === 'paused') {
    return { ok: false, status: 409, error: 'paused', message: 'This assistant is paused. Choose a plan to switch it back on.' };
  }
  if (tenant.status === 'failed') {
    return { ok: false, status: 409, error: 'provisioning_failed', message: 'Setup did not finish. Retry provisioning from the dashboard.' };
  }

  let profile = null;
  try {
    profile = readTenantProfile(slug);
  } catch {
    profile = null;
  }
  if (!profile) return { ok: false, status: 409, error: 'no_profile', message: 'The business profile has not been saved yet.' };
  const check = validateProfile(profile);
  if (check.errors?.length) return { ok: false, status: 409, error: 'invalid_profile', errors: check.errors };

  const env = readTenantEnv(slug);
  const transport = (env.TRANSPORT || 'baileys').toLowerCase();
  const linked = tenant.link_status === 'connected' || (transport === 'cloud' && !!env.CLOUD_TOKEN);
  if (!linked) {
    return {
      ok: false,
      status: 409,
      error: 'whatsapp_not_connected',
      message: 'Connect WhatsApp first — the assistant has no number to answer on.',
    };
  }

  try {
    const start = wizardHooks.start || startTenantViaHook;
    await start(slug);
  } catch (err) {
    return { ok: false, status: 502, error: 'start_failed', message: String(err?.message || 'The assistant did not start.').slice(0, 200) };
  }

  const stamp = new Date(Number(now)).toISOString();
  run("UPDATE tenants SET status = 'active', updated_at = ? WHERE slug = ?", [stamp, slug]);
  recordAudit({ action: 'tenant_went_live', accountId, tenant: slug, ip });
  notify({
    accountId,
    tenant: slug,
    kind: 'live',
    title: 'Your assistant is live',
    body: 'It is answering on WhatsApp now. You can change any setting from Settings.',
  });
  return { ok: true, status: 'active', liveAt: stamp };
}

/** Everything the wizard page needs, in one answer. */
export function wizardState(slug, accountId) {
  const membership = tenantForAccount(accountId, slug);
  if (!membership) return { ok: false, status: 404, error: 'not_found' };
  const tenant = get('SELECT * FROM tenants WHERE slug = ?', [slug]);
  const draft = readDraft(slug);
  const templates = listTemplates();
  const agentLimit = checkEntitlement(slug, 'agents', { used: 0, add: 0 });

  return {
    ok: true,
    tenant: {
      slug: tenant.slug, name: tenant.name, number: tenant.number, status: tenant.status,
      plan_id: tenant.plan_id, link_status: tenant.link_status, provision_step: tenant.provision_step,
      provision_error: tenant.provision_error, trial_ends_at: tenant.trial_ends_at,
    },
    role: membership.member_role,
    steps: STEPS,
    step: draft.step,
    draft: draft.data,
    updated_at: draft.updated_at,
    templates,
    help: helpTexts(),
    entitlements: { agents: agentLimit, plan: tenant.plan_id },
    canEdit: membership.member_role === 'owner',
  };
}

export default {
  STEPS,
  STEP_IDS,
  stepFor,
  fieldsForStep,
  readDraft,
  previewProfile,
  saveStep,
  addDocument,
  sandboxChat,
  goLive,
  wizardState,
  setWizardHooks,
  resetWizardHooks,
};
