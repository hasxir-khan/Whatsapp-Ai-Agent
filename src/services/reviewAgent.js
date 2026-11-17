// src/services/reviewAgent.js
// The review and referral agent (features.reviewAgent).
//
// After a job is finished — a booking marked done, an order delivered — we wait
// (24 hours by default) and ask one short question: how did we do, 1 to 5?
//
// What happens next depends on the answer, and the split is deliberate:
//   • 4-5 → the review link (if the owner has one) and one referral invitation
//   • 1-3 → no review link, ever. A thank-you, and the owner hears about it
//           with the customer's own words, because that is the message that
//           actually needs a human.
//
// One ask per completed job. Opt-outs and quiet hours apply like everywhere
// else, because they live in growth.js and this file has no way around them.

import { config } from '../config/env.js';
import { business, featureOn, reviewLink, referral as referralConfig } from './profile.js';
import { sendProactively } from './growth.js';
import { detectLanguage } from './language.js';
import {
  getContact, scheduleReviewAsk, dueReviewAsks, reviewAskFor, setReviewAsk, reviewAsk,
  saveReferral, getReferral, referralFor, bumpReferral, logEvent, all, saveLead, upsertContact,
} from '../utils/db.js';

const HOUR = 3600 * 1000;

export function reviewAgentEnabled() {
  return featureOn('reviewAgent');
}

function firstName(contact = {}) {
  const raw = contact.name || contact.push_name || '';
  return String(raw).split(' ')[0] || '';
}

/** How long after the job we ask. Owner can override per business. */
export function askDelayHours() {
  const b = business();
  const raw = b.review?.afterHours ?? b.reviewAfterHours;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : config.review.afterHours;
}

/**
 * Queue the ask for one finished job. Idempotent: the (kind, ref_id) index
 * means a double `.done` can never produce two messages.
 */
export function scheduleAfterJob({ number, kind, refId, now = new Date() } = {}) {
  if (!reviewAgentEnabled() || !number || refId == null) return null;
  const dueAt = new Date(now.getTime() + askDelayHours() * HOUR).toISOString();
  const row = scheduleReviewAsk({ number, kind, refId, dueAt });
  if (row) logEvent('review_scheduled', number, { kind, refId, dueAt });
  return row;
}

// ── the ask ────────────────────────────────────────────────
/** Short, one question, in their language. Never a wall of text. */
export function buildAsk({ contact = {}, kind = 'booking', lang = null } = {}) {
  const code = lang || contact.language || 'en';
  const name = firstName(contact);
  const hi = name ? `Hi ${name}` : 'Hi';
  const what = kind === 'order' ? 'your order' : 'your visit';

  if (code === 'ur') {
    return `${name ? name + ' صاحب، ' : ''}آپ کے ${kind === 'order' ? 'آرڈر' : 'وزٹ'} کے بارے میں پوچھنا تھا — 1 سے 5 تک بتائیں، کیسا رہا؟`;
  }
  if (code === 'roman-ur') {
    return `${hi} — ${kind === 'order' ? 'order' : 'visit'} kaisa raha? 1 se 5 tak bata dein (5 = bohat acha).`;
  }
  return `${hi} — how was ${what}? Just reply with a number from 1 to 5 (5 = great).`;
}

// ── the answer ─────────────────────────────────────────────
const WORD_RATINGS = { one: 1, two: 2, three: 3, four: 4, five: 5 };

/** "5", "5/5", "4 stars", "پانچ" — a rating, or nothing. */
export function parseRating(text = '') {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 40) return null;
  // The score has to *start* the message: "5" and "2 — burger was cold" are
  // ratings, "can I order 2 burgers" is an order.
  const leading = /^\s*([1-5])(?:\s*\/\s*5|\s*(?:stars?|out\s+of\s+5))?(?=\s|$|[.,!?—–-])/i.exec(clean);
  if (leading) return Number(leading[1]);
  const word = /^\s*(one|two|three|four|five)\s*(?:stars?)?\s*[.!]?\s*$/i.exec(clean);
  if (word) return WORD_RATINGS[word[1].toLowerCase()];
  const urdu = /^\s*([۱-۵])\s*(?:\/\s*۵)?\s*$/.exec(clean);
  if (urdu) return { '۱': 1, '۲': 2, '۳': 3, '۴': 4, '۵': 5 }[urdu[1]];
  return null;
}

// ── referrals ──────────────────────────────────────────────
/**
 * A short, readable code per customer: initials of the business plus a stable
 * four-character fingerprint of the number, so the same person always gets the
 * same code — no table lookup needed to regenerate it.
 */
