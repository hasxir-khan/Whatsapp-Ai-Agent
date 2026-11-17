// src/services/closerAgent.js
// The closer (features.closerAgent).
//
// Two jobs, both narrow:
//
//   1. Answer the four objections that actually lose sales — price, trust,
//      timing, "somewhere else is cheaper" — with facts from the profile.
//   2. When the customer is ready, hand them a quote and the real payment
//      details, and mark the order awaiting payment.
//
// The hard rules, enforced in code rather than in a prompt:
//   • no discount unless business.policies.maxDiscountPercent is configured,
//     and never above it — above it, a human decides
//   • two attempts per objection, then a human
//   • no invented prices, no fake scarcity, no urgency, no "only today"
//   • a payment receipt never marks an order paid. Ever. The owner verifies.

import { config } from '../config/env.js';
import { business, featureOn, policies as policyBlock, faqList, effectiveCatalog, payment as paymentConfig } from './profile.js';
import { formatMoney } from './geo.js';
import { buildQuote, formatQuote } from '../core/pricing.js';
import {
  getLead, getIntake, getContact, logObjection, objectionAttempts, createOrder, orderFor,
  setOrderStatus, logEvent, saveLead,
} from '../utils/db.js';

export function closerAgentEnabled() {
  return featureOn('closerAgent');
}

// ── objections ─────────────────────────────────────────────
// Ordered by specificity: "mehnga but I'll think about it" is a price
// objection with a timing tail, and price is the one worth answering.
const OBJECTIONS = [
  {
    kind: 'price',
    patterns: [
      /\b(mehnga|mehngi|mehnga\s+hai|zyada\s+hai|bahut\s+zyada|bohat\s+zyada|price\s+zyada|costly|expensive|too\s+(much|expensive|high)|over\s+budget|budget\s+se\s+bahar|afford)\b/i,
      /(مہنگا|مہنگی|زیادہ\s+ہے|بہت\s+زیادہ|بجٹ)/,
    ],
  },
  {
    kind: 'trust',
    patterns: [
      /\b(scam|fraud|fake|trust|bharosa|bharosa\s+nahi|genuine|legit|guarantee|refund\s+policy|advance\s+kyun|advance\s+dena)\b/i,
      /(بھروسہ|فراڈ|جعل|گارنٹی|ایڈوانس)/,
    ],
  },
  {
    kind: 'comparison',
    patterns: [
      /\b(cheaper|kisi\s+aur|doosre|dusre|another\s+(shop|site|person)|compare|comparison|same\s+thing\s+(cheaper|for\s+less)|market\s+mein)\b/i,
      /(دوسرے|کسی\s+اور|سستا|موازنہ)/,
    ],
  },
  {
    kind: 'timing',
    patterns: [
      /\b(sochta\s+hoon|sochti\s+hoon|sochna|baad\s+mein|baad\s+me|phir\s+dekhta|later|think\s+about\s+it|not\s+right\s+now|abhi\s+nahi|next\s+(month|week)|time\s+nahi)\b/i,
      /(سوچتا\s+ہوں|سوچتی\s+ہوں|بعد\s+میں|ابھی\s+نہیں)/,
    ],
  },
];

/** Which objection is this, if any? */
export function detectObjection(text = '') {
  const clean = String(text || '').trim();
  if (!clean) return null;
  for (const rule of OBJECTIONS) {
    if (rule.patterns.some((re) => re.test(clean))) return rule.kind;
  }
  return null;
}

const READY_PATTERNS = [
  /\b(order\s+(kar|karna|karni)|order\s+karna\s+hai|book\s+kar\s+do|confirm\s+kar|i'?ll\s+take\s+it|let'?s\s+do\s+it|go\s+ahead|sign\s+me\s+up|send\s+(me\s+)?(the\s+)?(quote|invoice)|how\s+do\s+i\s+pay|payment\s+kaise|paisa\s+kaise|advance\s+kaise|kahan\s+(bhejun|bhejna))\b/i,
  /(آرڈر\s+کرنا|بک\s+کر\s+دو|تصدیق|ادائیگی\s+کیسے|پیسے\s+کیسے|کہاں\s+بھیجوں)/,
];

