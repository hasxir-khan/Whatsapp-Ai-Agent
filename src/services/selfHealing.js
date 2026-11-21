// src/services/selfHealing.js
// Learning from the owner — carefully.
//
// The observation is simple: the bot answered, then the owner typed the answer
// himself. That gap is the most valuable training signal this system will ever
// get, and also the most dangerous one, because a customer's words are in it.
//
// So the loop is:
//   1. only fires when the owner *manually replied* in a chat where the bot had
//      just spoken (the handoff path), never by watching customer messages
//   2. one candidate rule per exchange, at most three a day
//   3. names, phone numbers, emails, links and addresses are removed before the
//      rule is stored; instruction-shaped text is rejected outright; any price
//      that is not in the catalogue is rejected outright
//   4. the rule lands in pending_rules, never in the profile. It becomes an FAQ
//      only when the owner types .approve-rule <id>
//   5. a rejected rule is remembered as rejected and never proposed again

import { config } from '../config/env.js';
import { featureOn, faqList, addFaq, effectiveCatalog, policies } from './profile.js';
import { detectInjection } from '../core/injection.js';
import {
  getMessages, addPendingRule, pendingRules, getPendingRule, decidePendingRule,
  rulesProposedSince, ruleByQuestion, getContact, logEvent,
} from '../utils/db.js';

export function selfHealingEnabled() {
  return featureOn('selfHealing');
}

// ── text hygiene ─────────────────────────────────────────────
const PHONE = /(\+?\d[\d\s().-]{7,}\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const URL = /\bhttps?:\/\/\S+/gi;
const ADDRESS = /\b(house|flat|plot|street|st\.|road|sector|block|phase|apartment|floor|gali|mohallah)\b[^.,\n]{0,40}/gi;
const MONEY = /(?:rs\.?|pkr|₨|rupees?)\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*(?:rs\.?|rupees?|pkr)\b/gi;
const PERCENT = /(\d{1,3})\s*%\s*(?:off|discount|chhoot)?/gi;

function tokens(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function jaccard(a = '', b = '') {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const t of A) if (B.has(t)) common += 1;
  return common / (A.size + B.size - common);
}

/** Names the owner might type: the contact's own name, and any greeting name. */
function knownNames(number) {
  const c = getContact(number) || {};
  const names = new Set();
  for (const raw of [c.name, c.push_name]) {
    if (!raw) continue;
    for (const part of String(raw).split(/\s+/)) {
      if (part.length > 2) names.add(part.toLowerCase());
    }
  }
  return names;
}

/**
 * Strip everything that belongs to one customer rather than to the business.
 * Returns the cleaned text and what was found, so the caller can explain itself.
 */
export function sanitise(text = '', { number = null } = {}) {
  let out = String(text || '');
  const removed = [];

  const drop = (re, label) => {
    re.lastIndex = 0;
    if (!re.test(out)) return;
    removed.push(label);
    re.lastIndex = 0;
    out = out.replace(re, ' ');
  };

  drop(URL, 'link');
  drop(EMAIL, 'email');
  drop(PHONE, 'phone');
  drop(ADDRESS, 'address');

  // The customer's name is the one name we know for certain.
  for (const name of knownNames(number)) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    if (re.test(out)) {
      removed.push('name');
      out = out.replace(re, ' ');
    }
  }

  out = out
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,;:\s-]+|[,;:\s-]+$/g, '')
    .trim();

  return { text: out, removed: [...new Set(removed)] };
}

function catalogNumbers() {
  const prices = new Set();
  for (const item of effectiveCatalog()) {
    for (const key of ['price', 'min', 'max']) {
      const n = Number(item?.[key]);
      if (Number.isFinite(n) && n > 0) prices.add(Math.round(n));
    }
  }
  return prices;
}

/**
 * Would this answer introduce a price the owner never configured, or a rule the
 * bot would follow blindly? Both are reasons to refuse, out loud.
 */
