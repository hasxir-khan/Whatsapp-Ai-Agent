// src/services/privacy.js
// Privacy tools: get your data out, and get it gone.
//
// Two promises, both kept literally:
//
//   1. An export contains exactly one contact's rows and nothing else. The
//      query is by number, the file is built from those rows, and the file name
//      carries the number so a wrong export is obvious at a glance.
//
//   2. A forget deletes the rows. Not "marks", not "hides": deletes, table by
//      table, in one pass, and then writes a line that says how many rows went —
//      with a hash of the number instead of the number, because an audit trail
//      that remembers who was forgotten is not a deletion.
//
// What survives on purpose: an opt-out marker and a blocked contact shell. A
// forgotten customer must never be messaged again, and "never message them" is
// itself a fact we are obliged to keep. Both are empty of content.
//
// The other half of privacy is time. Messages are kept until the owner says
// otherwise; PRIVACY_RETENTION_DAYS turns the bodies off after N days while the
// counts stay, so the owner keeps their numbers and loses the transcripts.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, normalizePhone } from '../config/env.js';
import { featureOn } from './profile.js';
import { clearAgentState } from './agents.js';
import { invoiceDir } from './invoice.js';
import { sweepTemp } from './media.js';
import {
  all,
  get,
  run,
  saveDB,
  logEvent,
  addPrivacyRequest,
  pendingPrivacyRequests,
  resolvePrivacyRequests,
  logPrivacyAction,
  recentPrivacyAudit,
} from '../utils/db.js';

export function privacyEnabled() {
  return featureOn('privacyTools');
}

const jidFor = (number) => `${normalizePhone(number)}@s.whatsapp.net`;

