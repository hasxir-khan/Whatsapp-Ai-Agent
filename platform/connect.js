// platform/connect.js
// The only part of the platform that touches a live WhatsApp session.
//
// It does not speak the WhatsApp protocol. The tenant's own bot process already
// does that (src/transport/baileys.js), so the platform:
//   • asks that process what it is doing, over loopback, with the tenant's own
//     DASHBOARD_TOKEN (`Authorization: Bearer …`) — the dashboard route that
//     already exists;
//   • hands the phone-number pairing over to the bot too: `PAIRING_NUMBER` is
//     what makes Baileys call `sock.requestPairingCode()`, and the code it
//     returns is shown exactly as the library produced it (WhatsApp's own
//     format, e.g. `ABCD-1234` — never reformatted, never padded);
//   • for Cloud API tenants there is no QR at all, only a webhook URL and a
//     verify token that stays server-side.
//
// Every answer here is owner-only, rate limited, `no-store`, and never cached:
// the QR *is* the login.

import { get, run } from './db.js';
import { tenantForAccount, isTenantOwner, getTenantSecret } from './provisioning.js';
import { recordAudit } from './audit.js';
import { rateLimit } from '../src/services/adminPanel.js';

export const LINK_STATES = ['unlinked', 'waiting', 'connected', 'error'];

/** Replaced in tests: no HTTP, no process control, no phone. */
export const connectHooks = {
  probeStatus: null, // async (slug, {port, token}) => {status, pairingCode, qr, transport}
  qr: null, // async (slug) => {ok, qr, transport, ...}
  start: null,
  stop: null,
  restart: null,
};

export function setConnectHooks(next = {}) {
  for (const key of Object.keys(connectHooks)) {
    if (typeof next[key] === 'function') connectHooks[key] = next[key];
  }
  return connectHooks;
}

export function resetConnectHooks() {
  for (const key of Object.keys(connectHooks)) connectHooks[key] = null;
}

async function admin() {
  return import('../src/services/adminPanel.js');
}

function normalize(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'online' || value === 'connected' || value === 'linked') return 'connected';
  if (['waiting_for_qr', 'pairing', 'connecting', 'reconnecting', 'starting', 'waiting'].includes(value)) return 'waiting';
  if (['stopped', 'error', 'logged_out', 'not_started', 'unlinked'].includes(value)) return value === 'error' ? 'error' : 'waiting';
  return 'waiting';
}