export function readyToBuy(text = '') {
  const clean = String(text || '').trim();
  return READY_PATTERNS.some((re) => re.test(clean));
}

// ── discounts ──────────────────────────────────────────────
/**
 * The discount ceiling, and whether it exists at all. No configured ceiling
 * means no discount — not a default percentage invented by the software.
 */
export function discountPolicy() {
  const p = policyBlock();
  const raw = p.maxDiscountPercent;
  const n = Number(raw);
  const configured = raw !== undefined && raw !== null && raw !== '' && Number.isFinite(n) && n > 0;
  return { configured, cap: configured ? Math.min(100, Math.round(n * 100) / 100) : 0 };
}

/** "10% off" / "5 percent kam" / "discount do" — what did they ask for? */
export function askedDiscountPercent(text = '') {
  const m = /(\d{1,2}(?:\.\d)?)\s*(?:%|percent|pc\b)/i.exec(String(text || ''));
  if (m) return Number(m[1]);
  const urdu = /(\d{1,2})\s*(فیصد|فيصد)/.exec(String(text || ''));
  if (urdu) return Number(urdu[1]);
  return null;
}

function fmtPrice(amount, currency) {
  return formatMoney(Number(amount) || 0, currency || business().currency || 'PKR');
}

/** The first catalogue item we can talk about, with a real price. */
function headlineItem(text = '') {
  const items = effectiveCatalog();
  const needle = String(text || '').toLowerCase();
  const mentioned = items.find((i) => i.name && needle.includes(String(i.name).toLowerCase()));
  const item = mentioned || items.find((i) => (i.price ?? i.min) > 0);
  if (!item) return null;
  return {
    name: item.name,
    price: Number(item.price ?? item.min) || 0,
    stock: item.stock,
  };
}

const TRUST_WORDS = /guarantee|refund|replace|warranty|return|bharosa|ضمانت|واپسی/i;

/** Something true the business has actually written down about trust. */
function trustFact() {
  const faq = faqList().find((f) => {
    const q = String(f.question || f.q || '');
    const a = String(f.answer || f.a || '');
    return TRUST_WORDS.test(q) || TRUST_WORDS.test(a);
  });
  if (faq) return { question: faq.question || faq.q, answer: faq.answer || faq.a };
  const p = policyBlock();
  const written = p.refund || p.guarantee || p.returns || p.warranty;
  if (written) return { question: 'policy', answer: String(written) };
  return null;
}

function firstFaqMatch(text = '') {
  const needle = String(text || '').toLowerCase();
  const faqs = faqList();
  const hit = faqs.find((f) => {
    const q = String(f.question || f.q || '').toLowerCase();
    return q && needle.split(/\s+/).some((w) => w.length > 3 && q.includes(w));
  });
  return hit ? { question: hit.question || hit.q, answer: hit.answer || hit.a } : null;
}

// ── the reply ──────────────────────────────────────────────
/**
 * A deterministic answer: acknowledge, one concrete fact, one question.
 * Same input, same words — nothing here is generated, so nothing can be
 * invented.
 */