/** Irreversible, fixed length, and enough to see "this happened twice". */
export function subjectHash(number) {
  return crypto.createHash('sha256').update(`privacy:${normalizePhone(number)}`).digest('hex').slice(0, 16);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── export ──────────────────────────────────────────────────

/**
 * Everything this bot holds about one number, as JSON.
 * Read-only: building an export must never change a row.
 */
export function exportContact(rawNumber) {
  const number = normalizePhone(rawNumber);
  if (!number) return { ok: false, reason: 'invalid_number' };
  const jid = jidFor(number);

  const contact = get('SELECT * FROM contacts WHERE number = ?', [number]);
  const messages = all('SELECT role, kind, content, meta, created_at FROM messages WHERE number = ? ORDER BY id', [number]);
  const facts = all('SELECT key, value, updated_at FROM facts WHERE number = ?', [number]);
  const leads = all('SELECT * FROM leads WHERE number = ?', [number]);
  const bookings = all('SELECT * FROM bookings WHERE chat = ? OR chat = ?', [number, jid]);
  const orders = all('SELECT * FROM orders WHERE chat = ? OR chat = ?', [number, jid]);
  const followups = all('SELECT * FROM followups WHERE number = ?', [number]);
  const referrals = all('SELECT * FROM referrals WHERE number = ?', [number]);
  const reviews = all('SELECT * FROM review_asks WHERE number = ?', [number]);
  const intake = all('SELECT * FROM intake WHERE number = ?', [number]);
  const calls = all('SELECT * FROM calls WHERE number = ?', [number]);
  const intents = all('SELECT * FROM message_intents WHERE chat = ? OR chat = ?', [number, jid]);
  // Consent is not content: it is the record of what the customer allowed.
  const consents = all('SELECT number, reason, source, created_at FROM growth_optouts WHERE number = ?', [number]);
  const privacy = all('SELECT status, language, created_at, decided_at FROM privacy_requests WHERE number = ?', [number]);
  const requests = all('SELECT * FROM pending WHERE number = ?', [number]);
  const reminders = all('SELECT * FROM booking_reminders WHERE number = ?', [number]);
  // CRM and order history are about this person too, so they travel with the
  // export and are deleted by the forget.
  const tags = all('SELECT tag, source, created_at FROM contact_tags WHERE number = ?', [number]);
  // Which tracked link (or ad) brought them, if any. It is a fact about this
  // person, so it travels with them.
  const sourceLink = all('SELECT source, code, detail, created_at FROM contact_sources WHERE number = ?', [number]);
  const notes = all('SELECT note, author, created_at FROM contact_notes WHERE number = ?', [number]);
  // Phase 6: which custom agent held this conversation, and what it did.
  // Empty unless the owner switched multiAgent on, so an existing export is
  // byte-identical when the feature is off.
  const agentChats = featureOn('multiAgent')
    ? all('SELECT agent, handoffs, updated_at FROM agent_chats WHERE chat = ? OR chat = ?', [number, jid])
    : [];
  const agentEvents = featureOn('multiAgent')
    ? all('SELECT agent, kind, detail, created_at FROM agent_events WHERE chat = ? OR chat = ?', [number, jid])
    : [];
  // Phase 6 Part 2: the promo messages we sent this contact are their data too.
  // Only included when the marketing team is on, so other exports do not change.
  const growthMessages = featureOn('marketingAgents')
    ? all('SELECT agent, reason, result, created_at FROM growth_sends WHERE number = ?', [number])
    : [];
  // Phase 6 Part 3: every decision the brain took about this chat, and every
  // experiment it put this contact in. Only when the flag is on, so other
  // exports keep their exact shape.
  const brainDecisions = featureOn('businessBrain')
    ? all('SELECT kind, action, rationale, outcome, created_at FROM brain_decisions WHERE chat = ? OR chat = ?', [number, jid])
    : [];
  const experimentSends = featureOn('businessBrain')
    ? all('SELECT experiment_id, variant, outcome, created_at FROM experiment_sends WHERE number = ?', [number])
    : [];
  const orderIds = all('SELECT id FROM orders WHERE chat = ? OR chat = ?', [number, jid]).map((row) => row.id);
  const orderHistory = orderIds.length
    ? all(`SELECT * FROM order_events WHERE order_id IN (${orderIds.map(() => '?').join(',')}) ORDER BY id`, orderIds)
    : [];

  const payload = {
    format: 'wa-assistant-contact-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    tenant: config.tenant.slug,
    business: config.owner.profile?.business?.name || null,
    contact: contact
      ? {
          number: contact.number,
          name: contact.name,
          pushName: contact.push_name,
          category: contact.category,
          language: contact.language,
          country: contact.country,
          currency: contact.currency,
          isBlocked: Boolean(contact.is_blocked),
          pausedUntil: contact.bot_paused_until,
          firstSeen: contact.first_seen,
          lastSeen: contact.last_seen,
          messageCount: contact.message_count,
        }
      : null,
    messages: messages.map((m) => ({ ...m, meta: m.meta ? safeJson(m.meta) : null })),
    facts,
    leads,
    bookings,
    orders,
    followups,
    referrals,
    reviews,
    intake,
    calls,
    intents,
    consents,
    privacyRequests: privacy,
    scheduledMessages: requests,
    bookingReminders: reminders,
    tags,
    notes,
    sourceLink,
    orderHistory,
    ...(featureOn('multiAgent') ? { agentChats, agentEvents } : {}),
    ...(featureOn('marketingAgents') ? { growthMessages } : {}),
    ...(featureOn('businessBrain') ? { brainDecisions, experimentSends } : {}),
  };

  const counts = Object.fromEntries(
    Object.entries({ messages, facts, leads, bookings, orders, followups, referrals, reviews, intake, calls, intents, consents, tags, notes, sourceLink, orderHistory, ...(featureOn('multiAgent') ? { agentChats, agentEvents } : {}), ...(featureOn('marketingAgents') ? { growthMessages } : {}), ...(featureOn('businessBrain') ? { brainDecisions, experimentSends } : {}) })
      .map(([key, rows]) => [key, rows.length])
  );

  return { ok: true, number, payload, counts, text: JSON.stringify(payload, null, 2) };
}

export function exportFileName(rawNumber, now = new Date()) {
  const number = normalizePhone(rawNumber);
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `export-${number}-${stamp}.json`;
}

// ── forget ──────────────────────────────────────────────────

/**
 * The tables that hold a person, and the column that names them.
 * One list, in one place, so adding a table without adding it here is a visible
 * mistake instead of a silent leak.
 */
export const CONTACT_TABLES = [
  { table: 'messages', where: 'number = ?' },
  { table: 'seen_messages', where: 'number = ?' },
  { table: 'facts', where: 'number = ?' },
  { table: 'summaries', where: 'number = ?' },
  { table: 'intake', where: 'number = ?' },
  { table: 'leads', where: 'number = ?' },
  { table: 'followups', where: 'number = ?' },
  { table: 'pending', where: 'number = ?' },
  { table: 'pending_rules', where: 'number = ?' },
  { table: 'calls', where: 'number = ?' },
  { table: 'review_asks', where: 'number = ?' },
  { table: 'referrals', where: 'number = ?' },
  { table: 'reactivation_log', where: 'number = ?' },
  { table: 'growth_sends', where: 'number = ?' },
  { table: 'growth_drafts', where: 'number = ?' },
  { table: 'growth_optouts', where: 'number = ?' }, // re-added below as the marker
  { table: 'booking_reminders', where: 'number = ?' },
  { table: 'objection_attempts', where: 'number = ?' },
  { table: 'privacy_requests', where: 'number = ?' },
  { table: 'contact_tags', where: 'number = ?' },
  { table: 'contact_sources', where: 'number = ?' },
  { table: 'contact_notes', where: 'number = ?' },
  { table: 'message_intents', where: 'chat = ? OR chat = ?' },
  { table: 'bookings', where: 'chat = ? OR chat = ?' },
  { table: 'orders', where: 'chat = ? OR chat = ?' },
  { table: 'tool_calls', where: 'chat = ? OR chat = ?' },
  { table: 'outbox', where: 'jid = ? OR jid = ?' },
  { table: 'cloud_messages', where: 'number = ?' },
];

function countRows(table, where, params) {
  try {
    return get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params)?.n || 0;
  } catch {
    return 0;
  }
}

