// src/core/replyChannel.js
// One customer message in, one reply out.
//
// The batch pipeline is a chain of pipelines — visual catalogue, receipt,
// booking, closer, tool confirmation, emergency, the main brain, and the quote
// that used to be sent on its own after the answer. Live testing produced the
// obvious symptom: two replies to one message, sometimes glued into one bubble.
//
// This module is the single place that decides whether a reply may still be
// sent for this batch. Everything that talks to a customer goes through it, and
// the second caller is logged instead of sent.

import { isPrivateMedia } from '../services/ephemeralMedia.js';
import * as db from '../utils/db.js';

const answered = new Map(); // chat -> { batch, at }
const DEDUPE_WINDOW_MS = 120_000;

/** A stable id for one debounced batch: the newest inbound message id. */
export function batchIdOf(items = []) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const id = items[i]?.incoming?.id;
    if (id) return String(id);
  }
  return `t${Date.now()}`;
}

function prune(now = Date.now()) {
  for (const [chat, entry] of answered) {
    if (now - entry.at > DEDUPE_WINDOW_MS * 2) answered.delete(chat);
  }
}

/** Has this chat already been answered for this batch? */
export function alreadyAnswered(chat, batch) {
  prune();
  const entry = answered.get(String(chat));
  if (!entry) return false;
  if (Date.now() - entry.at > DEDUPE_WINDOW_MS) return false;
  return entry.batch === String(batch);
}

export function markAnswered(chat, batch) {
  answered.set(String(chat), { batch: String(batch), at: Date.now() });
}

/**
 * The only way a batch talks to the customer.
 *
 * `say` sends the first message and silently refuses the rest (logging them so
 * the cause is visible in `.debug`). `single()` merges several pieces of text
 * into one message instead of sending two.
 */
export function createReplyChannel({
  chat,
  batch,
  transport = null,
  jid = null,
  sendTyping = null,
  sendHuman = null,
  sendPlain = null,
  label = 'reply',
} = {}) {
  let used = false;
  const blocked = [];

  const deliver = async (text, opts = {}) => {
    if (!text) return null;
    if (used) {
      blocked.push({ ...(isPrivateMedia() ? {} : { text: String(text).slice(0, 120) }), at: Date.now() });
      try {
        db.logEvent('duplicate_reply_blocked', chat || null, {
          label,
          batch: batch || null,
          ...(isPrivateMedia() ? {} : { preview: String(text).slice(0, 80) }),
        });
      } catch {
        /* logging must not throw */
      }
      return null;
    }
    used = true;
    markAnswered(chat, batch);
    // The harness (and `.debug`) counts logical replies from this event: one
    // inbound message may produce one, however many bubbles it splits into.
    try {
      db.logEvent('reply_sent', chat || null, { label, batch: batch || null });
    } catch {
      /* ignore */
    }
    // A voice note or a human-paced reply needs the bubble splitter; a short
    // deterministic line does not.
    const wantsHuman = opts.voice !== undefined || opts.incomingText !== undefined;
    if (wantsHuman && typeof sendHuman === 'function') return sendHuman(transport, jid, text, opts);
    if (typeof sendTyping === 'function') return sendTyping(transport, jid, text, opts);
    if (typeof sendPlain === 'function') return sendPlain(text, opts);
    return null;
  };

  return {
    get used() {
      return used;
    },
    get blocked() {
      return blocked.slice();
    },
    say: deliver,
    /** Claim the right to answer without sending (for a path that will send itself). */
    claim() {
      if (used) return false;
      used = true;
      markAnswered(chat, batch);
      return true;
    },
    release() {
      used = false;
    },
  };
}

/** What a queue-level guard should check before a whole batch runs. */
export function beginBatch(chat, batch) {
  if (alreadyAnswered(chat, batch)) return { skip: true, reason: 'already answered' };
  return { skip: false };
}

export function _resetForTests() {
  answered.clear();
}

export default {
  batchIdOf,
  alreadyAnswered,
  markAnswered,
  createReplyChannel,
  beginBatch,
  _resetForTests,
};