export function buildObjectionReply({ kind, attempt = 1, lang = 'en', text = '', discount = null } = {}) {
  const item = headlineItem(text);
  const price = item ? fmtPrice(item.price, business().currency) : null;
  const faq = firstFaqMatch(text) || (kind === 'trust' ? trustFact() : null);
  const finalAttempt = attempt >= config.closer.maxAttempts;
  const disc = discount && discount.percent ? discount : null;

  const fact =
    kind === 'price' && disc
      ? disc.text
      : kind === 'price' && price
        ? price
        : kind === 'trust' && faq
          ? faq.answer
          : kind === 'comparison' && price
            ? price
            : null;

  // ── Urdu ──
  if (lang === 'ur') {
    const head = kind === 'price' ? 'میں سمجھتا ہوں، قیمت اہم ہے۔' : kind === 'trust' ? 'بھروسہ فطری بات ہے۔' : kind === 'comparison' ? 'موازنہ کرنا درست ہے۔' : 'بالکل، سوچ کر بتائیں۔';
    const body = fact ? ` ${fact}` : '';
    const tail = finalAttempt
      ? ' اگر چاہیں تو میں آپ کو مالک سے بات کرنے دے دوں؟'
      : kind === 'timing'
        ? ' کیا میں ایک بات طے کر دوں تاکہ آپ کو یاد رہے؟'
        : ' کیا آپ بتائیں کہ کس چیز پر شک ہے؟';
    return `${head}${body}${tail}`;
  }

  // ── Roman Urdu ──
  if (lang === 'roman-ur') {
    const head =
      kind === 'price'
        ? 'Samajh sakta hoon, price dekhna zaroori hai.'
        : kind === 'trust'
          ? 'Bharosa hona chahiye, bilkul theek.'
          : kind === 'comparison'
            ? 'Compare karna aap ka haq hai.'
            : 'Theek hai, soch lijiye.';
    const body = fact ? ` ${fact}` : '';
    const tail = finalAttempt
      ? ' Chahein to main owner se baat karwa doon?'
      : kind === 'timing'
        ? ' Main ek slot hold kar doon taake yaad rahe?'
        : ' Kis cheez par sawal hai?';
    return `${head}${body}${tail}`;
  }

  // ── English ──
  const head =
    kind === 'price'
      ? "Fair enough — price matters."
      : kind === 'trust'
        ? 'Trust has to be earned, that’s fair.'
        : kind === 'comparison'
          ? 'Worth comparing, of course.'
          : 'No rush at all.';
  const body = fact ? ` ${fact}` : '';
  const tail = finalAttempt
    ? ' Would you like me to put you in touch with the owner?'
    : kind === 'timing'
      ? ' Shall I hold a slot for you so it’s there when you decide?'
      : ' What’s the part you’re unsure about?';
  return `${head}${body}${tail}`;
}

/**
 * Decide what to say to one message.
 * @returns {{handled:boolean, reply?:string, kind?:string, escalate?:boolean, discountPercent?:number}}
 */
export function handleCloserTurn({ number, text = '', lang = 'en', now = new Date() } = {}) {
  if (!closerAgentEnabled()) return { handled: false };

  const kind = detectObjection(text);
  if (!kind) return { handled: false };

  const attempted = objectionAttempts(number, kind);
  const max = config.closer.maxAttempts;

  // Already said our piece twice: stop selling, offer a person.
  if (attempted >= max) {
    logEvent('closer_handoff', number, { kind, attempts: attempted });
    saveLead({ number, status: 'negotiating', next_action: `owner to answer ${kind} objection` });
    const handoff =
      lang === 'ur'
        ? 'میں آپ کو مزید قائل نہیں کروں گا — مالک خود بات کریں گے۔'
        : lang === 'roman-ur'
          ? 'Main zyada convince nahi karunga — owner khud baat kar lenge.'
          : "I won't keep pushing — I'll ask the owner to talk to you directly.";
    return { handled: true, reply: handoff, kind, escalate: true };
  }

  const attempt = attempted + 1;
  logObjection({ number, kind, attempt });

  // A discount is only ever offered where the owner configured a ceiling, and
  // only once per customer.
  let discount = null;
  if (kind === 'price') {
    const policy = discountPolicy();
    const asked = askedDiscountPercent(text);
    if (policy.configured && asked != null && asked > policy.cap) {
      // They asked for more than the owner allows us to give. That is a
      // decision, not a negotiation: a human makes it.
      logEvent('closer_discount_handoff', number, { asked, cap: policy.cap });
      const reply =
        lang === 'ur'
          ? `مجھے ${policy.cap}% تک کی اجازت ہے، اس سے زیادہ مالک طے کریں گے — میں پوچھ کر بتاتا ہوں۔`
          : lang === 'roman-ur'
            ? `Mere paas ${policy.cap}% tak ki permission hai, us se zyada owner decide karenge — pooch kar batata hoon.`
            : `I'm allowed up to ${policy.cap}% — anything beyond that the owner decides. Let me ask.`;
      return { handled: true, reply, kind, escalate: true, discountRequest: asked };
    }
    if (policy.configured) {
      const wanted = asked ?? Math.min(5, policy.cap);
      const percent = Math.min(wanted, policy.cap);
      const item = headlineItem(text) || headlineItem(
        String(getLead(number)?.project_type || '')
      );
      if (percent > 0 && item) {
        const after = Math.round(item.price * (1 - percent / 100));
        discount = {
          percent,
          text:
            lang === 'ur'
              ? `${percent}% کمی کر کے ${fmtPrice(after, business().currency)} کر سکتا ہوں (${item.name}).`
              : lang === 'roman-ur'
                ? `${percent}% kam kar ke ${fmtPrice(after, business().currency)} kar sakta hoon (${item.name}).`
                : `I can do ${percent}% off — ${fmtPrice(after, business().currency)} for the ${item.name}.`,
        };
      }
    } else if (asked != null) {
      // They asked for a discount above a ceiling that does not exist: a human
      // decides. No silent "no", no invented approval.
      logEvent('closer_discount_handoff', number, { asked });
      const reply =
        lang === 'ur'
          ? 'قیمت میں کمی کا فیصلہ مالک کرتے ہیں — میں ان سے پوچھ کر بتاتا ہوں۔'
          : lang === 'roman-ur'
            ? 'Discount ka faisla owner karte hain — unse pooch kar batata hoon.'
            : "Discounts are the owner's call — let me ask and come back to you.";
      return { handled: true, reply, kind, escalate: true, discountRequest: asked };
    }
  }

  const reply = buildObjectionReply({ kind, attempt, lang, text, discount });
  return { handled: true, reply, kind, attempt, discountPercent: discount?.percent ?? null };
}

