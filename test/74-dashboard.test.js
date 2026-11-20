import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  tenant,
  db,
  owner,
  staff,
  outsider,
  slug,
  zone,
  now,
  day,
  from,
  ago,
  seed,
  dir,
  phone,
  privateText,
  fakeKey,
  dashboard,
  pages,
  serve,
  reports,
  store,
  record,
  midnight,
  shiftDay,
} from './fixtures/dashboard.js';
import { fakeSock } from './helpers.js';
const contract = await import('../src/services/reportContract.js');
const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
const impact = await import('../src/services/impact.js'),
  accuracy = await import('../src/services/accuracy.js'),
  payments = await import('../src/services/paymentReview.js');
await seed();
const { http, origin } = await serve();
after(async () => {
  await new Promise((r) => http.close(r));
  db.closePlatformDb();
});
const q = (opts) => new URLSearchParams(opts),
  view = (name, options, clock = now) => dashboard(slug, name, q(options), { owner: true, now: clock });
function safe(text) {
  for (const marker of [
    phone,
    privateText,
    fakeKey,
    'private-proof-image.png',
    process.env.PLATFORM_TENANT_TOKEN,
    process.env.PLATFORM_KEY_SECRET,
  ])
    assert.ok(!text.includes(marker), 'no private fixture');
}
const call = async (url, auth, opts = {}) => {
  const r = await fetch(origin + url, {
    redirect: 'manual',
    ...opts,
    headers: { ...(auth ? { cookie: auth.cookie } : {}), ...opts.headers },
  });
  return { status: r.status, raw: await r.text(), headers: r.headers };
};
const base = '/api/platform/tenants/' + slug + '/reports/',
  page = '/platform/reports/' + slug + '/';
const post = (auth, body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(auth ? { 'x-platform-csrf': auth.csrf } : {}) },
  body: JSON.stringify(body),
});