function removeInvoices(orderIds = []) {
  const dir = invoiceDir();
  let removed = 0;
  if (!dir || !fs.existsSync(dir)) return removed;
  const names = new Set(
    orderIds.map((id) => new RegExp(`-\\d{4}-${String(Number(id)).padStart(4, '0')}\\.pdf$`))
  );
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.pdf')) continue;
    if (![...names].some((re) => re.test(name))) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch {
      /* a PDF held open by a reader will be swept later */
    }
  }
  return removed;
}

/**
 * Delete one contact, table by table.
 *
 * Idempotent on purpose: a second run finds nothing to delete, removes no
 * marker, and reports `alreadyForgotten`. That matters because `.forget` is
 * typed by a human twice, and humans type it twice by accident.
 */
export function forgetContact(rawNumber, { reason = 'owner_request', now = new Date() } = {}) {
  const number = normalizePhone(rawNumber);
  if (!number) return { ok: false, reason: 'invalid_number' };
  if (number === normalizePhone(config.owner.number)) return { ok: false, reason: 'owner_number' };

  const jid = jidFor(number);
  const contact = get('SELECT * FROM contacts WHERE number = ?', [number]);
  const forgottenMarker = contact?.category === 'forgotten';
  const orderIds = all('SELECT id FROM orders WHERE chat = ? OR chat = ?', [number, jid]).map((row) => row.id);

  const removed = {};
  let total = 0;

  // Order history is keyed by order id, not by number: read the ids first, then
  // delete the events, then let the generic loop finish the job on `orders`.
  if (orderIds.length) {
    const holes = orderIds.map(() => '?').join(',');
    const before = get(`SELECT COUNT(*) AS n FROM order_events WHERE order_id IN (${holes})`, orderIds)?.n || 0;
    if (before) {
      run(`DELETE FROM order_events WHERE order_id IN (${holes})`, orderIds);
      removed.order_events = before;
      total += before;
    }
  }
  // Phase 6: the agent that answered, and its event trail, are about this
  // person as well.
  if (featureOn('multiAgent')) {
    for (const table of ['agent_chats', 'agent_events']) {
      const where = 'chat = ? OR chat = ?';
      const before = countRows(table, where, [number, jid]);
      if (before) {
        run(`DELETE FROM ${table} WHERE ${where}`, [number, jid]);
        removed[table] = before;
        total += before;
      }
    }
    try {
      clearAgentState(jid);
    } catch {
      /* memory only */
    }
  }
  // Phase 6 Part 3: the reasoning trail is about this person, so it goes too.
  for (const { table, where } of [
    { table: 'brain_decisions', where: 'chat = ? OR chat = ?' },
    { table: 'experiment_sends', where: 'number = ?' },
  ]) {
    const params = where.includes('OR') ? [number, jid] : [number];
    const before = countRows(table, where, params);
    if (before) {
      run(`DELETE FROM ${table} WHERE ${where}`, params);
      removed[table] = before;
      total += before;
    }
  }
  for (const { table, where } of CONTACT_TABLES) {
    const params = where.includes('OR') ? [number, jid] : [number];
    const before = countRows(table, where, params);
    if (before) {
      run(`DELETE FROM ${table} WHERE ${where}`, params);
      removed[table] = before;
      total += before;
    }
  }

  // The contact row itself becomes a shell: blocked, paused for a century, and
  // empty. The number stays so the bot can recognise them and stay quiet.
  const pausedUntil = new Date(now.getTime() + 3650 * 86_400_000).toISOString();
  if (contact) {
    run(
      `UPDATE contacts
          SET name = NULL, push_name = NULL, notes = NULL, assigned_to = NULL,
              language = NULL, locale = NULL, spam_score = 0, message_count = 0,
              is_blocked = 1, bot_paused_until = ?, category = 'forgotten', stage = NULL
        WHERE number = ?`,
      [pausedUntil, number]
    );
    removed.contactShell = 1;
    total += 1;
  } else {
    run(
      `INSERT INTO contacts (number, jid, category, is_blocked, bot_paused_until, message_count, first_seen, last_seen)
       VALUES (?,?,?,?,?,?,?,?)`,
      [number, jid, 'forgotten', 1, pausedUntil, 0, now.toISOString(), now.toISOString()]
    );
    removed.contactShell = 1;
    total += 1;
  }

  // The marker that makes "never message them again" true.
  run('INSERT OR REPLACE INTO growth_optouts (number, reason, source, created_at) VALUES (?,?,?,?)', [
    number,
    'forgotten',
    reason,
    now.toISOString(),
  ]);
  removed.optOutMarker = 1;

  const invoices = removeInvoices(orderIds);
  if (invoices) removed.invoices = invoices;

  // Temp media has no owner column, so it cannot be deleted "for" one person.
  // What can be done: sweep the transient folder, skipping anything written in
  // the last five minutes so a file mid-conversation is not pulled out from
  // under a running job.
  try {
    sweepTemp(5 * 60_000);
    removed.tempSwept = 1;
  } catch {
    /* the folder may not exist on a fresh install */
  }

  saveDB(true);

  if (!forgottenMarker || total > 2) {
    logPrivacyAction({ action: 'forget', subjectHash: subjectHash(number), detail: { rows: removed, reason } });
  }
  logEvent('privacy_forget', null, { hash: subjectHash(number), rows: total, already: forgottenMarker });
  resolvePrivacyRequests(number, 'done');

  return {
    ok: true,
    number,
    already: forgottenMarker && total <= 2,
    removed,
    total,
  };
}