// ── payment ────────────────────────────────────────────────
/**
 * Payment instructions from business.payment, in the order a customer needs
 * them. Nothing is invented: what is not configured is not mentioned.
 */
export function paymentInstructions({ lang = 'en', amount = null, currency = null } = {}) {
  const pay = paymentConfig();
  const lines = [];
  const total = amount ? fmtPrice(amount, currency) : null;

  const bank = pay.bank || (pay.bankAccount ? { number: pay.bankAccount, name: pay.bankName, title: pay.accountTitle } : null);
  if (bank?.number || bank?.accountNumber) {
    const parts = [bank.name || bank.bank, bank.title || bank.accountTitle, bank.number || bank.accountNumber].filter(Boolean);
    lines.push(`🏦 ${parts.join(' · ')}`);
  }
  for (const [label, key] of [['JazzCash', 'jazzcash'], ['Easypaisa', 'easypaisa']]) {
    const acct = pay[key];
    if (acct && (acct.number || acct.accountNumber)) {
      const parts = [acct.title || acct.name, acct.number || acct.accountNumber].filter(Boolean);
      lines.push(`📱 ${label}: ${parts.join(' · ')}`);
    }
  }
  if (pay.stripeLink || pay.stripe || pay.link) lines.push(`💳 ${pay.stripeLink || pay.stripe || pay.link}`);
  if (pay.cod || pay.cashOnDelivery) lines.push('🚚 Cash on delivery is fine too.');

  if (!lines.length) return null;
  const head =
    lang === 'ur'
      ? `ادائیگی کے لیے${total ? ` ${total}` : ''}:`
      : lang === 'roman-ur'
        ? `Payment ke liye${total ? ` ${total}` : ''}:`
        : `To pay${total ? ` ${total}` : ''}:`;
  return `${head}\n${lines.join('\n')}`;
}

function firstName(number) {
  const c = getContact(number);
  const raw = c?.name || c?.push_name || '';
  return String(raw).split(' ')[0] || '';
}

/**
 * The customer said yes. Produce the quote, the payment details, and an order
 * that says "awaiting payment" — not "paid".
 */
