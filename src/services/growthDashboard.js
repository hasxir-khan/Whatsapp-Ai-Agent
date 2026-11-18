// src/services/growthDashboard.js
// The numbers behind the dashboard's growth section.
//
// Read-only, and deliberately boring: every figure is a SELECT. No secrets, no
// tokens, no phone numbers beyond the count, nothing that could be used to
// message somebody. The funnel is the part worth looking at:
//
//   conversations → leads → quotes → orders → paid → reviewed
//
// Each step is counted on its own terms (someone who ordered without a quote
// still counts as an order), so the funnel answers "how far do people get",
// not "how tidy is the data".

import { get, all, logEvent } from '../utils/db.js';
import { featureOn } from './profile.js';
import { sourceSummary, sourceLinksEnabled } from './sourceLinks.js';

const count = (sql, params = []) => get(sql, params)?.c || 0;
const sum = (sql, params = []) => get(sql, params)?.s || 0;

// ── the funnel ─────────────────────────────────────────────
export function funnel() {
  const conversations = count("SELECT COUNT(DISTINCT number) AS c FROM messages WHERE role = 'user'");
  const leads = count('SELECT COUNT(*) AS c FROM leads');
  const quotes = count("SELECT COUNT(*) AS c FROM events WHERE type IN ('quote_sent','quote_built')");
  const orders = count("SELECT COUNT(*) AS c FROM orders WHERE status != 'cancelled'");
  const paid = count("SELECT COUNT(*) AS c FROM orders WHERE status IN ('paid','delivered')");
  const reviewed = count("SELECT COUNT(*) AS c FROM review_asks WHERE status = 'rated'");

  const steps = [
    { key: 'conversations', label: 'Conversations', value: conversations },
    { key: 'leads', label: 'Leads', value: leads },
    { key: 'quotes', label: 'Quotes', value: quotes },
    { key: 'orders', label: 'Orders', value: orders },
    { key: 'paid', label: 'Paid', value: paid },
    { key: 'reviewed', label: 'Reviewed', value: reviewed },
  ];

  // Conversion against the step before it, and against the top of the funnel.
  return steps.map((step, i) => {
    const previous = i > 0 ? steps[i - 1].value : step.value;
    return {
      ...step,
      fromPrevious: previous > 0 ? Math.round((step.value / previous) * 1000) / 10 : null,
      fromTop: conversations > 0 ? Math.round((step.value / conversations) * 1000) / 10 : null,
    };
  });
}

// ── per agent ──────────────────────────────────────────────
const AGENTS = ['booking', 'reminder', 'rebook', 'followup', 'reactivation', 'review', 'analyst', 'content'];

/**
 * For each agent: how many messages went out, how many of those people wrote
 * back, how many ended up buying, and how many opted out afterwards.
 */
export function agentStats() {
  const rows = all(
    `SELECT agent, result, COUNT(*) AS count, COUNT(DISTINCT number) AS people
       FROM growth_sends GROUP BY agent, result`
  );
  const byAgent = {};
  for (const row of rows) {
    byAgent[row.agent] = byAgent[row.agent] || { agent: row.agent, sent: 0, skipped: 0, held: 0, failed: 0, people: 0 };
    byAgent[row.agent][row.result] = (byAgent[row.agent][row.result] || 0) + row.count;
    byAgent[row.agent].people = Math.max(byAgent[row.agent].people, row.people);
  }

  const out = [];
  for (const agent of Object.keys(byAgent).sort()) {
    const sentRows = all(
      "SELECT number, created_at FROM growth_sends WHERE agent = ? AND result = 'sent'",
      [agent]
    );
    let replied = 0;
    let converted = 0;
    for (const row of sentRows) {
      const reply = get("SELECT 1 AS c FROM messages WHERE number = ? AND role = 'user' AND created_at > ? LIMIT 1", [
        row.number,
        row.created_at,
      ]);
      if (reply) replied += 1;
      const bought = get(
        `SELECT 1 AS c FROM orders WHERE chat = ? AND status IN ('paid','delivered')
         UNION SELECT 1 FROM bookings WHERE chat = ? AND status IN ('done','completed') LIMIT 1`,
        [`${row.number}@s.whatsapp.net`, `${row.number}@s.whatsapp.net`]
      );
      if (bought) converted += 1;
    }
    const optOuts = count(
      "SELECT COUNT(*) AS c FROM growth_optouts WHERE number IN (SELECT number FROM growth_sends WHERE agent = ?)",
      [agent]
    );
    out.push({ ...byAgent[agent], agent, replied, converted, optOuts });
  }

  // An agent that has never run still deserves a line, otherwise "0" looks
  // like "broken".
  for (const agent of AGENTS) {
    if (!out.find((a) => a.agent === agent)) {
      out.push({ agent, sent: 0, skipped: 0, held: 0, failed: 0, people: 0, replied: 0, converted: 0, optOuts: 0, idle: true });
    }
  }
  return out.sort((a, b) => b.sent - a.sent || a.agent.localeCompare(b.agent));
}

