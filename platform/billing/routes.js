import { asActor } from './audit.js';
import { billingEnabled } from '../env.js';
import { readSession } from '../session.js';
import { sendHtml, sendJson, readJsonBody, clientIp, PLATFORM_HEADERS } from '../http.js';
import { safeEqual, rateLimit } from '../../src/services/adminPanel.js';
import { tenantForAccount, destroyTenant } from '../provisioning.js';
import { getAccount, exportTokenValid, consentStatus } from '../accounts.js';
import { flush } from '../db.js';
import { withWorker } from '../keys.js';
import { operatorAuthorised, operatorSession } from '../operatorAuth.js';
import { page } from '../views.js';
import { ManualProvider, invoice, reviewPayment, priceUpgrade, documentPDF, uuid } from './payments.js';
import { readProof, recheck, uploadProof } from './proofs.js';
import { MAX_BYTES, prepareUpload } from './proofInput.js';
import { publishPlan, configure } from './catalog.js';
import { entitlementsFor, changeSubscription, subscription } from './subscriptions.js';
import { bootstrapBilling, syncWorker } from './jobs.js';
import { operations, customerView } from './overview.js';
import { BillingError, need } from './rules.js';
const manual = new ManualProvider();
function shell(res, op, slug = '') {
  return sendHtml(
    res,
    200,
    page({
      title: op ? 'Billing operations' : 'Plans and billing',
      head: '<link rel="stylesheet" href="/platform/billing.css">',
      body: `<main id="billing" data-slug="${slug}" data-operator="${op ? 1 : 0}"><header><a href="${op ? '/platform/operator' : '/platform/app'}">← ${op ? 'Operations' : 'My assistants'}</a></header><h1>${op ? 'Billing operations' : 'Plans and billing'}</h1><p id="notice" role="status" aria-live="polite"></p><div id="content">Loading…</div></main>`,
      script: '<script type="module" src="/platform/billing.js"></script>',
    })
  );
}
function fail(res, err) {
  return sendJson(res, err instanceof BillingError ? err.status : 503, {
    error: err instanceof BillingError ? err.message : 'billing_temporarily_unavailable',
  });
}
async function body(req, limit) {
  const r = await readJsonBody(req, { limit });
  need(r.ok, r.error || 'invalid_body', r.status || 400);
  return r.body;
}
function rate(key, max = 60) {
  need(rateLimit('billing:' + key, { max, windowMs: 60000 }).ok, 'too_many_requests', 429);
}
function tenantAuth(req, slug, write = false) {
  const who = readSession(req);
  need(who.ok, 'unauthorised', 401);
  const a = getAccount(who.accountId);
  need(a?.status === 'active' && consentStatus(a).ok, 'unauthorised', 401);
  const t = tenantForAccount(a.id, slug);
  need(t, 'not_found', 404);
  if (write) {
    need(t.member_role === 'owner', 'owner_only', 403);
    need(who.csrf && safeEqual(req.headers['x-platform-csrf'] || '', who.csrf), 'csrf', 403);
  }
  return { t, who, owner: t.member_role === 'owner' };
}
async function pdf(res, slug, kind, id, guard) {
  const file = await documentPDF(slug, kind, id);
  guard();
  res.writeHead(200, {
    ...PLATFORM_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${file.number}.pdf"`,
  });
  res.end(file.data);
}
export async function customerRoute(req, res, { slug, rest, html }) {
  try {
    need(billingEnabled(), 'not_found', 404);
    const write = req.method === 'POST',
      auth = () => tenantAuth(req, slug, write),
      { t, owner, who } = auth();
    rate(who.accountId, 120);
    bootstrapBilling();
    const sid = subscription(slug)?.sid;
    need(sid, 'finish_provisioning', 409);
    const sameTerm = () => need(subscription(slug)?.sid === sid, 'not_found', 404);
    if (!write) {
      need(req.method === 'GET', 'method_not_allowed', 405);
      if (html) return shell(res, false, slug);
      if (rest === '/billing') return sendJson(res, 200, customerView(slug, owner));
      const [, kind, id] = rest.split('/').slice(1);
      need(uuid(id) && rest === `/billing/${kind}/${id}`, 'not_found', 404);
      need(owner, 'owner_only', 403);
      if (kind === 'proofs') return sendJson(res, 200, readProof(slug, id));
      if (['quotes', 'invoices', 'receipts'].includes(kind))
        return await pdf(res, slug, kind, id, () => {
          sameTerm();
          need(auth().owner, 'owner_only', 403);
        });
      need(false, 'not_found', 404);
    }
    need(!html, 'method_not_allowed', 405);
    const upload = /^\/billing\/invoices\/([\da-f-]{36})\/proof$/.exec(rest);
    if (upload) rate('proof:' + who.accountId, 5);
    let data = await body(req, upload ? Math.ceil(MAX_BYTES / 3) * 4 + 12000 : undefined);
    auth();
    if (upload) {
      invoice(slug, upload[1]);
      data = await prepareUpload(data);
      auth();
    }
    if (rest === '/billing/delete') {
      need(t.account_id === who.accountId, 'primary_owner_required', 403);
      need(data.confirm === slug, 'confirmation_required');
      const result = await destroyTenant(slug, {
        accountId: t.account_id,
        guard: () =>
          subscription(slug)?.sid === sid &&
          auth().owner &&
          exportTokenValid(getAccount(who.accountId)) &&
          entitlementsFor(slug)?.state === 'pending_deletion',
      });
      need(result.ok, result.error || 'not_ready', 409);
      return sendJson(res, 200, { deleted: true });
    }
    const result = await asActor('owner', who.accountId, () =>
      withWorker(slug, async () => {
        auth();
        sameTerm();
        if (rest === '/billing/checkout') return manual.createCheckout(slug, data);
        if (upload) return uploadProof(slug, upload[1], data);
        const act = rest.slice('/billing/'.length);
        need(['cancel', 'resume', 'downgrade', 'paused_reply'].includes(act), 'not_found', 404);
        const next = changeSubscription(slug, act, data);
        await syncWorker(slug);
        return next;
      })
    );
    return sendJson(res, 200, result);
  } catch (err) {
    return fail(res, err);
  }
}
export async function billingOperator(req, res, url) {
  try {
    need(billingEnabled(), 'not_found', 404);
    const session = operatorAuthorised(req, res);
    if (!session) return;
    rate('op:' + clientIp(req), 120);
    const checkSession = () => need(operatorSession(req) === session, 'operator_auth_required', 401);
    bootstrapBilling();
    const rest = url.pathname.replace(/^\/(?:api\/)?platform\/operator\/billing/, '');
    if (req.method === 'GET') {
      if (!rest)
        return url.pathname.startsWith('/api/')
          ? sendJson(res, 200, {
              ...operations(
                url.searchParams.get('filter') || 'all',
                Date.now(),
                Number(url.searchParams.get('page') || 1)
              ),
              csrf: session.csrf,
            })
          : shell(res, true);
      const m = /^\/([a-z0-9-]{2,40})\/proofs\/([a-f\d-]{36})$/.exec(rest);
      need(m && uuid(m[2]), 'not_found', 404);
      return sendJson(res, 200, readProof(m[1], m[2]));
    }
    need(req.method === 'POST' && url.pathname.startsWith('/api/'), 'method_not_allowed', 405);
    need(safeEqual(req.headers['x-operator-csrf'] || '', session.csrf), 'csrf', 403);
    const data = await body(req);
    checkSession();
    if (rest === '/plans')
      return sendJson(
        res,
        201,
        asActor('operator', null, () => publishPlan(data))
      );
    if (rest === '/settings')
      return sendJson(
        res,
        200,
        asActor('operator', null, () => configure(data))
      );
    const m =
      /^\/([a-z0-9-]{2,40})\/(subscriptions|invoices|payments|proofs)(?:\/([a-f\d-]{36}))?\/([a-z]+)$/.exec(
        rest
      );
    need(m, 'not_found', 404);
    const [, slug, kind, id, act] = m;
    need(kind === 'subscriptions' ? !id : uuid(id), 'not_found', 404);
    const result = await asActor('operator', null, () =>
      withWorker(slug, async () => {
        checkSession();
        need(subscription(slug), 'not_found', 404);
        let r;
        if (kind === 'subscriptions' && ['comp', 'extend', 'change'].includes(act))
          r = changeSubscription(slug, act, data);
        else if (kind === 'invoices' && act === 'price') r = priceUpgrade(slug, id, data);
        else if (kind === 'proofs' && act === 'recheck') r = recheck(slug, id);
        else if (kind === 'payments' && ['accept', 'reject', 'more', 'reverse', 'refund'].includes(act))
          r = act === 'refund' ? manual.refund(slug, id, data) : reviewPayment(slug, id, act, data);
        else need(false, 'not_found', 404);
        await syncWorker(slug);
        need(flush(), 'storage_unavailable', 503);
        return r;
      })
    );
    return sendJson(res, 200, result);
  } catch (err) {
    return fail(res, err);
  }
}
