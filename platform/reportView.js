import {billingEnabled} from './env.js';
import { page, esc } from './views.js';
import { definitions, definitionFor } from './reportMetrics.js';
import { pages, ownerPages } from './dashboard.js';
import { STALE_MINUTES } from './reportFreshness.js';
const titles = {
  overview: 'Overview',
  agents: 'Agents & activity',
  leads: 'Leads',
  payments: 'Payments & decisions',
  usage: 'Usage',
  analytics: 'Analytics',
  health: 'Health',
  data: 'Export & data',
  operator: 'Fleet health',
};
const subtitles = {
  overview: 'What changed in your conversations, and where your team stepped in.',
  agents: 'See which agents answered, handed off, or needed help.',
  leads: 'Follow new inquiries through to a paid order.',
  payments: 'Review the queue here. Accept, reject or recheck only in WhatsApp.',
  usage: 'Understand provider activity without confusing estimates with a bill.',
  analytics: 'Find where customers progress, get stuck or need a better answer.',
  health: 'The last observed connection, transport and key state.',
  data: 'Download your own records and check how long they are kept.',
  operator: 'Read-only operations. No chat content, phone numbers or contact handles.',
};
const human = (k) =>
  String(k)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ');
const show = (v) =>
  v == null
    ? '—'
    : Array.isArray(v)
      ? v.join(', ') || '—'
      : typeof v === 'number'
        ? v.toLocaleString('en', { maximumFractionDigits: 2 })
        : String(v);
const base = (m) => `/platform/reports/${encodeURIComponent(m.slug)}`;
const link = (label, url, active = false) =>
  `<a class="chip${active ? ' selected' : ''}" ${active ? 'aria-current="page"' : ''} href="${esc(url)}">${esc(label)}</a>`;
const field = (name, label, value = '', type = 'text', attrs = '') =>
  `<label>${esc(label)}<input type="${type}" name="${esc(name)}" value="${esc(value)}" ${attrs}></label>`;