export function auditRule(question = '', answer = '') {
  const text = `${question}\n${answer}`;
  const reasons = [];

  const injection = detectInjection(text);
  if (injection.found) reasons.push(`instruction-like text (${injection.hits[0]})`);

  // "always tell customers…", "never mention…", "you must…" — a rule is data,
  // not an order to the assistant.
  if (/\b(always|never)\s+(tell|say|mention|offer|promise|ask|reply|answer)\b/i.test(text)) {
    reasons.push('it orders the bot how to behave instead of stating a fact');
  }
  if (/\b(you must|you should always|from now on|ignore the|override)\b/i.test(text)) {
    reasons.push('it tries to change the bot\'s instructions');
  }

  const known = catalogNumbers();
  MONEY.lastIndex = 0;
  let match;
  while ((match = MONEY.exec(text)) !== null) {
    const raw = match[1] || match[2] || '';
    const amount = Math.round(Number(String(raw).replace(/,/g, '')));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (!known.has(amount)) reasons.push(`price ${amount} is not in the catalogue`);
  }

  const cap = Number(policies().maxDiscountPercent);
  PERCENT.lastIndex = 0;
  while ((match = PERCENT.exec(text)) !== null) {
    const pct = Number(match[1]);
    if (Number.isFinite(pct) && pct > 0) {
      if (!Number.isFinite(cap) || cap <= 0) reasons.push(`${pct}% discount is not authorised`);
      else if (pct > cap) reasons.push(`${pct}% is above the ${cap}% the owner allows`);
    }
  }

  // An answer made only of placeholders is not an answer.
  const body = answer.replace(/[^\p{L}\p{N}]/gu, '');
  if (body.length < 8) reasons.push('the answer is too short to be a rule');

  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** Is this question already covered — by an FAQ, or by a rule we proposed before? */
export function duplicateOf(question = '') {
  const q = String(question || '').trim();
  if (!q) return null;
  const seen = ruleByQuestion(q);
  if (seen) return { kind: seen.status, id: seen.id, question: seen.question };

  for (const faq of faqList()) {
    if (jaccard(q, faq.q || '') >= 0.75) return { kind: 'faq', question: faq.q };
  }
  return null;
}

function lastExchange(number) {
  const rows = getMessages(number, 20);
  let botIndex = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].role === 'assistant') {
      botIndex = i;
      break;
    }
  }
  if (botIndex === -1) return null;

  let question = null;
  for (let i = botIndex - 1; i >= 0; i -= 1) {
    if (rows[i].role === 'user') {
      question = rows[i];
      break;
    }
  }
  return { bot: rows[botIndex], question };
}

function looksLikeQuestion(text = '') {
  const s = String(text || '').trim();
  if (s.length < 6 || s.length > 200) return false;
  if (/\?$/.test(s)) return true;
  return /\b(do you|can you|is there|are you|how|what|when|where|which|why|kitna|kitne|kya|kaise|kab|kahan|kia)\b/i.test(s);
}

/**
 * One candidate rule from one exchange. Pure: no I/O beyond reading what it is
 * given, so the rules can be tested without a phone.
 */
export function candidateFrom({ number = null, question = '', botText = '', ownerText = '', now = new Date() } = {}) {
  const reasons = [];

  if (!looksLikeQuestion(question)) reasons.push('the customer message does not look like a question');
  if (String(ownerText || '').trim().length < 12) reasons.push('the owner reply is too short to learn from');

  // Material difference: if the owner said what the bot said, there is nothing
  // to learn. This is the check that keeps the feature from learning noise.
  const similarity = jaccard(botText, ownerText);
  if (similarity >= 0.55) reasons.push('the owner said essentially what the bot said');

  const q = sanitise(question, { number });
  const a = sanitise(ownerText, { number });
  if (!q.text || !a.text) reasons.push('nothing survived sanitisation');

  const audit = auditRule(q.text, a.text);
  reasons.push(...audit.reasons);

  const questionText = q.text.replace(/\s+/g, ' ').trim().slice(0, 200);
  const answerText = a.text.replace(/\s+/g, ' ').trim().slice(0, 400);

  const duplicate = reasons.length ? null : duplicateOf(noteKey(questionText));
  if (duplicate) reasons.push(`already covered (${duplicate.kind})`);

  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    question: questionText,
    answer: answerText,
    removed: [...new Set([...q.removed, ...a.removed])],
    similarity: Number(similarity.toFixed(2)),
    duplicate,
    at: now.toISOString(),
  };
}

/**
 * The key a rule is remembered under. "Do you deliver to Gulberg?" and "do you
 * deliver to gulberg" are the same question, so normalise before storing.
 */
