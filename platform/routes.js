// platform/routes.js
// The control plane's HTTP surface. One function, one router, no framework.
//
// Order of every request:
//   1. is the platform switched on? (no → not ours, the server 404s)
//   2. is it configured? (enabled but no PLATFORM_SECRET → 503 page, never open)
//   3. which route? (public pages and sign-in endpoints first)
//   4. who is this? (signed cookie → account; 401 JSON for the API)
//   5. may they mutate? (double-submit CSRF for cookie sessions)
//   6. do they own this tenant? (`tenantForAccount` — the only ACL door)
//
// Every refusal is the same shape, and none of them leak whether an account or
// tenant exists.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformEnabled, platformMisconfigured, platformPublicUrl, CONSENT } from './env.js';
import { ensurePlatformDb, run } from './db.js';
import { rateLimit } from '../src/services/adminPanel.js';
import {
  isPlatformPath, sendJson, sendHtml, sendText, redirect, readJsonBody, readRawBody, clientIp, userAgent,
} from './http.js';
import * as views from './views.js';
import * as accounts from './accounts.js';
import session from './session.js';
import { seedPlans, listPlans, assignPlan, expireTrials, planForTenant } from './plans.js';
import { provisionTenant, retryProvisioning, tenantForAccount, tenantsForAccount, destroyTenant } from './provisioning.js';
import { wizardState, saveStep, addDocument, sandboxChat, goLive } from './wizard.js';
import { linkStatus, qrFor, requestPairingCode, pairingCode, disconnect } from './connect.js';
import { summary as usageSummary, ingestJournal } from './usage.js';
import { notificationsFor, markNotificationsRead, recentAudit, recordAudit } from './audit.js';
import { claimTrial, exportAccount, exportTokenValid, scrubAccount, getAccount } from './accounts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');

const TYPES = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const AUTH_PAGES = new Set(['/platform/login', '/platform/signup', '/platform/verify', '/platform/reset']);

let lastExpiryCheck = 0;

/** Trial expiry runs at most once a minute per process; it is also runnable by cron. */
async function maybeExpireTrials(now = Date.now()) {
  if (now - lastExpiryCheck < 60000) return null;
  lastExpiryCheck = now;
  try {
    const result = await expireTrials({ now });
    return result;
  } catch {
    return null;
  }
}

function accountPayload(account) {
  const consent = accounts.consentStatus(account);
  return {
    id: account.id,
    email: account.email,
    role: account.role,
    created_at: account.created_at,
    email_verified: !!account.email_verified,
    consent: { ...consent.versions, ...consent },
  };
}

function tenantPayload(row) {
  return {
    slug: row.slug,
    name: row.name,
    number: row.number,
    status: row.status,
    plan_id: row.plan_id,
    link_status: row.link_status,
    provision_step: row.provision_step,
    provision_error: row.provision_error,
    trial_ends_at: row.trial_ends_at,
    created_at: row.created_at,
    role: row.member_role || 'owner',
  };
}

function serveStatic(res, file) {
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(PUBLIC) + path.sep)) return sendText(res, 404, 'Not found');
  let body;
  try {
    body = fs.readFileSync(resolved);
  } catch {
    return sendText(res, 404, 'Not found');
  }
  const type = TYPES[path.extname(resolved)] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
  return true;
}

/** 401 for the API, a redirect for a page. */
function unauthenticated(res, wantsJson) {
  if (wantsJson) return sendJson(res, 401, { error: 'unauthorised' });
  return redirect(res, '/platform/login');
}

/**
 * Main entry point, called by src/server.js (and by platform/index.js when the
 * platform runs as its own app).
 * @returns {Promise<boolean>} true when this request belonged to the platform
 */
