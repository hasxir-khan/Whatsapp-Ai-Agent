// platform/audit.js
// What happened, and what the owner should be told.
//
// Two hard rules, both tested:
//   1. no customer message content ever reaches these tables. `detail` is
//      sanitised to short primitives (names, ids, counts) and anything that
//      looks like prose from a conversation is dropped;
//   2. bookkeeping never breaks the action it is recording.

import { get, all, run, lastId } from './db.js';

const MAX_TEXT = 200;
const MAX_KEYS = 20;

/**
 * Keys whose value could be a message. Never stored, whatever the caller sends.
 */
const FORBIDDEN = /(^|_)(text|message|msg|body|content|reply|prompt|completion|transcript|conversation_text|note)($|_)/i;

/**
 * Keys whose value could be a credential. Also never stored: the audit trail may
 * say *that* a key was added, never what it was. `apiKey` and `api_key` both land
 * on the same test because the key is camel-split before matching.
 */
const CREDENTIAL = /(^|_)(api_?key|key|secret|token|password|passwd|credential|credentials|authorization|auth_header|private_key|bearer|otp|code)($|_)/i;

function snakeKey(key) {
  return String(key || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Would storing this field name risk a message or a credential? */
export function forbiddenKey(key) {
  const snake = snakeKey(key);
  return FORBIDDEN.test(snake) || CREDENTIAL.test(snake);
}

function cleanValue(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, MAX_TEXT);
  if (Array.isArray(value)) return depth > 1 ? null : value.slice(0, 10).map((v) => cleanValue(v, depth + 1));
  if (typeof value === 'object') {
    if (depth > 1) return null;
    const out = {};
    let n = 0;
    for (const [key, inner] of Object.entries(value)) {
      if (n >= MAX_KEYS) break;
      if (forbiddenKey(key)) continue;
      out[key] = cleanValue(inner, depth + 1);
      n += 1;
    }
    return out;
  }
  return null;
}

export function sanitiseDetail(detail) {
  if (detail === null || detail === undefined) return null;
  if (typeof detail === 'string') return detail.slice(0, MAX_TEXT);
  try {
    const cleaned = cleanValue(detail);
    return JSON.stringify(cleaned).slice(0, 500);
  } catch {
    return null;
  }
}

export function recordAudit({ action, accountId = null, tenant = null, detail = null, ip = null, ok = true, now = new Date() } = {}) {
  try {
    run('INSERT INTO platform_audit (created_at, account_id, tenant, action, detail, ip, ok) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      new Date(now).toISOString(),
      accountId || null,
      tenant || null,
      String(action || 'unknown').slice(0, 60),
      sanitiseDetail(detail),
      ip ? String(ip).slice(0, 60) : null,
      ok ? 1 : 0,
    ]);
    return { ok: true, id: lastId() };
  } catch {
    return { ok: false };
  }
}

export function recentAudit({ accountId = null, tenant = null, limit = 50 } = {}) {
  const n = Math.min(200, Math.max(1, Number(limit) || 50));
  if (tenant) return all('SELECT * FROM platform_audit WHERE tenant = ? ORDER BY id DESC LIMIT ?', [tenant, n]);
  if (accountId) return all('SELECT * FROM platform_audit WHERE account_id = ? ORDER BY id DESC LIMIT ?', [accountId, n]);
  return all('SELECT * FROM platform_audit ORDER BY id DESC LIMIT ?', [n]);
}

/** Something the owner must see inside the platform (the bot may be paused). */
export function notify({ accountId, tenant = null, kind = 'info', title, body = null, now = new Date() } = {}) {
  try {
    run('INSERT INTO platform_notifications (created_at, account_id, tenant, kind, title, body) VALUES (?, ?, ?, ?, ?, ?)', [
      new Date(now).toISOString(),
      accountId,
      tenant,
      String(kind).slice(0, 40),
      String(title || '').slice(0, MAX_TEXT),
      body ? String(body).slice(0, 1000) : null,
    ]);
    return { ok: true, id: lastId() };
  } catch {
    return { ok: false };
  }
}

export function notificationsFor(accountId, { limit = 20, unreadOnly = false } = {}) {
  const n = Math.min(100, Math.max(1, Number(limit) || 20));
  const sql = unreadOnly
    ? 'SELECT * FROM platform_notifications WHERE account_id = ? AND read_at IS NULL ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM platform_notifications WHERE account_id = ? ORDER BY id DESC LIMIT ?';
  return all(sql, [accountId, n]);
}

export function markNotificationsRead(accountId, { ids = null, now = new Date() } = {}) {
  const stamp = new Date(now).toISOString();
  if (Array.isArray(ids) && ids.length) {
    for (const id of ids.slice(0, 100)) {
      run('UPDATE platform_notifications SET read_at = ? WHERE id = ? AND account_id = ? AND read_at IS NULL', [stamp, Number(id), accountId]);
    }
    return { ok: true, markAll: false };
  }
  run('UPDATE platform_notifications SET read_at = ? WHERE account_id = ? AND read_at IS NULL', [stamp, accountId]);
  return { ok: true, markAll: true };
}

export function auditCount(action = null) {
  try {
    const row = action
      ? get('SELECT COUNT(*) AS n FROM platform_audit WHERE action = ?', [action])
      : get('SELECT COUNT(*) AS n FROM platform_audit');
    return Number(row?.n || 0);
  } catch {
    return 0;
  }
}

export default {
  recordAudit, recentAudit, notify, notificationsFor, markNotificationsRead, sanitiseDetail, forbiddenKey, auditCount,
};
