/**
 * Owner decisions + payment review.
 *
 * What this module does: when a customer sends a payment proof, it reads what
 * it can, runs the checks a computer can run, opens a decision request, tells
 * the customer once that the owner is checking, and puts a short card in front
 * of the owner. It never accepts money, never calls a proof real or fake, and
 * never accuses anyone.
 *
 * Everything here is behind `features.ownerDecisions` / `features.paymentReview`.
 * With both off, no code in this file is reached and the bot behaves exactly as
 * it did before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';
import { featureOn, profile, setPath } from './profile.js';
import {
  getOrder,
  orderFor,
  logOrderEvent,
  orderEvents,
  getContact,
  logEvent,
  run,
  all,
} from '../utils/db.js';
import { formatMoney } from './geo.js';
import { inQuietHours, sendProactively, sendToOwner } from './growth.js';
import {
  DECISION_TYPES,
  decisionSettings,
  teamLimit,
  teamRoster,
  memberFor,
  chainFor,
  chainRecipients,
  normalizeMemberNumber,
  validateDecisions,
  withinWorkingHours,
} from './decisionTeam.js';
import {
  getDecision,
  decisionEvents,
  listDecisions,
  openDecision,
  openDecisionsFor,
  openDecisionForOrder,
  decide,
  reverseDecision,
  escalate,
  expireDecisions,
  awaitingDecisionFor,
  normalizeDecisionId,
} from './decisions.js';
import {
  extractFields,
  runChecks,
  riskFromChecks,
  riskLine,
  saveProofFile,
  recordProof,
  proofsForRequest,
  recentProofs,
  purgeExpiredProofs,
  looksLikePaymentProof,
  forgetProofsFor,
  proofsForExport,
} from './paymentProofs.js';

const iso = (d) => (d instanceof Date ? d : new Date(d || Date.now())).toISOString();
const mins = (n) => Number(n) * 60_000;
const digits = (v) => String(v || '').replace(/\D/g, '');

export function paymentReviewOn() {
  return featureOn('paymentReview');
}

export function ownerDecisionsOn() {
  return featureOn('ownerDecisions');
}

/** Either flag turns the engine on: payment review implies decisions exist. */
function enabled() {
  return paymentReviewOn() || ownerDecisionsOn();
}

// ════════════════════════════════════════════════════════════
// Words (English, Roman Urdu, Urdu)
// ════════════════════════════════════════════════════════════
const langOf = (lang) => (lang === 'ur' ? 'ur' : lang === 'roman-ur' ? 'roman-ur' : 'en');

/** Rejection reasons. `not_verified` never says fake, and none of them accuse. */
export const REJECT_REASONS = [
  { n: 1, code: 'not_verified', label: 'could not verify it yet (never says fake)' },
  { n: 2, code: 'real_not_received_yet', label: 'bank shows it, ours has not received it yet' },
  { n: 3, code: 'wrong_amount_short', label: 'amount received is short' },
  { n: 4, code: 'wrong_amount_excess', label: 'amount received is more than due' },
  { n: 5, code: 'wrong_account', label: 'sent to the wrong account' },
  { n: 6, code: 'duplicate_reference', label: 'transaction id was already used' },
  { n: 7, code: 'unclear_proof', label: 'the screenshot is unreadable' },
  { n: 8, code: 'other', label: 'something else (add your own words)' },
];

export const REASON_CODES = REJECT_REASONS.map((r) => r.code);

/** The customer-facing wording for each reason, in three languages. */
export const REASON_MESSAGES = {
  not_verified: {
    en: "I couldn't verify this payment against our account yet. Could you send a sharper screenshot, or the transaction ID from your bank app, so I can check it again?",
    'roman-ur':
      'Main abhi is payment ko hamare account se verify nahi kar saka. Ek saaf screenshot ya bank app ka transaction ID bhej dein taake main dobara check kar sakoon?',
    ur: 'میں ابھی یہ ادائیگی ہمارے اکاؤنٹ سے تصدیق نہیں کر سکا۔ براہِ کرم ایک واضح اسکرین شاٹ یا بینک ایپ کی ٹرانزیکشن آئی ڈی بھیجیں تاکہ میں دوبارہ جانچ سکوں۔',
  },
  real_not_received_yet: {
    en: "Your bank shows the payment, but it hasn't reached our account yet — these can take a little while. I've noted it and we'll check again shortly. Please don't send it a second time.",
    'roman-ur':
      'Aap ke bank par payment dikh rahi hai, lekin hamare account mein abhi nahi aayi — is mein thora waqt lag sakta hai. Main ne note kar liya hai, thori dair mein dobara check karenge. Dobara bhejne ki zaroorat nahi.',
    ur: 'آپ کے بینک پر ادائیگی نظر آ رہی ہے، مگر ہمارے اکاؤنٹ میں ابھی نہیں پہنچی — اس میں تھوڑا وقت لگ سکتا ہے۔ میں نے نوٹ کر لیا ہے، تھوڑی دیر میں دوبارہ جانچ کریں گے۔ دوبارہ بھیجنے کی ضرورت نہیں۔',
  },
  wrong_amount_short: {
    en: 'The amount we can see is less than what is due. You can send the remaining amount, or tell us if that was intended and we will adjust it.',
    'roman-ur':
      'Jo amount nazar aa rahi hai wo due se kam hai. Baqi amount bhej dein, ya bata dein ke aisa hi tha to hum adjust kar lete hain.',
    ur: 'جو رقم نظر آ رہی ہے وہ واجب الادا سے کم ہے۔ باقی رقم بھیج دیں، یا بتا دیں کہ ایسا ہی تھا تو ہم ایڈجسٹ کر لیتے ہیں۔',
  },
  wrong_amount_excess: {
    en: 'We can see more than the amount due. Nothing is wrong from your side — the owner will confirm how the extra is handled (refunded or adjusted).',
    'roman-ur':
      'Due se zyada amount nazar aa rahi hai. Aap ki taraf se koi masla nahi — owner confirm karenge ke extra amount refund hogi ya adjust.',
    ur: 'واجب الادا سے زیادہ رقم نظر آ رہی ہے۔ آپ کی طرف سے کوئی مسئلہ نہیں — مالک تصدیق کریں گے کہ اضافی رقم واپس ہوگی یا ایڈجسٹ۔',
  },
  wrong_account: {
    en: 'This payment went to a different account than ours. Please check the account details in your order message and send it to that one.',
    'roman-ur':
      'Yeh payment hamare account ke bajaye kisi aur account mein gayi hai. Order ke message mein diye gaye account details check kar ke us par bhejein.',
    ur: 'یہ ادائیگی ہمارے اکاؤنٹ کے بجائے کسی اور اکاؤنٹ میں گئی ہے۔ آرڈر کے پیغام میں دیے گئے اکاؤنٹ کی تفصیل دیکھ کر اسی پر بھیجیں۔',
  },
  duplicate_reference: {
    en: 'This transaction ID has already been used for a payment. If this is a new payment, please send its own transaction ID.',
    'roman-ur':
      'Yeh transaction ID pehle kisi payment ke liye use ho chuki hai. Agar yeh nayi payment hai to iski apni transaction ID bhejein.',
    ur: 'یہ ٹرانزیکشن آئی ڈی پہلے کسی ادائیگی کے لیے استعمال ہو چکی ہے۔ اگر یہ نئی ادائیگی ہے تو اس کی اپنی ٹرانزیکشن آئی ڈی بھیجیں۔',
  },
  unclear_proof: {
    en: "The screenshot is a little unclear — I can't read the amount and transaction ID. Could you send a sharper one?",
    'roman-ur': 'Screenshot thora clear nahi hai — amount aur transaction ID parh nahi sakta. Ek saaf screenshot bhej dein?',
    ur: 'اسکرین شاٹ تھوڑا واضح نہیں ہے — رقم اور ٹرانزیکشن آئی ڈی پڑھ نہیں سکتا۔ ایک واضح اسکرین شاٹ بھیج دیں؟',
  },
  other: {
    en: 'The owner needs to check one thing on this payment and will come back to you shortly.',
    'roman-ur': 'Owner ko is payment par ek cheez check karni hai, wo thori dair mein aap ko bata denge.',
    ur: 'مالک کو اس ادائیگی پر ایک چیز جانچنی ہے، وہ تھوڑی دیر میں آپ کو بتا دیں گے۔',
  },
};

