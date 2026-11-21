import {billingEnabled} from './env.js';
import {entitlementsFor} from './billing/subscriptions.js';
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

import { draftMetadata } from './draftMetadata.js';
import { get, run, flush } from './db.js';
import { tenantForAccount, isTenantOwner, mergeWizardIntoProfile } from './provisioning.js';
import { readTenantProfile, writeTenantProfile, saveUpload, ingestUpload, validateTenantProfile, tenantRunning } from '../src/services/adminPanel.js';
import { checklist, markTestChat } from './onboarding.js';
import { applySettings } from './settings.js';
import { withWorker, stopKeyWorker } from './keys.js';
import { listTemplates, isTemplate, buildProfileFromTemplate } from '../src/services/templates.js';
import { applyEntitlements, checkEntitlement } from './plans.js';
import { linkStatus, startTenantViaHook } from './connect.js';
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
    data = draftMetadata(JSON.parse(row.data || '{}'));
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
    4: [],
    5: ['conversation', 'intake', 'replyTiming', 'agents'],
    6: [], 7: [], 8: [],
  };
  return map[Number(stepId)] || [];
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
  const check = validateTenantProfile(slug, applied);
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
  const invalid = (field, message) => ({ ok: false, status: 400, error: 'invalid', saved: false,
    errors: [message], fieldErrors: [{ field, message }], step: current.step });
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return invalid('patch', 'Expected a group of fields.');
  for (const name of Object.keys(patch)) if (!fieldsForStep(step).includes(name)) return invalid(name, 'This field is not editable in this step.');
  if (patch.template && !isTemplate(patch.template)) return invalid('template', 'Choose a listed template.');
  if (patch.business !== undefined && (!patch.business || typeof patch.business !== 'object' || Array.isArray(patch.business))) return invalid('business', 'Expected business details.');
  if (patch.business && Object.keys(patch.business).some((k) => !['name','type','city','hours','languages','tone'].includes(k))) return invalid('business', 'Unrecognised business field.');
  for (const k of ['name','type','city','hours']) if (patch.business?.[k] !== undefined && (typeof patch.business[k] !== 'string' || !patch.business[k].trim())) return invalid(`business.${k}`, `Enter the business ${k}.`);
  for (const k of ['catalog','services','faqs']) if (patch[k] !== undefined && (!Array.isArray(patch[k]) || patch[k].some((r) => !r || typeof r !== 'object' || Array.isArray(r)))) return invalid(k, 'Expected a list of entries.');
  if (patch.payment !== undefined && (!patch.payment || typeof patch.payment !== 'object' || Array.isArray(patch.payment))) return invalid('payment','Expected payment details.');
  if (patch.payment?.bank !== undefined && (!patch.payment.bank || typeof patch.payment.bank !== 'object' || Array.isArray(patch.payment.bank) || Object.values(patch.payment.bank).some((v) => typeof v !== 'string'))) return invalid('payment.bank.number','Enter the bank account details as text.');
  if (patch.services?.some((r) => typeof r.name !== 'string' || !r.name.trim())) return invalid('services','Each service needs a name.');
  if (patch.business?.tone !== undefined && typeof patch.business.tone !== 'string' && typeof patch.business.tone?.style !== 'string') return invalid('business.tone','Enter a tone description.');
  // The profile is the source of truth, not a duplicate of payment details in the control database.
  const data = draftMetadata(current.data);
  let base;
  try { base = readTenantProfile(slug); } catch { return invalid('business', 'Finish provisioning the profile first.'); }
  if (stepDef.id === 1 && !patch.template && membership.template && 'template' in patch) return invalid('template', 'To keep this profile, leave its current template selected.');
  if (stepDef.id === 1 && patch.template && patch.template !== membership.template) {
    const template = buildProfileFromTemplate(patch.template, { name: base.business?.name || membership.name, number: base.owner?.number, city: base.business?.city });
    // Replacing a starter is only safe before people edit it; keep plan flags.
    if (current.step > 2 || membership.status === 'active') return invalid('template', 'Setup is already under way. Edit the business details instead.');
    base = { ...base, ...template, features: base.features };
  }
  // Only apply this step's delta. Replaying the entire draft here would roll
  // back Settings edits whenever the owner advanced to another wizard page.
  if (stepDef.id === 5 && Object.keys(patch).length) {
    const changes = {};
    for (const [group, values] of Object.entries(patch)) {
      if (group === 'replyTiming') changes['conversation.replyTiming'] = values;
      else if (['conversation','intake'].includes(group) && values && typeof values === 'object') {
        for (const [k,v] of Object.entries(values)) changes[`${group}.${k}`] = v;
      } else return invalid(group, 'Use Behaviour settings to edit this group.');
    }
    const result = applySettings({ slug, accountId, patch: changes });
    if (!result.ok) return { ...result, fieldErrors: result.errors || [], saved: false };
  } else if (stepDef.id <= 3 && Object.keys(patch).length) {
    const profile = mergeWizardIntoProfile(base, patch);
    const written = writeTenantProfile(slug, profile);
    if (!written.ok) return { ok: false, status: 400, error: 'invalid', saved: false, errors: written.errors,
      fieldErrors: written.errors.map((message) => ({ field: message.match(/business\.[a-z]+/)?.[0] || (/faq/i.test(message) ? 'faqs' : /catalog/i.test(message) ? 'catalog' : 'business'), message })) };
  }

  const stamp = new Date(Number(now)).toISOString();
  const existing = draftRow(slug);
  const nextStep = Math.min(8, stepDef.id + 1);
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
    stepDef.id === 1 ? patch.template || null : null, stamp, slug,
  ]);
  recordAudit({ action: 'wizard_step_saved', accountId, tenant: slug, detail: { step: stepDef.id } });

  return {
    ok: true,
    saved: true,
    step: stepDef.id,
    nextStep: STEPS.find((s) => s.id > stepDef.id)?.id || null,
    warnings: [],
    updatedAt: stamp,
  };
}

