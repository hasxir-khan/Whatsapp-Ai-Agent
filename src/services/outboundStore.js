// src/services/outboundStore.js
// "I have that message" — the answer WhatsApp asks for and we did not have.
//
// When a recipient's phone cannot decrypt a message it sends a retry receipt and
// WhatsApp asks the sender for the original payload via `getMessage(key)`. The
// bot answered `undefined` for everything, so the bubble sat on *Waiting for
// this message* until the client gave up. This store keeps the payload we sent,
// keyed by the id WhatsApp gave us back, for a short window.
//
// Rules, because this is the one place that keeps outgoing text twice:
//   • 48 hours by default (GETMESSAGE_HOURS), then gone;
//   • a hard row cap (GETMESSAGE_MAX_ROWS, default 5000), oldest first;
//   • a byte cap per row: media payloads embed Buffers and are skipped rather
//     than stored as megabyte-sized JSON — a retry for those cannot be answered
//     from here, and pretending otherwise would bloat the database;
//   • nothing here is ever logged, printed or put in an incident;
//   • it is covered by `.export` (the contact gets it) and `.forget` (it goes
//     with them), and by the general retention purge.

import { run, all, get } from '../utils/db.js';
import { config } from '../config/env.js';

const DEFAULT_HOURS = 48;
const DEFAULT_MAX_ROWS = 5000;
const DEFAULT_MAX_BYTES = 4096;

/** Is the store on? `OUTBOUND_STORE=0` turns it off (getMessage returns nothing). */
export function outboundStoreEnabled() {
  const raw = process.env.OUTBOUND_STORE;
  if (raw === undefined || raw === '') return true;
  return !['0', 'false', 'off', 'no'].includes(String(raw).toLowerCase());
}

export function outboundWindowHours() {
  const hours = Number(process.env.GETMESSAGE_HOURS);
  return Number.isFinite(hours) && hours > 0 ? Math.min(24 * 14, Math.floor(hours)) : DEFAULT_HOURS;
}

export function outboundMaxRows() {
  const rows = Number(process.env.GETMESSAGE_MAX_ROWS);
  return Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : DEFAULT_MAX_ROWS;
}

function maxBytes() {
  const bytes = Number(process.env.GETMESSAGE_MAX_BYTES);
  return Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : DEFAULT_MAX_BYTES;
}

/**
 * What Baileys expects back from `getMessage`: an IMessage. We stored the
 * *payload we sent* (`{ text: '…' }`), so this converts it to the shape a
 * receive path would see. Anything we cannot express is not stored at all.
 */
export function toMessage(payload = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (text) return { conversation: text };
  if (payload.extendedTextMessage) return { extendedTextMessage: payload.extendedTextMessage };
  // A reaction is small and is its own message type.
  if (payload.react) return { reactionMessage: { text: String(payload.react.text || ''), key: payload.react.key || null } };
  // Everything else (media buffers, buttons, lists) is either too large or
  // cannot be rebuilt from JSON. Not stored — the honest answer is `undefined`.
  return null;
}

/**
 * Keep one sent message. Returns what happened, which the caller may ignore.
 * @returns {{stored:boolean, reason?:string, id?:string}}
 */
export function storeOutbound({ id, jid = null, payload = {}, now = new Date() } = {}) {
  if (!outboundStoreEnabled()) return { stored: false, reason: 'disabled' };
  if (!id || !jid) return { stored: false, reason: 'missing_id_or_jid' };

  const message = toMessage(payload);
  if (!message) return { stored: false, reason: 'unsupported_kind' };

  let body;
  try {
    body = JSON.stringify(message);
  } catch {
    return { stored: false, reason: 'unserialisable' };
  }
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > maxBytes()) return { stored: false, reason: 'too_large' };

  const when = new Date(now);
  const expires = new Date(when.getTime() + outboundWindowHours() * 3_600_000);
  try {
    run(
      'INSERT OR REPLACE INTO outbound_messages (id, chat, kind, body, bytes, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
      [String(id), String(jid), 'text', body, bytes, when.toISOString(), expires.toISOString()]
    );
    // Cheap with the index, and it keeps the cap honest even on a busy day.
    purgeOutbound({ now: when });
    return { stored: true, id: String(id) };
  } catch {
    // A store failure must never fail a send.
    return { stored: false, reason: 'db_error' };
  }
}

/** The payload for one outgoing id, or null when unknown/expired. */
export function getStoredOutbound(id, { now = new Date() } = {}) {
  if (!outboundStoreEnabled() || !id) return null;
  const row = get('SELECT * FROM outbound_messages WHERE id = ?', [String(id)]);
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= new Date(now).getTime()) {
    try {
      run('DELETE FROM outbound_messages WHERE id = ?', [String(id)]);
    } catch {
      /* the purge will find it */
    }
    return null;
  }
  try {
    return { id: row.id, chat: row.chat, message: JSON.parse(row.body), createdAt: row.created_at, expiresAt: row.expires_at };
  } catch {
    return null;
  }
}