export async function handlePlatformRoute(req, res, url) {
  if (!isPlatformPath(url?.pathname)) return false;
  if (!platformEnabled()) return false; // not ours: the server answers 404

  const pathname = url.pathname;
  const isApi = pathname.startsWith('/api/platform');
  const method = String(req.method || 'GET').toUpperCase();
  const ip = clientIp(req);

  if (platformMisconfigured()) {
    if (isApi) return sendJson(res, 503, { error: 'platform_not_configured' }), true;
    return sendHtml(res, 503, views.misconfiguredPage()), true;
  }

  await ensurePlatformDb();
  seedPlans();

  // ── public pages ─────────────────────────────────────────
  if (!isApi) {
    if (pathname === '/platform' || pathname === '/platform/') {
      const who = session.readSession(req);
      return redirect(res, who.ok ? '/platform/app' : '/platform/login'), true;
    }
    if (AUTH_PAGES.has(pathname)) {
      const who = session.readSession(req);
      if (who.ok) return redirect(res, '/platform/app'), true;
      if (pathname === '/platform/login') return sendHtml(res, 200, views.loginPage()), true;
      if (pathname === '/platform/signup') return sendHtml(res, 200, views.signupPage()), true;
      if (pathname === '/platform/verify') {
        return sendHtml(res, 200, views.verifyPage({ email: String(url.searchParams.get('email') || '') })), true;
      }
      return sendHtml(res, 200, views.resetPage()), true;
    }
    if (pathname === '/platform/app' || pathname === '/platform/app/') {
      const who = session.readSession(req);
      if (!who.ok) return redirect(res, '/platform/login'), true;
      return sendHtml(res, 200, views.appPage()), true;
    }
    if (pathname.startsWith('/platform/') && TYPES[path.extname(pathname)]) {
      const name = path.basename(pathname);
      if (['app.js', 'app.css', 'auth.js'].includes(name)) return serveStatic(res, path.join(PUBLIC, name)), true;
    }
    return sendHtml(res, 404, views.notFoundPage()), true;
  }

  // ── API ──────────────────────────────────────────────────
  maybeExpireTrials();

  // Unauthenticated endpoints. Rate limited by the accounts module itself.
  if (method === 'POST' && pathname === '/api/platform/signup') {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status || 400, { error: body.error }), true;
    const result = await accounts.signupStart({
      email: body.body.email,
      terms: body.body.terms === true,
      privacy: body.body.privacy === true,
      ip,
    });
    return sendJson(res, result.ok ? 200 : result.status || 400, result), true;
  }

  if (method === 'POST' && pathname === '/api/platform/signup/verify') {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status || 400, { error: body.error }), true;
    const result = accounts.signupVerify({
      email: body.body.email,
      code: body.body.code,
      password: body.body.password,
      ip,
    });
    if (!result.ok) return sendJson(res, result.status || 400, result), true;
    const issued = session.issueSession(result.account.id, { ip, userAgent: userAgent(req) });
    return sendJson(res, 200, { ok: true, account: accountPayload(result.account) }, { 'Set-Cookie': issued.cookies }), true;
  }

  if (method === 'POST' && pathname === '/api/platform/login') {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status || 400, { error: body.error }), true;
    const result = accounts.login({ email: body.body.email, password: body.body.password, ip });
    if (!result.ok) {
      recordAudit({ action: 'login_failed', detail: { email: String(body.body.email || '').slice(0, 60) }, ip, ok: false });
      return sendJson(res, result.status || 401, result), true;
    }
    const issued = session.issueSession(result.account.id, { ip, userAgent: userAgent(req) });
    recordAudit({ action: 'login', accountId: result.account.id, ip });
    return sendJson(res, 200, { ok: true, account: accountPayload(result.account) }, { 'Set-Cookie': issued.cookies }), true;
  }

  if (method === 'POST' && pathname === '/api/platform/password/forgot') {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status || 400, { error: body.error }), true;
    const result = await accounts.passwordResetStart({ email: body.body.email, ip });
    return sendJson(res, result.ok ? 200 : result.status || 400, result), true;
  }

  if (method === 'POST' && pathname === '/api/platform/password/reset') {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status || 400, { error: body.error }), true;
    const result = accounts.passwordResetComplete({
      email: body.body.email,
      code: body.body.code,
      password: body.body.password,
    });
    if (result.ok) recordAudit({ action: 'password_reset', accountId: result.account.id, ip });
    return sendJson(res, result.ok ? 200 : result.status || 400, result), true;
  }

  // Everything below needs a session.
  const who = session.readSession(req);
  if (!who.ok) return unauthenticated(res, true), true;
  const account = getAccount(who.accountId);
  if (!account || account.status !== 'active') {
    return sendJson(res, 401, { error: 'unauthorised' }, { 'Set-Cookie': session.clearCookies() }), true;
  }
  const consent = accounts.consentStatus(account);
  if (!consent.ok && pathname !== '/api/platform/logout' && pathname !== '/api/platform/me') {
    return sendJson(res, 409, { error: 'consent_required', missing: consent.missing, versions: CONSENT }), true;
  }

  const general = rateLimit(`platform-api:${account.id}`, { max: 300, windowMs: 60000 });
  if (!general.ok) return sendJson(res, 429, { error: 'too_many_requests', retryAfter: general.retryAfter }), true;

  if (method !== 'GET' && method !== 'HEAD') {
    // Header token or same-origin; both are checked by the shared rule.
    if (!session.mutationAllowed(req, who, null)) {
      return sendJson(res, 403, { error: 'csrf' }), true;
    }
  }

  // ── account-level routes ─────────────────────────────────
  if (pathname === '/api/platform/me' && method === 'GET') {
    return sendJson(res, 200, {
      account: accountPayload(account),
      tenants: tenantsForAccount(account.id).map(tenantPayload),
      plans: listPlans().map((p) => ({ id: p.id, name: p.name, limits: p.limits })),
      templates: (await import('../src/services/templates.js')).listTemplates(),
      notifications: notificationsFor(account.id),
      consent: accounts.consentStatus(account),
    }), true;
  }

  if (pathname === '/api/platform/plans' && method === 'GET') {
    return sendJson(res, 200, {
      plans: listPlans().map((p) => ({ id: p.id, name: p.name, limits: p.limits, features: p.features, trial_days: p.trial_days })),
    }), true;
  }

  if (pathname === '/api/platform/logout' && method === 'POST') {
    session.revokeSession(who.sessionId);
    recordAudit({ action: 'logout', accountId: account.id, ip });
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': session.clearCookies() }), true;
  }

  if (pathname === '/api/platform/account/export' && method === 'POST') {
    const result = exportAccount(account.id);
    if (!result.ok) return sendJson(res, 404, result), true;
    recordAudit({ action: 'account_exported', accountId: account.id, ip });
    return sendJson(res, 200, result), true;
  }

  if (pathname === '/api/platform/account/delete' && method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status || 400, { error: body.error }), true;
    if (body.body.confirm !== 'DELETE') {
      return sendJson(res, 400, { error: 'confirm_required', message: 'Send {"confirm":"DELETE"} to delete.' }), true;
    }
    const fresh = getAccount(account.id);
    if (!exportTokenValid(fresh)) {
      return sendJson(res, 409, {
        error: 'export_first',
        message: 'Export your data first — deletion removes the assistant folders too.',
      }), true;
    }
    for (const tenant of tenantsForAccount(account.id)) {
      await destroyTenant(tenant.slug, { accountId: account.id, ip });
    }
    scrubAccount(account.id);
    recordAudit({ action: 'account_deleted', accountId: account.id, ip });
    return sendJson(res, 200, { ok: true, deleted: true }, { 'Set-Cookie': session.clearCookies() }), true;
  }

  if (pathname === '/api/platform/notifications/read' && method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status || 400, { error: body.error }), true;
    return sendJson(res, 200, markNotificationsRead(account.id, { ids: body.body.ids || null })), true;
  }

  if (pathname === '/api/platform/audit' && method === 'GET') {
    return sendJson(res, 200, { audit: recentAudit({ accountId: account.id, limit: 50 }) }), true;
  }

  if (pathname === '/api/platform/tenants' && method === 'POST') {
    const limited = rateLimit(`platform-create:${account.id}`, { max: 5, windowMs: 60 * 60000 });
    if (!limited.ok) return sendJson(res, 429, { error: 'too_many_requests', retryAfter: limited.retryAfter }), true;
    const body = await readJsonBody(req);
    if (!body.ok) return sendJson(res, body.status || 400, { error: body.error }), true;
    const { name, number, template = null, city = '', languages = null, hours = '' } = body.body;
    if (!String(name || '').trim()) return sendJson(res, 400, { error: 'name_required' }), true;

    // How many numbers this account may run is a plan limit, checked before a
    // folder is created rather than after.
    const existing = tenantsForAccount(account.id);
    if (existing.length) {
      const plan = planForTenant(existing[0].slug)?.plan;
      const limit = Number(plan?.limits?.numbers) || 1;
      if (existing.length >= limit) {
        return sendJson(res, 409, {
          error: 'plan_limit',
          entitlement: 'numbers',
          limit,
          used: existing.length,
          message: `Your plan covers ${limit} WhatsApp number${limit === 1 ? '' : 's'}. Upgrade to add another assistant.`,
        }), true;
      }
    }

    const result = await provisionTenant({
      accountId: account.id,
      name: String(name).trim().slice(0, 120),
      number,
      template,
      city,
      languages,
      hours,
      ip,
    });
    if (!result.ok) return sendJson(res, result.error === 'number_in_use' ? 409 : 400, result), true;

    // The trial is claimed only once there is an assistant to trial, so a failed
    // setup does not burn the number's free days.
    const trial = claimTrial({ accountId: account.id, number });
    if (!trial.trialing && trial.reason === 'number_already_trialed') {
      // No second free trial on the same number: plan limits, no trial window.
      run('UPDATE tenants SET trial_ends_at = NULL WHERE slug = ?', [result.slug]);
    }
    recordAudit({ action: 'tenant_created', accountId: account.id, tenant: result.slug, ip, detail: { trial: !!trial.trialing } });
    const created = tenantsForAccount(account.id).find((t) => t.slug === result.slug);
    return sendJson(res, 201, {
      ok: true,
      slug: result.slug,
      tenant: created ? tenantPayload(created) : null,
      // Secrets are returned exactly once, at creation.
      secrets: result.secrets || [],
    }), true;
  }

  // ── per-tenant routes ────────────────────────────────────
  const tenantMatch = pathname.match(/^\/api\/platform\/tenants\/([a-z0-9-]{2,40})(\/.*)?$/);
  if (tenantMatch) {
    const slug = tenantMatch[1];
    const rest = tenantMatch[2] || '';
    const membership = tenantForAccount(account.id, slug);
    if (!membership) return sendJson(res, 404, { error: 'not_found' }), true;
    const owner = membership.member_role === 'owner';

    if (rest === '' && method === 'GET') {
      const state = wizardState(slug, account.id);
      if (!state.ok) return sendJson(res, state.status || 404, state), true;
      try {
        await ingestJournal({ slug });
      } catch {
        /* no journal is normal */
      }
      return sendJson(res, 200, {
        ...state,
        usage: usageSummary(slug),
        plans: listPlans().map((p) => ({ id: p.id, name: p.name, limits: p.limits })),
        entitlements: planForTenant(slug),
      }), true;
    }

    // Payments review, read-only. In mounted mode the bot writes a small
    // counts-only snapshot into the tenant's data folder; in hosted mode there
    // is no shared filesystem, so the answer says so instead of pretending.
    if (rest === '/payments' && method === 'GET') {
      const { readPaymentsSnapshot } = await import('../src/services/paymentReview.js');
      const root = process.env.TENANTS_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tenants');
      const dir = path.join(root, slug, 'data');
      const snapshot = readPaymentsSnapshot(dir);
      return sendJson(res, 200, {
        ok: true,
        slug,
        available: Boolean(snapshot),
        summary: snapshot,
        hint: snapshot ? null : 'Payments review lives in the bot. The platform reads a counts-only snapshot when it shares the filesystem (mounted mode).',
      }), true;
    }

    if (rest === '/provision' && method === 'POST') {
      if (!owner) return sendJson(res, 403, { error: 'owner_only' }), true;
      const result = await retryProvisioning(slug, { accountId: account.id, ip });
      return sendJson(res, result.ok ? 200 : 400, result), true;
    }

    const wizardMatch = rest.match(/^\/wizard\/(\d+)$/);
    if (wizardMatch && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return sendJson(res, body.status || 400, { error: body.error }), true;
      const result = saveStep(slug, account.id, { step: wizardMatch[1], patch: body.body.patch || {} });
      return sendJson(res, result.ok ? 200 : result.status || 400, result), true;
    }

    if (rest === '/documents' && method === 'POST') {
      if (!owner) return sendJson(res, 403, { error: 'owner_only' }), true;
      const limitedUpload = rateLimit(`platform-upload:${account.id}:${slug}`, { max: 20, windowMs: 60 * 60000 });
      if (!limitedUpload.ok) return sendJson(res, 429, { error: 'too_many_requests', retryAfter: limitedUpload.retryAfter }), true;
      const raw = await readRawBody(req);
      if (!raw.ok) return sendJson(res, raw.status || 400, { error: raw.error }), true;
      const name = String(req.headers['x-file-name'] || 'document.pdf').slice(0, 120);
      const result = await addDocument(slug, account.id, { name, buffer: raw.buffer });
      return sendJson(res, result.ok ? 200 : result.status || 400, result), true;
    }

    if (rest === '/test-chat' && method === 'POST') {
      const limitedChat = rateLimit(`platform-testchat:${account.id}:${slug}`, { max: 30, windowMs: 60 * 60000 });
      if (!limitedChat.ok) return sendJson(res, 429, { error: 'too_many_requests', retryAfter: limitedChat.retryAfter }), true;
      const body = await readJsonBody(req);
      if (!body.ok) return sendJson(res, body.status || 400, { error: body.error }), true;
      const result = await sandboxChat(slug, account.id, { text: body.body.text });
      return sendJson(res, result.ok ? 200 : result.status || 400, result), true;
    }

    if (rest === '/go-live' && method === 'POST') {
      const result = await goLive(slug, account.id, { ip });
      return sendJson(res, result.ok ? 200 : result.status || 400, result), true;
    }

    if (rest === '/status' && method === 'GET') {
      const result = await linkStatus(slug);
      return sendJson(res, result.ok ? 200 : 404, result), true;
    }

    if (rest === '/qr' && method === 'GET') {
      const result = await qrFor(slug, { accountId: account.id, ip });
      return sendJson(res, result.ok ? 200 : result.status || 404, result, { 'Cache-Control': 'no-store, private' }), true;
    }

    if (rest === '/pairing' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return sendJson(res, body.status || 400, { error: body.error }), true;
      const result = await requestPairingCode(slug, { accountId: account.id, number: body.body.number || null, ip });
      return sendJson(res, result.ok ? 200 : result.status || 400, result), true;
    }

    if (rest === '/pairing/code' && method === 'GET') {
      const result = await pairingCode(slug, { accountId: account.id });
      return sendJson(res, result.ok ? 200 : result.status || 400, result), true;
    }

    if (rest === '/disconnect' && method === 'POST') {
      const result = await disconnect(slug, { accountId: account.id, ip });
      return sendJson(res, result.ok ? 200 : result.status || 400, result), true;
    }

    if (rest === '/plan' && method === 'POST') {
      if (!owner) return sendJson(res, 403, { error: 'owner_only' }), true;
      if (account.role !== 'admin') {
        return sendJson(res, 403, {
          error: 'admin_only',
          message: 'Plans are assigned by the platform owner. Contact support to change yours.',
        }), true;
      }
      const body = await readJsonBody(req);
      if (!body.ok) return sendJson(res, body.status || 400, { error: body.error }), true;
      const result = assignPlan({ slug, planId: body.body.planId, accountId: account.id, ip });
      return sendJson(res, result.ok ? 200 : 400, result), true;
    }

    if (rest === '/members' && method === 'POST') {
      if (!owner) return sendJson(res, 403, { error: 'owner_only' }), true;
      const body = await readJsonBody(req);
      if (!body.ok) return sendJson(res, body.status || 400, { error: body.error }), true;
      const target = accounts.findByEmail(body.body.email);
      const role = body.body.role === 'owner' ? 'owner' : 'staff';
      if (!target || target.status !== 'active') {
        return sendJson(res, 404, {
          error: 'no_account',
          message: 'That person needs a platform account first — then you can give them view access.',
        }), true;
      }
      run(
        'INSERT INTO memberships (account_id, slug, role, created_at) VALUES (?, ?, ?, ?)',
        [target.id, slug, role, new Date().toISOString()],
      );
      recordAudit({ action: 'member_added', accountId: account.id, tenant: slug, ip, detail: { role } });
      return sendJson(res, 200, { ok: true, role }), true;
    }

    if (rest === '/usage' && method === 'GET') {
      return sendJson(res, 200, { usage: usageSummary(slug), plan: planForTenant(slug)?.plan || null }), true;
    }

    return sendJson(res, 404, { error: 'not_found' }), true;
  }

  return sendJson(res, 404, { error: 'not_found' }), true;
}

/** Cloud API webhook URL for a tenant slug (also used by the UI). */
export function webhookUrlFor(slug) {
  const base = platformPublicUrl();
  return base ? `${base}/webhook/${slug}` : null;
}

export default { handlePlatformRoute, webhookUrlFor };
