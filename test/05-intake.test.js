import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('intake');

const { initDB, getIntake, getLead } = await import('../src/utils/db.js');
const { mockTransport } = await import('../src/dev/mockLlm.js');
const intake = await import('../src/core/projectIntake.js');

await initDB();
mockTransport();

const NUMBER = '447700900123';

test('starts by asking for the project type', async () => {
  const result = await intake.ingest(NUMBER, 'Hi there!');
  assert.equal(result.state.fields.projectType, undefined);
  assert.equal(result.nextField, 'projectType');
  assert.ok(result.completeness < 0.2);
});

test('captures what the client says and moves to the next question', async () => {
  const result = await intake.ingest(
    NUMBER,
    'I need a website for my clothing store, about six pages, with Stripe payments and a login area.'
  );
  assert.ok(result.state.fields.projectType, 'project type should be captured');
  assert.ok(result.state.fields.features, 'features should be captured');
  assert.notEqual(result.nextField, 'projectType');
});

test('state is persisted, not just kept in memory', async () => {
  const row = getIntake(NUMBER);
  assert.ok(row, 'intake row should exist');
  assert.ok(Object.keys(row.fields).length >= 2);
  assert.ok(row.fields.projectType);
});

test('asking about price triggers a quote once the basics are known', async () => {
  const result = await intake.ingest(NUMBER, 'What would that cost? My budget is around $3,000.');
  assert.equal(result.readyToQuote, true);
  assert.ok(result.quote, 'quote should be built');
  assert.ok(result.quote.pkrMin > 0);
  assert.equal(result.quote.local.currency, 'GBP');
});

test('markQuoted records the quote and stops re-quoting', async () => {
  const state = intake.getState(NUMBER);
  const result = await intake.ingest(NUMBER, 'ok');
  const quote = result.quote || intake.getState(NUMBER).quote;
  intake.markQuoted(state, quote);

  const after = await intake.ingest(NUMBER, 'How much was it again?');
  assert.equal(after.readyToQuote, false, 'must not re-quote automatically');
  assert.ok(intake.getState(NUMBER).quotedAt);
});

test('a PDF brief can be merged into the intake', async () => {
  const before = Object.keys(intake.getState(NUMBER).fields).length;
  intake.mergeExternalFields(NUMBER, {
    projectType: 'web app',
    goal: 'internal CRM for a 12-person agency',
    features: ['contacts', 'deals', 'invoices'],
  });
  const fields = intake.getState(NUMBER).fields;
  assert.equal(fields.projectType, 'web app');
  assert.ok(Object.keys(fields).length >= before);
  assert.match(String(fields.features), /invoices/);
});

test('prompt block tells the model not to re-ask', () => {
  const block = intake.intakePromptBlock(intake.getState(NUMBER));
  assert.match(block, /Known:/);
  assert.match(block, /never re-ask|Do not ask more/i);
});

test('reset clears a conversation', async () => {
  intake.resetState(NUMBER);
  const state = intake.getState(NUMBER);
  assert.deepEqual(state.fields, {});
  assert.equal(state.quote, null);
  assert.equal(getLead(NUMBER), null);
});