export function startOrder({ number, text = '', lang = 'en', now = new Date() } = {}) {
  const chat = `${number}@s.whatsapp.net`;
  const existing = orderFor(chat);
  if (existing && existing.status === 'awaiting_payment') {
    // They already have one; repeat the details instead of duplicating orders.
    return { ok: true, order: existing, duplicate: true, reply: paymentInstructions({ lang, amount: existing.total, currency: existing.currency }) || '' };
  }

  const intake = getIntake(number);
  const lead = getLead(number);
  const fields = intake?.fields || {};
  const projectType = fields.project_type || lead?.project_type || text;
  let quote = intake?.quote || null;
  try {
    quote = quote || buildQuote({ ...fields, project_type: projectType }, number);
  } catch (err) {
    logEvent('closer_quote_failed', number, err.message);
    quote = null;
  }

  const item = headlineItem(projectType) || headlineItem(text);
  const total = quote?.max || quote?.min || item?.price || 0;
  const currency = quote?.currency || business().currency || 'PKR';

  const { order } = createOrder({
    chat,
    items: item ? [{ name: item.name, qty: 1, price: item.price }] : [{ name: projectType || 'order', qty: 1 }],
    total,
    currency,
    name: firstName(number) || null,
  });
  setOrderStatus(order.id, 'awaiting_payment');
  logEvent('order_awaiting_payment', number, { order: order.id, total, currency });

  const quoteText = quote ? formatQuote(quote, { ...fields, project_type: projectType }) : '';
  const pay = paymentInstructions({ lang, amount: total, currency });
  const closing =
    lang === 'ur'
      ? 'رقم ملنے پر میں مالک کو بتا دوں گا۔'
      : lang === 'roman-ur'
        ? 'Payment milne par main owner ko bata dunga.'
        : "Once it's in, I'll get it confirmed by the owner.";

  const reply = [quoteText, pay, pay ? closing : null]
    .filter(Boolean)
    .join('\n\n');

  return {
    ok: true,
    order: orderFor(chat) || order,
    quote,
    reply:
      reply ||
      (lang === 'ur'
        ? 'ٹھیک ہے — مالک ادائیگی کی تفصیل بھیج دیں گے۔'
        : lang === 'roman-ur'
          ? 'Theek hai — owner payment details bhej denge.'
          : "Noted — the owner will send payment details."),
  };
}

// ── receipts ───────────────────────────────────────────────
/**
 * A screenshot of a bank transfer is evidence, not proof. We read it, we tell
 * the owner, and we never mark an order paid ourselves.
 *
 * @param {object} opts
 * @param {Function} [opts.reader]  injected image reader (tests); defaults to vision
 */
export async function handleReceipt({ number, buffer = null, mimetype = 'image/jpeg', transport = null, now = new Date(), reader = null } = {}) {
  if (!closerAgentEnabled()) return { handled: false };
  const order = orderFor(`${number}@s.whatsapp.net`);
  if (!order || !['awaiting_payment', 'placed'].includes(order.status)) return { handled: false };

  let described = null;
  const read = reader || (await import('./vision.js')).analyzeImage;
  try {
    const out = await read({ buffer, mimetype, caption: 'payment receipt', context: 'A customer says this is proof of payment for an order.' });
    described = out?.description || null;
  } catch (err) {
    logEvent('receipt_read_failed', number, err.message);
  }

  logEvent('receipt_received', number, { order: order.id, read: !!described });
  if (transport) {
    const who = firstName(number) || `+${number}`;
    const text =
      `🧾 *Payment proof from ${who}* (+${number}) — order #${order.id}, ${fmtPrice(order.total, order.currency)}\n\n` +
      (described ? `"${String(described).slice(0, 600)}"\n\n` : '_Could not read the image — look at it yourself._\n\n') +
      `Order is still *awaiting payment*. Mark it paid only after you have checked:\n` +
      `.paid ${order.id}`;
    try {
      await transport.sendMessage(config.owner.jid, { text });
    } catch (err) {
      logEvent('receipt_notify_failed', number, err.message);
    }
  }

  return { handled: true, order, described };
}

export default {
  closerAgentEnabled, detectObjection, readyToBuy, discountPolicy, askedDiscountPercent,
  buildObjectionReply, handleCloserTurn, paymentInstructions, startOrder, handleReceipt,
};
