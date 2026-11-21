// src/services/crm.js
// A small, honest CRM: tags and notes a human typed, plus a handful of tags the
// bot can derive from facts it already stores.
//
// Two rules keep this from becoming the usual CRM swamp:
//
//   1. A tag is a short lowercase word, and the owner can remove it. Nothing
//      here decides that a person *is* a "vip" in a way the owner cannot see or
//      undo — auto tags are recomputed from data and marked as auto.
//   2. Nothing is ever shared across tenants. Every query is scoped by the
//      tenant slug, including the counts, so one business cannot enumerate
//      another's customers by guessing tags.

import { config } from '../config/env.js';
import { profile, featureOn } from './profile.js';
import {
  addContactTag,
  removeContactTag,
  contactTags,
  tagCounts,
  numbersWithTag,
  countTagsFor,
  addContactNote,
  contactNotes,
  getContact,
  get,
  all,
} from '../utils/db.js';

export const MAX_TAGS_PER_CONTACT = 20;
export const MAX_TAG_LENGTH = 24;
export const MAX_NOTE_LENGTH = 500;

/** Tags the bot may add by itself. Anything else is the owner's word. */
export const AUTO_TAGS = ['new', 'repeat', 'vip', 'cold', 'complaint', 'referrer'];

export function crmEnabled() {
  return featureOn('crm');
}

const tenant = () => config.tenant.slug;

/**
 * A tag is lowercase, one word, and short. Spaces become dashes so ".find
 * big spender" and ".find big-spender" are the same question.
 */
export function normaliseTag(raw = '') {
  const tag = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/^#/, '')
    .replace(/[^a-z0-9\u0600-\u06ff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_TAG_LENGTH);
  return tag || null;
}

export function normaliseNote(raw = '') {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_LENGTH);
}

// ── tags ────────────────────────────────────────────────────

export function tagsFor(number, { tenantSlug = tenant() } = {}) {
  if (!number) return [];
  return contactTags(String(number).replace(/\D/g, ''), { tenant: tenantSlug });
}

export function addTag(number, rawTag, { source = 'owner', tenantSlug = tenant() } = {}) {
  if (!crmEnabled()) return { ok: false, reason: 'disabled' };
  const num = String(number || '').replace(/\D/g, '');
  if (!num) return { ok: false, reason: 'invalid_number' };

  const tag = normaliseTag(rawTag);
  if (!tag) return { ok: false, reason: 'invalid_tag' };
  if (!/^[a-z0-9\u0600-\u06ff-]+$/.test(tag)) return { ok: false, reason: 'invalid_tag' };

  const existing = tagsFor(num, { tenantSlug }).map((row) => row.tag);
  if (existing.includes(tag)) return { ok: true, tag, already: true };
  if (existing.length >= MAX_TAGS_PER_CONTACT) {
    return { ok: false, reason: 'too_many_tags', limit: MAX_TAGS_PER_CONTACT };
  }

  addContactTag({ tenant: tenantSlug, number: num, tag, source });
  return { ok: true, tag, added: true };
}

export function removeTag(number, rawTag, { tenantSlug = tenant() } = {}) {
  if (!crmEnabled()) return { ok: false, reason: 'disabled' };
  const num = String(number || '').replace(/\D/g, '');
  const tag = normaliseTag(rawTag);
  if (!num || !tag) return { ok: false, reason: 'invalid' };
  const removed = removeContactTag({ tenant: tenantSlug, number: num, tag });
  return { ok: true, tag, removed: Boolean(removed) };
}

export function tagOverview({ tenantSlug = tenant() } = {}) {
  return tagCounts({ tenant: tenantSlug });
}

export function findByTag(rawTag, { tenantSlug = tenant() } = {}) {
  const tag = normaliseTag(rawTag);
  if (!tag) return { ok: false, reason: 'invalid_tag', tag: null, contacts: [] };
  const numbers = numbersWithTag(tag, { tenant: tenantSlug });
  const contacts = numbers.map((number) => {
    const contact = getContact(number) || {};
    return {
      number,
      name: contact.name || contact.push_name || null,
      blocked: Boolean(contact.is_blocked),
      tagsOnly: true,
    };
  });
  return { ok: true, tag, contacts };
}

// ── notes ───────────────────────────────────────────────────

export function addNote(number, text, { author = 'owner', tenantSlug = tenant() } = {}) {
  if (!crmEnabled()) return { ok: false, reason: 'disabled' };
  const num = String(number || '').replace(/\D/g, '');
  const note = normaliseNote(text);
  if (!num) return { ok: false, reason: 'invalid_number' };
  if (!note) return { ok: false, reason: 'empty_note' };
  const row = addContactNote({ tenant: tenantSlug, number: num, note, author });
  return { ok: true, note: row };
}

export function notesFor(number, { tenantSlug = tenant(), limit = 20 } = {}) {
  const num = String(number || '').replace(/\D/g, '');
  if (!num) return [];
  return contactNotes(num, { tenant: tenantSlug, limit });
}