// ── where people come from ─────────────────────────────────
export const SOURCE_LABELS = {
  qr: 'QR code',
  link: 'Link',
  referral: 'Referral',
  ads: 'Ad tag',
  direct: 'Direct',
};

/**
 * Source per contact: an explicit tag (QR sticker, ad link) wins, then a
 * referral, then the tracked link this phase added, then how they were first
 * categorised. A referral outranks a tracked link because a human vouched for
 * us — that is the stronger claim.
 */
export function sourceOf(number) {
  const tag = get("SELECT detail FROM events WHERE type = 'source_tag' AND number = ? ORDER BY id LIMIT 1", [number]);
  if (tag?.detail) return normaliseSource(tag.detail);
  const referred = get("SELECT 1 AS c FROM events WHERE type = 'referral_attributed' AND number = ? LIMIT 1", [number]);
  if (referred) return 'referral';
  const tracked = get('SELECT source FROM contact_sources WHERE number = ?', [number]);
  if (tracked?.source) return tracked.source;
  const contact = get('SELECT category FROM contacts WHERE number = ?', [number]);
  return normaliseSource(contact?.category || 'direct');
}

/** A tracked source keeps its own name; the five old buckets keep their label. */
function labelFor(key) {
  if (SOURCE_LABELS[key]) return SOURCE_LABELS[key];
  const tracked = get('SELECT label FROM tracked_sources WHERE source = ?', [key]);
  return tracked?.label || key;
}

function normaliseSource(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (/^(qr|qrcode|qr_code|sticker)$/.test(s)) return 'qr';
  if (/^(link|bio|website|ig_bio|tiktok_bio)$/.test(s)) return 'link';
  if (/^(referral|ref)$/.test(s)) return 'referral';
  if (/^(ads?|ad|facebook|fb|instagram|ig|meta|google|tiktok)$/.test(s)) return 'ads';
  return 'direct';
}

/**
 * Conversations, leads, paid orders and revenue per source. This is the table
 * that answers "was the QR sticker worth printing?".
 */
export function sourceBreakdown() {
  const sources = {};
  const blank = () => ({ conversations: 0, leads: 0, paidOrders: 0, revenue: 0 });

  for (const row of all("SELECT DISTINCT number FROM messages WHERE role = 'user'")) {
    const key = sourceOf(row.number);
    sources[key] = sources[key] || blank();
    sources[key].conversations += 1;
  }
  for (const row of all('SELECT number FROM leads')) {
    const key = sourceOf(row.number);
    sources[key] = sources[key] || blank();
    sources[key].leads += 1;
  }
  for (const row of all("SELECT chat, total FROM orders WHERE status IN ('paid','delivered')")) {
    const number = String(row.chat || '').split('@')[0].replace(/\D/g, '');
    const key = sourceOf(number);
    sources[key] = sources[key] || blank();
    sources[key].paidOrders += 1;
    sources[key].revenue += Number(row.total) || 0;
  }

  return Object.entries(sources)
    .map(([key, value]) => ({ source: key, label: labelFor(key), ...value }))
    .sort((a, b) => b.revenue - a.revenue || b.conversations - a.conversations);
}

// ── one object for the page ────────────────────────────────
export function growthSnapshot() {
  return {
    funnel: funnel(),
    agents: agentStats(),
    sources: sourceBreakdown(),
    // Per tracked link: what it cost to print, and what it brought in. Empty
    // unless the owner has made one.
    sourceLinks: sourceLinksEnabled() ? sourceSummary() : { enabled: false, sources: [], stale: [], total: 0 },
    optOuts: count('SELECT COUNT(*) AS c FROM growth_optouts'),
    revenue: sum("SELECT SUM(total) AS s FROM orders WHERE status IN ('paid','delivered')"),
    features: {
      bookingAgent: featureOn('bookingAgent'),
      booking: featureOn('bookingAgent'),
      followUpAgent: featureOn('followUpAgent'),
      closerAgent: featureOn('closerAgent'),
      reviewAgent: featureOn('reviewAgent'),
      analystAgent: featureOn('analystAgent'),
      reactivationAgent: featureOn('reactivationAgent'),
      contentAgent: featureOn('contentAgent'),
      growthApproval: featureOn('growthApproval'),
    },
  };
}

/**
 * Record where a newcomer came from, from their first message. Only ever
 * written once per number, so a later mention of "#ads" cannot rewrite history.
 */
export function recordSourceTag(number, text = '') {
  if (!number || !text) return null;
  const existing = get("SELECT 1 AS c FROM events WHERE type = 'source_tag' AND number = ? LIMIT 1", [number]);
  if (existing) return null;

  const tag = /#(qr|qrcode|link|bio|ads?|ad|fb|facebook|ig|instagram|tiktok|google)\b/i.exec(text);
  if (!tag) return null;
  const source = normaliseSource(tag[1]);
  logEvent('source_tag', number, source);
  return source;
}

export default { funnel, agentStats, sourceBreakdown, growthSnapshot, sourceOf, recordSourceTag, SOURCE_LABELS };
