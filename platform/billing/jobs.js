import { createHash } from 'node:crypto';
import { billingEnabled, platformPublicUrl } from '../env.js';
import { get, all, run, billingTransaction as transaction, flush } from '../db.js';
import { initCatalog, settings } from './catalog.js';
import { openSubscription, subscription, entitlementsFor, recordState, queue } from './subscriptions.js';
import { documentPDF, paymentCard } from './payments.js';
import { purgeProofs } from './proofs.js';
import { publishLease, readUsage, reminderDays } from './leases.js';
import { stamp, DAY } from './rules.js';
import { sendMail } from '../mailer.js';
import { recordAudit, notify } from '../audit.js';
import { tenantRunning } from '../../src/services/adminPanel.js';
import { withWorker, stopKeyWorker, deliverKeysAtStart } from '../keys.js';
import { destroyTenant } from '../provisioning.js';

export function bootstrapBilling(now = Date.now()) {
  initCatalog(now);
  for (const t of all(
    "SELECT slug FROM tenants WHERE status IN ('active','provisioned','paused') AND slug NOT IN (SELECT slug FROM b_sub)"
  ))
    openSubscription(t.slug, { legacy: true, now });
}
// Called under the worker lock after every term mutation and each tick. A billing-aware
// live session is soft-paused: all sending/handling is stopped, QR login stays intact.
export async function syncWorker(slug, now = Date.now()) {
  const e = entitlementsFor(slug, now),
    t = get('SELECT * FROM tenants WHERE slug=?', [slug]);
  if (!e || !t) return;
  const wired = subscription(slug).wired;
  const applied = publishLease(slug, now);
  if (t.status === 'active' && (!applied || !wired)) {
    if (applied && e.canRun && (await deliverKeysAtStart(slug)).ok) return;
    await stopKeyWorker(slug);
    run("UPDATE tenants SET status='provisioned' WHERE slug=?", [slug]);
  }
  if (!e.canRun && ['active', 'provisioned'].includes(t.status))
    run("UPDATE tenants SET status='paused',paused_reason='billing' WHERE slug=?", [slug]);
  if (e.canRun && t.status === 'paused' && ['billing', 'trial_expired'].includes(t.paused_reason))
    run('UPDATE tenants SET status=?,paused_reason=NULL WHERE slug=?', [
      wired && tenantRunning(slug) ? 'active' : 'provisioned',
      slug,
    ]);
}
function schedule(slug, now) {
  const e = recordState(slug, 'clock', now),
    days = reminderDays(e, now),
    cfg = settings();
  if (days) for (const channel of ['email', 'whatsapp']) queue(e.sid, 'remind_' + days, e.end, channel, now);
  if (e.canceling && !e.canRun) {
    const day = Math.floor((+new Date(now) - Date.parse(e.cancelEffectiveAt)) / DAY),
      n = [25, 15, 0].find((n) => day >= n);
    if (n !== undefined) queue(e.sid, 'export_' + n, e.end, 'email', now);
  }
  const usage = readUsage(slug, now);
  for (const k of usage.limits) queue(e.sid, 'limit_' + k, usage.month, 'email', now);
  for (const p of all(
    "SELECT p.id FROM b_card p JOIN b_invoice i ON i.id=p.invoice WHERE sid=? AND p.state='review' AND p.at<=?",
    [e.sid, stamp(+new Date(now) - cfg.pendingHours * 3600000)]
  ))
    queue(e.sid, 'review_overdue', p.id, 'operator', now);
  return e;
}
function stillRelevant(row, e, now) {
  if (row.kind === 'receipt')
    return get('SELECT state FROM b_card WHERE id=?', [row.object])?.state === 'accepted';
  if (row.kind.startsWith('remind_'))
    return e.end === row.object && row.kind === 'remind_' + reminderDays(e, now);
  if (row.kind.startsWith('export_')) return e.end === row.object && e.canceling && !e.canRun;
  if (['grace', 'paused', 'canceled', 'pending_deletion'].includes(row.kind))
    return e.end === row.object && e.state === row.kind;
  if (row.kind === 'review_overdue')
    return get('SELECT state FROM b_card WHERE id=?', [row.object])?.state === 'review';
  return true;
}
const clockFor = (value) => (typeof value === 'function' ? value : () => value ?? Date.now());
function deliveryText(kind, e) {
  if (kind === 'receipt') return 'Your confirmed payment receipt is attached.';
  if (kind.startsWith('remind_')) return 'Your assistant term ends on ' + e.end.slice(0, 10) + ' UTC.';
  if (kind.startsWith('export_') || kind === 'pending_deletion')
    return (
      'Your canceled term ended. Export your data before permanent deletion on ' +
      e.deleteAt.slice(0, 10) +
      ' UTC.'
    );
  if (kind === 'grace')
    return 'Your paid term ended. The assistant is in grace until ' + e.until.slice(0, 10) + ' UTC.';
  if (['paused', 'canceled'].includes(kind)) return 'Your assistant is paused. Nothing was deleted.';
  if (kind.startsWith('limit_'))
    return 'Your assistant reached a plan limit. Review usage or choose another plan.';
  if (kind === 'reversed')
    return 'A payment confirmation was reversed. Review the balance and term in Billing.';
  if (kind === 'review_overdue') return 'A manual payment is awaiting operator review.';
  return 'Your proof needs another look. Open Billing for the reason and next step.';
}
export async function deliverBilling(time = null, send = sendMail) {
  if (!flush()) return;
  const clock = clockFor(time),
    at = stamp(clock());
  const rows = all(
    "SELECT d.*,s.slug FROM b_delivery d JOIN b_sub s ON s.sid=d.sid WHERE channel!='whatsapp' AND state IN ('queued','sending') AND (lease IS NULL OR lease<=?) ORDER BY d.rowid LIMIT 100",
    [at]
  );
  for (const row of rows) {
    const now = clock();
    const claimed = get('SELECT state,lease FROM b_delivery WHERE id=?', [row.id]);
    if (!claimed || !['queued', 'sending'].includes(claimed.state) || claimed.lease > at) continue;
    const e = entitlementsFor(row.slug, now);
    if (!e) continue;
    if (!stillRelevant(row, e, now)) {
      run("UPDATE b_delivery SET state='obsolete' WHERE id=?", [row.id]);
      continue;
    }
    const account = get(
      'SELECT a.id,a.email FROM accounts a JOIN tenants t ON t.account_id=a.id WHERE t.slug=?',
      [row.slug]
    );
    if (!account) continue;
    const to = row.channel === 'operator' ? process.env.PLATFORM_BILLING_OPERATOR_EMAIL : account.email;
    const url =
      (platformPublicUrl() || '').replace(/\/$/, '') +
      (row.channel === 'operator' ? '/platform/operator/billing' : '/platform/billing/' + row.slug);
    const text = deliveryText(row.kind, e);
    const lease = stamp(+new Date(now) + 10 * 60000);
    transaction(() => {
      run("UPDATE b_delivery SET state='sending',lease=? WHERE id=?", [lease, row.id]);
      if (row.state === 'queued' && row.channel !== 'operator')
        notify({
          accountId: account.id,
          tenant: row.slug,
          kind: 'billing',
          title: 'Billing update',
          body: text,
          now,
        });
    });
    try {
      let attachments;
      if (row.kind === 'receipt') {
        const p = paymentCard(row.slug, row.object);
        if (p.reversed) {
          run("UPDATE b_delivery SET state='obsolete' WHERE id=?", [row.id]);
          continue;
        }
        const pdf = await documentPDF(row.slug, 'receipts', p.id);
        attachments = [{ filename: pdf.number + '.pdf', content: pdf.data.toString('base64') }];
      }
      const checkAt = clock(),
        fresh = entitlementsFor(row.slug, checkAt);
      if (fresh?.sid !== row.sid || !stillRelevant(row, fresh, checkAt)) continue;
      if (!to && row.channel === 'operator') {
        run("UPDATE b_delivery SET state='queue_notice' WHERE id=?", [row.id]);
        continue;
      }
      const key = createHash('sha256').update(row.id).digest('hex');
      if (
        (
          await send({
            to,
            subject: 'Assistant billing update',
            text: text + '\n' + url,
            attachments,
            idempotencyKey: key,
            billingSid: e.sid,
          })
        ).ok
      )
        run("UPDATE b_delivery SET state='sent',lease=NULL WHERE id=?", [row.id]);
    } catch {
      /* retry after the lease; never log provider/proof contents */
    }
  }
  flush();
}
let busy = null,
  timer = null;
