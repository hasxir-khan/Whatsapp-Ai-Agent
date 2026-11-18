// src/services/health.js
// Reliability alerts, for the owner — not for the customer.
//
// The hard case in a WhatsApp bot is silence: the socket dropped at 2am, the
// free LLM tier ran out, the disk filled, the replies are sitting in the
// outbox, and nobody notices until a customer complains. This module looks at
// the same facts the dashboard sees, turns them into incidents with a start and
// an end, and tells the owner once.
//
// Three rules, because an alerting system that cries wolf gets muted:
//   1. One message per incident, not one per check. Dedupe is by a stable key.
//   2. A cooldown. If it is still broken after N minutes, it may say so once
//      more — not every minute.
//   3. A recovery message, so "back online" is as visible as "down".
//
// And one more: alerts must never depend on the thing that is broken. If the
// WhatsApp transport is down, the incident is still recorded, the dashboard and
// `node scripts/doctor.js` still show it, and ALERT_WEBHOOK_URL (if set) still
// gets a POST. There is always a second channel or there is no alert at all.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';
import { botState } from '../state.js';
import { featureOn } from './profile.js';
import { isOpen, parseHours } from './hours.js';
import { tenantBudget, llmStatus } from '../core/llm.js';
import { getUsage, all, get, logEvent } from '../utils/db.js';
import {
  findOpenIncident,
  openIncident,
  markIncidentNotified,
  resolveIncident,
  openIncidents,
  recentIncidents,
  incidentStats,
} from '../utils/db.js';

// ── settings ────────────────────────────────────────────────

export function alertsEnabled() {
  return featureOn('healthAlerts');
}

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function alertSettings() {
  return {
    cooldownMs: num(process.env.ALERT_COOLDOWN_MINUTES, 30) * 60_000,
    outboxMinutes: num(process.env.ALERT_OUTBOX_MINUTES, 10),
    reconnectCount: num(process.env.ALERT_RECONNECTS, 3),
    reconnectWindowMinutes: num(process.env.ALERT_RECONNECT_WINDOW_MINUTES, 10),
    slaMinutes: num(process.env.SLA_ALERT_MINUTES, 15),
    includeContent: String(process.env.ALERT_INCLUDE_CONTENT || '').toLowerCase() === 'true',
    backupMaxAgeDays: num(process.env.BACKUP_MAX_AGE_DAYS, 7),
    diskWarnPercent: num(process.env.DISK_WARN_PERCENT, 10),
    diskBadPercent: num(process.env.DISK_BAD_PERCENT, 5),
    llmFailures: num(process.env.ALERT_LLM_FAILURES, 3),
  };
}

/** Where backups land, so "no backup in a week" is a real check, not a guess. */
export function backupDir() {
  return process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(config.root, 'backups');
}

const nowIso = (now) => new Date(now).toISOString();
const minutesAgo = (now, minutes) => new Date(new Date(now).getTime() - minutes * 60_000).toISOString();

// ── the checks ──────────────────────────────────────────────
// Each returns { key, kind, severity, ok, detail }. `key` is the dedupe key:
// stable while the thing is broken, so one incident does not become fifty.

function transportCheck(now) {
  void now;
  // botState is the single source of truth for "is the socket up": the
  // dashboard, the doctor and this check all read it, and the transport writes
  // it. A separate "am I connected" probe here would be a second opinion that
  // can disagree with the one the owner sees.
  const status = String(botState.status || 'starting');
  const healthy = ['online', 'connecting', 'starting', 'pairing', 'waiting_for_qr'];
  if (healthy.includes(status)) {
    return { key: 'transport', kind: 'transport', ok: true, detail: status };
  }
  const bad = ['logged_out', 'logged out', 'stopped', 'error', 'failed'].includes(status);
  return {
    key: 'transport',
    kind: 'transport',
    severity: bad ? 'bad' : 'warn',
    ok: false,
    detail: status,
  };
}

function reconnectCheck(now) {
  const { reconnectCount, reconnectWindowMinutes } = alertSettings();
  const since = minutesAgo(now, reconnectWindowMinutes);
  const row = get(
    "SELECT COUNT(*) AS n FROM events WHERE type IN ('connection_lost','reconnect','transport_error') AND created_at >= ?",
    [since]
  );
  const failures = row?.n || 0;
  if (failures < Math.max(1, reconnectCount)) return { key: 'reconnects', kind: 'reconnects', ok: true, detail: `${failures}` };
  return {
    key: 'reconnects',
    kind: 'reconnects',
    severity: 'bad',
    ok: false,
    detail: `${failures} in ${reconnectWindowMinutes} min`,
  };
}

