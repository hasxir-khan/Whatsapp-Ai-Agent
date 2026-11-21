/**
 * The decision engine — one place where a human answers a question the AI is
 * not allowed to answer.
 *
 * Rules the code enforces, not just the prompt:
 *   • the first decision wins; a second attempt is refused and told what the
 *     current state is, so two teammates never double-answer a payment;
 *   • events are append-only — a decision is never edited, only superseded by a
 *     new event, so "who said this and when" has one answer;
 *   • only an admin may reverse a decision, and only with a reason that is
 *     written into the same history;
 *   • payment requests are resolved by a person. Nothing in this file accepts
 *     money on its own.
 */
import {
  run,
  all,
  get,
  logEvent,
  logOrderEvent,
  getOrder,
  setOrderStatus,
  setOrderPaidAmount,
} from '../utils/db.js';
import { config } from '../config/env.js';
import { formatMoney } from './geo.js';
// `.paid` stays the only path that turns an order into a paid one; a decision
// reuses it rather than writing the status itself.
import { markOrderPaid } from './jobFlow.js';
import {
  DECISION_TYPES,
  READY_TYPES,
  decisionSettings,
  canDecide,
  chainFor,
  memberFor,
  normalizeMemberNumber,
} from './decisionTeam.js';

export const STATUSES = ['pending', 'accepted', 'rejected', 'partial', 'recheck', 'escalated', 'expired', 'reversed'];
export const OPEN_STATUSES = ['pending', 'recheck', 'escalated'];

const iso = (d) => (d instanceof Date ? d : new Date(d || Date.now())).toISOString();
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const safeJson = (raw, fallback = null) => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

/** `DR-12` — readable in a WhatsApp card, easy to type back. */
function nextId() {
  const row = get('SELECT COUNT(*) AS n FROM decision_requests');
  let n = Number(row?.n || 0) + 1;
  for (let i = 0; i < 1000; i += 1) {
    const id = `DR-${n + i}`;
    if (!get('SELECT id FROM decision_requests WHERE id = ?', [id])) return id;
  }
  return `DR-${Date.now()}`;
}

/** Accept `DR-12`, `dr12` or `12`. */
export function normalizeDecisionId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = /^(?:dr[\s-]*)?(\d+)$/i.exec(s);
  if (m) return `DR-${m[1]}`;
  return /^DR-\d+$/.test(s) ? s : s;
}

export function getDecision(id) {
  const key = normalizeDecisionId(id);
  if (!key) return null;
  const row = get('SELECT * FROM decision_requests WHERE id = ?', [key]);
  return row ? hydrate(row) : null;
}

function hydrate(row) {
  return {
    ...row,
    payload: safeJson(row.payload, {}),
    chain: safeJson(row.chain, []),
    customer_notified: Number(row.customer_notified) === 1,
    open: OPEN_STATUSES.includes(row.status),
  };
}

export function decisionEvents(id) {
  return all('SELECT * FROM decision_events WHERE request_id = ? ORDER BY id ASC', [normalizeDecisionId(id)]).map((e) => ({
    ...e,
    detail: safeJson(e.detail, null),
  }));
}