/**
 * The function handed to Baileys as `getMessage`. This is the whole point of the
 * module: a key in, the message we sent back, or `undefined` — never a throw,
 * because a throw inside Baileys' retry path is a dropped message.
 */
export async function storedMessage(key = {}) {
  try {
    const row = getStoredOutbound(key?.id);
    return row ? row.message : undefined;
  } catch {
    return undefined;
  }
}

/** Drop expired rows and anything past the cap. Returns how many went. */
export function purgeOutbound({ now = new Date(), hours = outboundWindowHours(), maxRows = outboundMaxRows() } = {}) {
  const when = new Date(now);
  let removed = 0;
  try {
    const before = get('SELECT COUNT(*) AS n FROM outbound_messages')?.n || 0;
    const cutoff = new Date(when.getTime() - Math.max(1, hours) * 3_600_000).toISOString();
    run('DELETE FROM outbound_messages WHERE expires_at <= ?', [when.toISOString()]);
    run('DELETE FROM outbound_messages WHERE created_at < ?', [cutoff]);
    const after = get('SELECT COUNT(*) AS n FROM outbound_messages')?.n || 0;
    if (after > maxRows) {
      run(
        `DELETE FROM outbound_messages WHERE id IN (
           SELECT id FROM outbound_messages ORDER BY created_at ASC LIMIT ?
         )`,
        [after - maxRows]
      );
    }
    const final = get('SELECT COUNT(*) AS n FROM outbound_messages')?.n || 0;
    removed = Math.max(0, before - final);
  } catch {
    return 0;
  }
  return removed;
}

/** Counts for `.health` / `.status` (no content). */
export function outboundStoreStats({ now = new Date() } = {}) {
  try {
    const rows = get('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM outbound_messages')?.n || 0;
    const bytes = get('SELECT COALESCE(SUM(bytes),0) AS b FROM outbound_messages')?.b || 0;
    const oldest = get('SELECT MIN(created_at) AS c FROM outbound_messages')?.c || null;
    const expiring = get('SELECT COUNT(*) AS n FROM outbound_messages WHERE expires_at <= ?', [new Date(now.getTime() + 3_600_000).toISOString()])?.n || 0;
    return {
      enabled: outboundStoreEnabled(),
      rows,
      bytes,
      oldest,
      expiringSoon: expiring,
      hours: outboundWindowHours(),
      maxRows: outboundMaxRows(),
    };
  } catch {
    return { enabled: outboundStoreEnabled(), rows: 0, bytes: 0, oldest: null, expiringSoon: 0, hours: outboundWindowHours(), maxRows: outboundMaxRows() };
  }
}

/** A one-line summary for `.health`, and nothing that could be content. */
export function outboundStoreLine({ now = new Date() } = {}) {
  const stats = outboundStoreStats({ now });
  if (!stats.enabled) return 'Retry store: off (OUTBOUND_STORE=0) — retries cannot be answered';
  return `Retry store: ${stats.rows}/${stats.maxRows} messages · ${Math.round(stats.bytes / 1024)} KB · ${stats.hours}h window`;
}

/** Rows for one contact, for `.export`. */
export function outboundFor(rawNumber) {
  const digits = String(rawNumber || '').replace(/[^\d]/g, '');
  if (!digits) return [];
  try {
    return all('SELECT created_at, expires_at, kind, body FROM outbound_messages WHERE chat = ? OR chat = ? ORDER BY created_at', [
      `${digits}@s.whatsapp.net`,
      `${digits}@lid`,
    ]).map((row) => {
      let text = null;
      try {
        text = JSON.parse(row.body).conversation || null;
      } catch {
        text = null;
      }
      return { createdAt: row.created_at, expiresAt: row.expires_at, kind: row.kind, text };
    });
  } catch {
    return [];
  }
}

let purgeTimer = null;

/** Hourly is plenty for a 48-hour window; unref'd so it never holds a process open. */
export function startOutboundPurge({ intervalMs = 60 * 60 * 1000, onError = null, now = () => new Date() } = {}) {
  if (purgeTimer) return purgeTimer;
  if (!outboundStoreEnabled()) return null;
  purgeTimer = setInterval(() => {
    try {
      const removed = purgeOutbound({ now: now() });
      if (removed) console.log(`🧹 Retry store: ${removed} expired message(s) removed`);
    } catch (err) {
      onError?.(err);
    }
  }, intervalMs);
  purgeTimer.unref?.();
  return purgeTimer;
}

export function stopOutboundPurge() {
  if (purgeTimer) clearInterval(purgeTimer);
  purgeTimer = null;
}

export const OUTBOUND_STORE_DEFAULTS = {
  hours: DEFAULT_HOURS,
  maxRows: DEFAULT_MAX_ROWS,
  maxBytes: DEFAULT_MAX_BYTES,
  root: config.root,
};

export default {
  outboundStoreEnabled,
  outboundWindowHours,
  outboundMaxRows,
  storeOutbound,
  getStoredOutbound,
  storedMessage,
  purgeOutbound,
  outboundStoreStats,
  outboundStoreLine,
  outboundFor,
  startOutboundPurge,
  stopOutboundPurge,
  toMessage,
};