function outboxCheck(now) {
  const { outboxMinutes } = alertSettings();
  const row = get("SELECT MIN(created_at) AS oldest, COUNT(*) AS n FROM outbox WHERE status = 'pending'");
  const pending = row?.n || 0;
  if (!pending || !row?.oldest) return { key: 'outbox', kind: 'outbox', ok: true, detail: '0' };

  const ageMinutes = Math.round((new Date(now).getTime() - new Date(row.oldest).getTime()) / 60_000);
  if (ageMinutes < outboxMinutes) return { key: 'outbox', kind: 'outbox', ok: true, detail: `${pending}` };
  return {
    key: 'outbox',
    kind: 'outbox',
    severity: ageMinutes >= outboxMinutes * 3 ? 'bad' : 'warn',
    ok: false,
    detail: `${pending} queued, oldest ${ageMinutes} min`,
  };
}

function llmCheck(now) {
  const status = llmStatus();
  const providers = Array.isArray(status.providers) ? status.providers : [];
  if (!providers.length) {
    return { key: 'llm', kind: 'llm', severity: 'warn', ok: false, detail: 'no provider configured' };
  }

  const used = getUsage().llm_calls || 0;
  if (config.limits.dailyLlmCalls && used >= config.limits.dailyLlmCalls) {
    return { key: 'llm', kind: 'llm', severity: 'bad', ok: false, detail: `daily quota reached (${used}/${config.limits.dailyLlmCalls})` };
  }

  const { llmFailures } = alertSettings();
  const failures = get(
    "SELECT COUNT(*) AS n FROM events WHERE type IN ('llm_error','llm_rate_limited','llm_all_failed') AND created_at >= ?",
    [minutesAgo(now, 10)]
  )?.n || 0;
  if (failures >= Math.max(1, llmFailures)) {
    return { key: 'llm', kind: 'llm', severity: 'bad', ok: false, detail: `${failures} failures in 10 min` };
  }
  return { key: 'llm', kind: 'llm', ok: true, detail: `used ${used}` };
}

function tenantBudgetCheck() {
  const budget = tenantBudget();
  if (!budget.exceeded) return { key: 'tenant_budget', kind: 'tenant_budget', ok: true, detail: `${budget.used}/${budget.cap}` };
  return {
    key: 'tenant_budget',
    kind: 'tenant_budget',
    severity: 'warn',
    ok: false,
    detail: `${budget.tenant}: ${budget.used}/${budget.cap}`,
  };
}

let statfsImpl = fs.statfsSync;
export function setStatfs(impl) {
  statfsImpl = impl || fs.statfsSync;
}

function diskCheck() {
  const { diskWarnPercent, diskBadPercent } = alertSettings();
  let stats;
  try {
    if (typeof statfsImpl !== 'function') return { key: 'disk', kind: 'disk', ok: true, detail: 'unavailable' };
    stats = statfsImpl(config.paths.data);
  } catch {
    return { key: 'disk', kind: 'disk', ok: true, detail: 'unavailable' };
  }
  const total = Number(stats.bsize) * Number(stats.blocks);
  const free = Number(stats.bsize) * Number(stats.bavail ?? stats.bfree);
  if (!total) return { key: 'disk', kind: 'disk', ok: true, detail: 'unavailable' };

  const percentFree = Math.round((free / total) * 100);
  if (percentFree <= diskBadPercent) {
    return { key: 'disk', kind: 'disk', severity: 'bad', ok: false, detail: `${percentFree}% free` };
  }
  if (percentFree <= diskWarnPercent) {
    return { key: 'disk', kind: 'disk', severity: 'warn', ok: false, detail: `${percentFree}% free` };
  }
  return { key: 'disk', kind: 'disk', ok: true, detail: `${percentFree}% free` };
}

function backupCheck(now) {
  const { backupMaxAgeDays } = alertSettings();
  const dir = backupDir();
  let newest = 0;
  try {
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (!/\.(json\.gz|zip|tar\.gz)$/i.test(name)) continue;
        const stat = fs.statSync(path.join(dir, name));
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      }
    }
  } catch {
    /* an unreadable folder is the same as no backup */
  }

  if (!newest) return { key: 'backup', kind: 'backup', severity: 'warn', ok: false, detail: 'no backup found' };
  const ageDays = Math.floor((new Date(now).getTime() - newest) / 86_400_000);
  if (ageDays >= backupMaxAgeDays) {
    return { key: 'backup', kind: 'backup', severity: 'warn', ok: false, detail: `last backup ${ageDays} days ago` };
  }
  return { key: 'backup', kind: 'backup', ok: true, detail: `${ageDays}d old` };
}

/**
 * SLA: a customer wrote, and nobody — bot or owner — answered.
 * Business hours only, so an overnight message is not an incident at 3am.
 * Paused and blocked chats are excluded: silence there is on purpose.
 */