function record(requestId, { actor, kind, fromStatus = null, toStatus = null, reasonCode = null, reasonText = null, detail = null, now }) {
  run(
    `INSERT INTO decision_events (request_id, actor, kind, from_status, to_status, reason_code, reason_text, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [normalizeDecisionId(requestId), String(actor || ''), kind, fromStatus, toStatus, reasonCode, reasonText, detail ? JSON.stringify(detail) : null, iso(now)]
  );
}

/** Open decisions for a customer, oldest first. */
export function openDecisionsFor(contact) {
  const n = String(contact || '').replace(/\D/g, '');
  if (!n) return [];
  return all(
    `SELECT * FROM decision_requests WHERE contact = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})
     ORDER BY created_at ASC`,
    [n, ...OPEN_STATUSES]
  ).map(hydrate);
}

/** The pending decision for an order, if there is one. */
export function openDecisionForOrder(orderId) {
  const row = get(
    `SELECT * FROM decision_requests WHERE order_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})
     ORDER BY created_at DESC LIMIT 1`,
    [Number(orderId), ...OPEN_STATUSES]
  );
  return row ? hydrate(row) : null;
}

/** Everything a dashboard or `.decisions` needs, newest first. */
export function listDecisions({ status = null, contact = null, type = null, limit = 20 } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push(`status = ?`);
    params.push(status);
  }
  if (contact) {
    where.push('contact = ?');
    params.push(String(contact).replace(/\D/g, ''));
  }
  if (type) {
    where.push('type = ?');
    params.push(type);
  }
  const sql = `SELECT * FROM decision_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`;
  return all(sql, [...params, Math.max(1, Math.min(200, Number(limit) || 20))]).map(hydrate);
}

/**
 * Open a request. The chain is snapshotted onto the row so a later settings
 * change cannot silently re-route a decision that is already waiting.
 */
export function openDecision({
  type = 'other',
  contact,
  orderId = null,
  payload = {},
  now = new Date(),
  deadlineMinutes = null,
  chain = null,
  actor = 'ai',
  enabled = null,
} = {}) {
  const kind = String(type).toLowerCase();
  if (!DECISION_TYPES.includes(kind)) return { ok: false, error: `unknown decision type "${type}"` };
  const settings = decisionSettings();
  const allowed = enabled || settings.enabledTypes;
  if (!allowed.includes(kind)) return { ok: false, error: `decisions of type ${kind} are not enabled` };

  const number = String(contact || '').replace(/\D/g, '');
  if (!number) return { ok: false, error: 'a decision needs a customer number' };

  const steps = chain || chainFor(kind);
  const first = steps[0]?.who || 'owner';
  const id = nextId();
  const created = iso(now);
  const deadline = deadlineMinutes
    ? iso(new Date(new Date(now).getTime() + Number(deadlineMinutes) * 60_000))
    : iso(new Date(new Date(now).getTime() + (steps[steps.length - 1]?.afterMinutes || 180) * 60_000 + 24 * 3600_000));

  run(
    `INSERT INTO decision_requests
       (id, tenant, type, contact, order_id, payload, status, created_at, deadline_at, step, chain, assignee, customer_notified, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?, 0, ?)`,
    [id, config.tenant?.slug || null, kind, number, orderId === null ? null : Number(orderId), JSON.stringify(payload || {}), created, deadline, JSON.stringify(steps), String(first), created]
  );
  record(id, { actor, kind: 'opened', toStatus: 'pending', detail: { type: kind, orderId, assignee: first }, now });
  logEvent('decision_opened', number, { id, type: kind, orderId });
  return { ok: true, decision: getDecision(id) };
}

/**
 * Resolve a request. `action` is one of accepted/rejected/partial/recheck/
 * escalated/expired. Anyone else in the chain is told who handled it.
 */
export function decide({
  id,
  actor,
  action,
  amount = null,
  reasonCode = null,
  reasonText = null,
  now = new Date(),
} = {}) {
  const decision = getDecision(id);
  if (!decision) return { ok: false, error: `no decision ${id}` };
  const act = String(action || '').toLowerCase();
  if (!['accepted', 'rejected', 'partial', 'recheck', 'escalated', 'expired'].includes(act)) {
    return { ok: false, error: `unknown action "${action}"` };
  }
  if (!decision.open) {
    return {
      ok: false,
      error: 'already_decided',
      decision,
      handledBy: decision.resolved_by,
      reply: alreadyHandledText(decision),
    };
  }
  if (!canDecide(actor, decision.type)) {
    return { ok: false, error: 'not_allowed', decision, reply: notAllowedText(decision) };
  }
  // A recheck is a fresh clock on the same question, not a decision: it is
  // allowed to be set more than once, but still only by the same people.
  const terminal = act !== 'recheck' && act !== 'escalated';

  const partialAmount = act === 'partial' ? Math.max(0, Math.round(Number(amount) || 0)) : null;
  if (act === 'partial' && !(partialAmount > 0)) {
    return { ok: false, error: 'amount_required', decision, reply: 'How much did they actually pay? .partial ' + decision.id + ' 5000' };
  }
  if (act === 'rejected' && !reasonCode) {
    return { ok: false, error: 'reason_required', decision, reply: `Why? .reject ${decision.id} 1 (see .reject ${decision.id} for the list)` };
  }

  const status = act;
  run(
    `UPDATE decision_requests
        SET status = ?, resolved_at = ?, resolved_by = ?, reason_code = ?, reason_text = ?, step = ?, assignee = ?, updated_at = ?
      WHERE id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`,
    [status, terminal ? iso(now) : null, String(actor || ''), reasonCode, reasonText, decision.step, String(actor || ''), iso(now), decision.id, ...OPEN_STATUSES]
  );
  const after = getDecision(decision.id);
  if (terminal && after && after.open) {
    // Someone else wrote first between our read and write; the WHERE clause is
    // the lock, and the loser is told the truth instead of overwriting it.
    return { ok: false, error: 'already_decided', decision: after, handledBy: after.resolved_by, reply: alreadyHandledText(after) };
  }
  record(decision.id, {
    actor,
    kind: terminal ? 'decided' : act === 'recheck' ? 'recheck' : 'escalated',
    fromStatus: decision.status,
    toStatus: status,
    reasonCode,
    reasonText,
    detail: { amount: partialAmount },
    now,
  });
  logEvent(`decision_${status}`, decision.contact, { id: decision.id, type: decision.type, orderId: decision.order_id });

  // The money movement goes through the existing owner path — `.paid` is still
  // the only thing that turns an order into a paid one.
  let orderResult = null;
  if (decision.type === 'payment' && decision.order_id) {
    const order = getOrder(decision.order_id);
    if (order) {
      if (act === 'accepted') {
        const total = Number(order.total) || 0;
        const paid = Math.max(Number(order.paid_amount) || 0, total);
        setOrderPaidAmount(order.id, paid);
        orderResult = markOrderPaid(order.id);
      } else if (act === 'partial') {
        const paid = Math.max(Number(order.paid_amount) || 0, Math.min(partialAmount, Number(order.total) || partialAmount));
        setOrderPaidAmount(order.id, paid);
        logOrderEvent({ orderId: order.id, from: order.status, to: order.status, actor: String(actor || ''), detail: `partial payment ${formatMoney(paid, order.currency)} of ${formatMoney(order.total, order.currency)}` });
        orderResult = { ok: true, reply: `Order #${order.id}: ${formatMoney(paid, order.currency)} recorded, ${formatMoney(Math.max(0, (Number(order.total) || 0) - paid), order.currency)} still due.` };
      } else if (act === 'rejected') {
        logOrderEvent({ orderId: order.id, from: order.status, to: order.status, actor: String(actor || ''), detail: `payment not confirmed: ${reasonCode}` });
      }
    }
  }

  // A cancellation that is accepted closes the order; reject leaves it alone.
  if (decision.type === 'cancellation' && decision.order_id && act === 'accepted') {
    const order = getOrder(decision.order_id);
    if (order && !['paid', 'cancelled', 'delivered', 'completed'].includes(order.status)) {
      setOrderStatus(order.id, 'cancelled');
      logOrderEvent({ orderId: order.id, from: order.status, to: 'cancelled', actor: String(actor || ''), detail: `decision ${decision.id}` });
      orderResult = { ok: true, reply: `Order #${order.id} cancelled.` };
    }
  }

  // A reversal is the only edit-like act, and it is a new row, never a change.
  return {
    ok: true,
    decision: after,
    order: orderResult,
  };
}

