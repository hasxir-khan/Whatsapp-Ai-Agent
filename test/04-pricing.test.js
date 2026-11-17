import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('pricing');

const { buildQuote, formatQuote, parseBudget, startingPriceLine } = await import('../src/core/pricing.js');
const { priceFor, lookupNumber, isAwake, nextAwakeTime } = await import('../src/services/geo.js');

const PK_NUMBER = '923001234567';
const US_NUMBER = '12025550143';
const UK_NUMBER = '447700900123';

test('detects country, currency and timezone from the number', () => {
  assert.equal(lookupNumber(PK_NUMBER).currency, 'PKR');
  assert.equal(lookupNumber(US_NUMBER).currency, 'USD');
  assert.equal(lookupNumber(UK_NUMBER).currency, 'GBP');
  assert.equal(lookupNumber(UK_NUMBER).timezone, 'Europe/London');
});

test('local clients are quoted in PKR', () => {
  const price = priceFor(PK_NUMBER, 35000);
  assert.equal(price.currency, 'PKR');
  assert.match(price.text, /PKR/);
});

test('foreign clients are quoted in their currency with PKR shown', () => {
  const price = priceFor(UK_NUMBER, 70000);
  assert.equal(price.currency, 'GBP');
  assert.match(price.text, /£/);
  assert.match(price.text, /PKR/);
});

test('an e-commerce request picks the store service and adds payment', () => {
  const quote = buildQuote(
    {
      projectType: 'e-commerce store',
      goal: 'sell clothing online in the UK',
      features: 'product catalogue, cart, checkout, Stripe payments, admin panel, login',
      timeline: '6 weeks',
      budget: '£3,000',
    },
    UK_NUMBER
  );
  assert.equal(quote.serviceId, 'ecommerce');
  const addonNames = quote.breakdown.slice(1).map((a) => a.label);
  assert.ok(addonNames.some((n) => /payment/i.test(n)), `addons: ${addonNames}`);
  assert.ok(quote.pkrMax > quote.pkrMin);
  assert.ok(quote.local.currency === 'GBP');
  assert.ok(quote.timeline.length > 2);
  assert.ok(quote.stack.length >= 2);
});

test('a simple landing page stays cheap', () => {
  const quote = buildQuote({ projectType: 'landing page', goal: 'one page for my CV', features: 'contact form' }, PK_NUMBER);
  assert.equal(quote.serviceId, 'landing');
  assert.ok(quote.pkrMax < 30000, `got ${quote.pkrMax}`);
});

test('complexity raises the range', () => {
  const simple = buildQuote({ projectType: 'business website', goal: 'show services', features: 'about page' }, PK_NUMBER);
  const complex = buildQuote(
    {
      projectType: 'business website',
      goal: 'show services',
      features: 'login, payments, admin, chat, multi language, api, search, notifications, analytics, blog, upload, booking',
      extra: 'needs Stripe and Shopify integration',
    },
    PK_NUMBER
  );
  assert.ok(complex.pkrMin > simple.pkrMin);
  assert.ok(['complex', 'enterprise'].includes(complex.complexity));
});

test('a budget far below the scope is flagged, not discounted silently', () => {
  const quote = buildQuote(
    { projectType: 'e-commerce store', goal: 'sell online', features: 'cart, payments, admin', budget: '15,000 PKR' },
    PK_NUMBER
  );
  assert.ok(quote.scopeNote, 'expected a scope note');
  assert.match(quote.scopeNote, /budget/i);
});

test('parses budgets in different formats and currencies', () => {
  assert.equal(parseBudget('$1,500').currency, 'USD');
  assert.ok(parseBudget('$1,500').amount > 300000);
  assert.equal(parseBudget('80k PKR').amount, 80000);
  assert.equal(parseBudget('1.2 lakh').amount, 120000);
  assert.equal(parseBudget('no idea'), null);
});

test('quote card is WhatsApp-ready and never claims a fixed price', () => {
  const fields = { projectType: 'web app', goal: 'client portal', features: 'login, dashboard, invoices' };
  const text = formatQuote(buildQuote(fields, PK_NUMBER), fields);
  assert.match(text, /Price:/);
  assert.match(text, /Timeline:/);
  assert.match(text, /–/); // range, not a single number
  assert.match(text, /revision/i);
  assert.doesNotMatch(text, /\*\*|###/);
});

test('starting price line is short and priced', () => {
  const line = startingPriceLine(PK_NUMBER, { projectType: 'ecommerce store' });
  assert.match(line, /PKR/);
  assert.ok(line.length < 160);
});

test('client waking-hours helper returns sensible times', () => {
  assert.equal(typeof isAwake(UK_NUMBER, new Date()), 'boolean');
  const next = new Date(nextAwakeTime(UK_NUMBER, new Date()));
  assert.ok(next.getTime() > Date.now() - 60000);
});