/**
 * Documents go through `learn` exactly as they do in the admin panel: the same
 * 5 MB limit, the same extension whitelist, the same pipeline.
 */
export const addDocument = (slug, accountId, opts) => withWorker(slug, () => learnWhileStopped(slug, accountId, opts));
async function learnWhileStopped(slug, accountId, { name, buffer, now = Date.now() } = {}) {
  const membership = tenantForAccount(accountId, slug);
  if (!membership) return { ok: false, status: 404, error: 'not_found' };
  if (membership.member_role !== 'owner') return { ok: false, status: 403, error: 'owner_only' };

  if (membership.status === 'active' || tenantRunning(slug)) return { ok: false, status: 409, error: 'worker_running', message: 'Upload documents before starting linking, or pause the live assistant first.' };
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
    return { ok: false, status: 500, error: 'ingest_failed', message: 'The document could not be learned.' };
  }
  if (!ingested?.ok) {
    return { ok: false, status: 400, error: 'ingest_failed', message: 'The document was saved but could not be learned. Check its contents.' };
  }

  const documents = [...sofar, { name: saved.name, bytes: saved.bytes, at: new Date(Number(now)).toISOString(), chunks: ingested.chunks || null }];
  const data = draftMetadata({documents});
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
export const sandboxChat = (slug, accountId, opts) => withWorker(slug, () => sandboxWhileAuthorised(slug, accountId, opts));
async function sandboxWhileAuthorised(slug, accountId, { text, now = Date.now() } = {}) {
  const membership = tenantForAccount(accountId, slug);
  if (!membership) return { ok: false, status: 404, error: 'not_found' };
  const message = String(text || '').trim().slice(0, 500);
  if (!message) return { ok: false, status: 400, error: 'empty_message' };

  if (membership.member_role !== 'owner') return { ok: false, status: 403, error: 'owner_only' };

  if (billingEnabled() && !entitlementsFor(slug, now)?.canRun)
    return { ok: false, status: 409, error: 'assistant_paused' };
  const { runSandboxChat } = await import('./sandbox.js');
  const result = wizardHooks.sandboxChat ? { ok: true, ...await wizardHooks.sandboxChat(slug, message) } : await runSandboxChat(slug, message, { now });
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
  if (!result.replies?.some((r) => typeof r === 'string' && r.trim())) return { ok: false, status: 409, error: 'no_reply', message: 'The sandbox received no reply. Check the key and behaviour settings.' };
  markTestChat(slug);
  return { ok: true, sandbox: true, ...result };
}