export function alreadyHandledText(decision) {
  const who = decision.resolved_by ? `+${decision.resolved_by}` : 'someone else';
  const reason = decision.reason_code ? ` (${decision.reason_code})` : '';
  return `${decision.id} is already ${decision.status} by ${who}${reason}. Nothing changed.`;
}

function notAllowedText(decision) {
  const role = decision.type === 'payment' || decision.type === 'refund' ? 'payments' : decision.type === 'discount_above_cap' ? 'discounts' : 'chat';
  return `Only the owner or a teammate with the "${role}" role can answer ${decision.type} requests.`;
}

/**
 * Reverse a decision. Admin only — the owner, or a member holding `admin` — and
 * a reason is mandatory. The reversal is a new event; the original stays.
 */
export function reverseDecision({ id, actor, reason, now = new Date() } = {}) {
  const decision = getDecision(id);
  if (!decision) return { ok: false, error: `no decision ${id}`, reply: `No decision ${id}.` };
  const admin = String(actor || '').replace(/\D/g, '') === normalizeMemberNumber(config.owner?.number) ||
    Boolean(memberFor(actor)?.roles?.includes('admin'));
  if (!admin) return { ok: false, error: 'not_allowed', reply: 'Only an admin (the owner, or a member with the admin role) can reverse a decision.' };
  if (!['accepted', 'rejected', 'partial', 'expired'].includes(decision.status)) {
    return { ok: false, error: 'not_reversible', decision, reply: `${decision.id} is ${decision.status}; there is nothing to reverse.` };
  }
  const text = String(reason || '').trim();
  if (text.length < 4) return { ok: false, error: 'reason_required', reply: `A reversal needs a reason: .reverse ${decision.id} <why>` };

  run('UPDATE decision_requests SET status = ?, reason_text = ?, updated_at = ? WHERE id = ?', ['reversed', text, iso(now), decision.id]);
  record(decision.id, {
    actor,
    kind: 'reversed',
    fromStatus: decision.status,
    toStatus: 'reversed',
    reasonText: text,
    now,
  });
  logEvent('decision_reversed', decision.contact, { id: decision.id, type: decision.type });

  // Undo the money side of an acceptance: the order goes back to waiting, with
  // a note that says why, so the books match reality.
  if (decision.type === 'payment' && decision.order_id && ['accepted', 'partial'].includes(decision.status)) {
    const order = getOrder(decision.order_id);
    if (order && ['paid', 'awaiting_payment'].includes(order.status)) {
      setOrderPaidAmount(order.id, 0);
      if (order.status === 'paid') setOrderStatus(order.id, 'awaiting_payment');
      logOrderEvent({ orderId: order.id, from: order.status, to: 'awaiting_payment', actor: String(actor || ''), detail: `decision ${decision.id} reversed: ${text}` });
    }
  }
  return { ok: true, decision: getDecision(decision.id), reply: `${decision.id} reversed (${decision.status} → reversed). The reason is in the history.` };
}