/** Everything else the customer hears. Owner overrides live in
 * `business.decisionMessages.<key>.<lang>`. */
const MESSAGES = {
  received: {
    en: "Thanks — I've got your payment proof. The owner is checking it now; nothing else is needed from you.",
    'roman-ur': 'Shukriya — aap ka payment proof mil gaya hai. Owner ab isay check kar rahe hain; aap ki taraf se kuch aur nahi chahiye.',
    ur: 'شکریہ — آپ کا پیمنٹ پروف مل گیا ہے۔ مالک اب اس کی جانچ کر رہے ہیں؛ آپ کی طرف سے کچھ اور درکار نہیں۔',
  },
  accepted: {
    en: 'Payment confirmed — thank you. Your order is marked paid.',
    'roman-ur': 'Payment confirm ho gayi — shukriya. Aap ka order paid mark ho gaya hai.',
    ur: 'ادائیگی کی تصدیق ہو گئی — شکریہ۔ آپ کا آرڈر ادا شدہ ہے۔',
  },
  partial: {
    en: 'We received part of the payment. That is recorded, and the rest is still due — you can send it whenever you are ready.',
    'roman-ur': 'Payment ka kuch hissa mil gaya hai. Wo record ho gaya, baqi abhi due hai — jab chahein bhej dein.',
    ur: 'ادائیگی کا کچھ حصہ موصول ہوا ہے۔ وہ درج ہو گیا، باقی ابھی واجب الادا ہے — جب چاہیں بھیج دیں۔',
  },
  recheck: {
    en: "I've asked the owner to check this again — I'll let you know as soon as it's confirmed.",
    'roman-ur': 'Main ne owner se kaha hai ke dobara check karein — confirm hote hi bata dunga.',
    ur: 'میں نے مالک سے کہا ہے کہ دوبارہ جانچ کریں — تصدیق ہوتے ہی بتا دوں گا۔',
  },
  pending: {
    en: "I still don't have a confirmation on your payment. The owner has been reminded and I'll message you the moment it is confirmed — nothing else is needed from you.",
    'roman-ur': 'Aap ki payment ki confirmation abhi nahi aayi. Owner ko yaad dila diya hai aur confirm hote hi message kar dunga — aap ki taraf se kuch aur nahi chahiye.',
    ur: 'آپ کی ادائیگی کی تصدیق ابھی نہیں آئی۔ مالک کو یاد دلا دیا ہے اور تصدیق ہوتے ہی پیغام دوں گا — آپ کی طرف سے کچھ اور درکار نہیں۔',
  },
  whichOrder: {
    en: 'Which order is this payment for? Send the order number and I will attach it.',
    'roman-ur': 'Yeh payment kis order ke liye hai? Order number bhej dein, main attach kar deta hoon.',
    ur: 'یہ ادائیگی کس آرڈر کے لیے ہے؟ آرڈر نمبر بھیج دیں، میں منسلک کر دیتا ہوں۔',
  },
  tooManyProofs: {
    en: "I've got several proofs from you today. Could you send the one that shows the completed payment, and I'll get that checked?",
    'roman-ur': 'Aaj aap ki taraf se kai proofs mil chuke hain. Jis mein payment complete dikh rahi hai wohi bhej dein, main check karwa deta hoon.',
    ur: 'آج آپ کی طرف سے کئی پروف موصول ہو چکے ہیں۔ جس میں ادائیگی مکمل دکھ رہی ہو وہی بھیج دیں، میں جانچ کروا دیتا ہوں۔',
  },
};

const WAITING_LINES = {
  en: [
    "Still checking your payment — I'll message you the moment it's confirmed.",
    'Your proof is with the owner; it has not been forgotten.',
    'Nothing needed from you right now — I will come back as soon as it is confirmed.',
  ],
  'roman-ur': [
    'Aap ki payment abhi check ho rahi hai — confirm hote hi message kar dunga.',
    'Aap ka proof owner ke paas hai, bhoola nahi gaya.',
    'Abhi aap ki taraf se kuch nahi chahiye — confirm hote hi bata dunga.',
  ],
  ur: [
    'آپ کی ادائیگی ابھی جانچی جا رہی ہے — تصدیق ہوتے ہی پیغام دوں گا۔',
    'آپ کا پروف مالک کے پاس ہے، بھولا نہیں گیا۔',
    'ابھی آپ کی طرف سے کچھ درکار نہیں — تصدیق ہوتے ہی بتا دوں گا۔',
  ],
};

const DUE_MESSAGES = {
  en: [
    'Just a reminder — order #{id} is waiting for payment of {amount}. If you have already paid, send the screenshot here and I will get it checked.',
    "Order #{id} is still open with {amount} due. If you would rather pay on delivery or need a little more time, just tell me.",
    "Order #{id} is still waiting for {amount}. If you have changed your mind, that is completely okay — just say so and I will close it.",
  ],
  'roman-ur': [
    'Bas yaad dehani — order #{id} payment ke intezar mein hai ({amount}). Agar payment kar di hai to screenshot yahan bhej dein, main check karwa deta hoon.',
    'Order #{id} abhi open hai, {amount} due hai. Agar delivery par dena chahte hain ya thora waqt chahiye, bata dein.',
    'Order #{id} abhi {amount} ka intezar kar raha hai. Agar irada badal gaya hai to koi baat nahi — bata dein, main band kar deta hoon.',
  ],
  ur: [
    'صرف یاد دہانی — آرڈر #{id} میں {amount} کی ادائیگی باقی ہے۔ اگر ادا کر دی ہے تو اسکرین شاٹ یہاں بھیج دیں، میں جانچ کروا دیتا ہوں۔',
    'آرڈر #{id} ابھی کھلا ہے، {amount} واجب الادا ہے۔ اگر ڈیلیوری پر دینا چاہتے ہیں یا تھوڑا وقت چاہیے تو بتا دیں۔',
    'آرڈر #{id} ابھی {amount} کا انتظار کر رہا ہے۔ اگر ارادہ بدل گیا ہے تو کوئی بات نہیں — بتا دیں، میں بند کر دیتا ہوں۔',
  ],
};

/** Owner overrides for the lines above, from business.decisionMessages. */
function message(key, lang, fallbackVars = {}) {
  const l = langOf(lang);
  const override = profile()?.business?.decisionMessages?.[key];
  const text = (override && (override[l] || override.en)) || MESSAGES[key]?.[l] || MESSAGES[key]?.en || '';
  return text.replace(/\{(\w+)\}/g, (m, k) => (fallbackVars[k] === undefined ? m : fallbackVars[k]));
}

/** Reject wording: built-in, overridable per reason and language. */
export function rejectionText(code, lang, vars = {}) {
  const l = langOf(lang);
  const override = profile()?.business?.decisionMessages?.rejected?.[code];
  const custom = profile()?.business?.payment?.rejectReasons?.[code];
  const base =
    (override && (override[l] || override.en)) ||
    (custom && typeof custom === 'object' ? custom[l] || custom.en : typeof custom === 'string' ? custom : null) ||
    REASON_MESSAGES[code]?.[l] ||
    REASON_MESSAGES[code]?.en ||
    REASON_MESSAGES.other[l];
  const nextStep = {
    en: 'If anything is unclear, just reply here.',
    'roman-ur': 'Kuch samajh na aaye to yahin reply kar dein.',
    ur: 'کچھ سمجھ نہ آئے تو یہیں جواب دے دیں۔',
  }[l];
  return `${base.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : vars[k]))}\n${nextStep}`;
}

function expectedResponseSuffix(lang) {
  const minutes = decisionSettings().expectedResponseMinutes;
  if (!minutes) return '';
  return {
    en: ` Usually this takes about ${minutes} minutes.`,
    'roman-ur': ` Aam tor par is mein ${minutes} minute lagte hain.`,
    ur: ` عام طور پر اس میں ${minutes} منٹ لگتے ہیں۔`,
  }[langOf(lang)];
}

/** The contact's language, as the rest of the bot already recorded it. */
function languageFor(number) {
  const c = getContact(digits(number));
  return langOf(c?.language);
}

/**
 * Which language to answer in. The caller's detection wins when it is confident
 * (Urdu or Roman Urdu); otherwise the language we already stored for this person
 * is used, then the script of the proof itself. This is why a Urdu screenshot
 * from an Urdu-speaking customer never gets an English acknowledgement.
 */
