import { dashboard, operatorOverview, pages, ownerPages, selection, exportRows } from './dashboard.js';
import { reportPage } from './reportView.js';
import { sendJson, sendHtml, readJsonBody, PLATFORM_HEADERS } from './http.js';
import { safeEqual, rateLimit } from '../src/services/adminPanel.js';
import { getTenantSecret, tenantForAccount } from './provisioning.js';
import { recordAudit } from './audit.js';
import { get } from './db.js';
import { briefGrant } from '../src/services/reportBrief.js';
import { bounds } from './reportStore.js';

import { operatorConfigured, operatorAuthorised } from './operatorAuth.js';

export function operatorRoute(req, res, url) {
  if (!operatorConfigured()) return sendJson(res, 404, { error: 'not_found' });
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'read_only' });
  if (!operatorAuthorised(req, res)) return;
  try {
    const d = operatorOverview(url.searchParams);
    return url.pathname.startsWith('/api/')
      ? sendJson(res, 200, d)
      : sendHtml(res, 200, reportPage(d, url.searchParams));
  } catch (e) {
    if (e instanceof RangeError) return sendJson(res, 400, { error: 'invalid_page' });
    throw e;
  }
}
const csvField = (v) =>
  '"' +
  String(Array.isArray(v) ? v.join('|') : (v ?? ''))
    .replace(/^[=+@\-\t\r]/, "'$&")
    .replaceAll('"', '""') +
  '"';
async function download(req, res, url, { slug, accountId, who, ip }) {
  if (!who.csrf || !safeEqual(req.headers['x-platform-csrf'] || '', who.csrf))
    return sendJson(res, 403, { error: 'csrf' });
  const body = await readJsonBody(req);
  if (!body.ok) return sendJson(res, body.status || 400, { error: body.error });
  // Body reads yield. Do not export under stale membership after awaiting one.
  if (tenantForAccount(accountId, slug)?.member_role !== 'owner')
    return sendJson(res, 403, { error: 'owner_only' });
  const { format, kind } = body.body;
  if (!['csv', 'json'].includes(format) || !['leads', 'aggregates'].includes(kind))
    return sendJson(res, 400, { error: 'invalid_export' });
  const b = selection(slug, url.searchParams, new Date());
  const limited = rateLimit('report-export:' + accountId + ':' + slug, { max: 4, windowMs: 3600000 });
  if (!limited.ok) return sendJson(res, 429, { error: 'export_limit', retryAfter: limited.retryAfter });
  recordAudit({
    action: 'dashboard_export',
    accountId,
    tenant: slug,
    ip,
    detail: { format, kind, from: b.first, to: b.last },
  });
  const snapshot = kind === 'aggregates' ? dashboard(slug, 'overview', url.searchParams, { owner: true }) : null;
  res.writeHead(200, {
    ...PLATFORM_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
    'Content-Disposition': `attachment; filename="${slug}-${kind}.${format}"`,
  });
  const meta = { version: 1, from: b.first, to: b.last, zone: b.zone, updated: snapshot?.meta.updated };
  if (format === 'json') res.write(JSON.stringify(meta).slice(0, -1) + ',"rows":[');
  const cols =
    kind === 'leads'
      ? ['kind', 'at', 'contact', 'stage', 'nextAction', 'reason', 'score', 'source', 'assigned', 'tags']
      : [
          'day',
          'hour',
          'metric',
          'a',
          'b',
          'agent',
          'kind',
          'slot',
          'version',
          'key_id',
          'category',
          'count',
          'value',
          'estimated',
          'errors',
        ];
  if (format === 'csv') res.write(cols.map(csvField).join(',') + '\r\n');
  let offset = 0,
    started = false;
  for (const [key, value] of Object.entries(snapshot?.metrics || {})) {
    const row = { day: b.last, hour: -1, metric: 'selection', a: key, value };
    res.write(
      format === 'csv'
        ? cols.map((k) => csvField(row[k])).join(',') + '\r\n'
        : (started ? ',' : '') + JSON.stringify(row),
    );
    started = true;
  }
  for (;;) {
    const batch = exportRows(slug, b, kind, 500, offset);
    if (!batch.length) break;
    const chunk =
      format === 'csv'
        ? batch.map((row) => cols.map((k) => csvField(row[k])).join(',') + '\r\n').join('')
        : (started ? ',' : '') + batch.map((row) => JSON.stringify(row)).join(',');
    started = true;
    if (!res.write(chunk) && !res.destroyed)
      await new Promise((resolve) => {
        const done = () => {
          res.off('close', done);
          res.off('drain', done);
          resolve();
        };
        res.once('drain', done);
        res.once('close', done);
      });
    if (res.destroyed) return;
    if (batch.length < 500) break;
    offset += batch.length;
    if (tenantForAccount(accountId, slug)?.member_role !== 'owner') {
      res.destroy();
      return;
    }
  }
  res.end(format === 'json' ? ']}' : '');
}
export async function reportRoute(req, res, url, ctx) {
  const { slug, rest, owner, html } = ctx,
    name = rest.slice('/reports/'.length);
  if ((ownerPages.includes(name) || name === 'export' || name.startsWith('brief/')) && !owner)
    return sendJson(res, 403, { error: 'owner_only' });
  try {
    if (name === 'export' && req.method === 'POST' && !html) return await download(req, res, url, ctx);
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'read_only' });
    if (!html && /^brief\/id-[a-p]{16}$/.test(name)) {
      const contact = name.slice(6),
        { today, earliest } = bounds(slug);
      if (
        !get("SELECT 1 FROM r_cards WHERE slug=? AND kind='leads' AND contact=? AND day BETWEEN ? AND ? LIMIT 1", [
          slug,
          contact,
          earliest,
          today,
        ])
      )
        return sendJson(res, 404, { error: 'not_found' });
      const secret = getTenantSecret(slug, 'PLATFORM_TENANT_TOKEN');
      if (!secret) return sendJson(res, 409, { error: 'worker_not_ready' });
      const until = String(Date.now() + 300000);
      return sendJson(res, 200, {
        path: `/api/inbox/brief/${contact}?until=${until}&grant=${briefGrant(contact, until, secret)}`,
        origin: (process.env.PLATFORM_INBOX_ORIGIN || '').replace('{slug}', slug) || null,
      });
    }
    if (!pages.includes(name)) return sendJson(res, 404, { error: 'not_found' });
    const d = dashboard(slug, name, url.searchParams, { owner });
    return html ? sendHtml(res, 200, reportPage(d, url.searchParams)) : sendJson(res, 200, d);
  } catch (e) {
    if (e instanceof RangeError) return sendJson(res, 400, { error: e.message });
    throw e;
  }
}
