// Optional phone acceptance run. Set PLAYWRIGHT_MODULE to an installed
// playwright-core ESM entry and CHROMIUM_BIN to an offline Chromium executable.
import httpModule from 'node:http';
import assert from 'node:assert/strict';
import {
  seed,
  serve,
  db,
  slug,
  owner,
  staff,
  tenant,
  day,
  from,
  other,
  privateText,
} from '../fixtures/dashboard.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
for (let i = 0; i < 28; i++)
  tenant.run('INSERT INTO leads(number,created_at) VALUES(?,?)', [String(700000 + i), from]);
await seed();
const { http, origin } = await serve(),
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_BIN || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
const profile = async (auth, options = {}) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    ...options,
  });
  if (auth)
    await ctx.addCookies(
      auth.cookies.map((v) => {
        const [name, value] = v.split(';')[0].split('=');
        return { name, value, url: origin };
      }),
    );
  return ctx;
};
// Browser maps this synthetic HTTPS origin to a loopback tenant handler.
// Both cookie jars and both route handlers are real; no public host is contacted.
const inboxOrigin = 'https://inbox.example.invalid';
const { handleInboxRoute } = await import('../../src/server.js');
const { alias } = await import('../../src/services/reportContract.js');
const { sessionCookieHeader } = await import('../../src/services/webAuth.js');
const inbox = httpModule.createServer((req, res) => handleInboxRoute(req, res, new URL(req.url, inboxOrigin)));
await new Promise((r) => inbox.listen(0, '127.0.0.1', r));
try {
  const ctx = await profile(owner),
    p = await ctx.newPage(),
    errors = [],
    external = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('request', (r) => {
    if (r.url().startsWith('http') && new URL(r.url()).origin !== origin) external.push(r.url());
  });
  const base = origin + '/platform/reports/' + slug + '/';
  await p.goto(base + 'overview');
  const heading = async (h) => p.getByRole('heading', { name: h, exact: true, level: 1 }).waitFor();
  for (const [name, title] of Object.entries({
    overview: 'Overview',
    agents: 'Agents & activity',
    leads: 'Leads',
    payments: 'Payments & decisions',
    usage: 'Usage',
    analytics: 'Analytics',
    health: 'Health',
    data: 'Export & data',
  })) {
    await p.getByRole('navigation').getByRole('link', { name: title, exact: true }).click();
    await heading(title);
    await p.getByRole('link', { name: 'Today', exact: true }).click();
    await p.waitForURL(/range=today/);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, name + ' phone overflow');
    await p.locator('.help').first().click();
    assert.ok((await p.locator('#glossary').getAttribute('open')) !== null);
    if (name === 'overview') {
      await p.getByText('Custom dates', { exact: true }).click();
      await p.getByLabel('From', { exact: true }).fill(day);
      await p.getByLabel('Through', { exact: true }).fill(day);
      await p.getByRole('button', { name: 'Apply dates' }).click();
      await p.waitForURL(/range=custom/);
    } else if (name === 'agents') {
      await p.getByText('Filter activity', { exact: true }).click();
      await p.getByLabel('Agent', { exact: true }).fill('sales');
      await p.getByRole('button', { name: 'Apply filters' }).click();
      await p.waitForURL(/agent=sales/);
    } else if (name === 'leads') {
      await p.getByRole('link', { name: 'Next', exact: true }).click();
      await p.getByText('Page 2', { exact: true }).waitFor();
      await p.goto(base + 'leads?range=today&contact=' + alias(other, process.env.PLATFORM_TENANT_TOKEN));
      p.once('dialog', (d) => d.accept('https://inbox.example.invalid'));
      await p.getByRole('button', { name: 'Open brief' }).first().click();
      const brief = p.getByRole('link', { name: /Read collected fields/ });
      assert.match(await brief.getAttribute('href'), /^https:\/\/inbox\.example\.invalid\/api\/inbox\/brief\/id-/);
      await ctx.route(inboxOrigin + '/**', async (route) => {
        const req = route.request();
        const target =
          'http://127.0.0.1:' + inbox.address().port + new URL(req.url()).pathname + new URL(req.url()).search;
        const r = await fetch(target, { headers: await req.allHeaders() });
        await route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() });
      });
      const popup = ctx.waitForEvent('page');
      await brief.click();
      const briefPage = await popup;
      await briefPage.getByText(/Sign in to your normal tenant live inbox/).waitFor();
      const [name, value] = sessionCookieHeader(process.env.DASHBOARD_TOKEN).split(';')[0].split('=');
      await ctx.addCookies([{ name, value, url: inboxOrigin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
      const transition = briefPage.waitForResponse((r) => r.url().startsWith(inboxOrigin + '/api/inbox/brief/'));
      await briefPage.getByRole('link', { name: /signed in/ }).click();
      const fetched = await transition;
      assert.equal(fetched.status(), 200, 'tenant session must unlock brief after the same-origin navigation');
      assert.ok(
        (await briefPage.locator('main').innerText()).includes(privateText),
        'collected text in tenant only',
      );
      await briefPage.close();
      assert.ok(!(await p.content()).includes(privateText));
      const save = p.waitForEvent('download');
      await p.getByRole('button', { name: 'Download leads CSV' }).click();
      assert.match((await save).suggestedFilename(), /\.csv$/);
    } else if (name === 'payments') {
      await p.getByRole('link', { name: '1', exact: true }).first().click();
      await p.waitForURL(/order=1/);
      assert.equal(await p.getByRole('button', { name: /accept|reject/i }).count(), 0);
    } else if (name === 'usage') {
      await p.getByText('Estimate at my own BYOK rate').click();
      await p.getByLabel(/Your rate per million/).fill('2');
      assert.match(await p.locator('#estimate').innerText(), /at your rate/);
    } else if (name === 'analytics') assert.ok(await p.getByRole('img', { name: /Heatmap/ }).count());
    else if (name === 'data') {
      const save = p.waitForEvent('download');
      await p.getByRole('button', { name: 'Download aggregates JSON' }).click();
      assert.match((await save).suggestedFilename(), /\.json$/);
    }
    console.log('phone OK:', title);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const st = await profile(staff),
    sp = await st.newPage();
  await sp.goto(base + 'overview');
  assert.equal(
    await sp
      .getByRole('navigation')
      .getByRole('link', { name: /Payments|Export/ })
      .count(),
    0,
  );
  assert.equal((await sp.goto(base + 'payments')).status(), 403);
  const ops = await profile(null),
    op = await ops.newPage();
  await op.goto(origin + '/platform/operator');
  await op.getByLabel('Operator credential').fill(process.env.PLATFORM_OPERATOR_TOKEN);
  await op.getByRole('button', {name: 'Sign in'}).click();
  await op.getByRole('heading', { name: 'Fleet health', level: 1 }).waitFor();
  console.log('phone OK: staff navigation, direct denial, separate operator login');
} finally {
  await browser.close();
  await new Promise((r) => inbox.close(r));
  await new Promise((r) => http.close(r));
  db.closePlatformDb();
}