// ── go live ──────────────────────────────────────────────────
/**
 * The last step, and the only one that starts a process. Every precondition is
 * checked first so a half-configured bot never answers a real customer.
 */
export function goLive(slug, accountId, { ip = null, resume = false } = {}) {
  return withWorker(slug, async () => {
    const t = tenantForAccount(accountId, slug);
    if (!t) return { ok: false, status: 404, error: 'not_found' };
    if (t.member_role !== 'owner') return { ok: false, status: 403, error: 'owner_only' };
    if ((t.status === 'paused' && !(resume && t.paused_reason === 'owner')) || (billingEnabled() ? !entitlementsFor(slug)?.canRun : Date.parse(t.trial_ends_at) <= Date.now())) return { ok: false, status: 409, error: 'paused' };
    if (resume && t.status !== 'paused') return { ok: false, status: 409, error: 'not_paused' };
    if (!resume && t.status === 'active') return { ok: true, status: 'active', alreadyLive: true };
    if (!['provisioned','paused'].includes(t.status)) return { ok: false, status: 409, error: 'provisioning_incomplete' };
    const applied = applyEntitlements(slug, t.plan_id);
    if (!applied.ok) return { ok: false, status: 409, error: applied.error };
    await linkStatus(slug);
    const gate = checklist(slug);
    if (!gate.requiredComplete) return { ok: false, status: 409, error: 'checklist_incomplete', missing: gate.missing, items: gate.items };
    try { await (wizardHooks.start || startTenantViaHook)(slug); }
    catch { return { ok: false, status: 502, error: 'start_failed', message: 'The worker could not start. Check platform readiness and the worker log.' }; }
    const stamp = new Date().toISOString();
    run("UPDATE tenants SET status = 'active', paused_reason = NULL, updated_at = ? WHERE slug = ?", [stamp, slug]);
    if (!flush()) {
      try { await stopKeyWorker(slug); } catch { return { ok: false, status: 502, error: 'stop_failed' }; }
      run('UPDATE tenants SET status = ?, paused_reason = ? WHERE slug = ?', [t.status, t.paused_reason, slug]);
      return { ok: false, status: 503, error: 'storage_unavailable' };
    }
    recordAudit({ action: resume ? 'tenant_resumed' : 'tenant_went_live', accountId, tenant: slug, ip });
    notify({ accountId, tenant: slug, kind: 'live', title: 'Your assistant is live' });
    return { ok: true, status: 'active', liveAt: stamp };
  });
}

/** Everything the wizard page needs, in one answer. */
export function wizardState(slug, accountId) {
  const membership = tenantForAccount(accountId, slug);
  if (!membership) return { ok: false, status: 404, error: 'not_found' };
  const tenant = get('SELECT * FROM tenants WHERE slug = ?', [slug]);
  const draft = readDraft(slug);
  const templates = listTemplates();
  const agentLimit = checkEntitlement(slug, 'agents', { used: 0, add: 0 });

  let p = {};
  try { p = readTenantProfile(slug); } catch { /* provisioning may have failed */ }
  const b = p.business || {};
  return {
    ok: true,
    tenant: {
      slug: tenant.slug, name: tenant.name, status: tenant.status,
      plan_id: tenant.plan_id, link_status: tenant.link_status, provision_step: tenant.provision_step,
      provision_error: tenant.provision_error, trial_ends_at: tenant.trial_ends_at,
    },
    role: membership.member_role,
    steps: STEPS,
    step: draft.step,
    draft: { template: tenant.template, business: { name: b.name, type: b.type, hours: b.hours, city: b.city, languages: b.languages, tone: p.tone?.style },
      catalog: p.catalog?.items || [], faqs: p.faqs || [], payment: membership.member_role === 'owner' ? b.payment || {} : {}, documents: membership.member_role === 'owner' ? draft.data.documents || [] : [] },
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
