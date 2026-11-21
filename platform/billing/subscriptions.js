import { randomUUID } from 'node:crypto';
import { get, all, run, billingTransaction as transaction, lastId } from '../db.js';
import { recordAudit } from './audit.js';
import { initCatalog, settings, latest, version } from './catalog.js';
import { monthsAfter, stamp, DAY, need, bounded, choice } from './rules.js';

export const subscription = (slug) => get('SELECT * FROM b_sub WHERE slug=?', [slug]);
// Provisioning retries return the same term. A migrated assistant inherits at most its
// remaining legacy trial, never a guessed paid term or a second fresh trial.
export function openSubscription(slug, { legacy = false, now = Date.now() } = {}) {
  const old = subscription(slug);
  if (old) return old;
  initCatalog(now);
  return transaction(() => {
    const t = get('SELECT * FROM tenants WHERE slug=?', [slug]);
    need(t, 'not_found', 404);
    const v = latest('free'),
      at = stamp(now),
      sid = randomUUID();
    const eligible =
      !legacy &&
      t.number &&
      !get('SELECT trial_seen FROM accounts WHERE id=?', [t.account_id])?.trial_seen &&
      !get('SELECT 1 FROM trial_numbers WHERE number=?', [t.number]);
    const end = legacy ? t.trial_ends_at || at : stamp(+new Date(now) + (eligible ? v.trialDays : 0) * DAY);
    const state = end > at ? 'trialing' : 'paused';
    if ((eligible || (legacy && t.trial_ends_at)) && t.number) {
      run('INSERT OR IGNORE INTO trial_numbers VALUES(?,?,?)', [t.number, t.account_id, at]);
      run('UPDATE accounts SET trial_seen=1 WHERE id=?', [t.account_id]);
    }
    run('INSERT INTO b_sub VALUES(?,?,?,?,?,?,0,0)', [sid, slug, at, end, v.version, state]);
    run('INSERT INTO b_transition(sid,at,after_state,reason) VALUES(?,?,?,?)', [
      sid,
      at,
      state,
      legacy ? 'migration' : eligible ? 'trial_opened' : 'trial_unavailable',
    ]);
    return subscription(slug);
  });
}

