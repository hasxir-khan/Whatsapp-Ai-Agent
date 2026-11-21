// Content firewall shared by the worker writer and the importing control plane.
// A SQL column called "reason", "tag" or "agent" is NOT trusted display text.
import crypto from 'node:crypto';
export const REPORT_VERSION = 1;
export const DEFAULT_RETENTION = { free: 31, starter: 60, growth: 90 };
export function retention(plan) {
  return Math.max(
    plan?.version ? 1 : 31,
    Math.min(90, Math.trunc(Number(plan?.limits?.dashboard_days) || DEFAULT_RETENTION[plan?.id] || 31)),
  );
}
export const masked = (s) => typeof s === 'string' && /^id-[a-p]{16}$/.test(s);
export function alias(value, secret, namespace = 'contact') {
  if (!secret) throw new Error('dashboard_identity_missing');
  // The secret (not the encoding) prevents offline guessing from the ID alone.
  // Render the first 64 HMAC bits alphabetically to avoid phone-like labels.
  const hex = crypto.createHmac('sha256', secret).update(`${namespace}\0${value}`).digest('hex').slice(0, 16);
  return 'id-' + [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
export const enums = Object.fromEntries(
  Object.entries({
    agent:
      'sales support booking reminder rebook followup follow-up reactivation review analyst content manager closer frontdesk router reasoning payment_review quote assistant default unknown',
    source: 'direct link qr referral ads',
    tag: 'vip hot warm cold returning customer lead',
    member: 'owner unassigned',
    impact: 'followUpsSent followUpsAnswered reviewAsks reviewsReceived',
    incident: 'transport reconnects outbox llm tenant_budget disk backup sla decrypt delivery',
    severity: 'warn bad',
    incidentState: 'open resolved',
    nextAction:
      'request_review nurture nudge owner_call ask_budget ask_timeline send_quote follow_quote take_advance answer owner_objection not_recorded',
    actionReason:
      'won lost inactive negotiating budget_missing timeline_missing scope_ready quote_awaiting_reply hot_lead questions_open objection_limit not_recorded',
    action: 'reply clarify redirect handover react ignore',
    reason:
      'empty opt_out privacy self_harm threat sensitive_keyword insult cool_down human_request handover_keyword spam duplicate ack price_intent off_topic_redirect off_topic_warn off_topic_ignore unclear confusion angry classifier classifier_fallback normal new_contact_protected active_commitment ignore_limit daily_cap turn_limit approval_required',
    paymentReason:
      'not_verified real_not_received_yet wrong_amount_short wrong_amount_excess wrong_account duplicate_reference unclear_proof',
    state:
      'pending escalated recheck accepted partial rejected expired reversed cancelled placed paid delivered completed awaiting_payment',
    type: 'payment discount_above_cap refund custom_quote cancellation delivery_exception other',
    change: 'opened notified reminded decided reversed expired escalated note customer_waiting order_status',
    activity: 'route first_reply handoff order booking decision growth error',
    result: 'sent skipped held failed',
    stage: 'new engaged quoted ordered paid cold',
    leadReason: 'new_inquiry active_intake quote_outstanding order_placed payment_received cold_or_lost',
    intent: 'sales support booking complaint other',
    question: 'price hours location booking delivery payment services other',
    objection: 'price trust comparison timing',
    accuracy:
      'priceMismatch wrongLanguage midSentenceCuts forbiddenText doubleRepliesBlocked handoffs ownerReplies botHonesty',
    sourceMetric: 'inbound leads paid',
    funnel: 'leads quotes orders paid reviewed',
    media: 'videos vision processed refused video_ms voice correct errors',
    vote: 'up down',
    goal: 'orders leads revenue bookings reviews',
    experiment: 'followup offer review_ask',
    verdict: 'too_early inconclusive likely_better',
    role: 'user assistant owner',
    currency: 'PKR USD EUR GBP AED INR SAR CAD AUD BDT',
  }).map(([k, v]) => [k, new Set(v.split(' '))]),
);
export function code(group, value) {
  return enums[group]?.has(value) ? value : 'other';
}
export function dimension(group, value, secret) {
  return enums[group].has(value) ? value : alias(value || 'unknown', secret, group);
}
const dim = (g) => (v) => (masked(v) ? v : code(g, v));
const en = (g) => (v) => code(g, v);
export const numeric = (v) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? v : 0;
const amount = numeric,
  optional = (v) => (v == null ? null : numeric(v));
export const isoTime = (v) =>
  typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && !isNaN(Date.parse(v)) ? v : null;
const who = (v) => (masked(v) ? v : null);
export function zoneName(name) {
  try {
    if (!name || name.length > 64) return 'UTC';
    return new Intl.DateTimeFormat('en', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}
const stats = (keys) => Object.fromEntries(keys.split(' ').map((k) => [k, numeric]));
const pick = (spec, raw = {}) =>
  Object.fromEntries(Object.entries(spec).map(([k, clean]) => [k, clean(raw?.[k])]));
export const factTypes = {
  messages: [en('role')],
  source: [dim('source'), en('sourceMetric')],
  agent: [dim('agent'), en('activity')],
  decision: [en('action'), en('reason')],
  payment: [en('state'), en('paymentReason')],
  transition: [en('state'), en('paymentReason')],
  intent: [en('intent')],
  growth: [dim('agent'), en('result')],
  accuracy: [en('accuracy')],
  funnel: [en('funnel')],
  question: [en('question')],
  unanswered: [en('question')],
  objection: [en('objection')],
  review: [en('vote')],
  impact: [en('impact')],
  media: [en('media')],
  voice: [],
};
export function fact(row) {
  const spec = Object.hasOwn(factTypes, row.metric) && factTypes[row.metric];
  if (!spec || !Number.isInteger(row.hour) || row.hour < -1 || row.hour > 23) throw new Error('invalid_fact');
  return {
    metric: row.metric,
    hour: row.hour,
    a: spec[0]?.(row.a) || '',
    b: spec[1]?.(row.b) || '',
    n: numeric(row.n),
    value: amount(row.value),
  };
}
export const cleanPerson = (raw) =>
  pick(
    {
      who,
      first_at: isoTime,
      owner: (v) => +(v === 1),
      bot: (v) => +(v === 1),
      outside: (v) => +(v === 1),
      response_ms: optional,
      bookings: numeric,
      orders: numeric,
      revenue: amount,
      source: dim('source'),
    },
    raw,
  );
const cardTypes = {
  leads: {
    contact: who,
    stage: en('stage'),
    nextAction: en('nextAction'),
    reason: en('actionReason'),
    score: numeric,
    source: dim('source'),
    assigned: dim('member'),
    tags: (v) => (Array.isArray(v) ? v.slice(0, 16).map(dim('tag')) : []),
  },
  activity: {
    hour: (v) => Math.min(23, Math.floor(numeric(v))),
    type: en('activity'),
    agent: dim('agent'),
    contact: who,
    outcome: (v) => ['activity', 'action', 'result'].reduce((r, g) => (enums[g].has(v) ? v : r), 'other'),
    count: numeric,
  },
  payments: {
    type: en('type'),
    state: en('state'),
    reason: en('paymentReason'),
    order: numeric,
    amount,
    claimed: optional,
    deadline: isoTime,
    minutes: optional,
  },
  history: { type: en('change'), order: numeric, state: en('state'), reason: en('paymentReason') },
  analyst: { conversations: numeric, newLeads: optional, orders: optional, revenue: optional, bookings: optional },
  incidents: { type: en('incident'), severity: en('severity'), state: en('incidentState') },
  goals: { metric: en('goal'), target: numeric, current: numeric, percent: numeric },
  experiments: {
    type: en('experiment'),
    verdict: en('verdict'),
    ...stats('aSent aReplied bSent bReplied minSample'),
  },
};
export function cleanCard(kind, row) {
  if (!Object.hasOwn(cardTypes, kind)) throw new Error('invalid_card');
  return { kind, at: isoTime(row.at), ...pick(cardTypes[kind], row) };
}
export function cleanCurrent(raw) {
  if (!raw) return null;
  return {
    currency: code('currency', raw.currency),
    hoursKnown: raw.hoursKnown === true,
    minutesPerChat: numeric(raw.minutesPerChat),
    health: pick(
      {
        lastMessage: isoTime,
        ...stats('incidents badMac sessionReset absentMessage retryFailed outboundSent outboundDelivered unacked'),
      },
      raw.health,
    ),
    growth: pick(stats('sent cap optOuts'), raw.growth),
    budget: pick(stats('cap used'), raw.budget),
    drafts: numeric(raw.drafts),
    payments: pick(
      {
        ...stats('pending recheck overdue acceptedToday rejectedToday pendingAmount'),
        avgDecisionMinutes: optional,
        oldest: isoTime,
        reasons: (v) =>
          Object.fromEntries(
            [...enums.paymentReason, 'other'].filter((k) => v?.[k] > 0).map((k) => [k, numeric(v[k])]),
          ),
      },
      raw.payments,
    ),
  };
}