/**
 * Move a pending request to the next person on the chain. Called by the
 * follow-up loop when the owner's reminder ladder runs out.
 */
export function escalate({ id, now = new Date(), actor = 'system', reason = 'no decision in time' } = {}) {
  const decision = getDecision(id);
  if (!decision || !decision.open) return { ok: false, error: 'not_open', decision };
  const nextIndex = Math.min(decision.chain.length - 1, Number(decision.step || 0) + 1);
  const next = decision.chain[nextIndex];
  if (!next || (nextIndex === Number(decision.step || 0) && next.who === decision.assignee)) {
    return { ok: false, error: 'chain_end', decision };
  }
  run('UPDATE decision_requests SET status = ?, step = ?, assignee = ?, updated_at = ? WHERE id = ?', ['escalated', nextIndex, String(next.who), iso(now), decision.id]);
  const after = getDecision(decision.id);
  record(decision.id, { actor, kind: 'escalated', fromStatus: decision.status, toStatus: 'escalated', detail: { assignee: next.who, reason }, reasonText: reason, now });
  logEvent('decision_escalated', decision.contact, { id: decision.id, to: next.who });
  return { ok: true, decision: after, assignee: next.who };
}

/** Anything past its deadline becomes expired — the customer is told honestly. */
export function expireDecisions({ now = new Date() } = {}) {
  const rows = all("SELECT * FROM decision_requests WHERE status IN ('pending','recheck','escalated') AND deadline_at IS NOT NULL AND deadline_at <= ?", [iso(now)]);
  const expired = [];
  for (const row of rows) {
    run("UPDATE decision_requests SET status = 'expired', resolved_at = ?, updated_at = ? WHERE id = ?", [iso(now), iso(now), row.id]);
    record(row.id, { actor: 'system', kind: 'expired', fromStatus: row.status, toStatus: 'expired', now });
    expired.push(getDecision(row.id));
  }
  if (expired.length) logEvent('decisions_expired', null, { count: expired.length });
  return expired;
}

/** A pending decision is an active order context: this is what the handler asks. */
export function awaitingDecisionFor(contact, { type = null } = {}) {
  const list = openDecisionsFor(contact);
  return list.find((d) => !type || d.type === type) || null;
}

export { READY_TYPES, DECISION_TYPES };

export default {
  STATUSES,
  OPEN_STATUSES,
  normalizeDecisionId,
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
  alreadyHandledText,
  READY_TYPES,
  DECISION_TYPES,
};
