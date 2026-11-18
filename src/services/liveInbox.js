// src/services/liveInbox.js
// A live inbox for the owner: read the chats, answer them, take one over.
//
// The rules that make this safe rather than merely convenient:
//   • it is a *view* of SQLite that already exists. No second copy of a
//     conversation, no sync job, no "seen" state invented from scratch — a chat
//     is unread when the customer spoke last, which is what the owner means.
//   • replying from the browser goes through the same path as the owner typing
//     in WhatsApp: the message is sent, recorded as an owner turn, and the bot
//     steps back for the same handoff window. Two ways to answer, one behaviour.
//   • behind the dashboard token. With DASHBOARD_TOKEN set, every route is 401
//     without it; the inbox is the most private screen this bot has.
//   • everything degrades honestly. No transport in this process means the
//     reply is refused with a reason, not silently dropped.

import { config } from '../config/env.js';
import { featureOn, business } from './profile.js';
import {
  all, get, getContact, setContactPaused, logEvent, saveMessage,
} from '../utils/db.js';
import { crmEnabled, crmProfile, tagsFor, notesFor } from './crm.js';

export function liveInboxEnabled() {
  return featureOn('liveInbox');
}

const MAX_REPLY = 4000; // WhatsApp's own practical ceiling per bubble

function iso(d = new Date()) {
  return d.toISOString();
}

function pausedNow(contact, now = new Date()) {
  const until = Date.parse(contact?.bot_paused_until || '');
  return Number.isFinite(until) && until > now.getTime();
}

/**
 * The chat list: one row per contact who has ever said something, newest
 * activity first. "unread" is not a flag we maintain — it is "the customer
 * spoke last", counted from their trailing messages.
 */
export function inboxChats({ limit = 40, now = new Date() } = {}) {
  const rows = all(
    `SELECT c.number, c.name, c.push_name, c.category, c.stage, c.assigned_to,
            c.bot_paused_until, c.is_blocked, c.last_seen,
            (SELECT m.id         FROM messages m WHERE m.number = c.number ORDER BY m.id DESC LIMIT 1) AS last_id,
            (SELECT m.content    FROM messages m WHERE m.number = c.number ORDER BY m.id DESC LIMIT 1) AS last_text,
            (SELECT m.role       FROM messages m WHERE m.number = c.number ORDER BY m.id DESC LIMIT 1) AS last_role,
            (SELECT m.kind       FROM messages m WHERE m.number = c.number ORDER BY m.id DESC LIMIT 1) AS last_kind,
            (SELECT m.created_at FROM messages m WHERE m.number = c.number ORDER BY m.id DESC LIMIT 1) AS last_at,
            (SELECT COUNT(*) FROM messages m
               WHERE m.number = c.number AND m.role = 'user'
                 AND m.id > COALESCE((SELECT MAX(x.id) FROM messages x
                                       WHERE x.number = c.number AND x.role IN ('assistant','owner')), 0)
            ) AS unread
       FROM contacts c
      WHERE last_id IS NOT NULL
      ORDER BY last_at DESC, last_id DESC
      LIMIT ?`,
    [Math.max(1, Math.min(200, Number(limit) || 40))]
  );

  return rows.map((r) => ({
    number: r.number,
    name: r.name || r.push_name || null,
    label: r.name || r.push_name || `+${r.number}`,
    category: r.category || 'new',
    stage: r.stage || 'new',
    assignedTo: r.assigned_to || null,
    paused: pausedNow(r, now),
    pausedUntil: pausedNow(r, now) ? r.bot_paused_until : null,
    blocked: !!r.is_blocked,
    lastId: r.last_id,
    lastRole: r.last_role,
    lastKind: r.last_kind,
    lastAt: r.last_at,
    preview: previewOf(r.last_role, r.last_kind, r.last_text),
    unread: Number(r.unread) || 0,
    awaitingUs: r.last_role === 'user',
  }));
}

