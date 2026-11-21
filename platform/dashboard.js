// Read model only. None of the customer or operator pages opens a worker DB,
// consumes a journal, or queries usage_events. All list queries are bounded.
import { all, get } from './db.js';
import { bounds } from './reportStore.js';
import { workerFreshness, staleBefore } from './reportFreshness.js';
import { planForTenant, monthlyAllowanceLeft } from './plans.js';
import { validDay, shiftDay, localDateString, DAY_MS } from '../src/services/reportCalendar.js';
import { impactTotals, savedHours } from '../src/services/impactMetrics.js';
import { funnelSteps } from '../src/services/growthDashboard.js';
import { alias } from '../src/services/reportContract.js';
import { platformSecret } from './env.js';

export const pages = ['overview', 'agents', 'leads', 'payments', 'usage', 'analytics', 'health', 'data'];
export const ownerPages = ['payments', 'data'];
export const PAGE_SIZE = 25;
const scalar = (sql, p) => get(sql, p)?.n || 0;
export function selection(slug, q, now) {
  const b = bounds(slug, now),
    range = q.get('range') || '7';
  let first,
    last = b.today;
  if (range === 'custom') {
    first = q.get('from');
    last = q.get('to');
  } else if (['today', '7', '30'].includes(range))
    first = [b.earliest, shiftDay(last, 1 - (range === 'today' ? 1 : +range))].sort().at(-1);
  if (!validDay(first) || !validDay(last) || first > last || first < b.earliest || last > b.today)
    throw new RangeError('outside_retention');
  return { ...b, first, last, range };
}
function offsetFor(q, id) {
  const raw = q.get('p.' + id) || '1';
  if (!/^[1-9]\d{0,5}$/.test(raw)) throw new RangeError('invalid_page');
  return (Number(raw) - 1) * PAGE_SIZE;
}
const usageAgg =
  'SUM(calls) calls,SUM(tokens) tokens,SUM(prompt) inputTokens,SUM(completion) outputTokens,SUM(estimated) estimated,SUM(errors) errors';
const relation =
  'SELECT who,first_at,owner,bot,bookings,orders,revenue,response_ms,outside FROM r_people WHERE slug=? AND day BETWEEN ? AND ?';
const impact = (slug, first, last, hoursKnown = true) =>
  impactTotals(get, relation, [slug, first, last], { hoursKnown });