export function slaBreaches(now = new Date(), { minutes = alertSettings().slaMinutes } = {}) {
  const hoursSpec = config.owner.profile?.business?.hours;
  const parsed = parseHours(hoursSpec);
  const timeZone = config.timezone;

  const rows = all(
    `SELECT m.number AS number, MAX(m.created_at) AS last_at
       FROM messages m
      WHERE m.role = 'user' AND m.created_at >= ?
      GROUP BY m.number`,
    [minutesAgo(now, 24 * 60)]
  );

  const breaches = [];
  for (const row of rows) {
    const lastAt = new Date(row.last_at);
    const waited = Math.round((now.getTime() - lastAt.getTime()) / 60_000);
    if (waited < minutes) continue;

    // Was there an answer after that message?
    const answered = get(
      "SELECT id FROM messages WHERE number = ? AND role IN ('assistant','owner','system') AND created_at > ? LIMIT 1",
      [row.number, row.last_at]
    );
    if (answered) continue;

    const contact = get('SELECT * FROM contacts WHERE number = ?', [row.number]);
    if (!contact) continue;
    if (contact.is_blocked) continue;
    if (contact.bot_paused_until && new Date(contact.bot_paused_until) > now) continue;
    if (get('SELECT 1 AS x FROM growth_optouts WHERE number = ?', [row.number])) continue;

    // Business hours: if the message would have been handled while closed, it
    // is not an SLA miss — it is a closed shop.
    if (parsed.known) {
      const verdict = isOpen(lastAt, { hours: parsed, timeZone });
      if (!verdict.open) continue;
    }

    breaches.push({ number: row.number, waited, lastAt: row.last_at, name: contact.name || contact.push_name || '' });
  }
  return breaches;
}

function slaCheck(now) {
  const { slaMinutes, includeContent } = alertSettings();
  const breaches = slaBreaches(now, { minutes: slaMinutes });
  if (!breaches.length) return [];
  return breaches.map((breach) => {
    const who = breach.name ? `${breach.name} (+${breach.number})` : `+${breach.number}`;
    // Content is opt-in: the default summary says a chat is waiting, not what
    // the customer said.
    const detail = includeContent ? `${who} waiting ${breach.waited} min` : `a chat is waiting ${breach.waited} min`;
    return {
      key: `sla:${breach.number}`,
      kind: 'sla',
      severity: 'warn',
      ok: false,
      detail,
      number: breach.number,
    };
  });
}

/** Every check, as data. This is also what /api/status and doctor read. */
export function runChecks(now = new Date()) {
  const checks = [
    transportCheck(now),
    reconnectCheck(now),
    outboxCheck(now),
    llmCheck(now),
    tenantBudgetCheck(),
    diskCheck(),
    backupCheck(now),
    ...slaCheck(now),
  ];
  return checks;
}

export function healthSnapshot(now = new Date()) {
  const checks = runChecks(now);
  const failing = checks.filter((c) => !c.ok);
  return {
    enabled: alertsEnabled(),
    status: failing.length ? (failing.some((c) => c.severity === 'bad') ? 'down' : 'degraded') : 'ok',
    checks,
    failing: failing.map(({ key, kind, severity, detail }) => ({ key, kind, severity, detail })),
    incidents: incidentStats(),
    open: openIncidents().map((i) => ({ kind: i.kind, severity: i.severity, detail: i.detail, opened_at: i.opened_at })),
  };
}

// ── talking to the owner ────────────────────────────────────

const KIND_LABELS = {
  transport: 'WhatsApp connection',
  reconnects: 'Reconnect loop',
  outbox: 'Replies stuck in the outbox',
  llm: 'AI provider',
  tenant_budget: 'Tenant AI budget',
  disk: 'Disk space',
  backup: 'Backups',
  sla: 'A chat is waiting',
};

function alertText(incident) {
  const label = KIND_LABELS[incident.kind] || incident.kind;
  const icon = incident.severity === 'bad' ? '🔴' : '🟠';
  return `${icon} *${label}*: ${incident.detail || 'problem'}\nIt will show in /api/status and .health. I will tell you when it clears.`;
}

function recoveryText(incident) {
  const label = KIND_LABELS[incident.kind] || incident.kind;
  const minutes = Math.max(1, Math.round((Date.now() - new Date(incident.opened_at).getTime()) / 60_000));
  // "Back online" for the socket, "back to normal" for everything else: the
  // owner should not have to parse a generic sentence to know what recovered.
  const state = incident.kind === 'transport' ? 'is back online' : 'is back to normal';
  return `🟢 *${label}* ${state} (was out for ${minutes} min).`;
}

function ownerJid() {
  return config.owner.jid || `${config.owner.number}@s.whatsapp.net`;
}

