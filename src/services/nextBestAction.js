// src/services/nextBestAction.js
// Phase 6 Part 3 — what to do about this customer next.
//
// The ranking is a small, readable score: recency, value, stage and the caps
// that already exist. The model may rewrite one sentence of explanation, but it
// never picks the action and never invents a reason — if it is unavailable the
// deterministic reason is used as-is.
//
// Nothing here sends anything. The output is a suggestion the owner can act on.

import { featureOn, business, profile } from './profile.js';
import { config } from '../config/env.js';
import * as db from '../utils/db.js';
import { chat, hasLLM } from '../core/llm.js';
import { fenceUntrusted } from '../core/injection.js';
import { isOptedOut, canSendProactively } from './growth.js';
import { weightFor, recordOutcome } from './learning.js';

const DAY = 24 * 3600 * 1000;

export const ACTIONS = {
  followup: { label: 'Follow up', needsSend: true },
  quote_reminder: { label: 'Remind about the quote', needsSend: true },
  offer: { label: 'Offer inside your caps', needsSend: true },
  upsell: { label: 'Suggest something from the catalogue', needsSend: true },
  review_ask: { label: 'Ask for a review', needsSend: true },
  reactivate: { label: 'Win back', needsSend: true },
  wait: { label: 'Do nothing yet', needsSend: false },
  ask_owner: { label: 'Ask the owner', needsSend: false },
};

export function nbaEnabled() {
  return featureOn('businessBrain');
}

const daysBetween = (a, b) => Math.floor(Math.abs(b - a) / DAY);

function lastMessages(number) {
  const lastUser = db.get(
    `SELECT content, created_at FROM messages WHERE number = ? AND role = 'user' ORDER BY id DESC LIMIT 1`,
    [number]
  );
  const lastAny = db.get(`SELECT role, created_at FROM messages WHERE number = ? ORDER BY id DESC LIMIT 1`, [number]);
  return { lastUser, lastAny };
}

/**
 * Rank the possible next steps for one contact.
 * @returns {{action:string, label:string, score:number, reason:string, blocked:string[], draft:string|null}}
 */