function answerLanguage(number, lang = null, sample = '') {
  if (lang === 'ur' || lang === 'roman-ur') return lang;
  const stored = getContact(digits(number))?.language;
  if (stored === 'ur' || stored === 'roman-ur') return stored;
  if (/[\u0600-\u06FF]/.test(String(sample || ''))) return 'ur';
  return 'en';
}

function pick(list, seed) {
  if (!Array.isArray(list) || !list.length) return '';
  const n = Math.abs(Number(seed) || 0) % list.length;
  return list[n];
}

// ════════════════════════════════════════════════════════════
// Sending
// ════════════════════════════════════════════════════════════
async function sendText(transport, number, text) {
  if (!transport || typeof transport.sendMessage !== 'function' || !number || !text) return { sent: false };
  try {
    await transport.sendMessage(`${digits(number)}@s.whatsapp.net`, { text });
    return { sent: true };
  } catch (err) {
    logEvent('payment_review_send_failed', digits(number), { error: String(err.message).slice(0, 120) });
    return { sent: false };
  }
}

/** Customer-facing lines go through the growth gates: opt-out, quiet hours,
 * caps, approval mode. A proof acknowledgement is transactional — it answers
 * something the customer just did — so the once-a-day marketing cap does not
 * apply, but opt-out and quiet hours still do. */
async function sendCustomer({ transport, number, text, now = new Date(), agent = 'payment_review', transactional = true }) {
  return sendProactively({ transport, number: digits(number), text, agent, reason: 'payment_review', now, transactional });
}

// ════════════════════════════════════════════════════════════
// Proof intake
// ════════════════════════════════════════════════════════════
/** Open orders for a customer that are waiting for money. */
export function awaitingOrdersFor(number) {
  const chat = `${digits(number)}@s.whatsapp.net`;
  return all(
    "SELECT * FROM orders WHERE chat = ? AND status = 'awaiting_payment' ORDER BY id DESC LIMIT 5",
    [chat]
  ).map((o) => ({ ...o, items: safeJson(o.items, []) }));
}