export function billingTick(time = null, { deliver = true } = {}) {
  if (!billingEnabled()) return Promise.resolve();
  if (busy) return busy;
  busy = (async () => {
    const clock = clockFor(time);
    bootstrapBilling(clock());
    purgeProofs(clock());
    for (const { slug, sid } of all('SELECT slug,sid FROM b_sub')) {
      try {
        const e = await withWorker(slug, async () => {
          if (subscription(slug)?.sid !== sid) return;
          const now = clock();
          const result = transaction(() => schedule(slug, now));
          await syncWorker(slug, now);
          return result;
        });
        if (e?.deleteAt && stamp(clock()) >= e.deleteAt)
          await destroyTenant(slug, {
            guard: () => {
              const now = clock(),
                cur = entitlementsFor(slug, now);
              if (
                cur?.sid !== sid ||
                get('SELECT 1 FROM b_event WHERE sid=? AND at>? LIMIT 1', [sid, stamp(now)])
              )
                return false;
              return cur?.state === 'pending_deletion' && cur.deleteAt <= stamp(now);
            },
          });
      } catch {
        recordAudit({ action: 'billing_reconcile_failed', tenant: slug, ok: false });
      }
    }
    if (deliver) await deliverBilling(clock);
    flush();
  })().finally(() => {
    busy = null;
  });
  return busy;
}
export function startBilling() {
  if (timer || (!billingEnabled() && !get('SELECT 1 FROM b_proof WHERE purged=0 LIMIT 1'))) return;
  const tick = () => {
    if (billingEnabled()) billingTick().catch(() => {});
    else {
      try {
        purgeProofs();
        flush();
      } catch {
        /* retry privacy cleanup on the next tick */
      }
    }
  };
  tick();
  timer = setInterval(tick, 60000);
  timer.unref?.();
}
export function stopBilling() {
  clearInterval(timer);
  timer = null;
}