// ── tags the bot derives ────────────────────────────────────

/**
 * Work out which automatic tags apply, from rows that already exist.
 * No model, no guessing: orders, messages, referrals, complaints.
 */
export function deriveAutoTags(number, { now = new Date(), tenantSlug = tenant() } = {}) {
  const num = String(number || '').replace(/\D/g, '');
  if (!num) return [];
  const found = [];

  const orders = all(
    'SELECT id, total, status, created_at FROM orders WHERE chat = ? OR chat = ?',
    [num, `${num}@s.whatsapp.net`]
  );
  const contact = getContact(num);
  const inbound = get('SELECT COUNT(*) AS n FROM messages WHERE number = ? AND role = ?', [num, 'user'])?.n || 0;

  if (!orders.length && inbound <= 2) found.push('new');
  if (orders.length >= 2) found.push('repeat');

  const vipSpend = Number(profile()?.business?.crm?.vipSpend);
  if (Number.isFinite(vipSpend) && vipSpend > 0) {
    const spend = orders
      .filter((order) => !['cancelled', 'refunded'].includes(order.status))
      .reduce((sum, order) => sum + Number(order.total || 0), 0);
    if (spend >= vipSpend) found.push('vip');
  }

  const coldDays = Number(process.env.CRM_COLD_DAYS || 45);
  const lastSeen = contact?.last_seen ? new Date(contact.last_seen) : null;
  if (lastSeen && (now.getTime() - lastSeen.getTime()) / 86_400_000 >= coldDays) found.push('cold');

  // Intents are stored against the chat (a jid), so look for both forms.
  const complaint = get(
    "SELECT 1 AS x FROM message_intents WHERE (chat = ? OR chat = ?) AND intent = 'complaint' LIMIT 1",
    [num, `${num}@s.whatsapp.net`]
  );
  if (complaint) found.push('complaint');

  const referral = get('SELECT 1 AS x FROM referrals WHERE number = ? LIMIT 1', [num]);
  const referred = get("SELECT 1 AS x FROM events WHERE type = 'referral_attributed' AND number = ? LIMIT 1", [num]);
  if (referral || referred) found.push('referrer');

  void tenantSlug;
  return found;
}

/**
 * Recompute the automatic tags: add what applies, remove what no longer does.
 * Owner-added tags are never touched — even if the rule disagrees with a human.
 */
export function applyAutoTags(number, { now = new Date(), tenantSlug = tenant() } = {}) {
  if (!crmEnabled()) return { ok: false, reason: 'disabled', added: [], removed: [] };
  const num = String(number || '').replace(/\D/g, '');
  if (!num) return { ok: false, reason: 'invalid_number', added: [], removed: [] };

  const wanted = new Set(deriveAutoTags(num, { now, tenantSlug }));
  const current = tagsFor(num, { tenantSlug });
  const auto = new Set(current.filter((row) => row.source === 'auto').map((row) => row.tag));
  const manual = new Set(current.filter((row) => row.source !== 'auto').map((row) => row.tag));

  const added = [];
  const removed = [];

  for (const tag of wanted) {
    if (auto.has(tag) || manual.has(tag)) continue;
    if (countTagsFor(num, { tenant: tenantSlug }) >= MAX_TAGS_PER_CONTACT) break;
    addContactTag({ tenant: tenantSlug, number: num, tag, source: 'auto' });
    added.push(tag);
  }

  for (const tag of auto) {
    if (wanted.has(tag)) continue;
    removeContactTag({ tenant: tenantSlug, number: num, tag });
    removed.push(tag);
  }

  return { ok: true, added, removed, tags: [...wanted] };
}

/** One person's CRM record, for a dossier or a panel. */
export function crmProfile(number, { tenantSlug = tenant() } = {}) {
  const num = String(number || '').replace(/\D/g, '');
  return {
    number: num,
    tags: tagsFor(num, { tenantSlug }).map((row) => row.tag),
    notes: notesFor(num, { tenantSlug, limit: 5 }),
    autoTags: deriveAutoTags(num, { tenantSlug }),
  };
}

/**
 * Campaign audience filtering. A tag narrows the list; it never widens it —
 * opt-out, quiet hours and caps are applied later, by growth.js, exactly as
 * they are for an unfiltered campaign.
 */
export function filterByTag(rows = [], rawTag = null, { tenantSlug = tenant() } = {}) {
  const tag = normaliseTag(rawTag);
  if (!tag) return { tag: null, rows };
  const allowed = new Set(numbersWithTag(tag, { tenant: tenantSlug }));
  return { tag, rows: rows.filter((row) => allowed.has(String(row.number))) };
}

export default {
  crmEnabled,
  normaliseTag,
  normaliseNote,
  tagsFor,
  addTag,
  removeTag,
  tagOverview,
  findByTag,
  addNote,
  notesFor,
  deriveAutoTags,
  applyAutoTags,
  crmProfile,
  filterByTag,
  AUTO_TAGS,
  MAX_TAGS_PER_CONTACT,
  MAX_NOTE_LENGTH,
};