export function nextBestAction(number, { now = new Date(), explain = false } = {}) {
  const contact = db.getContact?.(number) || null;
  const blocked = [];
  const candidates = [];

  if (!number) return { action: 'wait', label: ACTIONS.wait.label, score: 0, reason: 'no number', blocked, draft: null };

  const { lastUser, lastAny } = lastMessages(number);
  const lastAt = Math.max(Date.parse(lastUser?.created_at || 0) || 0, Date.parse(lastAny?.created_at || 0) || 0);
  const quietDays = lastAt ? daysBetween(lastAt, now.getTime()) : 999;

  const orders = db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM orders WHERE (chat = ? OR chat = ?) AND status IN ('paid','delivered')`, [number, `${number}@s.whatsapp.net`]);
  const bookings = db.get(`SELECT COUNT(*) AS n FROM bookings WHERE (chat = ? OR chat = ?) AND status IN ('booked','confirmed')`, [number, `${number}@s.whatsapp.net`]);
  const lead = db.get('SELECT status, score, budget, quote_min, quote_max FROM leads WHERE number = ?', [number]);
  const tags = db.all('SELECT tag FROM contact_tags WHERE number = ?', [number]).map((r) => r.tag);
  const asks = db.get('SELECT COUNT(*) AS n FROM review_asks WHERE number = ?', [number])?.n || 0;
  const optedOut = isOptedOut(number);
  const promoSent = db.get(
    `SELECT MAX(created_at) AS at FROM growth_sends WHERE number = ? AND agent = 'promo' AND result = 'sent'`,
    [number]
  )?.at;

  if (optedOut) blocked.push('opted out — nothing proactive may be sent');
  if (contact?.is_blocked) blocked.push('blocked');
  if (contact?.bot_paused_until && Date.parse(contact.bot_paused_until) > now.getTime()) blocked.push('the owner is handling this chat');

  const push = (action, score, reason) => {
    const weight = weightFor(`nba:${action}`);
    candidates.push({ action, score: Math.round(score * weight * 100) / 100, reason, weight });
  };

  // A lead with a quote and silence is the strongest signal there is.
  if (lead && ['quoted', 'negotiating'].includes(String(lead.status)) && quietDays >= 2) {
    push('quote_reminder', 80 + Math.min(20, quietDays), `quoted ${quietDays} days ago and no reply since`);
  }
  if (lead && ['new', 'qualified'].includes(String(lead.status))) {
    push('followup', 55 + Math.min(15, quietDays), `a ${lead.status} lead with no decision yet`);
  }
  if (lead && ['new', 'qualified', 'quoted'].includes(String(lead.status)) && Number(lead.score) >= 60) {
    push('upsell', 40, 'a high-score lead who has not been shown the full catalogue');
  }
  if (quietDays >= 30) {
    push('reactivate', 45 + Math.min(20, quietDays - 30), `${quietDays} days quiet`);
  } else if (quietDays >= 3 && !lead) {
    push('followup', 35 + quietDays, `${quietDays} days since their last message`);
  }
  if ((orders?.n || 0) > 0 && asks === 0 && quietDays >= 1) {
    push('review_ask', 50, 'a paid order with no review request yet');
  }
  if ((orders?.n || 0) > 0 && !asks) {
    push('upsell', 30, 'bought before — the catalogue has more to show');
  }
  if ((bookings?.n || 0) > 0) {
    push('followup', 25, 'has a booking on the books');
  }
  const offers = Array.isArray(business()?.offers) ? business().offers.length : 0;
  if (offers && quietDays >= 7 && (orders?.n || 0) === 0) {
    push('offer', 34, 'no order yet and a configured offer exists');
  }

  if (!candidates.length) {
    return {
      action: 'wait',
      label: ACTIONS.wait.label,
      score: 0,
      reason: blocked.length ? blocked[0] : 'nothing worth doing — leaving them alone is the right move',
      blocked,
      draft: null,
    };
  }

  const check = canSendProactively(number, { now, agent: 'nba' });
  for (const c of candidates) {
    if (!check.ok) c.blockedBy = check.reason;
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  if (blocked.length || !check.ok) {
    const why = blocked[0] || `held: ${check.reason}`;
    return {
      action: check.ok && !blocked.length ? best.action : 'wait',
      label: ACTIONS.wait.label,
      score: best.score,
      reason: `best would be "${ACTIONS[best.action].label}" (${best.reason}) but ${why}`,
      blocked: [...blocked, ...(check.ok ? [] : [check.reason])],
      draft: null,
      alternatives: candidates.slice(0, 3),
    };
  }

  const result = {
    action: best.action,
    label: ACTIONS[best.action].label,
    score: best.score,
    reason: best.reason,
    weight: best.weight,
    blocked,
    draft: draftFor(best.action, number, { now, contact, lead, orders }),
    alternatives: candidates.slice(1, 3),
  };

  if (explain) result.explanation = explainAction(result);
  return result;
}

/** A one-line draft the owner can send, or nothing. Never sent automatically. */
function draftFor(action, number, { contact, lead, orders } = {}) {
  const name = contact?.name || contact?.push_name || '';
  const shop = business()?.name || 'us';
  const hi = name ? `${name}, ` : '';
  switch (action) {
    case 'quote_reminder':
      return `${hi}just checking in on the quote — happy to adjust the scope or the timing if something did not fit.`;
    case 'followup':
      return `${hi}following up on your message to ${shop}. Anything I can clear up for you?`;
    case 'offer':
      return `${hi}we have ${String(business()?.offers?.[0] || 'an offer')} running — would you like me to hold one for you?`;
    case 'upsell':
      return `${hi}since you have ordered before, there are a couple of things from the catalogue you have not tried yet — want me to send them?`;
    case 'review_ask':
      return `${hi}thank you for your order${orders?.n ? '' : ''}! If you have a minute, a short review helps us more than you would think. No pressure at all.`;
    case 'reactivate':
      return `${hi}it has been a while — we are still here if you need anything. Reply and I will pick it up.`;
    default:
      return null;
  }
}

/** One short sentence, at most 300 characters, from facts only. */
export function explainAction(result) {
  const base = `${result.label}: ${result.reason}.`;
  if (!hasLLM() || !nbaEnabled()) return base.slice(0, 300);
  try {
    chat({
      system: 'Rewrite one sentence for a shop owner. Do not add numbers, promises or advice.',
      messages: [{ role: 'user', content: fenceUntrusted(base) }],
      maxTokens: 60,
      temperature: 0.3,
      small: true,
    })
      .then((res) => {
        const text = String(res?.text || '').trim();
        if (text && text.length <= 300) {
          recordDecisionNote(result.action, text);
        }
      })
      .catch(() => {});
  } catch {
    /* the deterministic sentence is already good */
  }
  return base.slice(0, 300);
}

function recordDecisionNote(action, text) {
  try {
    db.run(
      'INSERT INTO brain_decisions (tenant, chat, kind, action, rationale, payload, outcome, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [config.tenant?.slug || null, null, 'next_best_action', action, String(text).slice(0, 300), null, null, new Date().toISOString()]
    );
  } catch {
    /* analytics only */
  }
}

/** Mark an outcome for the learning loop (called by the owner command or a reply). */
export function recordActionOutcome({ action, agent = null, outcome = 'none' } = {}) {
  return recordOutcome({ action, agent, outcome });
}

export function nbaLine(number, opts = {}) {
  const nba = nextBestAction(number, opts);
  return `${nba.label} — ${nba.reason}`;
}

export default { nextBestAction, nbaLine, ACTIONS, nbaEnabled, explainAction, recordActionOutcome };