function stamp({ minutes, state }) {
  return state === 'missing' ? 'Updated: unknown' : `Updated ${minutes} min ago`;
}
function workerNotice({ minutes, state }) {
  if (state === 'fresh') return '';
  const message =
    state === 'missing'
      ? 'No worker report available. Awaiting a worker snapshot.'
      : `Worker report overdue: no report received for ${minutes} min. Showing the last snapshot.`;
  return `<strong class="worker-warning" role="status">${message}</strong>`;
}
function heat(rows) {
  const max = Math.max(1, ...rows.map((r) => r.count)),
    map = new Map(rows.map((r) => [r.weekday + '-' + r.hour, r.count]));
  return `<svg viewBox="0 0 324 106" role="img" aria-label="Heatmap: inbound messages by weekday and hour"><text x="24" y="9">00</text><text x="96" y="9">06</text><text x="168" y="9">12</text><text x="240" y="9">18</text>${[
    'S',
    'M',
    'T',
    'W',
    'T',
    'F',
    'S',
  ]
    .map(
      (day, d) =>
        `<text x="4" y="${22 + d * 12}">${day}</text>` +
        Array.from({ length: 24 }, (_, h) => {
          const n = map.get(d + '-' + h) || 0;
          return `<rect x="${24 + h * 12}" y="${13 + d * 12}" width="10" height="10" rx="2" fill-opacity="${0.08 + (0.92 * n) / max}"><title>${day} ${h}:00 · ${n}</title></rect>`;
        }).join(''),
    )
    .join('')}</svg>`;
}
function chart(rows, key) {
  if (!rows.length) return '';
  const ordered = key === 'count' ? rows : [...rows].reverse(),
    max = Math.max(1, ...ordered.map((r) => r[key])),
    w = 300 / ordered.length;
  return `<svg role="img" aria-label="${esc(key)} by bucket; values in table below" viewBox="0 0 300 60">${ordered.map((r, i) => `<rect x="${i * w}" y="${56 - (52 * r[key]) / max}" width="${Math.max(1, w - 2)}" height="${(52 * r[key]) / max}" rx="2"><title>${esc(r.day || r.month || r.step)} · ${esc(show(r[key]))}</title></rect>`).join('')}</svg>`;
}
export function reportPage({ meta: m, metrics, tables }, query) {
  const name = m.page,
    op = name === 'operator',
    defIds = new Set();
  function help(key) {
    const id = definitionFor(name, key);
    defIds.add(id);
    return `<a class="help" aria-label="Definition: ${esc(definitions[id]?.[0] || id)}" href="#def-${esc(id)}">?</a>`;
  }
  function params(changes) {
    const q = new URLSearchParams(query);
    for (const [k, v] of Object.entries(changes))
      if (v === null) q.delete(k);
      else q.set(k, v);
    return '?' + q;
  }
  function hidden(keys) {
    return keys
      .filter((k) => query.has(k))
      .map((k) => `<input type="hidden" name="${k}" value="${esc(query.get(k))}">`)
      .join('');
  }
  const rangeKeys = ['range', 'from', 'to'];
  const filters = {
    agents: [
      ['type', 'Activity type'],
      ['agent', 'Agent'],
      ['contact', 'Contact ID'],
      ['outcome', 'Outcome'],
      ['hour', 'Business hour (0–23)'],
    ],
    leads: [
      ['stage', 'Stage'],
      ['contact', 'Contact ID'],
    ],
    payments: [
      ['order', 'Order ID'],
      ['state', 'State'],
    ],
  }[name];
  const ranges = op
    ? ''
    : `<div class="range" aria-label="Date range">${[
        ['today', 'Today'],
        ['7', '7 days'],
        ['30', '30 days'],
      ]
        .map(([v, l]) => link(l, '?range=' + v, m.range === v))
        .join(
          '',
        )}<details ${m.range === 'custom' ? 'open' : ''}><summary>Custom dates</summary><form class="filters"><input type="hidden" name="range" value="custom">${field('from', 'From', m.first, 'date', `min="${m.earliest}" max="${m.today}" required`)}${field('to', 'Through', m.last, 'date', `min="${m.earliest}" max="${m.today}" required`)}<button>Apply dates</button></form></details></div>`;
  const navigation = op
    ? ''
    : `<nav class="chips" aria-label="Dashboard sections">${pages
        .filter((k) => m.owner || !ownerPages.includes(k))
        .map((k) =>
          link(
            titles[k],
            base(m) +
              '/' +
              k +
              '?' +
              new URLSearchParams(rangeKeys.filter((key) => query.has(key)).map((key) => [key, query.get(key)])),
            k === name,
          ),
        )
        .join('')}</nav>`;
  const mediaKeys = new Set([
    'videoEntitlement',
    'monthlyVideos',
    'videosProcessed',
    'videosRefused',
    'voiceReplyLanguage',
    'videoProcessingMs',
    'mediaProviderErrors',
  ]);
  const metricCards = (media = false) =>
    Object.entries(metrics)
      .filter(([k]) => mediaKeys.has(k) === media)
      .map(
        ([k, v]) =>
          `<article class="metric"><div>${esc(definitions[k]?.[0] || human(k))} ${help(k)}</div><strong>${esc((k === 'quotaLeft' && metrics.quotaLimit === 0) || (k === 'callsLeft' && m.callBudgetUnlimited) ? 'Unlimited' : show(v))}</strong>${k === 'quotaLeft' && metrics.quotaLimit > 0 ? `<progress aria-label="Monthly conversation usage" max="${metrics.quotaLimit}" value="${metrics.monthlyConversations}"></progress>` : ''}${['botOrders', 'botBookings', 'botRevenue'].includes(k) ? '<small>Estimated attribution</small>' : ''}</article>`
      )
      .join('');
  const metricsHtml = metricCards();
  const mediaPanel =
    name === 'usage'
      ? `<section aria-label="Media intelligence"><h2>Voice and video</h2><div class="metrics">${metricCards(true)}</div></section>`
      : '';
  const filterForm = filters
    ? `<details class="panel" ${filters.some(([k]) => query.has(k)) ? 'open' : ''}><summary>Filter ${name === 'agents' ? 'activity' : name}</summary><form class="filters">${hidden(rangeKeys)}${filters.map(([k, l]) => field(k, l, query.get(k) || '')).join('')}<button>Apply filters</button></form></details>`
    : '';
  function section([id, t]) {
    const rows = t.rows,
      columns = Object.keys(rows[0] || {}).filter((k) => k !== 'kind' || !rows[0].at);
    const pager =
      t.more || t.page > 1
        ? `<div class="pager">${t.page > 1 ? link('Previous', params({ ['p.' + id]: t.page - 1 })) : ''}<span>Page ${t.page}</span>${t.more ? link('Next', params({ ['p.' + id]: t.page + 1 })) : ''}</div>`
        : '';
    const brief = id === 'leads' && m.owner;
    function cell(k, row) {
      if (k === 'workerReport') return stamp(row[k]) + workerNotice(row[k]);
      if (k === 'order' && row[k])
        return `<a href="${esc(params({ order: row[k], 'p.history': 1 }))}">${esc(row[k])}</a>`;
      return esc(show(row[k]));
    }
    return `<section class="panel"><h2>${esc(definitions[definitionFor(name, id)]?.[0] || human(id))} ${help(id)}</h2>${id === 'accuracy' ? '<p class="small">Price mismatches: target 0. Blocked is not sent. Owner edits/corrections: not instrumented.</p>' : ''}${id === 'heatmap' ? (m.covered ? heat(rows) : '') : ['daily', 'monthly', 'funnel'].includes(id) ? chart(rows, id === 'funnel' ? 'count' : 'calls') : ''}${!rows.length ? '<p class="small">No observations in this selection.</p>' : id === 'heatmap' ? '' : `<div class="table-wrap" tabindex="0"><table><thead><tr>${columns.map((k) => `<th>${esc(human(k))}</th>`).join('')}${brief ? '<th>Intake brief</th>' : ''}</tr></thead><tbody>${rows.map((r) => `<tr ${id === 'accuracy' && r.category === 'priceMismatch' && r.count > 0 ? 'class="red"' : ''}>${columns.map((k) => `<td>${cell(k, r)}</td>`).join('')}${brief ? `<td><button data-brief="${esc(r.contact)}">Open brief</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`}${pager}</section>`;
  }
  const note = op
    ? `Latest worker snapshot · <b>${stamp(m.freshness)}</b> · Operator authentication${m.staleWorkers || m.missingWorkers ? `<strong class="worker-warning" role="status">Active workers: ${m.staleWorkers} overdue (over ${STALE_MINUTES} min without a report); ${m.missingWorkers} with no worker report.</strong>` : ''}`
    : `<b>${stamp(m.freshness)}</b> · ${esc(m.zone)} · ${esc(m.first)} — ${esc(m.last)}${m.currency ? ' · ' + esc(m.currency) : ''}<br>${m.covered}/${m.expected} dates published${m.covered < m.expected ? ' · partial history, missing dates are unknown' : ''}${m.eventDatesComplete < m.covered ? ' · event-based counts are lower bounds before archive coverage' : ''}${m.thin ? ' · Thin data: fewer than 20 conversations. Read counts before percentages.' : ''}${workerNotice(m.freshness)}`;
  const download = (kind, format) =>
    `<button data-export="${kind}" data-format="${format}">Download ${kind} ${format.toUpperCase()}</button>`;
  const actions =
    name === 'data'
      ? `<section class="panel"><h2>Your data</h2><p>Export aggregate facts for this date selection, not messages, keys or proof files.</p><div class="chips">${download('aggregates', 'json')}${download('aggregates', 'csv')}</div><p>For your account export and confirmed deletion, use <a href="/platform/app#account-data">account data controls</a>.</p></section>`
      : name === 'leads' && m.owner
        ? `<section class="panel"><h2>Owner tools</h2>${download('leads', 'csv')}<p class="small">Collected brief values open only at your own live inbox, with its separate owner token.</p></section>`
        : name === 'usage' && m.owner && metrics.tokens != null
          ? `<details class="panel"><summary>Estimate at my own BYOK rate</summary><p>No platform price. This optional blended estimate stays in this tab; provider terms and actual charges may differ.</p><label>Your rate per million tokens (your currency)<input id="rate" type="number" min="0" step="any"></label><output id="estimate" data-tokens="${metrics.tokens}"></output></details>`
          : '';
  return page({
    title: titles[name] + ' · Assistant reports',
    head: '<link rel="stylesheet" href="/platform/reports.css">',
    script: op ? '' : '<script type="module" src="/platform/reports.js"></script>',
    body: `<main class="reports" ${op ? '' : `data-slug="${esc(m.slug)}"`}><header><div class="kicker">${op ? 'Platform / operations' : 'Assistant / reports'}</div>${op ? '' : `<a href="/platform/app">Back to assistants</a>`}${billingEnabled() ? ` · <a href="${op ? '/platform/operator/billing' : '/platform/billing/' + esc(m.slug)}">Billing</a>` : ''}</header>${navigation}<h1>${titles[name]}</h1><p class="lede">${subtitles[name]}</p>${ranges}<p class="stamp">${note}${['overview', 'usage'].includes(name) ? `<br>Usage ledger: ${m.meterUpdated ? `updated ${Math.max(0, Math.floor((Date.now() - Date.parse(m.meterUpdated)) / 60000))} min ago` : 'awaiting usage import'}` : ''}</p>${filterForm}<div class="metrics">${metricsHtml}</div>${mediaPanel}${Object.entries(tables).map(section).join('')}${actions}<p id="notice" role="status"></p><details id="glossary" class="panel" ${op ? 'open' : ''}><summary>Metric definitions</summary><dl>${[...defIds].map((id) => `<dt id="def-${esc(id)}">${esc(definitions[id]?.[0] || id)}</dt><dd>${esc(definitions[id]?.[1] || '')}</dd>`).join('')}</dl></details></main>`,
  });
}