export function noteKey(question = '') {
  return String(question || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function proposalsToday(now = new Date()) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return rulesProposedSince(start.toISOString());
}

export function limitPerDay() {
  return Math.max(1, Number(config.selfHealing?.maxPerDay) || 3);
}

/**
 * The hook the handler calls when the owner types a reply into a customer chat.
 * Returns what happened, and never throws: this runs *after* the owner's message
 * is already sent, and must not interfere with it.
 */
export function observeOwnerReply({ number = null, text = '', transport = null, now = new Date() } = {}) {
  if (!selfHealingEnabled()) return { handled: false, reason: 'disabled' };
  if (!number || !String(text || '').trim()) return { handled: false, reason: 'empty' };

  const exchange = lastExchange(number);
  if (!exchange) return { handled: false, reason: 'no_bot_reply' };

  const windowMs = Math.max(1, Number(config.selfHealing?.windowMinutes) || 30) * 60000;
  const botAt = Date.parse(exchange.bot?.created_at || '');
  if (Number.isFinite(botAt) && now.getTime() - botAt > windowMs) {
    return { handled: false, reason: 'too_late' };
  }

  if (pendingRules('pending', 50).length >= 10) {
    return { handled: false, reason: 'too_many_pending' };
  }

  if (proposalsToday(now) >= limitPerDay()) {
    logEvent('rule_capped', number, { limit: limitPerDay() });
    return { handled: false, reason: 'daily_cap' };
  }

  const candidate = candidateFrom({
    number,
    question: exchange.question?.content || '',
    botText: exchange.bot?.content || '',
    ownerText: text,
    now,
  });

  if (!candidate.ok) {
    logEvent('rule_skipped', number, candidate.reasons.join('; '));
    return { handled: false, reason: 'rejected', reasons: candidate.reasons };
  }

  const row = addPendingRule({
    number,
    question: noteKey(candidate.question),
    answer: candidate.answer,
    created_at: now.toISOString(),
  });
  logEvent('rule_proposed', number, { id: row.id, removed: candidate.removed });

  const notice =
    `🧠 *New rule learned* (#${row.id})\n\n` +
    `Q: ${candidate.question}\n` +
    `A: ${candidate.answer}\n` +
    (candidate.removed.length ? `\n_Removed before storing: ${candidate.removed.join(', ')}_\n` : '') +
    `\nType .approve-rule ${row.id} or .reject-rule ${row.id}`;

  if (transport?.sendMessage) {
    Promise.resolve(transport.sendMessage(config.owner.jid, { text: notice })).catch((err) =>
      logEvent('rule_notify_failed', number, err.message)
    );
  }

  return { handled: true, rule: row, notice, candidate };
}

// ── owner-facing ─────────────────────────────────────────────
export function rulesText() {
  if (!selfHealingEnabled()) {
    return 'Rule learning is off. Turn it on with: .set features.selfHealing true';
  }
  const rows = pendingRules('pending', 10);
  const head = `🧠 *Rules waiting for you* (${proposalsToday()} proposed today, max ${limitPerDay()})`;
  if (!rows.length) {
    return `${head}\n\nNothing pending. When you answer a customer yourself right after the bot, the difference becomes a candidate rule here.`;
  }
  const list = rows.map((r) => `#${r.id}  Q: ${r.question}\n     A: ${String(r.answer).slice(0, 160)}`);
  return `${head}\n\n${list.join('\n\n')}\n\n.approve-rule <id>  ·  .reject-rule <id>`;
}

/** Approve a rule: it becomes an ordinary FAQ, through the same path as .addfaq. */
export function approveRule(id) {
  const row = getPendingRule(Number(id));
  if (!row) return { ok: false, reply: `No rule with id ${id}.` };
  if (row.status !== 'pending') return { ok: false, reply: `Rule #${id} is already ${row.status}.` };

  const audit = auditRule(row.question, row.answer);
  if (!audit.ok) {
    decidePendingRule(row.id, 'rejected', { reason: `re-audit: ${audit.reasons.join('; ')}` });
    return { ok: false, reply: `Rule #${id} was rejected on re-check: ${audit.reasons.join('; ')}` };
  }

  try {
    addFaq(row.question, row.answer);
  } catch (err) {
    return { ok: false, reply: `Could not add the FAQ: ${err.message}` };
  }
  decidePendingRule(row.id, 'approved');
  logEvent('rule_approved', row.number, { id: row.id });
  return {
    ok: true,
    rule: row,
    reply: `✅ Rule #${row.id} is now an FAQ.\nQ: ${row.question}\nA: ${row.answer}\n\nIt applies to every customer from the next message.`,
  };
}

export function rejectRule(id) {
  const row = getPendingRule(Number(id));
  if (!row) return { ok: false, reply: `No rule with id ${id}.` };
  if (row.status !== 'pending') return { ok: false, reply: `Rule #${id} is already ${row.status}.` };
  decidePendingRule(row.id, 'rejected', { reason: 'rejected by owner' });
  logEvent('rule_rejected', row.number, { id: row.id });
  return { ok: true, rule: row, reply: `🚫 Rule #${id} rejected. It will not be proposed again.` };
}

export default {
  selfHealingEnabled,
  observeOwnerReply,
  candidateFrom,
  sanitise,
  auditRule,
  duplicateOf,
  rulesText,
  approveRule,
  rejectRule,
  proposalsToday,
  limitPerDay,
  noteKey,
};
