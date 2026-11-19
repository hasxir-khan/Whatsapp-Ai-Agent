// src/services/noGuess.js
// "No guessing" — what to do when the answer is not in the business's data.
//
// A price the owner never published, or a policy they never wrote, is not a
// question a language model should answer. The rule here is one line long: say
// it will be confirmed, put the exact question in front of the owner, and let
// the owner's reply reach the customer. That is the existing handoff machinery —
// nothing new is built, nothing is guessed.
//
// This module only decides *that* a question is unanswerable and writes the two
// sentences involved. The handler sends them and pauses the chat.

import { effectiveServices, policies, business } from './profile.js';

const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

export const PRICE_ASK = /\b(price|prices|pricing|cost|costs|charge|charges|rate|rates|quote|quotation|estimate|how much|total|discount)\b|kitn[ae]|kya rate|qemat|قیمت|کتنا|ریٹ/i;

// Policy topics people ask about, and the keys that would answer them.
const POLICY_TOPICS = [
  { key: 'refund', re: /\b(refund|reimburse|money back|wapas|واپس|رقم واپس)\b/i, fields: ['refund', 'returns', 'return'] },
  { key: 'returns', re: /\b(return|exchange|badal|بدل)\b/i, fields: ['returns', 'return', 'exchange'] },
  { key: 'delivery', re: /\b(delivery|deliver|shipping|courier|pahunch|ڈیلیوری|پہنچ)\b/i, fields: ['delivery', 'shipping', 'deliveryAreas'] },
  { key: 'warranty', re: /\b(warranty|guarantee|guarantor|ضمانت)\b/i, fields: ['warranty', 'guarantee'] },
  { key: 'payment', re: /\b(payment plan|installment|instalment|emi|قسط)\b/i, fields: ['payment', 'paymentPlan', 'installments'] },
  { key: 'privacy', re: /\b(privacy|gdpr|data (policy|stored))\b/i, fields: ['privacy'] },
];

/** Every price the business has actually published, as numbers. */
export function publishedPrices() {
  try {
    return (effectiveServices() || [])
      .map((s) => Number(s?.min ?? s?.price ?? s?.from))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

export function hasPublishedPrices() {
  return publishedPrices().length > 0;
}

export function asksPrice(text = '') {
  return PRICE_ASK.test(String(text || ''));
}

// "what is your price", "kitna hoga?", "قیمت کیا ہے" — a question, not a budget
// the customer is stating about their own project. The difference matters: a
// stated budget belongs to the collector, a question without an answer belongs
// to the owner.
const PRICE_QUESTION =
  /(how much|what('s| is| are) (the |your )?(price|prices|cost|rate|rates|charges?|fees?)|price (kya|kia|hai|kya hai)|kya rate|kitn[ae] (hoga|hogi|hai|lagega)|قیمت کیا|کتنا (ہوگا|ہے)|کتنی (ہے|ہوگی))/i;

export function asksPriceQuestion(text = '') {
  const clean = String(text || '');
  if (!PRICE_ASK.test(clean)) return false;
  return PRICE_QUESTION.test(clean) || /\?|؟/.test(clean);
}

/** The policy topic asked about, if the profile has no answer for it. */
export function unansweredPolicy(text = '') {
  const clean = String(text || '');
  if (!clean.trim()) return null;
  const p = policies() || {};
  for (const topic of POLICY_TOPICS) {
    if (!topic.re.test(clean)) continue;
    const answered = topic.fields.some((f) => {
      const v = p[f] ?? p.cancellation?.[f];
      return typeof v === 'string' ? v.trim().length > 0 : Boolean(v);
    });
    if (!answered) return topic.key;
  }
  return null;
}

const L = (en, roman, ur) => ({ en, 'roman-ur': roman, ur });
const pick = (line, lang) => line[lang] || line.en;

const CONFIRM = {
  price: L(
    "I don't want to give you a number I'm not sure about — let me confirm the price with the owner and come straight back to you.",
    'Main aap ko aisa number nahi dena chahta jo pakka na ho — price owner se confirm kar ke foran bata deta hoon.',
    'میں آپ کو ایسا نمبر نہیں دینا چاہتا جو پکا نہ ہو — قیمت مالک سے تصدیق کر کے فوراً بتا دیتا ہوں۔'
  ),
  policy: L(
    "That's an owner question, not something I'll guess at — I'm asking and will come back to you here.",
    'Yeh owner ka faisla hai, main andaza nahi lagaunga — pooch raha hoon aur yahin bata dunga.',
    'یہ مالک کا فیصلہ ہے، میں اندازہ نہیں لگاؤں گا — پوچھ رہا ہوں اور یہیں بتا دوں گا۔'
  ),
  conflict: L(
    "You've told me two different things about that — which one should I go with?",
    'Aap ne is bare mein do alag baatain batayi hain — kaun si lein?',
    'آپ نے اس بارے میں دو مختلف باتیں بتائی ہیں — کون سی لیں؟'
  ),
};

/** The customer-facing line for an unanswerable question. */
export function noGuessLine(kind, lang = 'en') {
  return pick(CONFIRM[kind] || CONFIRM.policy, lang);
}

/**
 * The owner's task. Deliberately a question, not a summary: the owner can answer
 * it in one line, and that line goes to the customer.
 */
export function ownerTaskText({ number, kind = 'price', question = '' }) {
  const asked = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (kind === 'price') {
    return [
      `❓ +${number} asked about price and nothing published covers it.`,
      asked ? `They said: "${asked}"` : null,
      '',
      'Reply here with the number and I will pass it on. Nothing was quoted.',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `❓ +${number} asked about ${kind} and the policies have no answer.`,
    asked ? `They said: "${asked}"` : null,
    '',
    'Answer here and I will pass it on. Nothing was guessed.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** "Your budget" said two ways — the uncertainty is named, then one question. */
export function conflictLine(lang = 'en') {
  return pick(CONFIRM.conflict, lang);
}

export default {
  PRICE_ASK,
  asksPrice,
  asksPriceQuestion,
  conflictLine,
  hasPublishedPrices,
  noGuessLine,
  ownerTaskText,
  publishedPrices,
  unansweredPolicy,
};