/** Ask the tenant process what it is doing. Never follows a redirect. */
async function defaultProbeStatus(slug, { port, token } = {}) {
  if (!port) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { authorization: `Bearer ${token || ''}` },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      status: data.status || null,
      pairingCode: data.pairingCode || null,
      transport: data.transport || null,
      connectedAt: data.connectedAt || null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function setLinkState(slug, state, error = null) {
  run('UPDATE tenants SET link_status = ?, link_updated_at = ?, link_error = ? WHERE slug = ?', [
    state, new Date().toISOString(), error ? String(error).slice(0, 200) : null, slug,
  ]);
}

/**
 * Poll status for the wizard: `waiting → connected → error`.
 * The pairing code and the QR are *never* returned by this function.
 */
export async function linkStatus(slug, { now = Date.now() } = {}) {
  const tenant = get('SELECT * FROM tenants WHERE slug = ?', [String(slug)]);
  if (!tenant) return { ok: false, error: 'no_tenant', status: 'error' };

  const env = (await admin()).readTenantEnv(slug);
  const transport = (env.TRANSPORT || 'baileys').toLowerCase();
  const token = getTenantSecret(slug, 'DASHBOARD_TOKEN');
  const probe = (connectHooks.probeStatus || defaultProbeStatus);

  let live = null;
  try {
    live = await probe(slug, { port: tenant.port, token });
  } catch {
    live = null;
  }

  let state;
  let detail = null;
  if (transport === 'cloud') {
    // Cloud API has no session: "connected" means the secrets are in place.
    const ready = !!env.CLOUD_TOKEN && !!env.CLOUD_PHONE_ID && !!env.CLOUD_VERIFY_TOKEN;
    state = ready ? 'connected' : 'waiting';
    detail = ready ? 'cloud_ready' : 'cloud_not_configured';
  } else if (live?.status) {
    state = normalize(live.status);
  } else {
    // Not running (or not answering): the state we last recorded is the truth.
    state = tenant.link_status === 'connected' && !tenant.link_error ? 'connected' : 'waiting';
    if (tenant.link_error) state = 'error';
    detail = 'not_running';
  }

  if (state !== tenant.link_status) setLinkState(slug, state, state === 'error' ? tenant.link_error : null);
  return {
    ok: true,
    status: state,
    transport,
    running: !!live,
    detail,
    connectedAt: live?.connectedAt || null,
    updatedAt: new Date(Number(now)).toISOString(),
  };
}

/**
 * The QR for the browser, as a data URL or the Cloud API instructions.
 * `qrForTenant` (adminPanel) already knows how to find it — from this process's
 * botState, or from the `qr-<slug>.png` the tenant process writes — so this only
 * adds the platform's rules on top.
 */
export async function qrFor(slug, { accountId, ip = null, now = Date.now() } = {}) {
  const membership = tenantForAccount(accountId, slug);
  if (!membership) return { ok: false, status: 404, error: 'not_found' };
  if (!isTenantOwner(accountId, slug)) {
    return { ok: false, status: 403, error: 'owner_only', message: 'Only the account owner can see the QR code.' };
  }
  const limited = rateLimit(`platform-qr:${accountId}:${slug}`, { max: 20, windowMs: 60000, now: Number(now) });
  if (!limited.ok) return { ok: false, status: 429, error: 'too_many_requests', retryAfter: limited.retryAfter };

  let info = null;
  try {
    info = connectHooks.qr ? await connectHooks.qr(slug) : await (await admin()).qrForTenant(slug);
  } catch (err) {
    // No folder yet, or a tenant that was never created on disk: answer honestly
    // instead of letting the exception become a 500 with an internal message.
    recordAudit({ action: 'qr_unavailable', accountId, tenant: slug, ip, ok: false });
    return {
      ok: false,
      status: 409,
      error: 'not_ready',
      message: String(err?.message || '').includes('not_found')
        ? 'This assistant has no files on this machine yet. Finish provisioning, then ask for the QR again.'
        : 'The QR is not available right now. Start the assistant and try again.',
    };
  }
  recordAudit({ action: 'qr_viewed', accountId, tenant: slug, ip });
  if (info?.transport === 'cloud') {
    return {
      ok: true,
      transport: 'cloud',
      qr: null,
      webhookUrl: info.webhookUrl || null,
      webhookPath: info.webhookPath || `/webhook/${slug}`,
      verifyTokenSet: !!info.verifyTokenSet,
      appSecretSet: !!info.appSecretSet,
      note: info.note || 'Point Meta at this webhook and copy the verify token from your server env.',
    };
  }
  return {
    ok: true,
    transport: info?.transport || 'baileys',
    qr: info?.qr || null,
    status: info?.status || 'waiting',
    expiresInSeconds: info?.qr ? 60 : 0,
    note: info?.qr ? 'Scan this in WhatsApp → Linked devices. It changes every minute.' : info?.note || 'Start the assistant to get a QR.',
  };
}

/**
 * Phone-number pairing. The bot does the work; the platform only asks for it.
 * A 6-digit code here would be a lie — the platform account's own login code is
 * the only six-digit thing in this product.
 */
export async function requestPairingCode(slug, { accountId, number = null, ip = null, now = Date.now() } = {}) {
  if (!isTenantOwner(accountId, slug)) {
    return { ok: false, status: 403, error: 'owner_only', message: 'Only the account owner can link a number.' };
  }
  const limited = rateLimit(`platform-pair:${accountId}:${slug}`, { max: 3, windowMs: 60 * 60000, now: Number(now) });
  if (!limited.ok) return { ok: false, status: 429, error: 'too_many_requests', retryAfter: limited.retryAfter };

  const tenant = get('SELECT * FROM tenants WHERE slug = ?', [String(slug)]);
  if (!tenant) return { ok: false, status: 404, error: 'not_found' };
  const env = (await admin()).readTenantEnv(slug);
  if ((env.TRANSPORT || 'baileys').toLowerCase() === 'cloud') {
    return { ok: false, status: 400, error: 'cloud_transport', message: 'Cloud API numbers do not use a pairing code.' };
  }

  const digits = String(number || tenant.number || '').replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(digits)) return { ok: false, status: 400, error: 'bad_number' };

  try {
    (await admin()).writeTenantEnvValue(slug, 'PAIRING_NUMBER', digits);
  } catch {
    return {
      ok: false,
      status: 409,
      error: 'not_ready',
      message: 'This assistant has no .env on this machine yet. Finish provisioning first.',
    };
  }
  try {
    if (connectHooks.restart) await connectHooks.restart(slug);
    else await (await admin()).restartTenant(slug);
  } catch (err) {
    setLinkState(slug, 'error', err.message);
    return { ok: false, status: 502, error: 'restart_failed', message: 'The assistant did not start. Check its logs and try again.' };
  }

  setLinkState(slug, 'waiting');
  recordAudit({ action: 'pairing_requested', accountId, tenant: slug, ip, detail: { number: `+${digits.slice(0, 4)}…` } });
  return {
    ok: true,
    status: 'waiting',
    note:
      'Open WhatsApp on that phone → Settings → Linked devices → Link with phone number, ' +
      'then type the code the assistant shows. It appears here as soon as the bot generates it.',
    pollAfterMs: 3500,
  };
}

