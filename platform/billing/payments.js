import { randomUUID } from 'node:crypto';
import { all, get, run, billingTransaction as transaction } from '../db.js';
import { recordAudit } from './audit.js';
import { latest, version, settings } from './catalog.js';
import { entitlementsFor, subscription, addEvent, recordState, queue, opsReasons } from './subscriptions.js';
import { stamp, need, minor, totals, bounded, choice, money } from './rules.js';
import { REASON_CODES, REASON_MESSAGES } from '../../src/services/paymentReview.js';
import { renderInvoicePDF } from '../../src/services/invoice.js';

export const uuid = (s) =>
  typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
function sequence(kind, now) {
  const year = stamp(now).slice(0, 4);
  run('INSERT INTO b_sequence VALUES(?,?,1) ON CONFLICT(year,kind) DO UPDATE SET last=last+1', [year, kind]);
  return `${kind}-${year}-${String(get('SELECT last FROM b_sequence WHERE year=? AND kind=?', [year, kind]).last).padStart(6, '0')}`;
}
export function invoice(slug, id) {
  const i = get('SELECT i.* FROM b_invoice i JOIN b_sub s ON i.sid=s.sid WHERE s.slug=? AND i.id=?', [
    slug,
    id,
  ]);
  need(i, 'not_found', 404);
  const paid = get('SELECT COALESCE(sum(amount),0) n FROM b_confirmed WHERE invoice=?', [i.id]).n;
  return { ...i, ...(i.total === null ? { paid: 0, due: null } : totals(i.subtotal, i.tax_bps, paid)) };
}
export function paymentCard(slug, id) {
  const p = get(
    'SELECT p.* FROM b_card p JOIN b_invoice i ON i.id=p.invoice JOIN b_sub s ON s.sid=i.sid WHERE s.slug=? AND p.id=?',
    [slug, id]
  );
  need(p, 'not_found', 404);
  return p;
}
export function checkout(slug, input, now = Date.now()) {
  const { months, requestId } = input;
  need(uuid(requestId), 'invalid_request_id');
  return transaction(() => {
    const s = subscription(slug);
    need(s, 'not_found', 404);
    const existing = get('SELECT id FROM b_invoice WHERE sid=? AND request_id=?', [s.sid, requestId]);
    if (existing) return invoice(slug, existing.id);
    const cfg = settings(),
      v = version(input.version),
      e = entitlementsFor(slug, now);
    need(cfg.methods.length, 'payment_instructions_missing', 409);
    need(
      v && v.offered && v.plan !== 'free' && latest(v.plan).version === v.version,
      'plan_not_offered',
      409
    );
    bounded(months, 1, 36);
    need(v.offers[months], 'duration_not_offered');
    need(!e.canceling || !e.canRun, 'resume_before_payment', 409);
    const inTerm = e.hasTerm && e.end > stamp(now),
      kind = inTerm && v.rank > e.rank ? 'upgrade' : 'term';
    if (inTerm && v.rank < e.rank) need(e.next?.version === v.version, 'schedule_downgrade_first', 409);
    const price = kind === 'upgrade' ? null : v.offers[months],
      id = randomUUID(),
      ref = 'PAY-' + randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase();
    run(
      'INSERT INTO b_invoice(id,sid,version,months,kind,ref,currency,subtotal,tax_bps,tax_label,total,invoice_no,quote_no,at,request_id,basis,methods) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        s.sid,
        v.version,
        months,
        kind,
        ref,
        v.currency,
        price,
        cfg.taxBps,
        cfg.taxLabel,
        price === null ? null : totals(price, cfg.taxBps).total,
        price === null ? null : sequence('INV', now),
        price === null ? sequence('QUO', now) : null,
        stamp(now),
        requestId,
        kind === 'upgrade' ? `${e.version}:${e.end}` : null,
        JSON.stringify(cfg.methods),
      ]
    );
    recordAudit({ action: 'billing_checkout', tenant: slug, detail: { object: id } });
    return invoice(slug, id);
  });
}
export function priceUpgrade(slug, id, input, now = Date.now()) {
  return transaction(() => {
    const i = invoice(slug, id),
      e = entitlementsFor(slug, now);
    need(i.kind === 'upgrade' && i.total === null, 'already_priced', 409);
    need(i.basis === `${e.version}:${e.end}` && e.end > stamp(now), 'quote_expired', 409);
    const price = minor(input.difference);
    need(price > 0, 'positive_difference_required');
    run('UPDATE b_invoice SET subtotal=?,total=?,invoice_no=? WHERE id=?', [
      price,
      totals(price, i.tax_bps).total,
      sequence('INV', now),
      id,
    ]);
    recordAudit({ action: 'billing_upgrade_priced', tenant: slug });
    return invoice(slug, id);
  });
}
// Internal command: caller must already own the database transaction. Money, number,
// term grant, receipt and its delivery intent commit (or roll back) together.
function confirm(slug, p, input, now) {
  if (p.state === 'accepted') {
    need(input.amount === p.amount && input.currency === p.currency, 'confirmation_conflict', 409);
    return p;
  }
  need(['review', 'more'].includes(p.state), 'not_reviewable', 409);
  const i = invoice(slug, p.invoice),
    e = entitlementsFor(slug, now),
    v = version(i.version);
  need(
    input.currency === i.currency && minor(input.amount) > 0 && input.amount <= i.due,
    'amount_or_currency_mismatch',
    409
  );
  need(!e.canceling || !e.canRun, 'resume_before_payment', 409);
  if (i.kind === 'upgrade')
    need(i.basis === `${e.version}:${e.end}` && e.hasTerm && e.end > stamp(now), 'quote_expired', 409);
  else if (e.hasTerm && e.end > stamp(now))
    need(v.rank <= e.rank && (v.rank === e.rank || e.next?.version === v.version), 'term_changed', 409);
  run('INSERT INTO b_payment(id,invoice,currency,amount,confirmed,receipt) VALUES(?,?,?,?,?,?)', [
    p.id,
    i.id,
    i.currency,
    input.amount,
    stamp(now),
    sequence('RCT', now),
  ]);
  if (i.due === input.amount) {
    need(!i.grant_id, 'already_granted', 409);
    const grant = addEvent(e, i.kind, { version: i.version, units: i.months, source: p.id, now });
    run('UPDATE b_invoice SET grant_id=? WHERE id=?', [grant, i.id]);
  }
  queue(e.sid, 'receipt', p.id, 'email', now);
  recordState(slug, 'payment_confirmed', now);
  recordAudit({ action: 'billing_payment_confirmed', tenant: slug, detail: { object: p.id } });
  return paymentCard(slug, p.id);
}
export function reviewPayment(slug, id, action, input = {}, now = Date.now()) {
  return transaction(() => {
    const p = paymentCard(slug, id);
    if (action === 'accept') return confirm(slug, p, input, now);
    const i = invoice(slug, p.invoice);
    const reason = input.reason;
    if (action === 'reverse') {
      choice(reason, opsReasons, 'reason_required');
      if (p.state === 'reversed') return p;
      need(p.state === 'accepted', 'not_confirmed', 409);
      run('INSERT INTO b_reversal VALUES(?,?,?)', [id, stamp(now), reason]);
      if (i.grant_id) {
        addEvent(i, 'reversal', { undo: i.grant_id, reason, now });
        run('UPDATE b_invoice SET grant_id=NULL WHERE id=?', [i.id]);
      }
      recordState(slug, 'payment_reversed', now);
      queue(i.sid, 'reversed', id, 'email', now);
    } else if (action === 'refund') {
      choice(reason, opsReasons, 'reason_required');
      need(p.confirmed && input.currency === p.currency, 'not_confirmed', 409);
      need(uuid(input.requestId), 'invalid_request_id');
      const seen = get('SELECT payment FROM b_refund WHERE id=?', [input.requestId]);
      if (seen) {
        need(seen.payment === id, 'request_conflict', 409);
        return p;
      }
      const prev = get('SELECT COALESCE(sum(amount),0) n FROM b_refund WHERE payment=?', [id]).n;
      need(minor(input.amount) > 0 && input.amount + prev <= p.amount, 'invalid_refund');
      run('INSERT INTO b_refund VALUES(?,?,?,?,?,?)', [
        input.requestId,
        id,
        input.amount,
        p.currency,
        reason,
        stamp(now),
      ]);
    } else {
      choice(action, ['reject', 'more']);
      need(['review', 'more'].includes(p.state), 'not_reviewable', 409);
      choice(reason, REASON_CODES, 'reason_required');
      run('UPDATE b_review SET state=?,reason=? WHERE id=?', [
        action === 'more' ? 'more' : 'rejected',
        reason,
        id,
      ]);
      queue(i.sid, action, id, 'email', now);
    }
    recordAudit({ action: 'billing_payment_' + action, tenant: slug, detail: { object: id, reason } });
    return paymentCard(slug, id);
  });
}
export function history(slug) {
  const s = subscription(slug);
  if (!s) return [];
  return all('SELECT id FROM b_invoice WHERE sid=? ORDER BY rowid DESC', [s.sid]).map(({ id }) => {
    const i = invoice(slug, id);
    const payments = all(
      'SELECT p.id,p.state,p.reason,p.at,p.confirmed,p.reversed,p.receipt,p.amount,p.currency,f.id proof FROM b_card p LEFT JOIN b_proof f ON f.payment=p.id WHERE p.invoice=? ORDER BY p.seq DESC',
      [id]
    ).map((p) => ({
      ...p,
      message: REASON_MESSAGES[p.reason]?.en || null,
      refunds: all('SELECT amount,currency,reason,at FROM b_refund WHERE payment=?', [p.id]),
    }));
    return {
      id,
      plan: version(i.version).name,
      version: i.version,
      months: i.months,
      kind: i.kind,
      ref: i.ref,
      subtotal: i.subtotal,
      tax: i.tax,
      taxLabel: i.tax_label,
      total: i.total,
      due: i.due,
      paid: i.paid,
      currency: i.currency,
      at: i.at,
      number: i.invoice_no,
      quote: i.quote_no,
      methods: JSON.parse(i.methods),
      status:
        i.total === null
          ? 'awaiting_quote'
          : !i.due
            ? 'accepted'
            : payments[0]?.state === 'review'
              ? 'under_review'
              : i.paid
                ? 'partial'
                : payments[0]?.state || 'awaiting_proof',
      payments,
    };
  });
}
export async function documentPDF(slug, kind, id) {
  let i,
    p = null;
  if (kind === 'receipts') {
    p = paymentCard(slug, id);
    need(p.receipt, 'not_found', 404);
    i = invoice(slug, p.invoice);
  } else i = invoice(slug, id);
  const quote = kind === 'quotes',
    number = p ? p.receipt : quote ? i.quote_no : i.invoice_no;
  need(number, 'not_found', 404);
  const v = version(i.version);
  const label = p ? 'Receipt' : quote ? 'Quote' : i.due ? 'Unpaid invoice' : 'Invoice';
  const amount = p ? p.amount : quote ? null : i.total;
  const data = await renderInvoicePDF({
    label,
    invoiceNo: number,
    currency: i.currency,
    date: (p?.confirmed || i.at).slice(0, 10),
    business: { name: 'Assistant platform' },
    client: { name: slug },
    lines: [
      {
        name: `${v.name} v${v.revision} · ${i.kind === 'upgrade' ? 'upgrade difference' : i.months + ' calendar month(s)'}`,
        qty: 1,
        text: amount === null ? 'To be confirmed' : money(p ? p.amount : i.subtotal, i.currency),
      },
    ],
    subtotal: p || amount === null ? '' : money(i.subtotal, i.currency),
    total: amount === null ? 'Not yet priced' : money(amount, i.currency),
    payment: !p && !quote && i.tax ? [{ label: i.tax_label, value: money(i.tax, i.currency) }] : [],
    notes: p
      ? p.reversed
        ? 'Reversed · not an active payment.'
        : `Payment received against ${i.invoice_no}.`
      : quote
        ? 'Estimate only. Do not transfer until invoiced.'
        : `Outstanding: ${money(i.due, i.currency)}. Reference: ${i.ref}.`,
    footer: label,
  });
  return { data, number };
}