// ── the customer's own request ──────────────────────────────

// English, Roman Urdu, Urdu script. Nothing clever: a request to be deleted is
// a short, direct sentence, and this must work before any model is involved.
const DELETE_PATTERNS = [
  /\b(delete|remove|erase|wipe|forget)\s+(all\s+)?(my|of\s+my)\s+(data|account|info|information|details|records|messages|chat)\b/i,
  /\b(i\s+want|please)\s+(to\s+be\s+)?(deleted|forgotten|erased)\b/i,
  /\bdelete\s+me\b/i,
  /\b(mera|meri|mere)\s+(data|account|maloomat|record|details|baatein|messages)\s+(delete|remove|mita|hata)\s*(do|de|dijiye|kar\s*do|kardo)?\b/i,
  /\b(mujhe|mujhey)\s+(delete|bhula|bhoola|forget|hata)\s*(do|de|dijiye|kardo)?\b/i,
  /\b(data|account)\s+(delete|remove)\s*(kar|karo|kardo|do)\b/i,
  /(میرا|میری|میرے)\s*(ڈیٹا|اکاؤنٹ|ریکارڈ|معلومات|پیغامات)\s*(ڈیلیٹ|حذف|مٹا)/,
  /(مجھے|مجھھے)\s*(بھول|حذف|ڈیلیٹ)/,
];

/** Is this message a request to be forgotten? */
export function isDeletionRequest(text = '') {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 300) return false;
  return DELETE_PATTERNS.some((re) => re.test(clean));
}

/**
 * Record the request and return the sentence to send back. The customer is not
 * forgotten immediately: a WhatsApp message is a weak identity claim, and the
 * owner is the one who knows whether this is a real customer or a prank.
 */