export function dashboard(slug, name, q = new URLSearchParams(), { owner = false, now = new Date() } = {}) {
  if (!pages.includes(name) || (!owner && ownerPages.includes(name))) throw new Error('not_permitted');
  const b = selection(slug, q, now),
    p = [slug, b.first, b.last],
    span = 'slug=? AND day BETWEEN ? AND ?';
  const st = get('SELECT * FROM r_state WHERE slug=?', [slug]);
  const current = st ? JSON.parse(st.current) : null;
  const plan = planForTenant(slug).plan;
  const observed = get(`SELECT COUNT(*) n,COALESCE(SUM(events_complete),0) complete FROM r_days WHERE ${span}`, p),
    coverage = observed.n;
  const conv = scalar(`SELECT COUNT(DISTINCT who) n FROM r_people WHERE ${span} AND first_at IS NOT NULL`, p);
  const meta = {
    ...b,
    slug,
    page: name,
    owner,
    updated: st?.at || null,
    freshness: workerFreshness(st?.at, now),
    meterUpdated: get('SELECT at FROM r_cursor WHERE slug=?', [slug])?.at || null,
    conversations: coverage ? conv : null,
    thin: coverage > 0 && conv < 20,
    eventDatesComplete: observed.complete,
    covered: coverage,
    expected: 1 + (Date.parse(b.last) - Date.parse(b.first)) / DAY_MS,
    currency: current?.currency || null,
  };
  if (current?.budget) meta.callBudgetUnlimited = current.budget.cap === 0;
  const metrics = {},
    tables = {};
  const meter = (sql, params) => get(`SELECT ${sql} FROM r_usage WHERE hour=-1 AND ${span}`, params);
  function group(id, sql, args = p, map = null) {
    const off = offsetFor(q, id),
      rows = all(`${sql} LIMIT ? OFFSET ?`, [...args, PAGE_SIZE + 1, off]);
    tables[id] = {
      page: off / PAGE_SIZE + 1,
      more: rows.length > PAGE_SIZE,
      rows: rows.slice(0, PAGE_SIZE).map((r) => (map ? map(r) : r)),
    };
  }
  function cards(id, filters = {}, args = p) {
    let sql = `SELECT data FROM r_cards WHERE kind=? AND ${span}`,
      params = [id, ...args];
    for (const [field, key] of Object.entries(filters))
      if (q.get(key)) {
        sql += ` AND ${field}=?`;
        params.push(q.get(key).slice(0, 64));
      }
    if (id === 'activity' && q.get('hour')) {
      const h = q.get('hour');
      if (!/^([01]?\d|2[0-3])$/.test(h)) throw new RangeError('invalid_hour');
      sql += " AND json_extract(data,'$.hour')=?";
      params.push(+h);
    }
    group(id, sql + ' ORDER BY day DESC,at DESC,rowid DESC', params, (r) => JSON.parse(r.data));
  }
  function facts(id, metric, cols = 'a category,SUM(n) count', by = 'a', extra = '') {
    group(
      id,
      `SELECT ${cols} FROM r_facts WHERE metric=? AND hour=-1 AND ${span} ${extra} GROUP BY ${by} ORDER BY SUM(n) DESC,${by}`,
      [metric, ...p],
    );
  }
  const nFact = (metric, a) =>
    scalar(`SELECT SUM(n) n FROM r_facts WHERE metric=? AND a=? AND hour=-1 AND ${span}`, [metric, a, ...p]);
  if (['usage', 'overview'].includes(name)) {
    const month = [b.today.slice(0, 7) + '-01', b.today];
    const used = scalar('SELECT COUNT(DISTINCT who) n FROM r_meter WHERE slug=? AND day BETWEEN ? AND ?', [
      slug,
      ...month,
    ]);
    const allowance = monthlyAllowanceLeft(slug, used);
    metrics.monthlyConversations = used;
    metrics.quotaLeft = allowance.left;
    metrics.quotaLimit = allowance.limit;
    const today = meter('SUM(calls) n', [slug, b.today, b.today]);
    metrics.callsToday = today.n || 0;
    metrics.callsLeft = current?.budget?.cap ? Math.max(0, current.budget.cap - current.budget.used) : null;
  }
  if (name === 'overview') {
    const impactDay = impact(...p, current?.hoursKnown === true);
    Object.assign(metrics, impactDay, {
      leads: nFact('funnel', 'leads'),
      hoursSaved: current ? savedHours(conv, current.minutesPerChat) : null,
    });
    for (const key of ['followUpsSent', 'followUpsAnswered', 'reviewAsks', 'reviewsReceived'])
      metrics[key] = nFact('impact', key);
    if (!coverage)
      for (const k of [
        ...Object.keys(impactDay),
        'leads',
        'hoursSaved',
        'followUpsSent',
        'followUpsAnswered',
        'reviewAsks',
        'reviewsReceived',
      ])
        metrics[k] = null;
    if (owner) metrics.pending = current?.payments.pending ?? null;
    Object.assign(metrics, {
      growthSentToday: current?.growth.sent ?? null,
      growthCap: current?.growth.cap ?? null,
      optOuts: current?.growth.optOuts ?? null,
    });
    const snapshotDay = st ? localDateString(new Date(st.at), b.zone) : b.today;
    cards('goals', {}, [slug, snapshotDay, snapshotDay]);
    facts('growth', 'growth', 'a agent,b outcome,SUM(n) count', 'a,b');
    // Compare equal length trailing weeks, neither a partial calendar week nor
    // a forecast. Never call missing history zero growth.
    const first = shiftDay(b.last, -6),
      prior = shiftDay(b.last, -13);
    const full =
      prior >= b.earliest &&
      scalar('SELECT COUNT(*) n FROM r_days WHERE slug=? AND day BETWEEN ? AND ?', [slug, prior, b.last]) === 14;
    const weekCovered =
      scalar('SELECT COUNT(*) n FROM r_days WHERE slug=? AND day BETWEEN ? AND ?', [slug, first, b.last]) === 7;
    const currentWeek = weekCovered ? impact(slug, first, b.last) : {},
      prev = full ? impact(slug, prior, shiftDay(first, -1)) : {};
    tables.week = {
      rows: ['conversations', 'automationRate', 'orders', 'revenue'].map((metric) => ({
        metric,
        thisWeek: currentWeek[metric] ?? null,
        previous: prev[metric] ?? null,
        changePercent: prev[metric] ? Math.round((currentWeek[metric] / prev[metric] - 1) * 1000) / 10 : null,
      })),
    };
  }
  if (name === 'agents') {
    group(
      'agents',
      `WITH agents AS (SELECT a agent,SUM(CASE WHEN b='handoff' THEN n ELSE 0 END) handoffs,SUM(CASE WHEN b IN ('order','booking') THEN n ELSE 0 END) resolved,
      SUM(CASE WHEN b='first_reply' THEN value END)/NULLIF(SUM(CASE WHEN b='first_reply' THEN n END)*1000.0,0) latencySeconds FROM r_facts WHERE metric='agent' AND hour=-1 AND ${span} GROUP BY a),
      routed AS (SELECT agent,COUNT(DISTINCT contact) conversations FROM r_cards WHERE kind='activity' AND type='route' AND ${span} GROUP BY agent),
      usage AS (SELECT agent,SUM(errors) errors FROM r_usage WHERE hour=-1 AND ${span} GROUP BY agent)
      SELECT ids.agent,COALESCE(conversations,0) conversations,COALESCE(handoffs,0) handoffs,COALESCE(resolved,0) resolved,COALESCE(handoffs,0) escalated,ROUND(latencySeconds,1) latencySeconds,COALESCE(errors,0) errors
      FROM (SELECT agent FROM agents UNION SELECT agent FROM usage) ids LEFT JOIN agents USING(agent) LEFT JOIN routed USING(agent) LEFT JOIN usage USING(agent) ORDER BY conversations DESC,ids.agent`,
      [...p, ...p, ...p],
    );
    facts('decisions', 'decision', 'a action,b reason,SUM(n) count', 'a,b');
    cards('activity', { type: 'type', agent: 'agent', contact: 'contact', outcome: 'outcome' });
    cards('analyst');
  }
  if (name === 'leads') {
    tables.pipeline = {
      rows: all(
        `SELECT outcome stage,COUNT(*) count FROM r_cards WHERE kind='leads' AND ${span} GROUP BY outcome ORDER BY count DESC`,
        p,
      ),
    };
    cards('leads', { outcome: 'stage', contact: 'contact' });
  }
  if (name === 'payments') {
    Object.assign(metrics, current?.payments || {});
    delete metrics.reasons;
    tables.rejections = {
      rows: Object.entries(current?.payments.reasons || {}).map(([reason, count]) => ({ reason, count })),
    };
    facts('transitions', 'transition', 'a state,b reason,SUM(n) count', 'a,b');
    facts('states', 'payment', 'a state,b reason,SUM(n) count', 'a,b');
    cards('payments', { order_ref: 'order', outcome: 'state' });
    cards('history', { order_ref: 'order' });
  }
  if (name === 'usage') {
    for (const [k, v] of Object.entries(meter(usageAgg, p))) metrics[k] = v || 0;
    metrics.messages = scalar(`SELECT SUM(n) n FROM r_facts WHERE metric='messages' AND hour=-1 AND ${span}`, p);
    const seconds = (args) =>
      scalar(`SELECT SUM(value) n FROM r_facts WHERE metric='voice' AND hour=-1 AND ${span}`, args);
    metrics.voiceMinutes = Math.round(seconds(p) / 6) / 10;
    metrics.voiceMinutesLeft = Math.max(
      0,
      (plan.limits.voice_minutes || 0) - seconds([slug, b.today.slice(0, 7) + '-01', b.today]) / 60,
    );
    const media = Object.fromEntries(
      all(`SELECT a,SUM(n) n FROM r_facts WHERE metric='media' AND hour=-1 AND ${span} GROUP BY a`, p).map((r) => [
        r.a,
        r.n,
      ])
    );
    metrics.videoEntitlement = plan.limits.videos_month;
    metrics.monthlyVideos = st
      ? scalar(`SELECT SUM(n) n FROM r_facts WHERE metric='media' AND a='videos' AND hour=-1 AND ${span}`, [
          slug,
          b.today.slice(0, 7) + '-01',
          b.today,
        ])
      : null;
    metrics.videosProcessed = coverage ? media.processed || 0 : null;
    metrics.videosRefused = coverage ? media.refused || 0 : null;
    metrics.mediaProviderErrors = coverage ? media.errors || 0 : null;
    metrics.voiceReplyLanguage = media.voice ? Math.round((100 * (media.correct || 0)) / media.voice) : null;
    const clips = (media.processed || 0) + (media.refused || 0);
    metrics.videoProcessingMs = clips ? Math.round((media.video_ms || 0) / clips) : null;
    if (!coverage) metrics.voiceMinutes = metrics.messages = null;
    if (!st) metrics.voiceMinutesLeft = null;
    for (const [id, column] of Object.entries({
      daily: 'day',
      monthly: 'substr(day,1,7)',
      providers: 'provider',
      models: 'provider,model',
      keys: 'provider,slot,key_id,version',
      agentsUsage: 'agent',
      kinds: 'kind',
    }))
      group(
        id,
        `SELECT ${id === 'monthly' ? column + ' month' : column},${usageAgg} FROM r_usage WHERE hour=-1 AND ${span} GROUP BY ${column} ORDER BY ${['daily', 'monthly'].includes(id) ? column + ' DESC' : 'SUM(tokens) DESC,' + column}`,
      );
  }
  if (name === 'analytics') {
    const counts = Object.fromEntries(
      all(`SELECT a,SUM(n) n FROM r_facts WHERE metric='funnel' AND hour=-1 AND ${span} GROUP BY a`, p).map(
        (r) => [r.a, r.n],
      ),
    );
    tables.funnel = {
      rows: funnelSteps({
        leads: 0,
        orders: 0,
        quotes: 0,
        paid: 0,
        reviewed: 0,
        ...counts,
        conversations: conv,
      }).map(({ label, value, fromPrevious, fromTop }) => ({ step: label, count: value, fromPrevious, fromTop })),
    };
    group(
      'sources',
      `WITH s AS (SELECT a source,SUM(CASE WHEN b='leads' THEN n ELSE 0 END) leads,SUM(CASE WHEN b='paid' THEN n ELSE 0 END) orders,SUM(value) revenue FROM r_facts WHERE metric='source' AND hour=-1 AND ${span} GROUP BY a),
      c AS (SELECT source,COUNT(DISTINCT who) conversations FROM r_people WHERE ${span} AND first_at IS NOT NULL GROUP BY source)
      SELECT source,COALESCE(conversations,0) conversations,COALESCE(leads,0) leads,COALESCE(orders,0) paidOrders,COALESCE(revenue,0) revenue FROM (SELECT source FROM s UNION SELECT source FROM c) LEFT JOIN s USING(source) LEFT JOIN c USING(source) ORDER BY revenue DESC,source`,
      [...p, ...p],
    );
    if (!coverage) tables.funnel.rows = [];
    tables.heatmap = {
      rows: all(
        `SELECT CAST(strftime('%w',day) AS INTEGER) weekday,hour,SUM(n) count FROM r_facts WHERE metric='messages' AND a='user' AND hour>=0 AND ${span} GROUP BY weekday,hour ORDER BY weekday,hour`,
        p,
      ),
    };
    for (const id of ['question', 'unanswered', 'intent', 'review']) facts(id, id);
    group(
      'objections',
      `SELECT a category,SUM(n) count FROM r_facts WHERE metric='objection' AND hour=-1 AND ${span} GROUP BY a HAVING SUM(n)>1 ORDER BY count DESC,a`,
    );
    facts('accuracy', 'accuracy');
    cards('experiments');
    metrics.reviewDrafts = current?.drafts ?? null;
  }
  if (['usage', 'overview'].includes(name) && !meta.meterUpdated) {
    for (const k of [
      'monthlyConversations',
      'quotaLeft',
      'callsToday',
      'calls',
      'tokens',
      'inputTokens',
      'outputTokens',
      'estimated',
      'errors',
    ])
      if (k in metrics) metrics[k] = null;
  }
  if (name === 'health') {
    const t = get('SELECT link_status,status FROM tenants WHERE slug=?', [slug]);
    Object.assign(metrics, { connection: t.link_status, status: t.status, ...current?.health });
    cards('incidents');
    group(
      'keyHealth',
      "SELECT provider,slot,health,last_used_at lastUsed FROM tenant_keys WHERE slug=? AND status='active' ORDER BY provider,slot",
      [slug],
    );
  }
  if (name === 'data') {
    metrics.retentionDays = b.days;
    metrics.oldestAllowed = b.earliest;
    metrics.coveredDays = coverage;
  }
  return { meta, metrics, tables };
}