/** The code itself: read from the running bot, displayed verbatim. */
export async function pairingCode(slug, { accountId, now = Date.now() } = {}) {
  if (!isTenantOwner(accountId, slug)) return { ok: false, status: 403, error: 'owner_only' };
  const limited = rateLimit(`platform-paircode:${accountId}:${slug}`, { max: 20, windowMs: 60000, now: Number(now) });
  if (!limited.ok) return { ok: false, status: 429, error: 'too_many_requests', retryAfter: limited.retryAfter };

  const tenant = get('SELECT * FROM tenants WHERE slug = ?', [String(slug)]);
  const token = getTenantSecret(slug, 'DASHBOARD_TOKEN');
  const probe = connectHooks.probeStatus || defaultProbeStatus;
  let live = null;
  try {
    live = await probe(slug, { port: tenant?.port, token });
  } catch {
    live = null;
  }
  const code = live?.pairingCode || null;
  return {
    ok: true,
    code,
    status: code ? 'pairing' : 'waiting',
    // What the library returns, not what we would like it to be.
    note: code ? 'Type this on the phone exactly as shown.' : 'The assistant has not produced a code yet — this page can stay open.',
  };
}

/** Unlink: stop the bot and throw the WhatsApp session away (not the business). */
export async function disconnect(slug, { accountId, ip = null } = {}) {
  if (!isTenantOwner(accountId, slug)) return { ok: false, status: 403, error: 'owner_only' };
  const tenant = get('SELECT * FROM tenants WHERE slug = ?', [String(slug)]);
  if (!tenant) return { ok: false, status: 404, error: 'not_found' };
  try {
    if (connectHooks.stop) await connectHooks.stop(slug);
    else await (await admin()).stopTenant(slug);
  } catch {
    /* already stopped is not a failure */
  }
  let files = false;
  try {
    const { rm } = await import('node:fs/promises');
    const path = await import('node:path');
    const adminModule = await admin();
    const dir = adminModule.tenantDir(slug);
    await rm(path.join(dir, 'sessions'), { recursive: true, force: true });
    files = true;
  } catch {
    files = false;
  }
  setLinkState(slug, 'unlinked');
  recordAudit({ action: 'whatsapp_disconnected', accountId, tenant: slug, ip, detail: { sessionsRemoved: files } });
  return { ok: true, status: 'unlinked', sessionsRemoved: files };
}

/** Start a tenant through the supervisor, with a hook for tests. */
export async function startTenantViaHook(slug) {
  if (connectHooks.start) return connectHooks.start(slug);
  const adminModule = await admin();
  return adminModule.startTenant(slug);
}

/** Is this number already linked to a different account? Asked before linking, not after. */
export function numberInUseElsewhere(number, { accountId, slug = null } = {}) {
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits) return null;
  const row = get('SELECT slug, account_id FROM tenants WHERE number = ?', [digits]);
  if (!row) return null;
  if (row.account_id === accountId || row.slug === slug) return null;
  return { slug: row.slug };
}

/**
 * The code format is the library's business, but the *page* should not show
 * "undefined" or a 40-character token as if it were a pairing code. This only
 * sanity-checks what arrived; it never rewrites it.
 */
export function looksLikePairingCode(value) {
  return /^[A-Za-z0-9]{4,8}(-[A-Za-z0-9]{4})?$/.test(String(value || ''));
}

export default {
  startTenantViaHook,
  linkStatus,
  qrFor,
  requestPairingCode,
  pairingCode,
  disconnect,
  numberInUseElsewhere,
  looksLikePairingCode,
  setConnectHooks,
  resetConnectHooks,
  LINK_STATES,
};
