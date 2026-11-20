// src/services/sessionRecovery.js
// One broken contact should not mean re-linking the whole number.
//
// When a single chat keeps producing decryption failures — WhatsApp says
// "message absent from node", or the socket logs a Bad MAC for that address —
// the signal session for *that contact* is out of step. The usual advice is
// "delete sessions/ and scan the QR again", which logs the bot out of every
// conversation, drops the pairing, and on a Cloud-API-per-tenant setup can mean
// re-provisioning. This does the narrow thing instead: drop the encryption
// session for that one address, so the next message negotiates fresh keys, and
// leave the rest of the account alone.
//
// Boundaries, because this touches encryption state:
//   • only after N failures for that chat inside a window (default 3 in 10 min);
//   • never more than once per chat per cooldown (default 30 min);
//   • logged as an event with the chat and the count — never the content;
//   • the owner is told once per cooldown, with plain advice;
//   • reversible in the sense that matters: nothing is deleted from the bot's own
//     data, and `SESSION_RECOVERY=0` disables the whole mechanism.
//
// If the transport cannot do it (Cloud API has no signal sessions; a socket that
// is not connected), the answer is an honest refusal, not a pretend success.

import { config } from '../config/env.js';
import { logEvent } from '../utils/db.js';
import { decryptFor } from './transportAudit.js';

/** `SESSION_RECOVERY=0` turns the mechanism off. */
export function recoveryEnabled() {
  const raw = process.env.SESSION_RECOVERY;
  if (raw === undefined || raw === '') return true;
  return !['0', 'false', 'off', 'no'].includes(String(raw).toLowerCase());
}

export function recoverySettings() {
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    threshold: num(process.env.SESSION_RECOVERY_THRESHOLD, 3),
    windowMs: num(process.env.SESSION_RECOVERY_WINDOW_MINUTES, 10) * 60_000,
    cooldownMs: num(process.env.SESSION_RECOVERY_COOLDOWN_MINUTES, 30) * 60_000,
  };
}

/** chat -> { at, count } for the last clear, so a loop cannot hammer the socket. */
const cleared = new Map();

export function clearRecoveryHistory() {
  cleared.clear();
}

export function recoveryLog() {
  return [...cleared.entries()].map(([chat, row]) => ({ chat, at: new Date(row.at).toISOString(), count: row.count }));
}

/**
 * Drop the encryption session for one address.
 *
 * Baileys keeps sessions in `authState.keys`; setting an entry to `null` deletes
 * it, which is the documented way to force a fresh key exchange with that
 * contact on the next message.
 *
 * @returns {{ok:boolean, reason?:string}}
 */
export async function clearContactSession({ sock, chat } = {}) {
  if (!sock || !chat) return { ok: false, reason: 'no_socket_or_chat' };
  const keys = sock.authState?.keys || sock.sock?.authState?.keys || null;
  if (!keys || typeof keys.set !== 'function') return { ok: false, reason: 'transport_cannot_reset' };
  if (!String(chat).includes('@')) return { ok: false, reason: 'not_a_jid' };
  try {
    await keys.set({ session: { [String(chat)]: null } });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `set_failed: ${err?.message || err}` };
  }
}

/** The message the owner gets: what happened, what to do, and what it did not do. */
export function recoveryAdvice(chat = '', count = 0) {
  const number = String(chat).replace(/@.*$/, '');
  return [
    `🩺 *Session reset for +${number}*`,
    `${count} messages from this chat could not be decrypted, so I dropped the encryption session for that contact only. The next message negotiates fresh keys.`,
    '',
    'What you can do:',
    '• nothing, if this chat starts working — that is the expected outcome',
    '• if it keeps happening for many chats: make sure one bot process runs per number (.health shows the session), then re-link with .qr',
    '• if it keeps happening on this transport only: the Cloud API has no signal sessions and does not have this failure',
    '',
    'OFF: .set features.healthAlerts true is unrelated — SESSION_RECOVERY=0 disables this.',
  ].join('\n');
}

async function tellOwner(sock, chat, count) {
  try {
    const jid = `${config.owner.number}@s.whatsapp.net`;
    const send = sock?.sendMessage || sock?.send;
    if (typeof send !== 'function') return { sent: false, reason: 'no_send' };
    await send.call(sock, jid, { text: recoveryAdvice(chat, count) });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err?.message || 'send_failed' };
  }
}

/**
 * The whole decision, in one call: is this chat bad enough, and has it been
 * reset too recently? Returns what it did, so a caller can log or ignore it.
 *
 * @returns {Promise<{recovered:boolean, reason:string, count?:number, cleared?:object, notified?:object}>}
 */
export async function maybeRecoverContact({ sock, chat, now = new Date(), notify = true } = {}) {
  if (!recoveryEnabled()) return { recovered: false, reason: 'disabled' };
  if (!chat) return { recovered: false, reason: 'no_chat' };

  const settings = recoverySettings();
  const at = new Date(now).getTime();
  const count = decryptFor(chat, { windowMs: settings.windowMs, now: at });
  if (count < settings.threshold) return { recovered: false, reason: 'below_threshold', count };

  const previous = cleared.get(String(chat));
  if (previous && at - previous.at < settings.cooldownMs) {
    return { recovered: false, reason: 'cooldown', count };
  }

  const result = await clearContactSession({ sock, chat });
  if (!result.ok) {
    // Recorded once, not per attempt: the owner-facing advice does not change.
    if (!previous || at - previous.at > settings.cooldownMs) {
      cleared.set(String(chat), { at, count: 0 });
      try {
        logEvent('session_recovery_refused', String(chat).replace(/@.*$/, '').replace(/\D/g, ''), { reason: result.reason });
      } catch {
        /* ignore */
      }
    }
    return { recovered: false, reason: result.reason, count };
  }

  cleared.set(String(chat), { at, count });
  try {
    logEvent('session_recovery', String(chat).replace(/@.*$/, '').replace(/\D/g, ''), { count, windowMinutes: Math.round(settings.windowMs / 60000) });
  } catch {
    /* ignore */
  }
  const notified = notify ? await tellOwner(sock, chat, count) : { sent: false, reason: 'notify_off' };
  return { recovered: true, reason: 'cleared', count, cleared: result, notified };
}

export default {
  recoveryEnabled,
  recoverySettings,
  clearContactSession,
  maybeRecoverContact,
  recoveryAdvice,
  recoveryLog,
  clearRecoveryHistory,
};