async function sendOwner(text) {
  // The transport may be the broken thing. Try, and never throw.
  // `transport.sendMessage` is the transport-agnostic door (Baileys forwards to
  // the socket, Cloud posts to the Graph API), so this path works on both.
  try {
    const { getTransport } = await import('../transport/index.js');
    const transport = getTransport();
    if (!transport) return false;
    if (typeof transport.sendMessage === 'function') {
      await transport.sendMessage(ownerJid(), { text });
      return true;
    }
    const sock = transport.sock;
    if (!sock || typeof sock.sendMessage !== 'function') return false;
    await sock.sendMessage(ownerJid(), { text });
    return true;
  } catch {
    return false;
  }
}

/**
 * The second channel. A webhook that is down must cost nothing: five seconds,
 * one attempt, errors swallowed into the log.
 */
export async function postWebhook(payload, { url = process.env.ALERT_WEBHOOK_URL, timeoutMs = 5000 } = {}) {
  const target = String(url || '').trim();
  if (!target) return { ok: false, reason: 'not_configured' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return { ok: response.ok, status: response.status };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

// ── one pass over the checks ────────────────────────────────

/**
 * Run every check, open/resolve incidents, notify with dedupe + cooldown.
 * Never throws: an alerting loop that dies is worse than no loop.
 *
 * @returns {Promise<{opened:Array, resolved:Array, notified:Array, checks:Array}>}
 */
export async function runHealthCheck(now = new Date(), { notify = true } = {}) {
  const result = { opened: [], resolved: [], notified: [], checks: [] };
  if (!alertsEnabled()) return result;

  let checks;
  try {
    checks = runChecks(now);
  } catch (err) {
    logEvent('health_check_error', null, err.message);
    return result;
  }
  result.checks = checks;

  const { cooldownMs } = alertSettings();
  const stillFailing = new Set();

  for (const check of checks) {
    if (check.ok) continue;
    stillFailing.add(check.key);

    let incident = findOpenIncident(check.key);
    if (!incident) {
      incident = openIncident({
        key: check.key,
        kind: check.kind,
        severity: check.severity || 'warn',
        detail: check.detail || null,
      });
      result.opened.push(incident);
      logEvent('health_incident', null, { kind: check.kind, detail: check.detail });
    } else if (incident.detail !== check.detail) {
      // Keep the detail current without turning it into a new incident.
      try {
        const { run } = await import('../utils/db.js');
        run('UPDATE incidents SET detail = ? WHERE id = ?', [check.detail || null, incident.id]);
        incident.detail = check.detail;
      } catch {
        /* a stale detail is not worth a crash */
      }
    }

    const lastNotified = incident.notified_at ? new Date(incident.notified_at).getTime() : 0;
    const due = !lastNotified || new Date(now).getTime() - lastNotified >= cooldownMs;
    if (notify && due) {
      const text = alertText(incident);
      const sent = await sendOwner(text);
      await postWebhook({
        type: 'incident',
        kind: incident.kind,
        severity: incident.severity,
        detail: incident.detail,
        tenant: config.tenant.slug,
        at: nowIso(now),
      });
      markIncidentNotified(incident.id, nowIso(now));
      result.notified.push({ id: incident.id, kind: incident.kind, viaWhatsApp: sent });
    }
  }

  // Anything open that is no longer failing has recovered.
  for (const incident of openIncidents()) {
    if (stillFailing.has(incident.key)) continue;
    resolveIncident(incident.id);
    result.resolved.push(incident);
    logEvent('health_recovered', null, { kind: incident.kind });
    if (notify) {
      await sendOwner(recoveryText(incident));
      await postWebhook({
        type: 'recovery',
        kind: incident.kind,
        tenant: config.tenant.slug,
        at: nowIso(now),
      });
    }
  }

  return result;
}

// ── the loop ────────────────────────────────────────────────

let timer = null;

export function startHealthMonitor({ intervalMs = Number(process.env.HEALTH_CHECK_SECONDS || 60) * 1000, onError = null } = {}) {
  if (timer) return timer;
  if (!alertsEnabled()) return null;
  // First pass shortly after boot: a crash-looping bot should say so early.
  timer = setInterval(() => {
    runHealthCheck().catch((err) => {
      if (onError) onError(err);
    });
  }, Math.max(10_000, intervalMs));
  timer.unref?.();
  return timer;
}

export function stopHealthMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Incident history is part of the public surface: `.incidents` and the doctor
// both read it, and neither should have to know which table it lives in.
export { recentIncidents, openIncidents };

export default {
  alertsEnabled,
  alertSettings,
  runChecks,
  runHealthCheck,
  healthSnapshot,
  slaBreaches,
  postWebhook,
  startHealthMonitor,
  stopHealthMonitor,
  recentIncidents,
  openIncidents,
};
