// src/services/orders.js
// The order lifecycle, from "placed" to "delivered", with the two things that
// actually matter to a small business:
//
//   1. The status is a fact in one place. "Where is my order?" is answered from
//      the orders table — never guessed, never improvised by the model.
//   2. The customer hears about it. Every message that goes out because of a
//      status change goes through growth.js, so opt-out, quiet hours, the daily
//      cap and the Cloud API's 24-hour window rule all apply without this file
//      knowing how any of them work.
//
// Payment is deliberately asymmetric: the bot can *ask* for money and can ask
// the owner to confirm, but only `.paid` — a human typing a command — can move
// an order to paid. A receipt photo is a claim, not a payment.

import { config } from '../config/env.js';
import { profile, featureOn } from './profile.js';
import { formatMoney } from './geo.js';
import { sendProactively, sendToOwner } from './growth.js';

import {
  getOrder,
  setOrderStatus,
  setOrderEta,
  orderFor,
  ordersWithStatus,
  logOrderEvent,
  orderEvents,
  countOrderReminders,
  logEvent,
  recentEvents,
  getContact,
  addDraft,
  pendingDraftFor,
} from '../utils/db.js';

export function orderTrackingEnabled() {
  return featureOn('orderTracking');
}

// ── the states ──────────────────────────────────────────────

export const ORDER_STATES = [
  'placed',
  'awaiting_payment',
  'paid',
  'preparing',
  'ready',
  'out_for_delivery',
  'delivered',
];

export const TERMINAL_STATES = ['delivered', 'cancelled', 'refunded'];

export const TRANSITIONS = {
  placed: ['awaiting_payment', 'cancelled'],
  awaiting_payment: ['paid', 'cancelled'],
  paid: ['preparing', 'refunded'],
  preparing: ['ready', 'cancelled'],
  ready: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
};

