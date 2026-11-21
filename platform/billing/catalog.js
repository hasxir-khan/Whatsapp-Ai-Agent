import { get, all, run, billingTransaction as transaction } from '../db.js';
import { trialDays } from '../env.js';
import { FEATURE_KEYS, FEATURE_ALIASES } from '../../src/services/profile.js';
import { minor, need, bounded, currencyCode, stamp } from './rules.js';
import { recordAudit } from './audit.js';
export const trialLimits = {
  tenants: 1,
  numbers: 1,
  agents: 2,
  team_members: 1,
  conversations_month: 200,
  voice_minutes: 0,
  videos_month: 0,
  history_days: 30,
  dashboard_days: 31,
  llm_calls_day: 100,
};
export function initCatalog(now = Date.now()) {
  if (!get("SELECT version FROM b_plan WHERE plan='free'"))
    publishPlan(
      {
        plan: 'free',
        name: 'Free trial',
        rank: 0,
        trialDays: Math.min(90, Math.floor(trialDays())),
        currency: null,
        offers: {},
        limits: trialLimits,
        features: ['liveInbox'],
      },
      now
    );
}
const hydrate = (r) => r && { ...JSON.parse(r.spec), version: r.version, revision: r.revision };
export const version = (id) => hydrate(get('SELECT * FROM b_plan WHERE version=?', [id]));
export const latest = (id) =>
  hydrate(get('SELECT * FROM b_plan WHERE plan=? ORDER BY revision DESC LIMIT 1', [id]));
export const catalog = () =>
  all(
    'SELECT p.* FROM b_plan p JOIN (SELECT plan,max(revision) rev FROM b_plan GROUP BY plan) l ON p.plan=l.plan AND p.revision=l.rev ORDER BY p.plan'
  ).map(hydrate);
function words(s, max = 80) {
  need(
    typeof s === 'string' &&
      s.length <= max &&
      /^[\p{L}\p{M}\p{N} .,()@_+'/-]*$/u.test(s) &&
      !/(?:\d[ -]*){5}/.test(s),
    'invalid_label'
  );
  return s.trim();
}
export function publishPlan(input, now = Date.now()) {
  const { plan, limits, offers } = input;
  need(/^[a-z][a-z0-9-]{1,32}$/.test(plan) && typeof plan === 'string', 'invalid_plan');
  const trial = plan === 'free';
  need(input.offered === undefined || typeof input.offered === 'boolean', 'invalid_option');
  const offered = trial || input.offered !== false;
  const spec = {
    plan,
    offered,
    name: words(input.name),
    rank: bounded(input.rank, trial ? 0 : 1, trial ? 0 : 999),
    currency: trial ? null : currencyCode(input.currency),
    trialDays: trial ? bounded(input.trialDays, 0, 90) : 0,
    limits: {},
    offers: {},
    features: [],
  };
  need(spec.name, 'invalid_name');
  for (const k of Object.keys(trialLimits))
    spec.limits[k] = bounded(
      limits?.[k],
      ['tenants', 'numbers', 'history_days', 'dashboard_days'].includes(k) ? 1 : 0,
      k === 'dashboard_days' ? 90 : 1000000
    );
  need(offers && typeof offers === 'object' && !Array.isArray(offers), 'invalid_prices');
  for (const [months, price] of Object.entries(offers)) {
    need(/^[1-9]\d?$/.test(months) && +months <= 36 && minor(price) > 0, 'invalid_offer');
    spec.offers[months] = price;
  }
  need(trial ? !Object.keys(offers).length : !offered || Object.keys(offers).length > 0, 'prices_required');
  need(
    Array.isArray(input.features) && input.features.every((k) => FEATURE_KEYS.includes(k)),
    'invalid_features'
  );
  spec.features = [...new Set(input.features.map((k) => FEATURE_ALIASES[k] || k))];
  return transaction(() => {
    const revision = (latest(plan)?.revision || 0) + 1;
    run('INSERT INTO b_plan(plan,revision,spec,at) VALUES(?,?,?,?)', [
      plan,
      revision,
      JSON.stringify(spec),
      stamp(now),
    ]);
    recordAudit({ action: 'billing_plan_published', detail: { plan, revision } });
    return latest(plan);
  });
}
export const defaults = {
  methods: [],
  graceDays: 3,
  retentionDays: 30,
  deleteWaitDays: 7,
  proofDays: 30,
  cacheHours: 12,
  pendingHours: 24,
  taxBps: 0,
  taxLabel: 'Tax',
  retainAccounting: false,
  terms: 'Operator to insert billing terms before launch.',
  refunds: 'Operator to insert refund policy before launch.',
};
export function settings() {
  return { ...defaults, ...JSON.parse(get('SELECT value FROM b_config WHERE id=1')?.value || '{}') };
}
export function configure(patch) {
  const v = settings();
  for (const [key, lo, hi] of [
    ['graceDays', 0, 30],
    ['retentionDays', 1, 365],
    ['deleteWaitDays', 1, 90],
    ['proofDays', 1, 365],
    ['cacheHours', 1, 168],
    ['pendingHours', 1, 168],
    ['taxBps', 0, 10000],
  ])
    if (key in patch) v[key] = bounded(patch[key], lo, hi);
  if ('methods' in patch) {
    need(Array.isArray(patch.methods) && patch.methods.length <= 6, 'invalid_methods');
    v.methods = patch.methods.map((m) => {
      const method = words(m.method, 40),
        receiver = words(m.receiver || ''),
        alias = words(m.alias || ''),
        tail = String(m.tail || '');
      need(method && (alias || receiver) && (!tail || /^\d{4}$/.test(tail)), 'invalid_method');
      return Object.fromEntries(Object.entries({ method, receiver, alias, tail }).filter(([, s]) => s));
    });
  }
  for (const key of ['terms', 'refunds', 'taxLabel'])
    if (key in patch) v[key] = words(patch[key], key === 'taxLabel' ? 30 : 500);
  if ('retainAccounting' in patch) {
    need(typeof patch.retainAccounting === 'boolean', 'invalid_option');
    v.retainAccounting = patch.retainAccounting;
  }
  return transaction(() => {
    run('INSERT OR REPLACE INTO b_config VALUES(1,?)', [JSON.stringify(v)]);
    recordAudit({ action: 'billing_policy_updated' });
    return v;
  });
}
