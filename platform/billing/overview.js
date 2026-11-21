import { pausedBehaviour, handoverLine } from '../../src/services/billingNotices.js';
import { all, get } from '../db.js';
import { readTenantProfile } from '../../src/services/adminPanel.js';
import { catalog, settings } from './catalog.js';
import { entitlementsFor, opsReasons, accountCapacity } from './subscriptions.js';
import { policyText, stamp, DAY, choice, bounded } from './rules.js';
import { history } from './payments.js';
import { billingBanner, readUsage } from './leases.js';
import { FEATURE_KEYS } from '../../src/services/profile.js';
import { REJECT_REASONS } from '../../src/services/paymentReview.js';
export function customerView(slug, owner, now = Date.now()) {
  const e = entitlementsFor(slug, now),
    cfg = settings();
  let profile;
  try {
    profile = readTenantProfile(slug);
  } catch {}
  const zone =
    profile?.business?.timezone || get('SELECT zone FROM r_state WHERE slug=?', [slug])?.zone || 'UTC';
  const invoices = history(slug);
  const account = get('SELECT account_id FROM tenants WHERE slug=?', [slug]);
  return {
    entitlement: e,
    banner: billingBanner(e, now),
    pausedSetting: pausedBehaviour(e.pausedReply),
    handoverLine,
    owner,
    zone,
    usage: {
      ...readUsage(slug, now),
      team_members: get('SELECT count(*) n FROM memberships WHERE slug=?', [slug]).n - 1,
      agents: (profile?.agents || []).length,
      tenants: accountCapacity(account.account_id).used,
      numbers: accountCapacity(account.account_id).used,
    },
    catalog: catalog().filter((p) => p.offered),
    instructions: owner ? cfg.methods : [],
    policy: policyText,
    timing: `Paid grace: ${cfg.graceDays} days. After a canceled term: ${cfg.retentionDays} days to export, then ${cfg.deleteWaitDays} days before permanent deletion.`,
    terms: cfg.terms,
    refunds: cfg.refunds,
    invoices: owner
      ? invoices
      : invoices.map(({ plan, version, status, at, total, due, currency }) => ({
          plan,
          version,
          status,
          at,
          total,
          due,
          currency,
        })),
    transitions: all(
      'SELECT at,before_state,after_state,reason FROM b_transition WHERE sid=? ORDER BY id DESC LIMIT 50',
      [e.sid]
    ),
  };
}
export function operations(filter = 'all', now = Date.now(), page = 1) {
  bounded(page, 1, 1000000, 'invalid_page');
  choice(filter, ['all', 'expiring', 'grace', 'paused', 'trial-ending', 'pending_deletion']);
  const cfg = settings(),
    at = stamp(now);
  const subs = all('SELECT slug FROM b_sub ORDER BY slug')
    .map(({ slug }) => ({ slug, ...entitlementsFor(slug, now) }))
    .filter(
      (e) =>
        filter === 'all' ||
        filter === e.state ||
        (filter === 'expiring' &&
          e.canRun &&
          e.end > at &&
          Date.parse(e.end) - Number(new Date(now)) <= 7 * DAY) ||
        (filter === 'trial-ending' &&
          e.state === 'trialing' &&
          Date.parse(e.end) - Number(new Date(now)) <= 7 * DAY)
    );
  const cards = all(
    `SELECT s.slug,p.id,p.invoice,p.state,p.amount,p.at,p.receipt,i.invoice_no,i.currency,i.ref,f.id proof,f.checks,f.risk,f.expires,f.purged FROM b_card p JOIN b_invoice i ON i.id=p.invoice JOIN b_sub s ON i.sid=s.sid LEFT JOIN b_proof f ON f.payment=p.id ORDER BY (p.state='review') DESC,p.at DESC,p.seq DESC LIMIT 51 OFFSET ?`,
    [(page - 1) * 50]
  ).map((p) => ({
    ...p,
    checks: p.expires && p.expires <= at ? [] : JSON.parse(p.checks || '[]'),
    purged: p.purged || (p.expires && p.expires <= at),
    overdue: p.state === 'review' && Date.parse(p.at) + cfg.pendingHours * 3600000 <= Number(new Date(now)),
    due: get(
      'SELECT i.total-COALESCE(sum(p.amount),0) n FROM b_invoice i LEFT JOIN b_confirmed p ON p.invoice=i.id WHERE i.id=? GROUP BY i.id',
      [p.invoice]
    ).n,
  }));
  const revenue = all(
    `SELECT month,currency,sum(n) confirmed FROM (SELECT substr(confirmed,1,7) month,currency,sum(amount) n FROM b_confirmed GROUP BY 1,2 UNION ALL SELECT month,currency,confirmed n FROM b_anonymous) GROUP BY 1,2 ORDER BY month DESC`
  );
  const churn = all(
    "SELECT month,after_state,sum(n) n FROM (SELECT substr(at,1,7) month,after_state,count(*) n FROM b_transition WHERE after_state IN ('cancel_at_period_end','canceled','deleted') GROUP BY 1,2 UNION ALL SELECT month,state,n FROM b_churn) GROUP BY 1,2 ORDER BY month DESC"
  );
  return {
    at,
    subscriptions: subs,
    cards: cards.slice(0, 50),
    page,
    more: cards.length > 50,
    quotes: all(
      'SELECT s.slug,i.id,i.quote_no,i.months,i.currency,p.plan FROM b_invoice i JOIN b_sub s ON s.sid=i.sid JOIN b_plan p ON p.version=i.version WHERE total IS NULL ORDER BY i.at'
    ),
    revenue,
    churn,
    audit: all(
      "SELECT created_at,tenant,action,detail FROM platform_audit WHERE action LIKE 'billing_%' ORDER BY id DESC LIMIT 100"
    ),
    catalog: catalog(),
    settings: cfg,
    policy: policyText,
    opsReasons,
    reasons: REJECT_REASONS,
    featureKeys: FEATURE_KEYS,
  };
}
