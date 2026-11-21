// src/services/outbox.js
// Never lose a reply to a bad connection.
//
// WhatsApp drops messages when the phone/server connection blips: the socket
// says "closed", the send throws, and a client who was mid-conversation gets
// silence. This module makes every outbound send go through a queue:
//
//   send → works? sent, done
//        → retryable failure? saved to the outbox, retried automatically,
//          and flushed the moment the connection is back
//        → permanent failure (blocked, logged out)? dropped loudly
//
// The bot has to be running for any of this (nothing can answer while the
// process is off), but it now survives flaky internet, reconnects and restarts
// without eating client messages.

import { isPrivateMedia } from './ephemeralMedia.js';
import { config } from '../config/env.js';
import {
  enqueueOutbox, dueOutbox, updateOutbox, outboxStats, pruneOutbox, logEvent, bumpUsage,
} from '../utils/db.js';
import { botState } from '../state.js';

const MAX_TRIES = 5;
const RETRY_WINDOW_MS = 30 * 60 * 1000; // give up after 30 minutes of trying

/** Failures worth retrying later (network / socket), vs. permanent ones. */
export function isRetryable(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = err?.status || err?.output?.statusCode;

  if (status === 401 || status === 403 || status === 405) return false; // unauthorized / method
  if (/blocked|not authorized|forbidden|invalid jid|item-not-found/.test(msg)) return false;

  return (
    /connection|closed|timeout|timed out|timedout|etimedout|econnreset|econnrefused|econnaborted|epipe|enotfound|eai_again|socket|not open|network|failed to send|stream error|428/.test(
      msg
    ) || !msg
  );
}

const kindOf = (payload = {}) => {
  if (payload.text) return 'text';
  if (payload.audio) return 'audio';
  if (payload.image) return 'image';
  if (payload.video) return 'video';
  if (payload.document) return 'document';
  return 'other';
};

/**
 * Send through the queue. Returns the WhatsApp message on success, or
 * `{ queued: true }` when the payload was stored for later.
 */
export async function sendReliable(sock, jid, payload) {
  if (config.dryRun) {
    return sock.sendMessage(jid, payload);
  }

  try {
    return await sock.sendMessage(jid, payload);
  } catch (err) {
    if (isPrivateMedia()) throw new Error('private_media_send_failed');
    if (!isRetryable(err)) throw err;

    const row = enqueueOutbox(jid, payload, { kind: kindOf(payload), error: err.message });
    logEvent('outbox_queued', jid.split('@')[0], { kind: kindOf(payload), error: String(err.message).slice(0, 120) });
    console.log(`📥 Not sent (${err.message.slice(0, 40)}) — queued for retry`);
    return { queued: true, id: row?.id };
  }
}

/** Try to deliver everything pending. Safe to call repeatedly. */
export async function flushOutbox(sock, { limit = 25 } = {}) {
  if (!sock) return { sent: 0, failed: 0, pending: 0 };

  const rows = dueOutbox(limit);
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      updateOutbox(row.id, { status: 'failed', error: 'unreadable payload' });
      failed += 1;
      continue;
    }

    const tooOld = Date.now() - new Date(row.created_at).getTime() > RETRY_WINDOW_MS;
    if (row.tries >= MAX_TRIES || tooOld) {
      updateOutbox(row.id, { status: 'failed', error: row.error || 'gave up (too many attempts)' });
      logEvent('outbox_failed', row.jid.split('@')[0], {
        tries: row.tries,
        kind: row.kind,
        reason: tooOld ? 'expired' : 'max tries',
      });
      failed += 1;
      continue;
    }

    try {
      await sock.sendMessage(row.jid, payload);
      updateOutbox(row.id, { status: 'sent' });
      sent += 1;
    } catch (err) {
      updateOutbox(row.id, { error: String(err.message).slice(0, 200), bumpTries: true });
      logEvent('outbox_retry_failed', row.jid.split('@')[0], { error: String(err.message).slice(0, 120) });

      if (isRetryable(err)) break; // still offline — keep the rest queued
      updateOutbox(row.id, { status: 'failed' });
      failed += 1;
    }
  }

  if (sent) {
    bumpUsage('outbox_sent', sent);
    console.log(`📤 Delivered ${sent} queued message${sent === 1 ? '' : 's'}`);
    logEvent('outbox_flushed', null, { sent, failed });
  }

  return { sent, failed, pending: outboxStats().pending };
}

/** Background retry loop while the bot is online. */
export function startOutboxLoop(sock, { intervalMs = 25000 } = {}) {
  const timer = setInterval(async () => {
    if (botState.status !== 'online') return;
    if (!outboxStats().pending) return;
    try {
      await flushOutbox(sock);
    } catch (err) {
      console.error('Outbox flush failed:', err.message);
    }
  }, intervalMs);
  timer.unref?.();

  // Keep the table from growing forever
  const janitor = setInterval(() => {
    try {
      pruneOutbox(14);
    } catch {
      /* ignore */
    }
  }, 6 * 60 * 60 * 1000);
  janitor.unref?.();

  return timer;
}

export function outboxStatus() {
  return { ...outboxStats(), maxTries: MAX_TRIES };
}

export default { sendReliable, flushOutbox, startOutboxLoop, outboxStatus, isRetryable };