function previewOf(role, kind, text) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  if (!body) {
    if (kind === 'image') return '[photo]';
    if (kind === 'voice') return '[voice note]';
    if (kind === 'video') return '[video]';
    if (kind === 'document') return '[document]';
    if (kind === 'location') return '[location]';
    return '[message]';
  }
  const prefix = role === 'owner' ? 'You: ' : role === 'assistant' ? 'Bot: ' : '';
  const clipped = body.length > 120 ? `${body.slice(0, 117)}…` : body;
  return `${prefix}${clipped}`;
}

/** How many messages in a row came from the customer at the end of a thread. */
function trailingFromCustomer(messages = []) {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== 'user') break;
    count += 1;
  }
  return count;
}

/** One conversation. `after` returns only newer rows, for live updates. */
export function inboxThread(number, { limit = 60, before = null, after = null } = {}) {
  const num = String(number || '').replace(/\D/g, '');
  if (!num) return { contact: null, messages: [], hasMore: false };

  const contact = getContact(num);
  if (!contact) return { contact: null, messages: [], hasMore: false };

  const cap = Math.max(1, Math.min(200, Number(limit) || 60));
  let rows;
  if (after) {
    rows = all(
      'SELECT id, role, kind, content, meta, created_at FROM messages WHERE number = ? AND id > ? ORDER BY id ASC LIMIT ?',
      [num, Number(after) || 0, cap]
    );
  } else if (before) {
    rows = all(
      'SELECT id, role, kind, content, meta, created_at FROM messages WHERE number = ? AND id < ? ORDER BY id DESC LIMIT ?',
      [num, Number(before) || Number.MAX_SAFE_INTEGER, cap]
    ).reverse();
  } else {
    rows = all(
      'SELECT id, role, kind, content, meta, created_at FROM messages WHERE number = ? ORDER BY id DESC LIMIT ?',
      [num, cap]
    ).reverse();
  }

  const messages = rows.map((r) => ({
    id: r.id,
    role: r.role,
    from: r.role === 'user' ? 'customer' : r.role === 'owner' ? 'you' : r.role === 'assistant' ? 'bot' : 'system',
    kind: r.kind || 'text',
    text: r.content || '',
    at: r.created_at,
  }));

  return {
    contact: {
      number: num,
      name: contact.name || contact.push_name || null,
      label: contact.name || contact.push_name || `+${num}`,
      stage: contact.stage || 'new',
      category: contact.category || 'new',
      paused: pausedNow(contact),
      pausedUntil: pausedNow(contact) ? contact.bot_paused_until : null,
      blocked: !!contact.is_blocked,
      assignedTo: contact.assigned_to || null,
      unread: trailingFromCustomer(messages),
    },
    messages,
    hasMore: messages.length === cap,
    // Read-only CRM strip for the side panel. The owner edits tags and notes
    // from WhatsApp (or the authenticated action route) — the page only shows.
    crm: crmPanelFor(num),
  };
}

/** Tags, notes and auto-tag profile for one chat, or null when CRM is off. */
export function crmPanelFor(number) {
  const num = String(number || '').replace(/\D/g, '');
  if (!num || !crmEnabled()) return null;
  try {
    const tags = tagsFor(num).map((row) => ({ tag: row.tag, source: row.source || 'owner' }));
    const profile = crmProfile(num);
    // A derived tag that is already sitting in the tag list is shown once.
    const seen = new Set(tags.map((row) => row.tag));
    profile.autoTags = (profile.autoTags || []).filter((tag) => !seen.has(tag)).slice(0, 8);
    return {
      tags,
      notes: notesFor(num, { limit: 5 }).map((row) => ({
        note: row.note,
        author: row.author || 'owner',
        at: row.created_at,
      })),
      profile,
    };
  } catch {
    // A CRM read must never blank out a conversation.
    return null;
  }
}