// Provider seam, not an HTTP webhook. Production registers manual only. An adapter
// must authenticate raw bytes BEFORE parsing. Unknown events never change the ledger.
export class PaymentProvider {
  createCheckout() {
    throw Error('not_implemented');
  }
  verifyWebhook() {
    return false;
  }
  parseEvent() {
    return null;
  }
  refund() {
    throw Error('not_implemented');
  }
}
export class ManualProvider extends PaymentProvider {
  createCheckout(...args) {
    return checkout(...args);
  }
  refund(slug, id, input, now) {
    return reviewPayment(slug, id, 'refund', input, now);
  }
}
export function verifiedEvent(provider, bytes, signature, now = Date.now()) {
  need(provider.verifyWebhook(bytes, signature), 'invalid_signature', 401);
  const ev = provider.parseEvent(bytes);
  if (ev?.type !== 'payment.confirmed') return { ignored: true };
  need(uuid(ev.id) && uuid(ev.transaction) && /^[a-z]{2,16}$/.test(provider.name), 'invalid_event');
  return transaction(() => {
    if (get('SELECT 1 FROM b_provider_event WHERE provider=? AND id=?', [provider.name, ev.id]))
      return { duplicate: true };
    const i = invoice(ev.slug, ev.invoice);
    const seen = get('SELECT invoice FROM b_review WHERE provider=? AND external=?', [
      provider.name,
      ev.transaction,
    ]);
    if (seen) {
      need(seen.invoice === i.id, 'payment_conflict', 409);
      return { duplicate: true };
    }
    need(ev.amount === i.due && ev.currency === i.currency, 'amount_or_currency_mismatch', 409);
    const id = randomUUID();
    run('INSERT INTO b_review(id,invoice,state,currency,at,provider,external) VALUES(?,?,?,?,?,?,?)', [
      id,
      i.id,
      'review',
      i.currency,
      stamp(now),
      provider.name,
      ev.transaction,
    ]);
    confirm(ev.slug, paymentCard(ev.slug, id), ev, now);
    run('INSERT INTO b_provider_event VALUES(?,?,?)', [provider.name, ev.id, i.sid]);
    return { accepted: true };
  });
}