test('seeded command parity on identical business dates, including a returning contact and human attribution', async () => {
  const week = impact.weekWindow(now),
    first =
      week.from === midnight(day, zone)
        ? day
        : new Intl.DateTimeFormat('en-CA', {
            timeZone: zone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(new Date(week.from));
  const d = view('overview', { range: 'custom', from: first, to: day }),
    raw = impact.impactReport({ now });
  for (const k of Object.keys(d.metrics).filter((k) => Object.hasOwn(raw.current, k)))
    assert.equal(d.metrics[k], raw.current[k], k);
  const two = view('overview', { range: '7' });
  assert.equal(two.metrics.conversations, 2);
  assert.equal(two.metrics.handledByBot, 1);
  assert.equal(two.metrics.botRevenue, 50);
  assert.equal(two.metrics.firstResponseMinutes, 2);
  const cmd = async (text) =>
    (await handleOwnerCommand(fakeSock(), phone + '@s.whatsapp.net', text, process.env.MY_NUMBER, { now })).reply;
  assert.equal(await cmd('.impact'), raw.text);
  assert.match(
    await cmd('.growth'),
    new RegExp(`${d.metrics.growthSentToday}/${d.metrics.growthCap} proactive sent`),
  );
  assert.equal(d.metrics.growthSentToday, 1);
  const acc = accuracy.accuracyReport({ now, days: 7 }),
    rows = view('analytics', { range: '7' }).tables.accuracy.rows;
  for (const m of acc.metrics.filter((r) => r.status === 'ok'))
    assert.equal(rows.find((r) => r.category === m.key)?.count, m.count, m.key);
  assert.ok((await cmd('.accuracy')).startsWith(accuracy.accuracyText(acc)));
  assert.equal(rows.find((r) => r.category === 'priceMismatch').count, 1);
  const p = payments.paymentsSummary({ now }),
    display = view('payments').metrics;
  for (const k of [
    'pending',
    'overdue',
    'acceptedToday',
    'rejectedToday',
    'avgDecisionMinutes',
    'pendingAmount',
    'recheck',
  ])
    assert.equal(display[k], p[k]);
  assert.equal(await cmd('.payments'), payments.paymentsStrip(p));
  assert.equal(display.pendingAmount, 15);
  assert.equal(display.avgDecisionMinutes, 5);
  assert.equal(view('analytics').tables.funnel.rows[0].count, 2);
  assert.equal(view('usage').metrics.quotaLeft, 5999);
  assert.equal(view('usage').metrics.estimated, 1);
  assert.equal(d.meta.thin, true);
});

test('single ACL for every HTML and API page: owner, view-only staff, unrelated session, anonymous and wrong tenant', async () => {
  for (const name of pages)
    for (const prefix of [base, page]) {
      const url = prefix + name,
        success = await call(url, owner);
      assert.equal(success.status, 200, url + ' ' + success.raw.slice(0, 150));
      safe(success.raw);
      assert.ok(success.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
      assert.equal((await call(url, staff)).status, ['payments', 'data'].includes(name) ? 403 : 200);
      assert.equal((await call(url, outsider)).status, 404);
      assert.equal((await call(url, null)).status, prefix === base ? 401 : 302);
      assert.equal((await call(url.replace(slug, 'unknown-cafe'), owner)).status, 404);
      assert.equal((await call(url, owner, post(owner, {}))).status, 405);
    }
  assert.ok(!Object.hasOwn(JSON.parse((await call(base + 'overview', staff)).raw).metrics, 'pending'));
  assert.equal((await call('/api/platform/tenants/' + slug + '/payments', staff)).status, 403);
  const f = JSON.parse((await call(base + 'agents?agent=sales&type=route', staff)).raw);
  assert.ok(f.tables.activity.rows.every((r) => r.agent === 'sales' && r.type === 'route'));
  assert.equal((await call(base + 'usage?range=custom&from=2000-01-01&to=' + day, owner)).status, 400);
  assert.equal((await call(base + 'usage?p.models=-2', owner)).status, 400);
});

test('exports: owner-only, double-submit CSRF, range limit, content firewall, download, audit and throttle', async () => {
  const url = base + 'export',
    body = { format: 'csv', kind: 'leads' };
  for (const [auth, status] of [
    [null, 401],
    [staff, 403],
    [outsider, 404],
  ])
    assert.equal((await call(url, auth, post(auth, body))).status, status);
  assert.equal((await call(url, owner, post(null, body))).status, 403);
  assert.equal((await call(url.replace(slug, 'other-cafe'), owner, post(owner, body))).status, 404);
  assert.equal((await call(url + '?range=invalid', owner, post(owner, body))).status, 400);
  for (const [format, kind] of [
    ['csv', 'leads'],
    ['json', 'aggregates'],
    ['csv', 'aggregates'],
    ['json', 'leads'],
  ]) {
    const r = await call(url, owner, post(owner, { format, kind }));
    assert.equal(r.status, 200);
    safe(r.raw);
    assert.ok(r.headers.get('content-disposition').includes('attachment'));
    if (format === 'json') assert.ok(JSON.parse(r.raw).rows.length);
    else assert.ok(r.raw.includes('\r\n'));
  }
  assert.equal((await call(url, owner, post(owner, body))).status, 429);
  assert.equal(
    db.get("SELECT COUNT(*) n FROM platform_audit WHERE tenant=? AND action='dashboard_export'", [slug]).n,
    4,
  );
});

test('brief requires independent tenant credential AND a short-lived owner grant; operator never accepts customer sessions', async () => {
  const id = contract.alias(phone, process.env.PLATFORM_TENANT_TOKEN),
    url = base + 'brief/' + id;
  for (const [auth, status] of [
    [null, 401],
    [outsider, 404],
    [staff, 403],
    [owner, 200],
  ]) {
    const r = await call(url, auth);
    assert.equal(r.status, status);
    safe(r.raw);
  }
  const { validBriefGrant } = await import('../src/services/reportBrief.js');
  const r = await call(url, owner),
    u = new URL(JSON.parse(r.raw).path, origin);
  const until = u.searchParams.get('until'),
    grant = u.searchParams.get('grant');
  assert.ok(validBriefGrant(id, until, grant, process.env.PLATFORM_TENANT_TOKEN));
  assert.ok(!validBriefGrant(id, until, grant, 'another worker'));
  assert.ok(!validBriefGrant(id, until, grant, process.env.PLATFORM_TENANT_TOKEN, +until + 1));
  // Exercise the actual worker HTTP handler too: login on one surface does
  // not confer auth on the other. Collected fields only appear on that side.
  const { handleInboxRoute } = await import('../src/server.js');
  async function inbox(path, headers) {
    const req = { method: 'GET', headers },
      res = {
        writeHead(status) {
          this.status = status;
        },
        end(text) {
          this.raw = String(text);
        },
      };
    await handleInboxRoute(req, res, new URL(path, origin));
    return res;
  }
  const key = { authorization: 'Bearer ' + process.env.DASHBOARD_TOKEN };
  assert.equal((await inbox(u.pathname + u.search, { cookie: owner.cookie })).status, 401);
  assert.equal((await inbox(u.pathname, key)).status, 403);
  const collected = await inbox(u.pathname + u.search, key);
  assert.equal(collected.status, 200);
  assert.ok(!collected.raw.includes(phone));
  assert.ok(JSON.parse(collected.raw).collected.some((f) => f.value === privateText));
  assert.equal((await call(url.replace(slug, 'other-cafe'), owner)).status, 404);
  for (const op of ['/platform/operator', '/api/platform/operator']) {
    for (const who of [null, staff, owner, outsider]) assert.equal((await call(op, who)).status, 401);
    assert.equal(
      (await call(op, null, { headers: { authorization: 'Bearer ' + process.env.PLATFORM_SECRET } })).status,
      401,
    );
    const admin = {
      authorization: 'Basic ' + Buffer.from('operator:' + process.env.PLATFORM_OPERATOR_TOKEN).toString('base64'),
    };
    const r = await call(op, null, { headers: admin });
    assert.equal(r.status, 200);
    safe(r.raw);
    assert.ok(!r.raw.includes(id));
    assert.ok(!r.raw.includes(slug));
    assert.equal((await call(base + 'overview', null, { headers: admin })).status, 401);
  }
});

test('business days at DST gaps and folds; hour buckets combine the repeated clock hour', () => {
  for (const [date, length] of [
    ['2026-03-08', 23],
    ['2026-11-01', 25],
  ])
    assert.equal(
      (Date.parse(midnight(shiftDay(date, 1), zone)) - Date.parse(midnight(date, zone))) / 3600000,
      length,
    );
  for (const at of ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'])
    tenant.run("INSERT INTO messages(number,role,content,created_at) VALUES(?,'user','?',?)", [phone, at]);
  const bundle = reports.tenantDay('2026-11-01', { zone, now });
  assert.equal(bundle.facts.find((r) => r.metric === 'messages' && r.hour === 1 && r.a === 'user').n, 2);
});

test('outage, v1 backfill, .importing replay, late events, stale generations, quota dedup and per-plan purge', async () => {
  const file = path.join(dir, 'dashboard-v1.jsonl'),
    clock = new Date(+now + 1000);
  tenant.run("INSERT INTO messages(number,role,created_at) VALUES('300300','user',?)", [ago(30)]);
  await reports.publishReports({ dir, now: clock, zone, days: 14 });
  fs.renameSync(file, file + '.importing');
  const lines = fs
    .readFileSync(file + '.importing', 'utf8')
    .trim()
    .split('\n');
  safe(lines.join(''));
  await store.reconcileTenant(slug, { dir, now: clock });
  assert.equal(view('overview').metrics.conversations, 3);
  assert.equal(store.importReports(slug, lines, clock).duplicates, 14);
  assert.equal(
    store.importReports(
      slug,
      lines.map((l) => JSON.stringify({ ...JSON.parse(l), at: ago(180) })),
      clock,
    ).imported,
    0,
  );
  const bad = JSON.stringify({ ...JSON.parse(lines[0]), v: 55 });
  assert.throws(() => store.importReports(slug, [bad], clock), /invalid_report/);
  const evt = {
    tenant: slug,
    uid: 'one-late-uid',
    at: ago(1),
    conversation: phone,
    model: fakeKey,
    provider: privateText,
    kind: 'embedding',
    totalTokens: 180,
  };
  assert.equal(record(evt).ok, true);
  assert.equal(record(evt).duplicate, true);
  store.refreshMeter(slug, clock);
  assert.equal(view('usage').metrics.tokens, 300);
  const old = shiftDay(day, -45);
  let row = { ...JSON.parse(lines.at(-1)), day: old, current: null };
  store.importReports(slug, [JSON.stringify(row)], clock);
  assert.ok(db.get('SELECT day FROM r_days WHERE slug=? AND day=?', [slug, old]));
  db.run("UPDATE tenants SET plan_id='free' WHERE slug=?", [slug]);
  assert.throws(() => view('overview', { range: 'custom', from: old, to: day }), /outside_retention/);
  store.purgeReports(slug, clock);
  for (const t of ['r_days', 'r_facts', 'r_people', 'r_cards', 'r_usage', 'r_meter'])
    assert.equal(db.get(`SELECT COUNT(*) n FROM ${t} WHERE slug=? AND day<?`, [slug, shiftDay(day, -30)]).n, 0);
  assert.equal(store.importReports(slug, [JSON.stringify(row)], clock).imported, 0);
  db.flush();
  for (const s of [phone, privateText, fakeKey]) assert.ok(!fs.readFileSync(db.currentFile()).includes(s));
});

test('30-day raw event expiry does not erase the longer plan’s safe counts, and older custom dates still match .accuracy', () => {
  const old = shiftDay(day, -40),
    at = midnight(old, zone);
  process.env.TENANT_REPORT_DAYS = '90';
  for (const [type, detail] of [
    ['rag_miss', privateText],
    ['reply_guard_rejected', JSON.stringify({ problems: ['price range changed ' + fakeKey] })],
    ['quote_built', privateText],
  ])
    tenant.run('INSERT INTO events(type,detail,created_at) VALUES(?,?,?)', [type, detail, at]);
  tenant.logEvent('fixture_tick');
  assert.equal(tenant.get('SELECT COUNT(*) n FROM events WHERE created_at=?', [at]).n, 0);
  const r = reports.tenantDay(old, { zone, now });
  safe(JSON.stringify(r));
  assert.equal(r.facts.find((f) => f.metric === 'accuracy' && f.a === 'priceMismatch').n, 1);
  assert.equal(r.facts.find((f) => f.metric === 'funnel' && f.a === 'quotes').n, 1);
  assert.equal(r.facts.find((f) => f.metric === 'unanswered').n, 1);
});

test('two real tenants: usage UID and key generations cannot collide, blind signup number, operator diagnostics, deletion removes all views', async () => {
  const newNumber = '12025550187';
  const created = await call(
    '/api/platform/tenants',
    outsider,
    post(outsider, { name: 'Second fixture', number: newNumber, city: 'Test City', template: 'restaurant' }),
  );
  assert.equal(created.status, 201, created.raw);
  const second = JSON.parse(created.raw).slug;
  assert.ok(!db.get('SELECT number FROM tenants WHERE slug=?', [second]).number.includes(newNumber));
  assert.ok(
    !db.get('SELECT number FROM trial_numbers WHERE account_id=?', [outsider.id]).number.includes(newNumber),
  );
  const register = (id, ref) =>
    record({
      tenant: second,
      uid: id,
      at: from,
      conversation: phone,
      totalTokens: 8,
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      keySlot: 1,
      keyRef: ref,
    });
  assert.equal(register('fake-call-1', 'aaaaaaaaaaaaaaaa:1').duplicate, undefined);
  register('another-call', 'bbbbbbbbbbbbbbbb:1');
  store.refreshMeter(second, now);
  const secondBase = base.replace(slug, second);
  const usage = JSON.parse((await call(secondBase + 'usage', outsider)).raw);
  assert.equal(usage.metrics.tokens, 16);
  assert.equal(usage.tables.keys.rows.length, 2);
  assert.notEqual(usage.tables.keys.rows[0].key_id, usage.tables.keys.rows[1].key_id);
  for (const name of pages) {
    assert.equal((await call(secondBase + name, owner)).status, 404);
    assert.equal((await call(page.replace(slug, second) + name, staff)).status, 404);
  }
  assert.equal(
    (await call(secondBase + 'brief/' + contract.alias(phone, process.env.PLATFORM_TENANT_TOKEN), outsider))
      .status,
    404,
  );
  const { diagnostics } = await import('../platform/diagnostics.js');
  const oldToken = process.env.PLATFORM_OPERATOR_TOKEN;
  process.env.PLATFORM_OPERATOR_TOKEN = process.env.PLATFORM_SECRET;
  assert.ok(diagnostics(db.all).errors.includes('report_operator_credential'));
  assert.equal((await call('/platform/operator', owner)).status, 404);
  process.env.PLATFORM_OPERATOR_TOKEN = oldToken;
  assert.equal((await call('/api/platform/account/export', outsider, post(outsider, {}))).status, 200);
  assert.equal(
    (await call('/api/platform/account/delete', outsider, post(outsider, { confirm: 'DELETE' }))).status,
    200,
  );
  for (const t of (await import('../platform/reportSchema.js')).reportTables)
    assert.equal(db.get(`SELECT COUNT(*) n FROM ${t} WHERE slug=?`, [second]).n, 0);
  assert.ok(db.get('SELECT slug FROM r_state WHERE slug=?', [slug]));
});

test('customer dashboard and platform off: routes absent, no reporting for ordinary or link-only bots', async () => {
  for (const flag of ['PLATFORM_DASHBOARD', 'PLATFORM_ENABLED']) {
    const prev = process.env[flag];
    process.env[flag] = '0';
    try {
      for (const url of [
        base + 'overview',
        page + 'overview',
        base + 'export',
        '/platform/operator',
        '/api/platform/operator',
        '/platform/reports.js',
      ])
        assert.equal((await call(url, owner)).status, 404);
    } finally {
      process.env[flag] = prev;
    }
  }
  const mode = process.env.TENANT_WORKER_MODE;
  process.env.TENANT_WORKER_MODE = 'live';
  process.env.TENANT_DASHBOARD = '0';
  assert.equal(reports.startReportLoop(), undefined);
  process.env.TENANT_DASHBOARD = '1';
  process.env.TENANT_WORKER_MODE = 'link';
  assert.equal(reports.startReportLoop(), undefined);
  process.env.TENANT_WORKER_MODE = 'live';
  const stop = reports.startReportLoop();
  assert.equal(typeof stop, 'function');
  stop();
  if (mode) process.env.TENANT_WORKER_MODE = mode;
  else delete process.env.TENANT_WORKER_MODE;
});
