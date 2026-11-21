// Real customer and operator routes, separate browser contexts, no network outside
// the disposable loopback server. No recorded click or mocked API response.
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import { demo, enable, fresh, offer, run, rules, jobs } from '../fixtures/billing.js';
import { setKeyHooks } from '../../platform/keys.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
enable();
const t = fresh();
offer();
run("INSERT INTO memberships VALUES(?,?,'staff',?)", [demo.staff.id, t.slug, rules.stamp(Date.now())]);
setKeyHooks({ stopTenant: async () => ({ ok: true }) });
const { http, origin } = await demo.serve();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const errors = [],
  external = [];
async function phone(auth, options = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    ...options,
  });
  if (auth)
    await ctx.addCookies(
      auth.cookies.map((c) => {
        const [name, value] = c.split(';')[0].split('=');
        return { name, value, url: origin };
      })
    );
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('request', (r) => {
    if (r.url().startsWith('http') && new URL(r.url()).origin !== origin) external.push(r.url());
  });
  return p;
}
const sample = await new Promise((r) => {
  const chunks = [],
    d = new PDFDocument();
  d.on('data', (b) => chunks.push(b));
  d.on('end', () => r(Buffer.concat(chunks)));
  d.text('Demo transfer only. PKR 225.00 to Example Shop ***0123 ref DEMO-PHONE');
  d.end();
});
const fits = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
try {
  const p = await phone(t.account),
    url = origin + '/platform/billing/' + t.slug;
  await p.goto(url);
  await p.getByRole('heading', { name: 'Usage and limits' }).waitFor();
  assert.ok(await fits(p));
  await p.getByLabel('Duration for Example').selectOption('2');
  await p.getByRole('button', { name: 'Choose Example' }).click();
  await p.getByText(/Transfer reference: PAY-/).waitFor();
  await p.getByLabel(/Redacted proof text/).fill('PKR 225.00 to Example Shop ***0123 ref DEMO-PHONE');
  await p
    .getByLabel(/Optional redacted image or PDF/)
    .setInputFiles({ name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: sample });
  await p.getByRole('button', { name: 'Submit proof' }).click();
  await p.getByText('Thank you. Your payment is under review.').waitFor();
  const op = await phone(null, {
    httpCredentials: { username: 'operator', password: process.env.PLATFORM_OPERATOR_TOKEN },
  });
  await op.goto(origin + '/platform/operator/billing');
  await op.getByRole('heading', { name: 'Manual review queue' }).waitFor();
  assert.ok(await fits(op));
  await op.getByRole('button', { name: 'Read masked proof' }).click();
  await op.locator('pre').filter({ hasText: 'first-page PDF text' }).waitFor();
  assert.ok(!(await op.locator('main').innerText()).includes(demo.privateText));
  await op.getByLabel(/Confirmed amount/).fill('10000');
  await op.getByRole('button', { name: 'Confirm received money' }).click();
  await op.getByText(/Confirmed: PKR 100.00/).waitFor();
  await p.reload();
  await p.getByText('Balance: PKR 125.00').waitFor();
  await p.getByLabel(/Redacted proof text/).fill('PKR 125.00 to Example Shop ***0123 ref DEMO-BALANCE');
  await p.getByRole('button', { name: 'Submit proof' }).click();
  await p.getByText('Thank you. Your payment is under review.').waitFor();
  await op.reload();
  await op.getByLabel(/Confirmed amount/).fill('12500');
  await op.getByRole('button', { name: 'Confirm received money' }).click();
  await op.getByText(/Confirmed: PKR 125.00/).waitFor();
  await op.getByLabel('Filter', { exact: true }).selectOption('paused');
  await op.getByRole('heading', { name: 'Revenue and cancellations' }).waitFor();
  await p.reload();
  await p.getByText('active', { exact: true }).waitFor();
  const download = p.waitForEvent('download');
  await p
    .getByRole('link', { name: /Receipt RCT-/ })
    .first()
    .click();
  assert.match((await download).suggestedFilename(), /^RCT-.*\.pdf$/);
  await p.getByRole('button', { name: 'Cancel at period end' }).click();
  await p.getByRole('button', { name: 'Resume subscription' }).click();
  await p.getByText('active', { exact: true }).waitFor();
  const staff = await phone(demo.staff);
  await staff.goto(url);
  await staff.getByText(/View only/).waitFor();
  assert.equal(await staff.getByRole('button', { name: 'Cancel at period end' }).count(), 0);
  assert.ok(await fits(staff));
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    '390×844 OK: plan/duration → PDF proof → manual partial → balance → confirmation → receipt download → cancel/resume; operator checks/filter; staff read-only. No external requests or page errors.'
  );
} finally {
  jobs.stopBilling();
  await browser.close();
  await new Promise((r) => http.close(r));
}
