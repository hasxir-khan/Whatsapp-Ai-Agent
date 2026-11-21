import {billingEnabled} from './env.js';
import {entitlementsFor} from './billing/subscriptions.js';
// Readiness is derived from the same profile, key store and link state the worker
// uses. Documents and sandbox turns are attested by the server, not wizard JSON.
import {dashboardEnabled} from './env.js';
import { get, run } from './db.js';
import { readTenantProfile, readTenantEnv, validateTenantProfile } from '../src/services/adminPanel.js';
import { keySecretProblem } from './crypto.js';
import { healthFor, modelState, stopKeyWorker, withWorker } from './keys.js';
import { recordAudit } from './audit.js';
import { tenantForAccount } from './provisioning.js';

function facts(slug) {
  const tenant = get('SELECT * FROM tenants WHERE slug = ?', [slug]);
  if (!tenant) return null;
  let profile;
  try { profile = readTenantProfile(slug); } catch { profile = {}; }
  const keys = healthFor(slug), model = modelState(slug);
  const chain = keys.chain.filter((r) => r.status === 'active' && r.provider === model.provider);
  return { tenant, profile, env: readTenantEnv(slug), keys, model, chain };
}

export function checklist(slug, f = facts(slug)) {
  if (!f) return { ok: false, error: 'not_found' };
  const { tenant, profile, env, model, chain, keys } = f;
  const business = profile.business || {}, payment = business.payment || {};
  const catalog = profile.catalog?.items || profile.catalog;
  // A draft (especially a v1 draft) is not proof of ingestion. Do not count
  // uploads belonging to a previously destroyed tenant that used this slug.
  const docs = get(`SELECT COUNT(*) AS n FROM platform_audit WHERE tenant = ? AND action = 'wizard_document_added'
    AND ok = 1 AND id > (SELECT COALESCE(MAX(id),0) FROM platform_audit WHERE tenant = ? AND action = 'tenant_destroyed')`, [slug,slug]).n;
  const serviceCount = (profile.owner?.services || []).length;
  const paymentNeeded = /order|product|retail|restaurant|shop/i.test(`${business.type} ${tenant.template}`) || profile.features?.orderTracking === true;
  const valid = validateTenantProfile(slug, profile);
  const items = [];
  const add = (id, label, ok, tab, step, required = true, detail = '') => items.push({ id, label, required, ok: !!ok, detail, action: { tab, step } });
  add('profile', 'Business name, type and city', !valid.errors.length && business.name && business.type && business.city, 'setup', 2, true, valid.errors[0]);
  add('catalog', 'Catalogue, services or learned document', catalog?.length || serviceCount || docs, 'setup', 3);
  add('hours', 'Opening hours', String(business.hours || '').trim(), 'setup', 2);
  const hasPayment = [payment.bank, payment.jazzcash, payment.easypaisa].some((p) => p?.number || p?.accountNumber)
    || payment.bankAccount || payment.cod || payment.cashOnDelivery || payment.link || payment.stripeLink;
  add('payment', 'Payment instructions', hasPayment, 'setup', 3, paymentNeeded);
  add('ownerNumber', 'Owner WhatsApp number', /^\d{10,15}$/.test(env.MY_NUMBER || ''), 'setup', 2);
  add('whatsapp', 'WhatsApp linked', tenant.link_status === 'connected', 'connect', 6);
  add('apiKey', 'Tested key for the selected provider', !keySecretProblem() && keys.keySource === 'tenant' && chain.some((r) => r.health === 'active'), 'keys', 5);
  add('compatibility', 'Model compatibility', model.lastRun && (!model.blocked && (model.lastRun.status !== 'FAIL' || model.override)), 'keys', 5, true, model.override ? 'Owner accepted a failed check' : model.lastRun?.status);
  add('testChat', 'Sandbox chat received a reply', tenant.test_chat_at, 'test', 7, true, tenant.test_chat_at);
  add('team', 'Team and escalations', business.decisions?.team?.members?.length, 'settings', 5, false);
  const missing = items.filter((r) => r.required && !r.ok).map((r) => r.id);
  const expired = (billingEnabled() ? !entitlementsFor(slug)?.canRun : Date.parse(tenant.trial_ends_at) <= Date.now());
  return { ok: true, items, missing, requiredComplete: !missing.length,
    canGoLive: !missing.length && !expired && tenant.status === 'provisioned',
    canResume: !missing.length && !expired && tenant.status === 'paused' && tenant.paused_reason === 'owner',
    done: items.filter((r) => r.ok && r.required).length, total: items.filter((r) => r.required).length };
}

export function connectionCard(slug, f = facts(slug)) {
  if (!f) return { ok: false, error: 'not_found' };
  const { tenant, env, keys, model, chain } = f;
  const latest = dashboardEnabled()
    ? get('SELECT last_success at FROM r_cursor WHERE slug=?', [slug])
    : get('SELECT MAX(created_at) AS at FROM usage_events WHERE tenant = ? AND error_category IS NULL', [slug]);
  return { ok: true, status: tenant.status, pausedReason: tenant.paused_reason || null,
    whatsapp: { state: tenant.link_status, transport: env.TRANSPORT || 'baileys', updatedAt: tenant.link_updated_at },
    ai: { provider: model.provider || null, model: model.model || null, blocked: model.blocked,
      health: !chain.length ? 'missing' : chain.every((r) => r.health === 'unknown') ? 'untested' : chain.some((r) => r.health !== 'active') ? 'degraded' : 'active' },
    lastModelCallAt: latest?.at || null, alerts: keys.alerts };
}

export function onboardingState(slug) {
  const f = facts(slug);
  return { ok: !!f, checklist: checklist(slug, f), connection: connectionCard(slug, f) };
}

export function markTestChat(slug) {
  run('UPDATE tenants SET test_chat_at = ? WHERE slug = ?', [new Date().toISOString(), slug]);
}

export function pauseTenant(slug, accountId, { ip = null } = {}) {
  return withWorker(slug, async () => {
    const t = tenantForAccount(accountId, slug);
    if (!t) return { ok: false, status: 404, error: 'not_found' };
    if (t.member_role !== 'owner') return { ok: false, status: 403, error: 'owner_only' };
    if (t.status === 'paused') return { ok: true, status: 'paused' };
    if (t.status !== 'active') return { ok: false, status: 409, error: 'not_live' };
    try { await stopKeyWorker(slug); } catch { return { ok: false, status: 502, error: 'stop_failed' }; }
    run("UPDATE tenants SET status = 'paused', paused_reason = 'owner', updated_at = ? WHERE slug = ?", [new Date().toISOString(), slug]);
    recordAudit({ action: 'tenant_paused', accountId, tenant: slug, ip });
    return { ok: true, status: 'paused' };
  });
}