export function requestDeletion(rawNumber, { language = 'en' } = {}) {
  const number = normalizePhone(rawNumber);
  if (!number) return { ok: false, reason: 'invalid_number' };
  if (number === normalizePhone(config.owner.number)) return { ok: false, reason: 'owner_number' };

  const existing = addPrivacyRequest(number, { language });
  logEvent('privacy_request', number, { language });
  return { ok: true, request: existing, duplicate: Boolean(existing && existing.status === 'pending' && existing.id) };
}

export const DELETION_ACK = {
  en: 'Understood — I have passed your request to delete your data to the owner. Nothing about you will be kept except a note that you asked to be forgotten, so we do not contact you again.',
  ur: 'سمجھ گیا — آپ کی درخواست ڈیٹا ڈیلیٹ کرنے کی مالک کو بھیج دی ہے۔ آپ کا کوئی ریکارڈ نہیں رکھا جائے گا سوائے اس یادداشت کے کہ آپ نے دوبارہ رابطہ نہ کرنے کو کہا تھا۔',
  roman: 'Samajh gaya — aap ki data delete karne ki request owner ko bhej di hai. Aap ka koi record nahi rakha jayega siwaaye is baat ke ke aap ne dobara rabta na karne ko kaha tha.',
};

export function deletionAcknowledgement(language = 'en') {
  if (language === 'ur') return DELETION_ACK.ur;
  if (language === 'roman' || language === 'ur-roman') return DELETION_ACK.roman;
  return DELETION_ACK.en;
}

export function privacyQueue(limit = 20) {
  return pendingPrivacyRequests(limit);
}

export function privacyAuditTrail(limit = 10) {
  return recentPrivacyAudit(limit);
}

// ── retention ───────────────────────────────────────────────

export function retentionDays() {
  const days = Number(process.env.PRIVACY_RETENTION_DAYS);
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
}

/**
 * Purge message bodies and media older than the retention window, keeping the
 * row (and therefore the counts) but not the words.
 */
export function purgeRetention({ days = retentionDays(), now = new Date() } = {}) {
  const window = Number(days) > 0 ? Math.floor(Number(days)) : 0;
  if (!window) return { ok: false, reason: 'disabled', purged: 0 };

  const cutoff = new Date(new Date(now).getTime() - window * 86_400_000).toISOString();
  const before = get("SELECT COUNT(*) AS n FROM messages WHERE created_at < ? AND content <> '[purged]'", [cutoff])?.n || 0;
  run(
    "UPDATE messages SET content = '[purged]', meta = NULL WHERE created_at < ? AND content <> '[purged]'",
    [cutoff]
  );
  // Seen-message cache holds raw text for deletion tracking; same window.
  run('DELETE FROM seen_messages WHERE created_at < ?', [cutoff]);

  let media = 0;
  try {
    const dir = config.paths.tmp;
    if (fs.existsSync(dir)) {
      const cutoffMs = new Date(cutoff).getTime();
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        try {
          if (fs.statSync(full).mtimeMs < cutoffMs) {
            fs.rmSync(full, { recursive: true, force: true });
            media += 1;
          }
        } catch {
          /* a file in use can wait for the next pass */
        }
      }
    }
  } catch {
    /* no temp folder, nothing to purge */
  }

  saveDB(true);
  if (before || media) {
    logPrivacyAction({
      action: 'retention',
      subjectHash: null,
      detail: { days: window, messages: before, media },
    });
    logEvent('privacy_retention', null, { messages: before, media, days: window });
  }
  return { ok: true, purged: before, media, days: window, cutoff };
}

let retentionTimer = null;

/** Once a day is enough for a window measured in days. */
export function startRetention({ intervalMs = 24 * 60 * 60 * 1000, onError = null } = {}) {
  if (retentionTimer) return retentionTimer;
  if (!retentionDays()) return null;
  retentionTimer = setInterval(() => {
    try {
      purgeRetention();
    } catch (err) {
      if (onError) onError(err);
    }
  }, intervalMs);
  retentionTimer.unref?.();
  return retentionTimer;
}

export function stopRetention() {
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = null;
}

export default {
  privacyEnabled,
  exportContact,
  exportFileName,
  forgetContact,
  isDeletionRequest,
  requestDeletion,
  deletionAcknowledgement,
  privacyQueue,
  privacyAuditTrail,
  retentionDays,
  purgeRetention,
  subjectHash,
  CONTACT_TABLES,
};
