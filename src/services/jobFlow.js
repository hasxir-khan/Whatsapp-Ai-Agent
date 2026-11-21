// src/services/jobFlow.js
// The join between the owner's two words and the review agent's timer.
//
// `.done 12` means "this job is finished". Only the owner can say it, because
// only the owner knows whether the table was served or the parcel arrived. That
// one command is what starts the review clock — no guessing from timestamps.

import { getBooking, getOrder, setBookingStatus, setOrderStatus, logEvent, logOrderEvent } from '../utils/db.js';
import { reviewAgentEnabled, scheduleAfterJob, askDelayHours } from './reviewAgent.js';
import { formatMoney } from './geo.js';

function numberOf(chat = '') {
  return String(chat || '').split('@')[0].replace(/\D/g, '') || null;
}

/**
 * Mark a booking or an order finished and queue the feedback ask.
 * @param {{id:number, kind?:'booking'|'order'|null, now?:Date}} opts
 */
export function finishJob({ id, kind = null, now = new Date() } = {}) {
  const booking = kind === 'order' ? null : getBooking(Number(id));
  const order = kind === 'booking' ? null : getOrder(Number(id));

  if (booking && (!order || kind === 'booking')) {
    if (['cancelled', 'no_show'].includes(booking.status)) {
      return { ok: false, reply: `Booking #${id} is ${booking.status} — nothing to review.` };
    }
    setBookingStatus(booking.id, 'done');
    logEvent('job_done', numberOf(booking.chat), { kind: 'booking', id: booking.id });
    const ask = reviewAgentEnabled()
      ? scheduleAfterJob({ number: numberOf(booking.chat), kind: 'booking', refId: booking.id, now })
      : null;
    return {
      ok: true,
      reply:
        `✅ Booking #${booking.id} (${booking.service}, ${booking.date} ${booking.time}) marked done.` +
        (ask
          ? `\nFeedback will be asked in ${askDelayHours()}h.`
          : '\n(Turn on features.reviewAgent to ask for feedback automatically.)'),
    };
  }

  if (order) {
    setOrderStatus(order.id, 'delivered');
    logEvent('job_done', numberOf(order.chat), { kind: 'order', id: order.id });
    const ask = reviewAgentEnabled()
      ? scheduleAfterJob({ number: numberOf(order.chat), kind: 'order', refId: order.id, now })
      : null;
    return {
      ok: true,
      reply:
        `✅ Order #${order.id} (${formatMoney(order.total, order.currency)}) marked delivered.` +
        (ask ? `\nFeedback will be asked in ${askDelayHours()}h.` : ''),
    };
  }

  return { ok: false, reply: `No booking or order with id ${id}. Check .bookings.` };
}

/**
 * The owner confirms the money is really in. This is the *only* path to a paid
 * order — a screenshot the customer sent is a claim, not a payment.
 */
export function markOrderPaid(id) {
  const order = getOrder(Number(id));
  if (!order) return { ok: false, reply: `No order with id ${id}.` };
  if (order.status === 'paid') return { ok: true, reply: `Order #${id} is already marked paid.` };
  setOrderStatus(order.id, 'paid');
  // The same command the lifecycle uses, written to the timeline as an owner act
  // so "who said this was paid" has an answer that is not a guess.
  logOrderEvent({
    orderId: order.id,
    from: order.status,
    to: 'paid',
    actor: 'owner',
    detail: order.status === 'awaiting_payment' ? null : 'override: .paid',
  });
  logEvent('order_paid', numberOf(order.chat), { id: order.id, total: order.total });
  return {
    ok: true,
    reply: `💰 Order #${order.id} marked paid (${formatMoney(order.total, order.currency)}).\nUse .done ${order.id} when it has been delivered to start the review flow.`,
  };
}

export default { finishJob, markOrderPaid };