function safeJson(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function orderNumber(order) {
  return Number(order?.id) || null;
}

function dueOf(order) {
  if (!order) return 0;
  return Math.max(0, (Number(order.total) || 0) - (Number(order.paid_amount) || 0));
}

/**
 * The customer sent something that might be a payment proof.
 * @returns {Promise<{handled:boolean, reason?:string, decision?:object}>}
 */
export async function handlePaymentProof({
  number,
  text = '',
  kind = 'image',
  buffer = null,
  mimetype = 'image/jpeg',
  transport = null,
  now = new Date(),
  lang = null,
  reader = null,
  download = null,
} = {}) {
  if (!paymentReviewOn()) return { handled: false, reason: 'off' };
  const contact = digits(number);
  if (!contact) return { handled: false, reason: 'no_number' };

  // The picture itself is fetched once, here, so the file we keep is the file
  // the customer sent. A failed download does not lose the proof: the reading
  // still goes ahead from the caption or the vision description.
  if (!buffer && typeof download === 'function') {
    try {
      const media = await download();
      if (media?.buffer?.length) {
        buffer = media.buffer;
        mimetype = media.mimetype || mimetype;
      }
    } catch (err) {
      logEvent('payment_proof_download_failed', contact, { error: String(err.message).slice(0, 120) });
    }
  }

  const orders = awaitingOrdersFor(contact);
  const existing = awaitingDecisionFor(contact, { type: 'payment' });

  // Already waiting on a decision: a second proof is linked to the same request
  // rather than opening a second one, and the customer is not told twice.
  if (existing && existing.order_id) {
    const saved = buffer ? saveProofFile({ buffer, mimetype, now }) : null;
    const fields = extractFields(text);
    const proof = recordProof({
      id: `P-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      requestId: existing.id,
      contact,
      orderId: existing.order_id,
      kind,
      saved,
      extracted: { ...fields, sha256: saved?.sha256 || null },
      checks: [],
      risk: existing.payload?.risk || 'needs_attention',
      now,
      retentionDays: decisionSettings().retentionDays,
    });
    logEvent('payment_proof_repeat', contact, { request: existing.id, proof: proof.id });
    if (!existing.customer_notified) await notifyCustomerReceived({ transport, number: contact, decision: existing, now, lang });
    return { handled: true, reason: 'already_pending', decision: existing, proof };
  }

  if (!orders.length) {
    // No order waiting for money: this is not a proof we can match. One short
    // question, asked once a day — then the normal pipeline answers normally.
    const recent = recentProofs({ limit: 20 }).filter((p) => p.contact === contact);
    const askedBefore = all(
      "SELECT id FROM events WHERE type = 'payment_proof_no_order' AND number = ? AND created_at >= ? LIMIT 1",
      [contact, iso(new Date(new Date(now).getTime() - 24 * 3600_000))]
    ).length;
    if (!askedBefore && !recent.length && !openDecisionsFor(contact).length && looksLikePaymentProof(text)) {
      await sendCustomer({ transport, number: contact, text: message('whichOrder', lang || languageFor(contact)), now });
      logEvent('payment_proof_no_order', contact, { kind });
      return { handled: true, reason: 'no_order' };
    }
    return { handled: false, reason: 'not_a_proof' };
  }

  // Several orders waiting: ask which one, once, and do not guess.
  if (orders.length > 1) {
    const list = orders.map((o) => `#${o.id} (${formatMoney(dueOf(o), o.currency)})`).join(', ');
    await sendCustomer({
      transport,
      number: contact,
      text:
        (lang || languageFor(contact)) === 'ur'
          ? `یہ ادائیگی کس آرڈر کے لیے ہے؟ ${list}`
          : (lang || languageFor(contact)) === 'roman-ur'
            ? `Yeh payment kis order ke liye hai? ${list}`
            : `Which order is this payment for? ${list}`,
      now,
    });
    logEvent('payment_proof_ambiguous', contact, { orders: orders.length });
    return { handled: true, reason: 'ambiguous_order' };
  }

  const order = orders[0];
  const settings = decisionSettings();
  const saved = buffer ? saveProofFile({ buffer, mimetype, now }) : null;
  const fields = extractFields(text);
  const withHash = { ...fields, sha256: saved?.sha256 || null };
  const checks = runChecks({ extracted: withHash, order, proofs: recentProofs({ now }), now, settings });
  const { risk, reasons } = riskFromChecks(checks);

  const opened = openDecision({
    type: 'payment',
    contact,
    orderId: order.id,
    payload: {
      orderId: order.id,
      due: dueOf(order),
      currency: order.currency,
      claimed: fields.amount,
      reference: fields.reference,
      provider: fields.provider,
      risk,
      checks,
      reasons,
      orderStatus: order.status,
    },
    now,
  });
  if (!opened.ok) return { handled: false, reason: opened.error };

  const decision = opened.decision;
  const proof = recordProof({
    id: `P-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    requestId: decision.id,
    contact,
    orderId: order.id,
    kind,
    saved,
    extracted: withHash,
    checks,
    risk,
    now,
    retentionDays: settings.retentionDays,
  });

  // The order timeline gets a fixed phrase, never the customer's words.
  logOrderEvent({
    orderId: order.id,
    from: order.status,
    to: order.status,
    actor: 'customer',
    detail: `proof ${proof.id} (${risk})`,
  });
  logEvent('payment_proof_received', contact, { decision: decision.id, order: order.id, risk, checks: checks.length });

  await notifyCustomerReceived({ transport, number: contact, decision: getDecision(decision.id), now, lang });
  await notifyOwners({ transport, decision: getDecision(decision.id), now, proof });
  return { handled: true, decision: getDecision(decision.id), proof };
}

/** The once-only "I have it, the owner is checking" line. */
async function notifyCustomerReceived({ transport, number, decision, now, lang }) {
  if (!decision) return { sent: false };
  if (decision.customer_notified) return { sent: false, reason: 'already' };
  const l = answerLanguage(number, lang, decision.payload?.text || '');
  const text = message('received', l) + expectedResponseSuffix(l);
  const out = await sendCustomer({ transport, number, text, now });
  if (out.sent) {
    run('UPDATE decision_requests SET customer_notified = 1 WHERE id = ?', [decision.id]);
    logEvent('decision_customer_notified', number, { id: decision.id });
  }
  return out;
}

// ════════════════════════════════════════════════════════════
// Owner card
// ════════════════════════════════════════════════════════════
const TICK = { pass: '✅', fail: '❌', unknown: '❔' };

/** Short, masked, and with the actions at the bottom. */
export function ownerCard(decision, { proof = null, retry = false } = {}) {
  if (!decision) return '';
  const payload = decision.payload || {};
  const order = decision.order_id ? getOrder(decision.order_id) : null;
  const currency = order?.currency || payload.currency || 'PKR';
  const due = order ? dueOf(order) : payload.due || 0;
  const f = proof?.extracted || {};
  const claimed = f.amount ?? payload.claimed ?? null;
  const lines = [];
  lines.push(`${retry ? '🔔 Reminder — ' : ''}💳 Payment to review — ${decision.id}`);
  lines.push(`Customer: +${decision.contact}`);
  if (order) lines.push(`Order #${order.id} · due ${formatMoney(due, currency)}`);
  else if (payload.customQuote) lines.push(`Quote: ${payload.customQuote}`);
  if (claimed !== null && claimed !== undefined) lines.push(`Claimed: ${formatMoney(claimed, currency)}`);
  const bitsOne = [];
  if (f.reference) bitsOne.push(`TID ${f.reference}`);
  if (f.provider) bitsOne.push(f.provider);
  if (f.status) bitsOne.push(f.status);
  if (f.occurredAt) bitsOne.push(f.occurredAt.slice(0, 16).replace('T', ' '));
  if (bitsOne.length) lines.push(bitsOne.join(' · '));
  if (f.receiver || f.accountTail) lines.push(`Receiver: ${f.receiver || ''}${f.accountTail ? ` (${'••••'}${String(f.accountTail).slice(-4)})` : ''}`.trim());
  if (Array.isArray(payload.checks) && payload.checks.length) {
    const checkLine = payload.checks
      .slice(0, 9)
      .map((c) => `${TICK[c.status] || '❔'} ${shortCheck(c.id)}`)
      .join(' · ');
    lines.push(`Checks: ${checkLine}`);
  }
  lines.push(`Risk: ${riskLine(payload.risk || 'needs_attention')}`);
  if (payload.checks) {
    const failed = payload.checks.filter((c) => c.status === 'fail');
    for (const c of failed.slice(0, 3)) lines.push(`• ${c.detail}`);
  }
  lines.push('');
  lines.push(`.accept ${decision.id} · .reject ${decision.id} 1 · .partial ${decision.id} ${Math.round(due / 2)} · .more ${decision.id}`);
  lines.push('(The AI will never accept this for you. Reasons: .reject ' + decision.id + ')');
  return lines.join('\n');
}

function shortCheck(id) {
  return {
    amount: 'amount',
    currency: 'currency',
    receiver: 'receiver',
    date: 'date',
    reference: 'ref',
    image: 'image',
    order: 'order',
    rate: 'rate',
    metadata: 'meta',
  }[id] || id;
}

/** The card as a payload: numbered text everywhere, real buttons on Cloud API. */
export function cardPayload(decision, { proof = null, transport = null } = {}) {
  const text = ownerCard(decision, { proof });
  const buttons = [
    { id: `accept:${decision.id}`, title: 'Accept' },
    { id: `reject:${decision.id}`, title: 'Reject' },
    { id: `more:${decision.id}`, title: 'More' },
  ];
  const cloud = transport?.kind === 'cloud' && typeof transport.sendButtons === 'function';
  return cloud ? { text, buttons } : { text, buttons: null };
}

/** Send the card to the owner and to everyone on the chain who should see it. */
export async function notifyOwners({ transport, decision, now = new Date(), proof = null, retry = false } = {}) {
  if (!decision) return { sent: 0 };
  const numbers = chainRecipients(decision.type).filter((n) => withinWorkingHours(memberFor(n)?.hours, now));
  const text = ownerCard(decision, { proof, retry });
  let sent = 0;
  for (const number of numbers) {
    if (digits(number) === digits(config.owner?.number)) {
      const out = await sendToOwner({ transport, text, agent: 'payment_review', reason: `decision ${decision.id}`, now });
      if (out.sent) sent += 1;
    } else {
      const out = await sendProactively({ transport, number: digits(number), text, agent: 'payment_review', reason: `decision ${decision.id}`, now, transactional: true });
      if (out.sent) sent += 1;
    }
  }
  if (sent) {
    recordEventRow(decision.id, { actor: 'system', kind: retry ? 'reminded' : 'notified', fromStatus: decision.status, toStatus: decision.status, now });
  }
  return { sent };
}

function recordEventRow(requestId, { actor, kind, fromStatus = null, toStatus = null, reasonCode = null, reasonText = null, detail = null, now }) {
  run(
    `INSERT INTO decision_events (request_id, actor, kind, from_status, to_status, reason_code, reason_text, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [normalizeDecisionId(requestId), String(actor || ''), kind, fromStatus, toStatus, reasonCode, reasonText, detail ? JSON.stringify(detail) : null, iso(now)]
  );
}

// ════════════════════════════════════════════════════════════
// Customer side: waiting, decisions, dues
// ════════════════════════════════════════════════════════════

/** The open decision for a customer, or null. Used by the handler to keep a
 * pending payment conversation from ever being silently ignored. */
export function pendingDecisionFor(number) {
  return awaitingDecisionFor(number);
}

/** Is the customer asking about the payment they already sent? */
export function asksAboutPayment(text) {
  return /paid|payment|confirm|transfer|receipt|screenshot|check|paisa|pemint|payment\s*ho|ادائیگی|تصدیق|رقم|رسید/i.test(String(text || ''));
}

/**
 * A short waiting line, at most one per 30 minutes. Returns the text to send,
 * or null when the cap says "not again yet" — the caller then answers normally.
 */
export function waitingLine({ number, lang = null, now = new Date() } = {}) {
  const decision = awaitingDecisionFor(number);
  if (!decision) return null;
  const events = decisionEvents(decision.id).filter((e) => e.kind === 'customer_waiting');
  const last = events[events.length - 1];
  if (last && new Date(now).getTime() - new Date(last.created_at).getTime() < 30 * 60_000) return null;
  const lines = WAITING_LINES[answerLanguage(number, lang)] || WAITING_LINES.en;
  const text = pick(lines, events.length);
  recordEventRow(decision.id, { actor: 'system', kind: 'customer_waiting', fromStatus: decision.status, toStatus: decision.status, now });
  return text;
}

/** Tell the customer the outcome. Never accuses, always gives a next step. */
export async function notifyCustomerDecision({ transport, decision, action, lang = null, now = new Date(), extra = {} }) {
  const l = answerLanguage(decision.contact, lang, decision.payload?.text || '');
  let text = '';
  if (action === 'accepted') {
    text = message('accepted', l);
    const order = decision.order_id ? getOrder(decision.order_id) : null;
    if (order) text += ` (${'#'}${order.id})`;
  } else if (action === 'partial') {
    text = message('partial', l);
    if (extra.paid !== undefined && extra.due !== undefined) {
      text +=
        l === 'ur'
          ? ` موصول: ${formatMoney(extra.paid, extra.currency)} · باقی: ${formatMoney(extra.due, extra.currency)}`
          : l === 'roman-ur'
            ? ` Mila: ${formatMoney(extra.paid, extra.currency)} · Baqi: ${formatMoney(extra.due, extra.currency)}`
            : ` Received: ${formatMoney(extra.paid, extra.currency)} · Remaining: ${formatMoney(extra.due, extra.currency)}`;
    }
  } else if (action === 'rejected') {
    text = rejectionText(decision.reason_code || 'other', l, extra.vars || {});
  } else if (action === 'recheck') {
    text = message('recheck', l);
  } else if (action === 'expired') {
    text = message('pending', l);
  } else if (action === 'pending_after_reminders') {
    text = message('pending', l);
  }
  if (!text) return { sent: false, reason: 'no_text' };
  return sendCustomer({ transport, number: decision.contact, text, now });
}

// ════════════════════════════════════════════════════════════
// Commands (owner + payments role)
// ════════════════════════════════════════════════════════════
// `.decisions` belongs to Conversation Control, so the owner-decision list is
// `.requests`; the old command grows a payments section when this flag is on.
const COMMANDS = ['accept', 'reject', 'partial', 'recheck', 'more', 'decision', 'requests', 'reverse', 'timeline', 'payments', 'chain'];

/** Is this text one of ours? Cheap check before the owner command router. */
export function isDecisionCommand(text) {
  const first = String(text || '').trim().split(/\s+/)[0] || '';
  if (!first.startsWith('.')) return false;
  const name = first.slice(1).toLowerCase().split('@')[0];
  return COMMANDS.includes(name) || (name === 'team' && /^\.team\s+(add|set|remove)\b/i.test(text));
}

/**
 * Handle `.accept`, `.reject`, `.partial`, `.recheck`, `.more`, `.decision`,
 * `.decisions`, `.reverse`, `.timeline`, `.payments`, `.chain` and
 * `.team add|set|remove`. Returns `{handled:false}` when it is not ours.
 */
export async function handleDecisionCommand({ text, from, now = new Date(), transport = null } = {}) {
  if (!isDecisionCommand(text)) return { handled: false };
  if (!enabled()) return { handled: false };
  const parts = String(text).trim().split(/\s+/);
  const name = parts[0].slice(1).toLowerCase().split('@')[0];
  const actor = digits(from);
  const args = parts.slice(1);
  const reply = (body) => ({ handled: true, reply: body });

  if (name === 'team') return handleTeamCommand({ args, actor, now, transport });
  if (name === 'chain') return handleChainCommand({ args, now });

  if (name === 'payments') {
    const s = paymentsSummary({ now });
    return reply(paymentsStrip(s));
  }

  if (name === 'requests') return reply(openDecisionLines());

  if (name === 'timeline') {
    const target = args[0];
    if (!target) return reply('Usage: .timeline 12  (or .timeline 92300…)');
    return reply(timelineText(target));
  }

  const id = normalizeDecisionId(args[0]);
  if (!id || !/^DR-\d+$/.test(id)) {
    return reply(`Usage: .${name} DR-3${name === 'reject' ? ' 1' : ''}${name === 'partial' ? ' 4000' : ''}`);
  }
  const decision = getDecision(id);
  if (!decision) return reply(`No decision ${id}. .decisions to see the open ones.`);

  if (name === 'decision') {
    return reply(decisionDetail(decision));
  }

  if (name === 'more') {
    const proof = proofsForRequest(decision.id)[0] || null;
    return reply(ownerCard(decision, { proof }));
  }

  if (name === 'reverse') {
    const reason = args.slice(1).join(' ').trim();
    const out = reverseDecision({ id, actor, reason, now });
    if (!out.ok) return reply(out.reply || out.error);
    return reply(`${out.reply}\nThe customer has not been told — send them a line yourself if needed.`);
  }

  if (name === 'recheck') {
    const minutes = Math.max(1, Math.round(Number(args[1]) || 30));
    const out = decide({ id, actor, action: 'recheck', now });
    if (!out.ok) return reply(out.reply || out.error);
    recordEventRow(decision.id, { actor, kind: 'note', fromStatus: decision.status, toStatus: 'recheck', detail: { recheckInMinutes: minutes }, now });
    const customer = await notifyCustomerDecision({ transport, decision: out.decision, action: 'recheck', now });
    return reply(`${decision.id}: recheck in ${minutes} min. Owner reminder scheduled.${customer.sent ? ' Customer told.' : ' Customer not told (quiet hours or opt-out).'}`);
  }

  if (name === 'reject') {
    const which = args[1];
    if (!which) {
      const list = REJECT_REASONS.map((r) => `${r.n}. ${r.code} — ${r.label}`).join('\n');
      return reply(`Why are you rejecting ${decision.id}?\n${list}\n\n.reject ${decision.id} 1  (or any custom sentence after the number)`);
    }
    const byNumber = REJECT_REASONS.find((r) => String(r.n) === String(which));
    const byCode = REJECT_REASONS.find((r) => r.code === String(which).toLowerCase());
    const reason = byNumber || byCode;
    if (!reason) return reply(`Unknown reason "${which}". Use 1–8 or a code, e.g. .reject ${decision.id} 2`);
    const customText = args.slice(2).join(' ').trim() || null;
    const out = decide({
      id,
      actor,
      action: 'rejected',
      reasonCode: reason.code,
      reasonText: customText,
      now,
    });
    if (!out.ok) return reply(out.reply || out.error);
    const customer = await notifyCustomerDecision({
      transport,
      decision: out.decision,
      action: 'rejected',
      now,
    });
    const others = await tellOthers({ transport, decision: out.decision, actor, action: 'rejected', now });
    logEvent('decision_rejected_told', decision.contact, { id, reason: reason.code, customer: customer.sent, others });
    return reply(
      `${decision.id}: rejected (${reason.code}).${customer.sent ? ' Customer told politely.' : ' Customer not told (quiet hours, opt-out or cap).'}${others ? ` ${others} teammate(s) told.` : ''}\nThe order is unchanged.`
    );
  }

  if (name === 'partial') {
    const amount = Number(String(args[1] || '').replace(/[^\d.]/g, ''));
    if (!(amount > 0)) return reply(`How much was actually received? .partial ${decision.id} 4000`);
    const out = decide({ id, actor, action: 'partial', amount, now });
    if (!out.ok) return reply(out.reply || out.error);
    const order = decision.order_id ? getOrder(decision.order_id) : null;
    const paid = order ? Number(order.paid_amount) || 0 : amount;
    const due = order ? dueOf(order) : 0;
    const customer = await notifyCustomerDecision({
      transport,
      decision: out.decision,
      action: 'partial',
      now,
      extra: { paid, due, currency: order?.currency || 'PKR' },
    });
    const others = await tellOthers({ transport, decision: out.decision, actor, action: 'partial', now });
    return reply(
      `${decision.id}: partial — ${formatMoney(paid, order?.currency || 'PKR')} recorded${order ? `, ${formatMoney(due, order?.currency || 'PKR')} still due` : ''}.${customer.sent ? ' Customer told.' : ' Customer not told.'}${others ? ` ${others} teammate(s) told.` : ''}`
    );
  }

  // accept
  const out = decide({ id, actor, action: 'accepted', now });
  if (!out.ok) return reply(out.reply || out.error);
  const customer = await notifyCustomerDecision({ transport, decision: out.decision, action: 'accepted', now });
  const others = await tellOthers({ transport, decision: out.decision, actor, action: 'accepted', now });
  const orderLine = out.order?.reply ? `\n${out.order.reply}` : '';
  return reply(
    `${decision.id}: accepted by +${actor}.${customer.sent ? ' Customer told.' : ' Customer not told (quiet hours, opt-out or cap).'}${others ? ` ${others} teammate(s) told it is handled.` : ''}${orderLine}`
  );
}

/** "Handled by X" to the rest of the chain, once. */
async function tellOthers({ transport, decision, actor, action, now }) {
  if (!ownerDecisionsOn() || !transport) return 0;
  let sent = 0;
  for (const number of chainRecipients(decision.type)) {
    if (digits(number) === digits(actor)) continue;
    const text = `${decision.id} (${decision.type}, +${decision.contact}) was ${action} by +${actor} at ${new Date(now).toISOString().slice(11, 16)}. Nothing to do.`;
    if (digits(number) === digits(config.owner?.number)) {
      const r = await sendToOwner({ transport, text, agent: 'payment_review', reason: `decision ${decision.id} handled`, now });
      if (r.sent) sent += 1;
    } else {
      const r = await sendProactively({ transport, number: digits(number), text, agent: 'payment_review', reason: `decision ${decision.id} handled`, now, transactional: true });
      if (r.sent) sent += 1;
    }
  }
  return sent;
}

/** The open requests, one line each. Used by `.requests` and by `.decisions`. */
export function openDecisionLines() {
  const list = listDecisions({ limit: 50 }).filter((d) => d.open);
  if (!list.length) return 'No pending decisions.';
  const lines = [`*Pending decisions (${list.length})*`];
  for (const d of list) {
    const when = new Date(d.created_at).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`• ${d.id} · ${d.type} · +${d.contact}${d.order_id ? ` · order #${d.order_id}` : ''} · ${d.status} · ${when} · waiting on +${d.assignee}`);
  }
  lines.push('', 'Open one: .decision DR-3');
  return lines.join('\n');
}

/** A decision in full: history included, because that is the point. */
export function decisionDetail(decision) {
  if (!decision) return 'No such decision.';
  const events = decisionEvents(decision.id);
  const lines = [
    `*${decision.id} · ${decision.type}*`,
    `Customer: +${decision.contact}${decision.order_id ? ` · order #${decision.order_id}` : ''}`,
    `Status: ${decision.status}${decision.reason_code ? ` (${decision.reason_code})` : ''}`,
    `Opened: ${decision.created_at.slice(0, 16).replace('T', ' ')} · waiting on +${decision.assignee}`,
  ];
  if (decision.resolved_by) lines.push(`Resolved by: +${decision.resolved_by} at ${String(decision.resolved_at || '').slice(0, 16).replace('T', ' ')}`);
  if (decision.reason_text) lines.push(`Owner's words: ${decision.reason_text}`);
  const checks = decision.payload?.checks || [];
  if (checks.length) {
    lines.push('', '*Checks*');
    for (const c of checks) lines.push(`${TICK[c.status] || '❔'} ${c.label} — ${c.detail}`);
  }
  if (decision.payload?.risk) lines.push('', `Risk: ${riskLine(decision.payload.risk)}`);
  lines.push('', '*History*');
  for (const e of events) {
    const when = String(e.created_at).slice(0, 16).replace('T', ' ');
    lines.push(`• ${when} · ${e.kind}${e.from_status ? ` ${e.from_status}→${e.to_status}` : ''} · +${e.actor}${e.reason_code ? ` · ${e.reason_code}` : ''}${e.reason_text ? ` · ${e.reason_text}` : ''}`);
  }
  lines.push('', `Actions: .accept ${decision.id} · .reject ${decision.id} 1 · .partial ${decision.id} 4000 · .reverse ${decision.id} <why>`);
  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════
// Team + chain commands
// ════════════════════════════════════════════════════════════
function membersFromSettings() {
  return decisionSettings().members.map((m) => ({ ...m }));
}

function saveMembers(list) {
  setPath('business.decisions.team.members', list);
}

/** `.team add Ayesha 923001112233 payments,chat 09:00-21:00` */
export async function handleTeamCommand({ args = [], actor, now = new Date(), transport = null } = {}) {
  const reply = (body) => ({ handled: true, reply: body });
  const sub = String(args[0] || '').toLowerCase();
  const members = membersFromSettings();
  const roster = teamRoster();
  void transport;

  if (!['add', 'set', 'remove'].includes(sub)) {
    const lines = ['*Decision team*', `• ${config.owner?.name || 'Owner'} — owner (always first) · +${config.owner?.number}`];
    for (const m of members) lines.push(`• ${m.name} — ${m.roles.join(', ')}${m.hours ? ` · ${m.hours}` : ''} · +${m.number}`);
    if (!members.length) lines.push('', 'No teammates yet. .team add Ayesha 923001112233 payments,chat');
    lines.push('', `Limit: ${members.length}/${teamLimit()}. Roles: view, chat, payments, discounts, admin.`);
    lines.push('Chains: .chain payment');
    return reply(lines.join('\n'));
  }

  if (sub === 'remove') {
    const number = normalizeMemberNumber(args[1]);
    if (!number) return reply('Usage: .team remove 923001112233');
    if (!members.some((m) => m.number === number)) return reply(`+${number} is not on the decision team.`);
    saveMembers(members.filter((m) => m.number !== number));
    // A chain step that points at a removed member is dropped, not left dangling.
    for (const type of DECISION_TYPES) {
      const chain = chainFor(type);
      if (chain.some((s) => s.who === number)) {
        setPath(`business.decisions.chains.${type}`, chain.filter((s) => s.who !== number));
      }
    }
    logEvent('decision_team_removed', number, { by: actor });
    return reply(`Removed +${number} from the decision team.`);
  }

  // add | set Ayesha 923001112233 payments,chat 09:00-21:00
  const name = String(args[1] || '').trim();
  const number = normalizeMemberNumber(args[2]);
  const roles = String(args[3] || '')
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((r) => r.toLowerCase());
  const hours = args[4] || null;
  if (!name || !number) return reply(`Usage: .team ${sub} Ayesha 923001112233 payments,chat 09:00-21:00`);
  if (sub === 'add' && members.length >= teamLimit()) {
    return reply(`The decision team is full (${teamLimit()}). Remove someone first, or raise the plan limit.`);
  }
  const candidate = { name, number, roles: roles.length ? roles : ['view'], hours };
  const check = validateDecisions({ team: { members: [...members.filter((m) => m.number !== number), candidate] } });
  if (check.errors.length) return reply(`Not saved: ${check.errors[0]}`);
  const next = members.filter((m) => m.number !== number).concat(candidate);
  saveMembers(next);
  logEvent('decision_team_saved', number, { by: actor, roles: candidate.roles });
  return reply(`${sub === 'add' ? 'Added' : 'Updated'} ${name} (+${number}) — ${candidate.roles.join(', ')}${hours ? ` · ${hours}` : ''}.\nRoster: ${teamRoster().length - 1}/${teamLimit()}`);
}

/** `.chain payment` shows; `.chain payment owner:0,92300…:15` sets. */
export async function handleChainCommand({ args = [], now = new Date() } = {}) {
  void now;
  const reply = (body) => ({ handled: true, reply: body });
  const type = String(args[0] || '').toLowerCase();
  if (!type) return reply(`Which chain? ${DECISION_TYPES.join(', ')}\n.chain payment  or  .chain payment owner:0,923001112233:15`);
  if (!DECISION_TYPES.includes(type)) return reply(`Unknown type "${type}". One of: ${DECISION_TYPES.join(', ')}`);

  if (args.length === 1) {
    const chain = chainFor(type);
    const lines = [`*Chain for ${type}*`];
    for (const [i, step] of chain.entries()) {
      const who = step.who === 'owner' ? `owner (+${config.owner?.number})` : `+${step.who}${memberFor(step.who)?.name ? ` (${memberFor(step.who).name})` : ''}`;
      lines.push(`${i + 1}. ${who} after ${step.afterMinutes} min`);
    }
    const s = decisionSettings();
    lines.push('', `Owner reminders: ${s.reminderMinutes.join(', ')} min · max ${s.maxRemindersPerDay}/day.`);
    lines.push(`Set: .chain ${type} owner:0,923001112233:15`);
    return reply(lines.join('\n'));
  }

  const spec = args.slice(1).join(' ');
  const steps = [];
  for (const piece of spec.split(/[,\s]+/).filter(Boolean)) {
    const [whoRaw, minutesRaw] = piece.split(':');
    const who = whoRaw.toLowerCase() === 'owner' ? 'owner' : normalizeMemberNumber(whoRaw);
    if (!who) return reply(`"${whoRaw}" is not a number or "owner".`);
    if (who !== 'owner' && !memberFor(who)) return reply(`+${who} is not on the decision team. .team add first.`);
    const afterMinutes = Math.max(0, Math.round(Number(minutesRaw) || 0));
    steps.push({ who, afterMinutes });
  }
  const check = validateDecisions({ chains: { [type]: steps } });
  if (check.errors.length) return reply(`Not saved: ${check.errors[0]}`);
  setPath(`business.decisions.chains.${type}`, steps);
  logEvent('decision_chain_saved', null, { type, steps: steps.length });
  return reply(`Chain for ${type}: ${steps.map((s) => `${s.who === 'owner' ? 'owner' : `+${s.who}`}@${s.afterMinutes}m`).join(' → ')}`);
}

// ════════════════════════════════════════════════════════════
// Timeline
// ════════════════════════════════════════════════════════════
/** `.timeline 12` (order) or `.timeline 92300…` (customer). */
export function timelineEntries(target) {
  const raw = String(target || '').replace(/[#\s]/g, '');
  const entries = [];
  let order = null;
  if (/^\d{1,9}$/.test(raw) && !/^92\d{8,}$/.test(raw)) order = getOrder(Number(raw));
  if (!order && /^\d{10,15}$/.test(raw)) order = orderFor(`${raw}@s.whatsapp.net`);
  if (!order) return { entries, order: null };

  entries.push({ at: order.created_at, text: `Order #${order.id} placed — ${formatMoney(order.total, order.currency)}` });
  for (const e of orderEvents(order.id)) {
    const to = e.to_status || e.to || '';
    const from = e.from_status || e.from || '';
    const label =
      to === 'paid'
        ? `Marked paid by ${e.actor}`
        : to === 'awaiting_payment'
          ? 'Payment instructions sent'
          : e.detail
            ? `${stampKind(e.detail)}${e.detail}`
            : `${e.actor || 'system'}: ${from} → ${to}`;
    entries.push({ at: e.created_at, text: label });
  }
  const decisions = all('SELECT * FROM decision_requests WHERE order_id = ? ORDER BY created_at', [order.id]).map((d) => ({
    ...d,
    payload: safeJson(d.payload, {}),
  }));
  for (const d of decisions) {
    entries.push({ at: d.created_at, text: `Proof received — ${d.id} (risk: ${riskLine(d.payload.risk || 'needs_attention')})` });
    for (const e of decisionEvents(d.id)) {
      if (e.kind === 'notified') entries.push({ at: e.created_at, text: `Owner notified — ${d.id}` });
      else if (e.kind === 'reminded') entries.push({ at: e.created_at, text: `Owner reminded — ${d.id}` });
      else if (e.kind === 'decided') entries.push({ at: e.created_at, text: `Decision: ${e.to_status}${e.reason_code ? ` (${e.reason_code})` : ''} by +${e.actor}` });
      else if (e.kind === 'reversed') entries.push({ at: e.created_at, text: `Reversed by +${e.actor} — ${e.reason_text || 'no reason'}` });
      else if (e.kind === 'customer_waiting') entries.push({ at: e.created_at, text: 'Customer told it is still being checked' });
    }
    if (d.customer_notified) entries.push({ at: d.created_at, text: 'Customer told the proof was received' });
  }
  entries.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { entries, order };
}

function stampKind(detail) {
  if (/^proof /.test(detail)) return 'Proof linked: ';
  if (/^reminder:/.test(detail)) return 'Reminder: ';
  if (/^due:/.test(detail)) return 'Payment reminder: day ';
  return '';
}

export function timelineText(target) {
  const { entries, order } = timelineEntries(target);
  if (!order) return `No order found for "${target}".`;
  if (!entries.length) return `Order #${order.id} has no events yet.`;
  const lines = [`*Timeline — order #${order.id}*`, `Customer: +${String(order.chat || '').split('@')[0]}`];
  for (const e of entries) {
    const when = String(e.at || '').slice(0, 16).replace('T', ' ');
    lines.push(`• ${when} — ${e.text}`);
  }
  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════
// Follow-ups: owner reminders, escalation, customer dues, retention
// ════════════════════════════════════════════════════════════
function eventsFor(requestId, kind) {
  return decisionEvents(requestId).filter((e) => e.kind === kind);
}

/** One reminder pass. Returns what it did, so the doctor and tests can see it. */
export async function runDecisionReminders({ transport = null, now = new Date() } = {}) {
  if (!enabled()) return { reminded: 0, escalated: 0, expired: 0 };
  const settings = decisionSettings();
  const expired = expireDecisions({ now });
  let reminded = 0;
  let escalated = 0;

  // A request that timed out is not silence: the customer is told once that the
  // confirmation is still pending, in their own language.
  for (const decision of expired) {
    if (decision.type !== 'payment') continue;
    await notifyCustomerDecision({ transport, decision, action: 'pending_after_reminders', now });
  }

  const openRows = all("SELECT * FROM decision_requests WHERE status IN ('pending','recheck','escalated') ORDER BY created_at").map(hydrate);
  const quiet = inQuietHours(now);

  // The morning digest comes first: one message for everything that was held
  // back overnight, rather than a burst at 9 a.m. A digest counts as a rung on
  // each request's ladder, so nobody is nudged twice for the same hour.
  if (!quiet) {
    const held = openRows.filter((d) => {
      const rungs = eventsFor(d.id, 'reminded').length + eventsFor(d.id, 'digest').length;
      const due = settings.reminderMinutes[rungs];
      if (due === undefined) return false;
      const ageMinutes = (new Date(now).getTime() - new Date(d.created_at).getTime()) / 60_000;
      return ageMinutes >= due && rungs === 0 && eventsFor(d.id, 'digest').length === 0;
    });
    if (held.length > 1) {
      const lines = [`☀️ *Overnight decisions (${held.length})*`];
      for (const d of held.slice(0, 10)) lines.push(`• ${d.id} · ${d.type} · +${d.contact}${d.order_id ? ` · order #${d.order_id}` : ''}`);
      lines.push('', '.requests to open them.');
      const out = await sendToOwner({ transport, text: lines.join('\n'), agent: 'payment_review', reason: 'decision digest', now });
      if (out.sent) for (const d of held) recordEventRow(d.id, { actor: 'system', kind: 'digest', fromStatus: d.status, toStatus: d.status, now });
    }
  }

  for (const decision of openRows) {
    const created = new Date(decision.created_at).getTime();
    const ageMinutes = (new Date(now).getTime() - created) / 60_000;
    const nudges = eventsFor(decision.id, 'reminded').length + eventsFor(decision.id, 'digest').length;
    const nextAt = settings.reminderMinutes[nudges];
    const ladderDone = nextAt === undefined;
    const today = eventsFor(decision.id, 'reminded').filter((e) => String(e.created_at).slice(0, 10) === iso(now).slice(0, 10));
    if (!ladderDone) {
      if (ageMinutes < nextAt) continue;
      // Quiet hours: nothing pings at 3 a.m.
      if (quiet) continue;
    }
    if (ladderDone || today.length >= settings.maxRemindersPerDay) {
      if (quiet) continue;
      // The ladder has run out. Move to the next person on the chain, if any.
      const more = escalate({ id: decision.id, now });
      if (more.ok) {
        escalated += 1;
        const fresh = more.decision;
        await notifyOwners({ transport, decision: fresh, now, retry: true });
        await notifyCustomerDecision({ transport, decision: fresh, action: 'pending_after_reminders', now });
      } else {
        // Nobody else to ask: the customer is told the honest truth once.
        const told = eventsFor(decision.id, 'customer_pending_told');
        if (!told.length) {
          await notifyCustomerDecision({ transport, decision, action: 'pending_after_reminders', now });
          recordEventRow(decision.id, { actor: 'system', kind: 'customer_pending_told', fromStatus: decision.status, toStatus: decision.status, now });
        }
      }
      continue;
    }

    const proofs = proofsForRequest(decision.id);
    await notifyOwners({ transport, decision, proof: proofs[0] || null, retry: true, now });
    reminded += 1;
  }

  return { reminded, escalated, expired: expired.length };
}

function hydrate(row) {
  return { ...row, payload: safeJson(row.payload, {}), chain: safeJson(row.chain, []), customer_notified: Number(row.customer_notified) === 1 };
}

/**
 * Customer dues: day 1, 3, 7, then ask the owner about cancelling. Reuses the
 * growth gates, so opt-out, quiet hours and caps all apply, and stops the
 * moment a proof arrives or a decision is open.
 */
export async function runPaymentDues({ transport = null, now = new Date() } = {}) {
  if (!paymentReviewOn()) return { sent: 0, asked: 0 };
  const settings = decisionSettings();
  const orders = all("SELECT * FROM orders WHERE status = 'awaiting_payment' ORDER BY id").map((o) => ({ ...o, items: safeJson(o.items, []) }));
  let sent = 0;
  let asked = 0;
  for (const order of orders) {
    const ageHours = (new Date(now).getTime() - new Date(order.created_at || now).getTime()) / 3600_000;
    if (ageHours < 24) continue;
    const number = digits(String(order.chat || '').split('@')[0]);
    if (!number) continue;
    // A proof or a pending decision stops the dues: the ball is with us.
    if (openDecisionForOrder(order.id)) continue;
    const proofs = all('SELECT id FROM payment_proofs WHERE order_id = ? AND deleted_at IS NULL', [order.id]);
    if (proofs.length) continue;

    const stage = Math.min(3, Math.max(1, ageHours >= 168 ? 3 : ageHours >= 72 ? 2 : 1));
    const done = orderEvents(order.id).filter((e) => /^due:[123]/.test(String(e.detail || '')));
    if (done.length >= 3) {
      // Three reminders and silence: ask the owner, do not keep pushing.
      const alreadyAsked = all("SELECT id FROM decision_requests WHERE order_id = ? AND type = 'cancellation'", [order.id]);
      if (!alreadyAsked.length) {
        const opened = openDecision({
          type: 'cancellation',
          contact: number,
          orderId: order.id,
          payload: { orderId: order.id, due: dueOf(order), currency: order.currency, reason: 'three payment reminders, no reply' },
          now,
        });
        if (opened.ok) {
          await sendToOwner({
            transport,
            text: `❓ Order #${order.id} (+${number}) is still unpaid after three reminders.\nCancel it? .accept ${opened.decision.id} (closes the order) · .reject ${opened.decision.id} 8 (keeps it open)`,
            agent: 'payment_review',
            reason: 'cancellation question',
            now,
          });
          asked += 1;
        }
      }
      continue;
    }
    if (done.some((e) => e.detail === `due:${stage}`)) continue;

    const due = dueOf(order);
    const lines = DUE_MESSAGES[langOf(languageFor(number))] || DUE_MESSAGES.en;
    const text = lines[stage - 1].replace('{id}', String(order.id)).replace('{amount}', formatMoney(due, order.currency || 'PKR'));
    const out = await sendProactively({
      transport,
      number,
      text,
      agent: 'payment_review',
      reason: `due:${stage}`,
      now,
      transactional: false,
    });
    if (out.sent) {
      logOrderEvent({ orderId: order.id, from: order.status, to: order.status, actor: 'bot', detail: `due:${stage}` });
      sent += 1;
    }
  }
  // Retention is part of the same daily pass: old proofs lose their files.
  const purged = purgeExpiredProofs({ now });
  return { sent, asked, purged: purged.deleted };
}

/** One loop tick, wired from the order loop. */
export async function runPaymentReview({ transport = null, now = new Date() } = {}) {
  if (!enabled()) return { skipped: true };
  const reminders = await runDecisionReminders({ transport, now });
  const dues = await runPaymentDues({ transport, now });
  writePaymentsSnapshot({ now });
  return { ...reminders, ...dues };
}

// ════════════════════════════════════════════════════════════
// Payments strip (`.payments`, inbox, admin, platform)
// ════════════════════════════════════════════════════════════
const dayKey = (date) => iso(date).slice(0, 10);

export function paymentsSummary({ now = new Date() } = {}) {
  const today = dayKey(now);
  const pending = listDecisions({ status: 'pending', limit: 200 });
  const recheck = listDecisions({ status: 'recheck', limit: 200 });
  const escalated = listDecisions({ status: 'escalated', limit: 200 });
  const decidedToday = all(
    "SELECT * FROM decision_requests WHERE type = 'payment' AND resolved_at IS NOT NULL AND resolved_at >= ?",
    [`${today}T00:00:00.000Z`]
  ).map(hydrate);
  const acceptedToday = decidedToday.filter((d) => ['accepted', 'partial'].includes(d.status));
  const rejectedToday = decidedToday.filter((d) => d.status === 'rejected');
  const overdue = [...pending, ...recheck, ...escalated].filter((d) => d.deadline_at && d.deadline_at < iso(now));

  const amounts = [...pending, ...recheck, ...escalated].reduce(
    (acc, d) => {
      const order = d.order_id ? getOrder(d.order_id) : null;
      acc.pending += order ? dueOf(order) : Number(d.payload?.due) || 0;
      return acc;
    },
    { pending: 0 }
  );

  // Average time from opening to a decision, over the last 30 days.
  const recent = all(
    "SELECT created_at, resolved_at FROM decision_requests WHERE type = 'payment' AND resolved_at IS NOT NULL AND resolved_at >= ?",
    [iso(new Date(new Date(now).getTime() - 30 * 24 * 3600_000))]
  );
  const avgMinutes = recent.length
    ? Math.round(recent.reduce((sum, r) => sum + (new Date(r.resolved_at).getTime() - new Date(r.created_at).getTime()) / 60_000, 0) / recent.length)
    : null;

  const reasons = {};
  for (const d of rejectedToday) reasons[d.reason_code || 'other'] = (reasons[d.reason_code || 'other'] || 0) + 1;

  return {
    enabled: enabled(),
    pending: pending.length + escalated.length,
    recheck: recheck.length,
    overdue: overdue.length,
    acceptedToday: acceptedToday.length,
    rejectedToday: rejectedToday.length,
    reasons,
    pendingAmount: amounts.pending,
    currency: profile()?.business?.currency || 'PKR',
    avgDecisionMinutes: avgMinutes,
    oldest: [...pending, ...escalated].map((d) => d.created_at).sort()[0] || null,
  };
}

export function paymentsStrip(summary = paymentsSummary()) {
  if (!summary.enabled) return 'Owner decisions are off. Turn them on with: .set features.ownerDecisions true';
  const lines = ['*Payments*'];
  lines.push(`• Pending: ${summary.pending}${summary.pending ? ` · ${formatMoney(summary.pendingAmount, summary.currency)} in claims` : ''}`);
  lines.push(`• Recheck: ${summary.recheck}`);
  lines.push(`• Overdue: ${summary.overdue}`);
  lines.push(`• Today: ${summary.acceptedToday} accepted, ${summary.rejectedToday} rejected`);
  if (Object.keys(summary.reasons).length) {
    lines.push(`  reasons: ${Object.entries(summary.reasons).map(([code, n]) => `${code}×${n}`).join(', ')}`);
  }
  lines.push(`• Average decision time: ${summary.avgDecisionMinutes === null ? 'n/a' : `${summary.avgDecisionMinutes} min`}`);
  if (summary.oldest) lines.push(`• Oldest waiting since ${summary.oldest.slice(0, 16).replace('T', ' ')}`);
  lines.push('', '.decisions to open one · .timeline <order> for the history');
  return lines.join('\n');
}

/** A small file the platform dashboard can read in mounted mode. It is counts
 * only — never a customer number, never an amount per person. */
export function paymentsSnapshotPath() {
  return path.resolve(config.paths.data, 'payments-summary.json');
}

export function writePaymentsSnapshot({ now = new Date() } = {}) {
  try {
    const s = paymentsSummary({ now });
    fs.writeFileSync(
      paymentsSnapshotPath(),
      JSON.stringify({ generatedAt: iso(now), tenant: config.tenant?.slug || 'default', ...s, reasons: s.reasons }, null, 2),
      { mode: 0o600 }
    );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function readPaymentsSnapshot(dir = null) {
  try {
    const file = dir ? path.join(dir, 'payments-summary.json') : paymentsSnapshotPath();
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// Impact / accuracy counters
// ════════════════════════════════════════════════════════════
/** What `.impact` adds: money questions that reached a person, and how fast. */
export function decisionCounters({ now = new Date() } = {}) {
  const since = iso(new Date(new Date(now).getTime() - 30 * 24 * 3600_000));
  const rows = all("SELECT * FROM decision_requests WHERE created_at >= ?", [since]).map(hydrate);
  const pending = rows.filter((d) => d.open).length;
  const decided = rows.filter((d) => d.resolved_at);
  const avg = decided.length
    ? Math.round(decided.reduce((sum, d) => sum + (new Date(d.resolved_at).getTime() - new Date(d.created_at).getTime()) / 60_000, 0) / decided.length)
    : null;
  const reversed = rows.filter((d) => d.status === 'reversed').length;
  return {
    opened: rows.length,
    pending,
    decided: decided.length,
    reversed,
    avgDecisionMinutes: avg,
    paymentsAccepted: rows.filter((d) => d.type === 'payment' && d.status === 'accepted').length,
    paymentsRejected: rows.filter((d) => d.type === 'payment' && d.status === 'rejected').length,
    paymentsPartial: rows.filter((d) => d.type === 'payment' && d.status === 'partial').length,
  };
}

export { forgetProofsFor, proofsForExport, looksLikePaymentProof as looksLikeProofText };

export default {
  paymentReviewOn,
  ownerDecisionsOn,
  isDecisionCommand,
  handleDecisionCommand,
  handlePaymentProof,
  handleTeamCommand,
  handleChainCommand,
  notifyCustomerDecision,
  notifyOwners,
  ownerCard,
  cardPayload,
  decisionDetail,
  pendingDecisionFor,
  openDecisionLines,
  waitingLine,
  asksAboutPayment,
  awaitingOrdersFor,
  rejectionText,
  REJECT_REASONS,
  REASON_CODES,
  REASON_MESSAGES,
  looksLikeProofText: looksLikePaymentProof,
  timelineEntries,
  timelineText,
  runPaymentReview,
  runDecisionReminders,
  runPaymentDues,
  paymentsSummary,
  paymentsStrip,
  paymentsSnapshotPath,
  writePaymentsSnapshot,
  readPaymentsSnapshot,
  decisionCounters,
};