// Sole term -> permission projection. Replaying non-reversed grants rather than
// subtracting days also gets later stacked renewals right after an earlier reversal.
export function entitlementsFor(tenant, now = Date.now()) {
  const s = subscription(typeof tenant === 'string' ? tenant : tenant.slug);
  if (!s) return null;
  const at = stamp(now),
    cfg = settings(),
    events = all('SELECT * FROM b_event WHERE sid=? AND at<=? ORDER BY id', [s.sid, at]);
  const undone = new Set(events.filter((e) => e.undo).map((e) => e.undo));
  let end = s.trial_end,
    paid = false,
    segments = [],
    cancel = null,
    scheduled = null;
  for (const e of events) {
    if (undone.has(e.id)) continue;
    if (['term', 'comp', 'extend'].includes(e.op)) {
      const start = (paid || e.op === 'extend') && end > e.at ? end : e.at;
      end = e.op === 'extend' ? stamp(Date.parse(start) + e.units * DAY) : monthsAfter(start, e.units);
      segments.push({ start, version: e.version });
      paid = true;
      if (e.op === 'term') cancel = null;
      scheduled = null;
    } else if (e.op === 'upgrade' || e.op === 'change') {
      if (paid && e.at < end) {
        segments = segments.filter((v) => v.start <= e.at);
        segments.push({ start: e.at, version: e.version });
        scheduled = null;
      }
    } else if (e.op === 'downgrade') scheduled = { start: end, version: e.version };
    else if (e.op === 'cancel') cancel = e;
    else if (e.op === 'resume') cancel = null;
  }
  const current = [...segments, ...(scheduled ? [scheduled] : [])].filter((v) => v.start <= at).at(-1);
  const v = version(current?.version || s.opening_version);
  let state,
    until = null,
    pendingAt = null,
    deleteAt = null;
  const cancelEffectiveAt = cancel ? (cancel.at > end ? cancel.at : end) : null;
  if (cancel) {
    pendingAt = stamp(Date.parse(cancelEffectiveAt) + cancel.units * DAY);
    deleteAt = stamp(Date.parse(pendingAt) + cancel.wait_days * DAY);
  }
  if (at < end) {
    state = cancel ? 'cancel_at_period_end' : paid ? 'active' : 'trialing';
    until = end;
  } else if (cancel) {
    state =
      at >= pendingAt
        ? 'pending_deletion'
        : Date.parse(at) < Date.parse(cancelEffectiveAt) + DAY
          ? 'canceled'
          : 'paused';
  } else if (paid && Date.parse(at) < Date.parse(end) + cfg.graceDays * DAY) {
    state = 'grace';
    until = stamp(Date.parse(end) + cfg.graceDays * DAY);
  } else state = 'paused';
  const next = segments.find((x) => x.start > at);
  return {
    sid: s.sid,
    state,
    canRun: !!until,
    hasTerm: paid,
    end,
    until,
    version: v.version,
    revision: v.revision,
    plan: v.plan,
    name: v.name,
    rank: v.rank,
    features: v.features,
    limits: v.limits,
    pausedReply: !!s.paused_reply,
    canceling: !!cancel,
    cancelEffectiveAt,
    pendingAt,
    deleteAt,
    next: next || scheduled,
    validUntil: until && next?.start < until ? next.start : until,
  };
}
export const opsReasons = [
  'support_correction',
  'service_credit',
  'bank_reversal',
  'customer_request',
  'billing_error',
];
export function addEvent(
  s,
  op,
  {
    version = null,
    units = null,
    source = null,
    undo = null,
    reason = op,
    wait = null,
    now = Date.now(),
  } = {}
) {
  run('INSERT INTO b_event(sid,at,op,version,units,source,undo,reason,wait_days) VALUES(?,?,?,?,?,?,?,?,?)', [
    s.sid,
    stamp(now),
    op,
    version,
    units,
    source,
    undo,
    reason,
    wait,
  ]);
  return lastId();
}
export function queue(sid, kind, object, channel = 'email', now = Date.now()) {
  const id = [sid, kind, object, channel].join(':');
  run('INSERT OR IGNORE INTO b_delivery(id,sid,kind,channel,object,at) VALUES(?,?,?,?,?,?)', [
    id,
    sid,
    kind,
    channel,
    String(object),
    stamp(now),
  ]);
  if (kind.startsWith('remind_'))
    run("UPDATE b_delivery SET state='queued',lease=NULL WHERE id=? AND state='obsolete'", [id]);
}
export function recordState(slug, reason, now = Date.now()) {
  const s = subscription(slug),
    e = entitlementsFor(slug, now);
  if (!s) return null;
  if (s.observed !== e.state) {
    const at = stamp(now);
    let before = s.observed;
    const transition = (to) => {
      run('INSERT INTO b_transition(sid,at,before_state,after_state,reason) VALUES(?,?,?,?,?)', [
        s.sid,
        at,
        before,
        to,
        reason,
      ]);
      before = to;
    };
    if (before === 'cancel_at_period_end' && ['paused', 'pending_deletion'].includes(e.state))
      transition('canceled');
    if (
      before === 'active' &&
      e.state === 'paused' &&
      e.hasTerm &&
      settings().graceDays > 0 &&
      reason === 'clock'
    )
      transition('grace');
    if (before === 'canceled' && e.state === 'pending_deletion') transition('paused');
    transition(e.state);
    run('UPDATE b_sub SET observed=? WHERE sid=?', [e.state, s.sid]);
    if (['grace', 'paused', 'canceled', 'pending_deletion'].includes(e.state))
      queue(s.sid, e.state, e.end, 'email', now);
  }
  // This compatibility mirror is not authority. Never unpause an owner-paused worker.
  run('UPDATE tenants SET plan_id=?,trial_ends_at=? WHERE slug=?', [
    e.plan,
    e.state === 'trialing' ? e.end : null,
    slug,
  ]);
  return e;
}
export function changeSubscription(slug, action, input = {}, now = Date.now()) {
  return transaction(() => {
    const s = subscription(slug),
      e = entitlementsFor(slug, now);
    need(e, 'not_found', 404);
    const cfg = settings();
    let event = { now };
    if (action === 'paused_reply') {
      need(typeof input.enabled === 'boolean', 'invalid_option');
      run('UPDATE b_sub SET paused_reply=? WHERE sid=?', [+input.enabled, s.sid]);
    } else {
      if (action === 'cancel') {
        if (e.canceling) return e;
        event.reason = choice(input.reason || 'unspecified', [
          'unspecified',
          'price',
          'not_needed',
          'missing_feature',
          'other',
        ]);
        event.units = cfg.retentionDays;
        event.wait = cfg.deleteWaitDays;
      } else if (action === 'resume') {
        if (!e.canceling) return e;
        need(stamp(now) < e.end, 'term_has_ended', 409);
      } else if (action === 'downgrade') {
        const v = version(input.version);
        need(
          e.hasTerm &&
            e.canRun &&
            !e.canceling &&
            v &&
            v.rank < e.rank &&
            v.plan !== 'free' &&
            latest(v.plan).version === v.version,
          'invalid_downgrade',
          409
        );
        if (e.next?.version === v.version) return e;
        event.version = v.version;
      } else if (['comp', 'extend', 'change'].includes(action)) {
        if (input.requestId) {
          need(/^[a-f0-9-]{36}$/.test(input.requestId), 'invalid_request_id');
          event.source = s.sid + ':' + action + ':' + input.requestId;
          if (get('SELECT 1 FROM b_event WHERE source=?', [event.source])) return e;
        }
        event.reason = choice(input.reason, opsReasons, 'reason_required');
        event.version = action === 'extend' ? e.version : version(input.version)?.version;
        need(event.version, 'invalid_version');
        if (action === 'change') need(e.hasTerm && stamp(now) < e.end, 'no_current_term', 409);
        if (action !== 'change') event.units = bounded(input.units, 1, action === 'extend' ? 365 : 36);
      } else need(false, 'invalid_action');
      addEvent(s, action, event);
    }
    recordAudit({ action: 'billing_' + action, tenant: slug, detail: { reason: event.reason || action } });
    return recordState(slug, action, now);
  });
}
export function accountCapacity(accountId) {
  const rows = all('SELECT slug FROM tenants WHERE account_id=?', [accountId]);
  const active = rows.map((r) => entitlementsFor(r.slug)).filter((e) => e?.canRun);
  const limits = (k) => Math.max(latest('free')?.limits[k] || 1, ...active.map((e) => e.limits[k]));
  return { used: rows.length, tenants: limits('tenants'), numbers: limits('numbers') };
}

export function warnLimit(slug, kind, now = Date.now()) {
  const s = subscription(slug);
  if (s) queue(s.sid, 'limit_' + kind, stamp(now).slice(0, 7), 'email', now);
}