// Flat export rows, never a tenant DB dump. Consumers can join facts by local
// date/hour. Separate lead export contains masked lead projections only.
export function exportRows(slug, b, kind, limit, offset) {
  const args = [slug, b.first, b.last],
    span = 'slug=? AND day BETWEEN ? AND ?';
  if (kind === 'leads')
    return all(`SELECT data FROM r_cards WHERE kind='leads' AND ${span} ORDER BY day,at,rowid LIMIT ? OFFSET ?`, [
      ...args,
      limit,
      offset,
    ]).map((r) => JSON.parse(r.data));
  return all(
    `SELECT day,hour,metric,a,b,'' agent,'' kind,0 slot,0 version,'' key_id,'' category,n count,value,0 estimated,0 errors FROM r_facts WHERE ${span}
    UNION ALL SELECT day,hour,'usage',provider,model,agent,kind,slot,version,key_id,category,calls,tokens,estimated,errors FROM r_usage WHERE ${span}
    UNION ALL SELECT day,-1,'impact',source,'distinct inbound','','',0,0,'','',COUNT(DISTINCT CASE WHEN first_at IS NOT NULL THEN who END),SUM(revenue),0,0 FROM r_people WHERE ${span} GROUP BY day,source
    ORDER BY 1,2,3,4,5,6,7,8,9,10,11 LIMIT ? OFFSET ?`,
    [...args, ...args, ...args, limit, offset],
  );
}
export function operatorOverview(q, now = new Date()) {
  const off = offsetFor(q, 'tenants');
  const tenants = all('SELECT slug,status,plan_id,trial_ends_at FROM tenants ORDER BY slug LIMIT ? OFFSET ?', [
    PAGE_SIZE + 1,
    off,
  ]);
  const fleet = get(
    `SELECT MAX(s.at) updated, COUNT(CASE WHEN t.status='active' THEN 1 END) active,
    COUNT(CASE WHEN t.status='active' AND s.at<? THEN 1 END) stale,
    COUNT(CASE WHEN t.status='active' AND s.at IS NULL THEN 1 END) missing
    FROM tenants t LEFT JOIN r_state s ON t.slug=s.slug`,
    [staleBefore(now)]
  );
  const rows = tenants.slice(0, PAGE_SIZE).map((t) => {
    const { today } = bounds(t.slug, now),
      state = get('SELECT current,at FROM r_state WHERE slug=?', [t.slug]);
    const h = state ? JSON.parse(state.current).health : null;
    const used = scalar('SELECT COUNT(DISTINCT who) n FROM r_meter WHERE slug=? AND day BETWEEN ? AND ?', [
      t.slug,
      today.slice(0, 7) + '-01',
      today,
    ]);
    return {
      tenant: alias(t.slug, platformSecret(), 'operator'),
      plan: t.plan_id,
      status: t.status,
      workerReport: workerFreshness(state?.at, now),
      lastActive:
        [h?.lastMessage, get('SELECT last_call FROM r_cursor WHERE slug=?', [t.slug])?.last_call]
          .filter(Boolean)
          .sort()
          .at(-1) || null,
      quotaLeft: get('SELECT id FROM r_cursor WHERE slug=?', [t.slug])
        ? (monthlyAllowanceLeft(t.slug, used)?.left ?? null)
        : null,
      keyErrors: scalar(
        "SELECT COUNT(*) n FROM tenant_keys WHERE slug=? AND status='active' AND health IN ('invalid','rate_limited','quota','failing')",
        [t.slug],
      ),
      incidents: h?.incidents ?? null,
      trialEnds: t.trial_ends_at,
    };
  });
  return {
    meta: { page: 'operator', updated: fleet.updated, freshness: workerFreshness(fleet.updated, now),
      staleWorkers: fleet.stale, missingWorkers: fleet.missing },
    metrics: { activeTenants: fleet.active },
    tables: {
      tenants: { rows, page: off / PAGE_SIZE + 1, more: tenants.length > PAGE_SIZE },
      providerTotals: {
        rows: all(
          'SELECT provider,SUM(calls) calls,SUM(tokens) tokens,SUM(errors) errors FROM r_usage WHERE hour=-1 GROUP BY provider ORDER BY calls DESC',
        ),
      },
    },
  };
}