/** Is the bot currently quiet in this chat? `release` undoes a takeover. */
export function inboxTakeover(number, { minutes = null, now = new Date() } = {}) {
  const num = String(number || '').replace(/\D/g, '');
  if (!num) return { ok: false, reason: 'no_number' };
  const wait = Number(minutes) > 0 ? Number(minutes) : config.behavior.handoffMinutes;
  const until = iso(new Date(now.getTime() + wait * 60000));
  setContactPaused(num, until);
  logEvent('inbox_takeover', num, { minutes: wait });
  return { ok: true, minutes: wait, until };
}

export function inboxRelease(number) {
  const num = String(number || '').replace(/\D/g, '');
  if (!num) return { ok: false, reason: 'no_number' };
  setContactPaused(num, null);
  logEvent('inbox_release', num);
  return { ok: true };
}

/**
 * The owner answering from the browser. Deliberately the same three steps as
 * replying from his phone: send, record, step back.
 *
 * @param {{number:string, text:string, transport?:object, now?:Date, pause?:boolean}} opts
 */
export async function inboxReply({ number, text, transport = null, now = new Date(), pause = true } = {}) {
  if (!liveInboxEnabled()) return { ok: false, status: 404, reason: 'disabled' };

  const num = String(number || '').replace(/\D/g, '');
  const body = String(text || '').trim();
  if (!num) return { ok: false, status: 400, reason: 'no_number' };
  if (!body) return { ok: false, status: 400, reason: 'empty' };
  if (body.length > MAX_REPLY) return { ok: false, status: 400, reason: 'too_long', limit: MAX_REPLY };

  const contact = getContact(num);
  if (!contact) return { ok: false, status: 404, reason: 'unknown_contact' };
  if (contact.is_blocked) return { ok: false, status: 409, reason: 'blocked' };
  if (!transport || typeof transport.sendMessage !== 'function') {
    return { ok: false, status: 503, reason: 'no_transport' };
  }
  if (typeof transport.can === 'function' && transport.can('text') === false) {
    return { ok: false, status: 503, reason: 'no_text_support' };
  }

  const jid = contact.jid || `${num}@s.whatsapp.net`;
  try {
    await transport.sendMessage(jid, { text: body });
  } catch (err) {
    logEvent('inbox_send_failed', num, err.message);
    return { ok: false, status: 502, reason: 'send_failed', error: err.message };
  }

  saveMessage(num, 'owner', body, 'text', { via: 'inbox' });
  let handoff = null;
  if (pause) handoff = inboxTakeover(num, { now });
  logEvent('inbox_reply', num, { chars: body.length, handoff: handoff?.minutes ?? null });

  return { ok: true, status: 200, handoff, sentAt: iso(now) };
}

/** What `.inbox` tells the owner, and what the `/inbox` page title says. */
export function inboxSummary({ now = new Date() } = {}) {
  const chats = inboxChats({ limit: 200, now });
  const waiting = chats.filter((c) => c.awaitingUs && !c.paused && !c.blocked);
  return {
    enabled: liveInboxEnabled(),
    total: chats.length,
    unreadChats: chats.filter((c) => c.unread > 0).length,
    awaitingUs: waiting.length,
    unreadMessages: chats.reduce((sum, c) => sum + c.unread, 0),
    paused: chats.filter((c) => c.paused).length,
    name: business().name || 'the business',
  };
}

/** The URL to open. Token is included only when one is configured. */
export function inboxUrl(base = null) {
  const host = base || config.server.publicUrl || `http://localhost:${config.server.port}`;
  const token = config.server.token;
  return `${host.replace(/\/$/, '')}/inbox${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

/** Latest message id across all chats — the cursor the UI watches. */
export function latestMessageId() {
  return Number(get('SELECT COALESCE(MAX(id), 0) AS id FROM messages')?.id) || 0;
}

export default {
  liveInboxEnabled,
  inboxChats,
  inboxThread,
  inboxReply,
  inboxTakeover,
  inboxRelease,
  inboxSummary,
  inboxUrl,
  latestMessageId,
};