const LABELS = {
  placed: 'Placed',
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid',
  preparing: 'Preparing',
  ready: 'Ready',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

export function statusLabel(state) {
  return LABELS[state] || state;
}

export function isOrderState(value) {
  const state = String(value || '').toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
  return ORDER_STATES.includes(state) || TERMINAL_STATES.includes(state);
}

export function normaliseState(value) {
  return String(value || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
}

/**
 * May this order move to `to`?
 *
 * Forwards is the normal path. Backwards is allowed only with an explicit
 * override, because "delivered → preparing" is almost always a typo, and a typo
 * must not rewrite history. Unknown states are refused outright.
 */
export function canTransition(from, to, { override = false } = {}) {
  const a = normaliseState(from);
  const b = normaliseState(to);
  if (!isOrderState(b)) return { ok: false, reason: 'unknown_state', state: b };
  if (a === b) return { ok: false, reason: 'same_state', state: b };

  const allowed = TRANSITIONS[a] || [];
  // Money is the one state that may not be reached by skipping ahead: a jump
  // from "placed" straight to "paid" would mark an unpaid order paid.
  if (b === 'paid' && a !== 'awaiting_payment' && !override) {
    return { ok: false, reason: 'paid_needs_payment_step', from: a, to: b };
  }
  if (allowed.includes(b)) return { ok: true, from: a, to: b };

  const fromIndex = ORDER_STATES.indexOf(a);
  const toIndex = ORDER_STATES.indexOf(b);
  const forward = fromIndex >= 0 && toIndex >= 0 && toIndex > fromIndex;

  // Forward jumps (a pickup order going straight to delivered) are allowed.
  if (forward) return { ok: true, from: a, to: b, skip: true };

  // Everything else — backwards, out of a terminal state, cancelled → anything
  // — needs the owner to say so on purpose.
  if (override) return { ok: true, from: a, to: b, override: true };
  return { ok: false, reason: 'not_allowed', from: a, to: b };
}

// ── templates the owner can edit ────────────────────────────

const DEFAULT_MESSAGES = {
  ready: {
    en: 'Good news {first_name} — order #{id} is ready. {eta_hint}',
    'roman-ur': '{first_name}, aap ka order #{id} tayyar hai. {eta_hint}',
    ur: '{first_name}، آپ کا آرڈر #{id} تیار ہے۔ {eta_hint}',
  },
  out_for_delivery: {
    en: 'Order #{id} is on its way to you, {first_name}. {eta_hint}',
    'roman-ur': '{first_name}, order #{id} raste mein hai. {eta_hint}',
    ur: '{first_name}، آرڈر #{id} راستے میں ہے۔ {eta_hint}',
  },
  delivered: {
    en: 'Order #{id} has been delivered. Thank you, {first_name}!',
    'roman-ur': 'Order #{id} deliver ho gaya. Shukriya, {first_name}!',
    ur: 'آرڈر #{id} ڈیلیور ہو گیا۔ شکریہ، {first_name}!',
  },
  payment_reminder: {
    en: 'A gentle reminder about order #{id} ({total}) — it is waiting for payment. Reply here if you need anything.',
    'roman-ur': 'Order #{id} ({total}) ki yaad dehani — payment ka intezar hai. Kuch chahiye to bataiye.',
    ur: 'آرڈر #{id} ({total}) کی یاد دہانی — ادائیگی کا انتظار ہے۔',
  },
};

/** The owner's own wording, when they wrote one. */
export function orderTemplate(state, lang = 'en') {
  const custom = profile()?.business?.orderMessages?.[state];
  if (typeof custom === 'string' && custom.trim()) return custom.trim();
  if (custom && typeof custom === 'object') {
    const byLang = custom[lang] || custom.en || Object.values(custom).find((v) => typeof v === 'string' && v.trim());
    if (byLang && String(byLang).trim()) return String(byLang).trim();
  }
  const defaults = DEFAULT_MESSAGES[state] || {};
  return defaults[lang] || defaults.en || '';
}

export function contactLanguage(number) {
  const contact = getContact(number);
  if (contact?.language) return contact.language;
  return 'en';
}

function firstNameOf(contact) {
  const raw = contact?.name || contact?.push_name || '';
  return String(raw).split(/\s+/)[0] || 'there';
}

const numberFromChat = (chat = '') => String(chat || '').split('@')[0].replace(/\D/g, '') || null;

/** Fill the placeholders. Nothing here invents a value that is not in the row. */
export function renderMessage(state, order, { lang = 'en', contact = null } = {}) {
  const template = orderTemplate(state, lang);
  const total = formatMoney(order?.total, order?.currency);
  const etaHint = order?.eta ? `ETA: ${order.eta}.` : '';
  return template
    .replace(/\{first_name\}/g, firstNameOf(contact))
    .replace(/\{name\}/g, contact?.name || contact?.push_name || '')
    .replace(/\{id\}/g, String(order?.id ?? ''))
    .replace(/\{status\}/g, statusLabel(order?.status))
    .replace(/\{total\}/g, total)
    .replace(/\{eta\}/g, order?.eta || '')
    .replace(/\{eta_hint\}/g, etaHint)
    .replace(/\{business\}/g, profile()?.business?.name || '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── the transition ──────────────────────────────────────────

/**
 * Move one order. Returns the outcome, never throws.
 *
 * `actor` is one of owner | bot | customer, and is stored with the transition:
 * "who says this happened" is the question people ask when an order goes wrong.
 */
export async function transitionOrder(id, to, { actor = 'owner', note = null, now = new Date(), override = false } = {}) {
  const order = getOrder(Number(id));
  if (!order) return { ok: false, reason: 'not_found', reply: `No order with id ${id}.` };

  const state = normaliseState(to);

  // A human confirms money. Not a model, not a receipt photo, not a customer
  // saying "I have paid" — the actor has to be the owner.
  if (state === 'paid' && actor !== 'owner') {
    return {
      ok: false,
      reason: 'owner_only',
      reply: `Only you can mark order #${order.id} paid (.paid ${order.id}).`,
      order,
    };
  }
  const check = canTransition(order.status, state, { override });
  if (!check.ok) {
    const why =
      check.reason === 'same_state'
        ? `Order #${order.id} is already ${statusLabel(state).toLowerCase()}.`
        : check.reason === 'unknown_state'
          ? `"${to}" is not an order status. One of: ${[...ORDER_STATES, 'cancelled', 'refunded'].join(', ')}.`
          : check.reason === 'paid_needs_payment_step'
        ? `Order #${order.id} is ${statusLabel(order.status).toLowerCase()} — ask for payment first (.status ${order.id} awaiting_payment), then .paid.`
      : `Order #${order.id} cannot go from ${statusLabel(order.status).toLowerCase()} to ${statusLabel(state).toLowerCase()} without an override.`;
    return { ok: false, reason: check.reason, reply: why, order };
  }

  setOrderStatus(order.id, state);
  logOrderEvent({
    orderId: order.id,
    from: order.status,
    to: state,
    actor,
    detail: note || (check.skip ? 'forward jump' : check.override ? 'override' : null),
  });
  logEvent('order_status', numberFromChat(order.chat), { id: order.id, from: order.status, to: state, actor });

  const updated = { ...order, status: state };

  // Delivered starts the review clock, exactly like `.done` would. One path per
  // outcome: the owner says delivered, the customer gets the review ask, not both.
  let review = null;
  if (state === 'delivered') {
    try {
      // Imported lazily so a plain order flow never pays for the review agent.
      const { scheduleAfterJob, reviewAgentEnabled } = await import('./reviewAgent.js');
      if (reviewAgentEnabled()) {
        review = scheduleAfterJob({ number: numberFromChat(order.chat), kind: 'order', refId: order.id, now });
      }
    } catch {
      /* a missing review ask must not undo a delivery */
    }
  }

  return { ok: true, order: updated, from: order.status, to: state, skipped: Boolean(check.skip), review };
}

// ── telling the customer ────────────────────────────────────

const NOTIFY_STATES = new Set(['ready', 'out_for_delivery', 'delivered']);
const NOTIFY_AGENT = 'order';
export const NOTIFY_AGENT_NAME = NOTIFY_AGENT;

/**
 * Send the customer a short status message — if the customer may be messaged at
 * all. Every gate lives in growth.js: opt-out, quiet hours, daily cap, and the
 * Cloud API's template rule outside 24 hours.
 */
export async function notifyCustomer(transport, order, state = order?.status, { now = new Date(), lang = null } = {}) {
  if (!orderTrackingEnabled()) return { sent: false, reason: 'disabled' };
  if (!NOTIFY_STATES.has(state)) return { sent: false, reason: 'not_notifiable' };

  const number = numberFromChat(order.chat);
  if (!number) return { sent: false, reason: 'no_number' };
  if (!transport) return { sent: false, reason: 'no_transport' };

  const contact = getContact(number);
  const language = lang || contact?.language || 'en';
  const text = renderMessage(state, order, { lang: language, contact });
  if (!text) return { sent: false, reason: 'no_template' };

  let outcome;
  try {
    outcome = await sendProactively({
      transport,
      number,
      text,
      agent: NOTIFY_AGENT,
      reason: `order:${state}`,
      now,
    // An order update is transactional — it is the customer's own order — so
    // the one-a-day marketing cap does not apply. Opt-out, quiet hours and the
    // global ceiling still do.
      transactional: true,
    });
  } catch (err) {
    // A status change must never fail because the customer could not be told.
    logEvent('order_notify_skipped', number, { id: order.id, state, reason: err.message });
    return { sent: false, reason: 'error', error: err.message };
  }

  logEvent(outcome.sent ? 'order_notified' : 'order_notify_skipped', number, {
    id: order.id,
    state,
    reason: outcome.reason || 'sent',
  });
  return outcome;
}

// ── "where is my order?" ────────────────────────────────────

const ORDER_QUESTION = [
  /\b(where('s| is)?|what('s| is)?( the)? status( of)?|status of|track|tracking|kahan|kidhar|kaha hai|kab (aayega|ayega|hoga))\b[^.?!]{0,40}\b(order|parcel|delivery|package|saman|order)\b/i,
  /\b(order|parcel|delivery|package|saman)\b[^.?!]{0,30}\b(kahan|kidhar|kaha|status|kab (aayega|ayega)|track)/i,
  /\b(order|parcel)\s*(ka|ki)\s*status\b/i,
  /\bmera\s+(order|parcel|saman)\b[^.?!]{0,25}\b(kahan|kab|status|kidhar)/i,
  /(آرڈر|پارسل|ڈیلیوری)[^.?!]{0,20}(کہاں|کب|اسٹیٹس|حالت)/,
  /\bstatus\b[^.?!]{0,20}\b(order|parcel|delivery)\b/i,
];

/** Is this message asking about an order? */
export function isOrderQuestion(text = '') {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 240) return false;
  return ORDER_QUESTION.some((re) => re.test(clean));
}

/**
 * The answer to "where is my order?", built from the row and nothing else.
 * Null means "no order for this chat" — the caller decides whether to ask for
 * details or hand off.
 */
export function orderStatusAnswer(number, { lang = null } = {}) {
  const chat = String(number || '').includes('@') ? String(number) : `${String(number || '').replace(/\D/g, '')}@s.whatsapp.net`;
  const row = orderFor(chat) || orderFor(String(chat).split('@')[0]);
  if (!row) return null;

  const order = { ...row, items: typeof row.items === 'string' ? safeItems(row.items) : row.items || [] };
  const language = lang || getContact(String(chat).split('@')[0])?.language || 'en';
  const state = statusLabel(order.status).toLowerCase();
  const eta = order.eta ? (language === 'ur' ? `متوقع وقت: ${order.eta}۔` : language === 'roman-ur' ? `Andaza: ${order.eta}.` : `ETA: ${order.eta}.`) : '';

  if (language === 'ur') {
    return `آپ کا آرڈر #${order.id} اس وقت *${state}* ہے۔ ${eta}`.trim();
  }
  if (language === 'roman-ur') {
    return `Aap ka order #${order.id} abhi *${state}* hai. ${eta}`.trim();
  }
  return `Order #${order.id} is currently *${state}*. ${eta}`.trim();
}

function safeItems(raw) {
  try {
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

// ── the owner's view ────────────────────────────────────────

export function openOrders(limit = 20) {
  const rows = ordersWithStatus(['placed', 'awaiting_payment', 'paid', 'preparing', 'ready', 'out_for_delivery'], limit);
  return rows.map((row) => ({ ...row, items: safeItems(row.items) }));
}

export function orderDetail(id) {
  const order = getOrder(Number(id));
  if (!order) return null;
  return { ...order, events: orderEvents(order.id) };
}

export function orderSummaryText(order) {
  const items = (order.items || []).map((i) => `${i.qty}× ${i.name}`).join(', ');
  const lines = [
    `*Order #${order.id}* — ${statusLabel(order.status)}`,
    `Total: ${formatMoney(order.total, order.currency)}`,
    items ? `Items: ${items}` : null,
    order.name ? `Name: ${order.name}` : null,
    order.phone ? `Phone: ${order.phone}` : null,
    order.address ? `Address: ${order.address}` : null,
    order.eta ? `ETA: ${order.eta}` : null,
    `Placed: ${new Date(order.created_at).toLocaleString('en-GB', { timeZone: config.timezone })}`,
  ].filter(Boolean);

  const events = order.events || orderEvents(order.id);
  if (events.length) {
    lines.push('');
    lines.push('History:');
    for (const event of events.slice(-8)) {
      const when = new Date(event.created_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short', timeZone: config.timezone });
      const who = event.actor || 'owner';
      const fromLabel = event.from_status ? statusLabel(event.from_status) : '—';
      const toLabel = event.to_status ? statusLabel(event.to_status) : '—';
      lines.push(`• ${when} ${fromLabel} → ${toLabel} (${who})${event.detail ? ` · ${event.detail}` : ''}`);
    }
  }
  return lines.join('\n');
}

// ── payment reminders ───────────────────────────────────────

export function reminderSettings() {
  const orders = profile()?.business?.orderReminders || {};
  const first = Number(process.env.ORDER_REMINDER_HOURS ?? orders.firstHours ?? 12);
  const second = Number(process.env.ORDER_REMINDER_SECOND_HOURS ?? orders.secondHours ?? 36);
  return {
    firstHours: Number.isFinite(first) && first > 0 ? first : 12,
    secondHours: Number.isFinite(second) && second > 0 ? second : Math.max(24, first * 3),
  };
}

function approvalRequired() {
  // Same switch the follow-up agent uses: drafts wait for the owner unless they
  // turned growthApproval off.
  return featureOn('growthApproval');
}

/**
 * One reminder, then one more, then silence and a note to the owner.
 * Called by the loop and directly by tests with a fake clock.
 */
export async function runPaymentReminders({ transport = null, now = new Date() } = {}) {
  if (!orderTrackingEnabled()) return { sent: 0, drafted: 0, escalated: 0, skipped: 0 };
  const { firstHours, secondHours } = reminderSettings();
  const rows = ordersWithStatus(['awaiting_payment'], 100);
  const result = { sent: 0, drafted: 0, escalated: 0, skipped: 0 };

  for (const order of rows) {
    const ageHours = (now.getTime() - new Date(order.created_at).getTime()) / 3_600_000;
    const sent = countOrderReminders(order.id);
    const number = numberFromChat(order.chat);
    if (!number) continue;

    // Stage 1, then stage 2, then stop.
    const stage = sent === 0 && ageHours >= firstHours ? 1 : sent === 1 && ageHours >= secondHours ? 2 : 0;
    if (!stage) {
      if (sent >= 2 && ageHours >= secondHours) {
        // Already reminded twice: the owner is told once, and then we stop.
        const told = orderEvents(order.id).some((e) => e.detail === 'reminder:stop');
        if (!told) {
          logOrderEvent({ orderId: order.id, from: order.status, to: order.status, actor: 'bot', detail: 'reminder:stop' });
          logEvent('order_reminder_gave_up', number, { id: order.id });
          if (transport) {
            await sendToOwner({
              transport,
              text: `💤 Order #${order.id} (+${number}) is still unpaid after ${Math.round(ageHours)}h and two reminders. I have stopped asking — it is your call now.`,
              agent: 'order',
              reason: 'unpaid order escalated',
              now,
            });
          }
          result.escalated += 1;
        }
      }
      continue;
    }

    const contact = getContact(number);
    const lang = contact?.language || 'en';
    const text = renderMessage('payment_reminder', order, { lang, contact });

    if (approvalRequired()) {
      const existing = pendingDraftFor(number, NOTIFY_AGENT);
      if (existing) {
        result.skipped += 1;
        continue;
      }
      addDraft({
        number,
        agent: NOTIFY_AGENT,
        kind: `payment_reminder_${stage}`,
        text,
        reason: `order #${order.id} unpaid ${Math.round(ageHours)}h`,
        dueAt: now.toISOString(),
      });
      logOrderEvent({ orderId: order.id, from: order.status, to: order.status, actor: 'bot', detail: `reminder:${stage}:draft` });
      result.drafted += 1;
      continue;
    }

    if (!transport) {
      result.skipped += 1;
      continue;
    }

    const outcome = await sendProactively({
      transport,
      number,
      text,
      agent: NOTIFY_AGENT,
      reason: `payment reminder ${stage}`,
      now,
      transactional: true,
    });
    if (outcome.sent) {
      logOrderEvent({ orderId: order.id, from: order.status, to: order.status, actor: 'bot', detail: `reminder:${stage}` });
      result.sent += 1;
    } else {
      result.skipped += 1;
      logEvent('order_reminder_skipped', number, { id: order.id, reason: outcome.reason });
    }
  }

  return result;
}

/**
 * The last few order messages growth.js refused to send, with the reason it gave
 * (opted out, quiet hours, no approved template outside the 24-hour window).
 * Read-only: `.growth` shows these so "the customer was never told" has an answer.
 */
export function recentOrderSkips(limit = 5) {
  return recentEvents(80)
    .filter((row) => (row.type === 'order_notify_skipped' || row.type === 'order_reminder_skipped') && row.number)
    .slice(0, Math.max(1, limit))
    .map((row) => {
      let detail = null;
      try {
        detail = row.detail ? JSON.parse(row.detail) : null;
      } catch {
        detail = { raw: row.detail };
      }
      return { number: row.number, reason: detail?.reason || 'held', detail, at: row.created_at };
    });
}

/**
 * A one-screen summary for `.growth` and the doctor: how much chasing is going on.
 * Counts only — no message bodies leave the database for this.
 */
export function reminderStats() {
  const open = ordersWithStatus(['awaiting_payment'], 500);
  let remindedOnce = 0;
  let stopped = 0;
  for (const order of open) {
    const sent = countOrderReminders(order.id);
    if (sent === 1) remindedOnce += 1;
    if (orderEvents(order.id).some((e) => e.detail === 'reminder:stop')) stopped += 1;
  }
  return { awaitingPayment: open.length, remindedOnce, stopped };
}

// ── the loop ────────────────────────────────────────────────

let timer = null;

export function startOrderLoop(opts = {}, extra = {}) {
  // Accepts { transport } like the other loops and a bare transport like the
  // booking loop — callers should not have to remember which is which.
  const bare = opts && typeof opts.sendMessage === 'function' ? opts : null;
  const { transport = bare, intervalMs = 30 * 60_000, onError = null } = bare ? extra : opts;
  if (timer) return timer;
  if (!orderTrackingEnabled()) return null;
  timer = setInterval(() => {
    runPaymentReminders({ transport, now: new Date() }).catch((err) => {
      if (onError) onError(err);
    });
    // Owner decisions ride the same tick: reminders, escalation and the honest
    // dues. Off (both flags false) this import resolves to a function that does
    // nothing, so the old loop's behaviour is unchanged.
    import('./paymentReview.js')
      .then(({ runPaymentReview }) => runPaymentReview({ transport, now: new Date() }))
      .catch((err) => {
        if (onError) onError(err);
      });
  }, Math.max(60_000, intervalMs));
  timer.unref?.();
  return timer;
}

export function stopOrderLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ── hooks from the rest of the bot ──────────────────────────

/** An order row appeared: log it and let the CRM learn from it. */
export async function onOrderPlaced(order, { now = new Date() } = {}) {
  if (!order?.id) return;
  logOrderEvent({ orderId: order.id, from: null, to: order.status || 'placed', actor: 'bot', detail: 'created' });
  try {
    const { applyAutoTags } = await import('./crm.js');
    applyAutoTags(numberFromChat(order.chat), { now });
  } catch {
    /* tagging is never allowed to block an order */
  }
}

export { numberFromChat };

export default {
  ORDER_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  statusLabel,
  normaliseState,
  isOrderState,
  canTransition,
  transitionOrder,
  notifyCustomer,
  isOrderQuestion,
  orderStatusAnswer,
  openOrders,
  orderDetail,
  orderSummaryText,
  renderMessage,
  orderTemplate,
  reminderSettings,
  reminderStats,
  recentOrderSkips,
  runPaymentReminders,
  startOrderLoop,
  stopOrderLoop,
  onOrderPlaced,
  orderTrackingEnabled,
  numberFromChat,
};
