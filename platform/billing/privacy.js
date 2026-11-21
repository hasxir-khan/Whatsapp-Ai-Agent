import fs from 'node:fs';
import path from 'node:path';
import { all, run } from '../db.js';
import { platformDir } from '../env.js';
import { entitlementsFor, subscription } from './subscriptions.js';
import { history } from './payments.js';
import { purgeProofs } from './proofs.js';
import { settings } from './catalog.js';
import { stamp } from './rules.js';
export function billingExport(slug, now = Date.now()) {
  const s = subscription(slug);
  if (!s) return null;
  return {
    slug,
    subscription: entitlementsFor(slug, now),
    invoices: history(slug),
    events: all('SELECT at,op,units,version,reason FROM b_event WHERE sid=? ORDER BY id', [s.sid]),
    transitions: all('SELECT at,before_state,after_state,reason FROM b_transition WHERE sid=? ORDER BY id', [
      s.sid,
    ]),
    proofs: all('SELECT kind,fields,at,expires FROM b_proof WHERE sid=? AND purged=0 AND expires>?', [
      s.sid,
      stamp(now),
    ]).map((p) => ({ ...p, fields: JSON.parse(p.fields) })),
  };
}
// Called under the tenant lock, as part of the existing stop-and-forget path. Erase
// even if billing was subsequently disabled. No financial identity needs a slug.
export function eraseBilling(slug, now = Date.now()) {
  const s = subscription(slug);
  if (!s) return;
  purgeProofs(now, s.sid);
  fs.rmSync(path.join(platformDir(), 'billing-mail', s.sid), { recursive: true, force: true });
  if (settings().retainAccounting) {
    const roll = (month, currency, confirmed, refunded) =>
      run(
        'INSERT INTO b_anonymous VALUES(?,?,?,?) ON CONFLICT(month,currency) DO UPDATE SET confirmed=confirmed+excluded.confirmed,refunded=refunded+excluded.refunded',
        [month, currency, confirmed, refunded]
      );
    for (const r of all(
      'SELECT substr(confirmed,1,7) month,p.currency,sum(amount) n FROM b_confirmed p JOIN b_invoice i ON i.id=p.invoice WHERE sid=? GROUP BY 1,2',
      [s.sid]
    ))
      roll(r.month, r.currency, r.n, 0);
    for (const r of all(
      'SELECT substr(r.at,1,7) month,r.currency,sum(r.amount) n FROM b_refund r JOIN b_payment p ON p.id=r.payment JOIN b_invoice i ON i.id=p.invoice WHERE sid=? GROUP BY 1,2',
      [s.sid]
    ))
      roll(r.month, r.currency, 0, r.n);
  }
  run('DELETE FROM b_sub WHERE sid=?', [s.sid]);
  run(
    'DELETE FROM b_reversal WHERE payment IN (SELECT p.id FROM b_payment p JOIN b_invoice i ON i.id=p.invoice WHERE i.sid=?)',
    [s.sid]
  );
  run(
    'DELETE FROM b_refund WHERE payment IN (SELECT p.id FROM b_payment p JOIN b_invoice i ON p.invoice=i.id WHERE i.sid=?)',
    [s.sid]
  );
  run('DELETE FROM b_payment WHERE invoice IN (SELECT id FROM b_invoice WHERE sid=?)', [s.sid]);
  run('DELETE FROM b_review WHERE invoice IN (SELECT id FROM b_invoice WHERE sid=?)', [s.sid]);
  for (const t of ['b_invoice', 'b_proof', 'b_delivery', 'b_provider_event'])
    run(`DELETE FROM ${t} WHERE sid=?`, [s.sid]);
  run('INSERT INTO b_transition(sid,at,before_state,after_state,reason) VALUES(?,?,?,?,?)', [
    s.sid,
    stamp(now),
    s.observed,
    'deleted',
    'tenant_forgotten',
  ]); // Preserve only month-level counts, not timestamps, ledger IDs or the owner's reasons.
  run(
    `INSERT INTO b_churn SELECT substr(at,1,7),after_state,count(*) FROM b_transition WHERE sid=? AND after_state IN ('cancel_at_period_end','canceled','deleted') GROUP BY 1,2 ON CONFLICT(month,state) DO UPDATE SET n=n+excluded.n`,
    [s.sid]
  );
  for (const t of ['b_event', 'b_transition']) run(`DELETE FROM ${t} WHERE sid=?`, [s.sid]);
  run(
    "UPDATE platform_audit SET tenant=NULL,account_id=NULL,ip=NULL,detail=NULL WHERE tenant=? AND action LIKE 'billing_%'",
    [slug]
  );
  run("DELETE FROM platform_notifications WHERE tenant=? AND kind LIKE 'billing%'", [slug]);
}