export function referralCode(number = '') {
  const existing = referralFor(number);
  if (existing?.code) return existing.code;

  const prefix = (business().name || 'GO')
    .replace(/[^A-Za-z]/g, '')
    .slice(0, 2)
    .toUpperCase()
    .padEnd(2, 'X');
  let hash = 0;
  const digits = String(number).replace(/\D/g, '');
  for (let i = 0; i < digits.length; i++) hash = (hash * 31 + digits.charCodeAt(i)) % 1_679_616; // 36^4
  const code = `${prefix}${hash.toString(36).toUpperCase().padStart(4, '0')}`;
  saveReferral({ code, number });
  return code;
}

/** Did a newcomer arrive quoting someone's code? */
export function findReferralCode(text = '', number = '') {
  const clean = String(text || '');
  if (!clean) return null;

  const explicit = /\bref(?:erral)?[\s:#-]*([a-z0-9]{4,10})\b/i.exec(clean);
  if (explicit) {
    const code = explicit[1].toUpperCase();
    const row = getReferral(code);
    if (row && row.number !== number) return row;
  }

  // Otherwise look for any known code as a whole word — "ALI4F2 se aaya hoon".
  for (const row of all('SELECT * FROM referrals LIMIT 500')) {
    if (row.number === number) continue;
    const re = new RegExp(`\\b${String(row.code).replace(/[^A-Z0-9]/gi, '')}\\b`, 'i');
    if (re.test(clean)) return row;
  }
  return null;
}

/**
 * Tag the newcomer's source and tell the owner. Rewards are mentioned only
 * when the business actually configured one.
 */
export function attributeReferral({ number, text, transport = null, context = null } = {}) {
  const row = findReferralCode(text, number);
  if (!row) return null;

  bumpReferral(row.code);
  logEvent('referral_attributed', number, { code: row.code, from: row.number });
  const contact = getContact(number);
  if (contact) upsertContact(number, { category: 'referral' });
  saveLead({ number, status: 'new', notes: `referred by ${row.number} (${row.code})` });

  const reward = referralConfig().reward || referralConfig().message || null;
  const who = firstName(contact || {}) || `+${number}`;
  const referrer = getContact(row.number);
  const referrerName = referrer?.name || referrer?.push_name || `+${row.number}`;

  if (transport) {
    const text2 =
      `🤝 *Referral* — ${who} (+${number}) came via ${referrerName}'s code ${row.code}.` +
      (context ? `\n\nThey said: "${String(context).slice(0, 200)}"` : '') +
      (reward ? `\nReward promised: ${reward}` : '\n(No reward is configured — this is tracking only.)');
    Promise.resolve(transport.sendMessage(config.owner.jid, { text: text2 })).catch((err) =>
      logEvent('referral_notify_failed', number, err.message)
    );
  }

  return { code: row.code, referrer: row.number, reward };
}

/** The one invitation, sent only to someone who just rated us well. */
export function buildReferralInvite({ contact = {}, lang = 'en', code, reward = null } = {}) {
  const name = firstName(contact);
  const rewardLine =
    reward == null
      ? ''
      : lang === 'ur'
        ? ` (جب وہ آپ کا کوڈ بتائیں، آپ کو ${reward} ملے گا)`
        : lang === 'roman-ur'
          ? ` (jab wo aap ka code batayen, aap ko ${reward} milega)`
          : ` (when they mention it, you get ${reward})`;

  if (lang === 'ur') return `${name ? name + ' صاحب، ' : ''}اگر کسی کو ضرورت ہو تو میرا نمبر اور کوڈ ${code} دے دیں${rewardLine}۔`;
  if (lang === 'roman-ur') return `${name ? name + ', ' : ''}kisi ko zaroorat ho to mera number aur code ${code} de dein${rewardLine}.`;
  return `${name ? `${name}, ` : ''}if you know someone who needs this, pass on my number and the code ${code}${rewardLine}.`;
}

// ── the loop ───────────────────────────────────────────────
/**
 * Send the asks that are due. Quiet hours leave them scheduled (they go out
 * the next morning); an opt-out cancels them for good.
 */
export async function runReviewAgent({ transport, now = new Date() } = {}) {
  if (!reviewAgentEnabled()) return { asked: 0, skipped: 0 };

  const due = dueReviewAsks(now.toISOString());
  const result = { asked: 0, skipped: 0, details: [] };

  for (const ask of due) {
    const contact = getContact(ask.number) || { number: ask.number };
    const text = buildAsk({ contact, kind: ask.kind, lang: contact.language });

    const outcome = await sendProactively({
      transport,
      number: ask.number,
      text,
      agent: 'review',
      reason: `${ask.kind} #${ask.ref_id} feedback`,
      now,
    });

    if (outcome.sent) {
      setReviewAsk(ask.id, { status: 'asked' });
      result.asked += 1;
      result.details.push({ id: ask.id, number: ask.number, sent: true });
      continue;
    }

    if (outcome.reason === 'opted_out') {
      setReviewAsk(ask.id, { status: 'skipped' });
      result.skipped += 1;
      result.details.push({ id: ask.id, number: ask.number, sent: false, reason: outcome.reason });
      continue;
    }

    // Quiet hours, caps, a closed Cloud window: not now is not never.
    result.skipped += 1;
    result.details.push({ id: ask.id, number: ask.number, sent: false, reason: outcome.reason, retry: true });
  }

  return result;
}

/**
 * A customer answered. Only called when a review ask is actually waiting —
 * "5" in the middle of an unrelated chat is a quantity, not a rating.
 */
export async function handleRating({ number, text = '', transport = null, now = new Date() } = {}) {
  if (!reviewAgentEnabled()) return { handled: false };
  const ask = reviewAskFor(number);
  // Only once we have actually asked. A "5" between `.done` and the scheduled
  // ask is a quantity in some other conversation.
  if (!ask || ask.status !== 'asked') return { handled: false };

  const rating = parseRating(text);
  if (rating == null) return { handled: false };

  const contact = getContact(number) || { number };
  const lang = contact.language || detectLanguage(text).code || 'en';
  const name = firstName(contact);

  setReviewAsk(ask.id, { status: 'rated', rating });
  logEvent('review_rated', number, { rating, ask: ask.id });

  if (rating >= 4) {
    const link = reviewLink();
    const code = referralCode(number);
    const reward = referralConfig().reward || null;
    const invitedBefore = all("SELECT 1 AS c FROM events WHERE type = 'referral_invited' AND number = ? LIMIT 1", [number]).length > 0;

    const thanks =
      lang === 'ur'
        ? `بہت شکریہ${name ? ' ' + name + ' صاحب' : ''}! 🙏`
        : lang === 'roman-ur'
          ? `Bohat shukriya${name ? ' ' + name : ''}! 🙏`
          : `Thank you${name ? `, ${name}` : ''}! 🙏`;

    const parts = [thanks];
    if (link) parts.push(link);
    if (!invitedBefore) {
      parts.push(buildReferralInvite({ contact, lang, code, reward }));
      logEvent('referral_invited', number, { code });
    }

    const reply = parts.join('\n\n');
    if (transport) await safeSend(transport, number, reply);
    return { handled: true, rating, reply, reviewLinkSent: !!link, referralCode: code };
  }

  // 1-3: thank them, send no link, and get a human involved with the reason.
  const reply =
    lang === 'ur'
      ? `شکریہ کہ آپ نے بتایا۔ مجھے افسوس ہے کہ تجربہ اچھا نہیں رہا — مالک خود آپ سے رابطہ کریں گے۔`
      : lang === 'roman-ur'
        ? 'Batane ka shukriya. Afsos hai ke tajurba acha nahi raha — owner khud rabta karenge.'
        : "Thanks for telling me — I'm sorry it wasn't good. The owner will reach out personally.";

  if (transport) {
    await safeSend(transport, number, reply);
    const who = name || `+${number}`;
    const alert =
      `⚠️ *Low rating: ${rating}/5* from ${who} (+${number})\n\n` +
      `They said: "${String(text).slice(0, 300)}"\n\n` +
      `No review link was sent. This one needs you.`;
    try {
      await transport.sendMessage(config.owner.jid, { text: alert });
    } catch (err) {
      logEvent('review_alert_failed', number, err.message);
    }
  }

  logEvent('review_low', number, { rating });
  return { handled: true, rating, reply, reviewLinkSent: false, alertOwner: true };
}

async function safeSend(transport, number, text) {
  try {
    await transport.sendMessage(`${number}@s.whatsapp.net`, { text });
    return true;
  } catch (err) {
    logEvent('review_send_failed', number, err.message);
    return false;
  }
}

export function startReviewLoop({ transport, intervalMs = 15 * 60_000 } = {}) {
  if (!reviewAgentEnabled()) return null;

  const tick = async () => {
    try {
      await runReviewAgent({ transport });
    } catch (err) {
      logEvent('review_agent_error', null, err.message);
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 30_000).unref?.();
  console.log(`⭐ Review agent loop started (asks ${askDelayHours()}h after a job)`);
  return timer;
}

export { reviewAsk };

export default {
  reviewAgentEnabled, askDelayHours, scheduleAfterJob, buildAsk, parseRating,
  referralCode, findReferralCode, attributeReferral, buildReferralInvite,
  runReviewAgent, handleRating, startReviewLoop,
};
