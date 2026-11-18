// Lead intelligence: scores must be explainable, and the next action must be
// something a human can actually do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('leads');

const db = await import('../src/utils/db.js');
await db.initDB();
const { scoreLead, rankLeads, refreshLead, pipelineSummary, serviceFor } = await import('../src/services/leads.js');

const base = {
  project_type: 'E-commerce Store',
  goal: 'sell jackets online',
  features: 'stripe, order dashboard',
  timeline: '6 weeks',
  budget: '3000 GBP',
};

test('a complete, quoted, recently active lead is hot', () => {
  const s = scoreLead({
    lead: { status: 'quoted', quote_min: 220, quote_max: 430 },
    contact: { message_count: 14, last_seen: new Date().toISOString(), country: 'United Kingdom' },
    intakeFields: base,
  });

  assert.ok(s.score >= 65, `expected hot, got ${s.score}`);
  assert.equal(s.priority, 'hot');
  assert.ok(s.reasons.some((r) => /budget/i.test(r)));
  assert.ok(s.reasons.some((r) => /scope/i.test(r)));
  assert.match(s.nextAction, /start date|advance/i);
});

test('a vague lead with no budget is cold and asks for the basics', () => {
  const s = scoreLead({
    lead: { status: 'new' },
    contact: { message_count: 1 },
    intakeFields: { project_type: 'website' },
  });

  assert.equal(s.priority, 'cold');
  assert.ok(s.score < 35, `expected cold, got ${s.score}`);
  assert.match(s.nextAction, /budget/i);
  assert.ok(s.risks.some((r) => /budget/i.test(r)));
});

test('a budget below the price list is flagged, not rewarded', () => {
  const cheap = scoreLead({
    lead: { status: 'new' },
    contact: { message_count: 6, last_seen: new Date().toISOString() },
    intakeFields: { ...base, budget: '2000 PKR' },
  });
  assert.ok(cheap.risks.some((r) => /below the range/i.test(r)));

  const fair = scoreLead({
    lead: { status: 'new' },
    contact: { message_count: 6, last_seen: new Date().toISOString() },
    intakeFields: { ...base, budget: '40000 PKR' },
  });
  assert.ok(fair.score > cheap.score, 'same lead with a workable budget should score higher');
});

test('silence costs points and changes the next action', () => {
  const old = new Date(Date.now() - 20 * 86400000).toISOString();
  const s = scoreLead({
    lead: { status: 'quoted', quote_min: 220, quote_max: 430 },
    contact: { message_count: 10, last_seen: old },
    intakeFields: base,
  });
  assert.ok(s.staleDays >= 19);
  assert.ok(s.risks.some((r) => /silent/i.test(r)));
  assert.match(s.nextAction, /follow up|nudge/i);
});

test('won and lost leads get closing actions, not sales actions', () => {
  const won = scoreLead({ lead: { status: 'won' }, contact: { message_count: 12 }, intakeFields: base });
  assert.match(won.nextAction, /testimonial|referral/i);

  const lost = scoreLead({ lead: { status: 'lost' }, contact: { message_count: 12 }, intakeFields: base });
  assert.match(lost.nextAction, /nurture/i);
  assert.ok(lost.score < won.score);
});

test('ranking puts the hottest lead first, across statuses', () => {
  db.saveLead({
    number: '447700900111', name: 'Cold Lead', project_type: 'website', status: 'new',
  });
  db.upsertContact('447700900111', { name: 'Cold Lead', message_count: 1 });

  db.saveLead({
    number: '447700900222', name: 'Warm Lead', project_type: 'E-commerce Store', status: 'quoted',
    goal: 'sell online', features: 'stripe', timeline: '4 weeks', budget: '2500 GBP',
    quote_min: 220, quote_max: 430, quote_currency: 'GBP',
  });
  db.upsertContact('447700900222', { name: 'Warm Lead', message_count: 12, country: 'United Kingdom' });

  const ranked = rankLeads();
  assert.equal(ranked[0].name, 'Warm Lead');
  assert.ok(ranked[0].score > ranked[ranked.length - 1].score);
});

test('pipeline summary converts quote values to PKR', () => {
  const summary = pipelineSummary();
  assert.ok(summary.total >= 2);
  assert.ok(summary.byPriority.hot >= 1);
  // £220–£430 is nowhere near PKR 325 — it must have been converted
  assert.ok(summary.valuePkr > 100000, `expected converted value, got ${summary.valuePkr}`);
  assert.ok(summary.needsAction.length >= 1);
});

test('refreshLead persists the score on the lead row', () => {
  const scored = refreshLead('447700900222');
  assert.ok(scored.score > 0);
  const row = db.getLead('447700900222');
  assert.equal(row.score, scored.score);
  assert.equal(row.priority, scored.priority);
  assert.ok(row.next_action);
});

test('service lookup matches by name, id or keyword', () => {
  assert.ok(serviceFor('E-commerce Store'));
  assert.ok(serviceFor('ecommerce'));
  assert.equal(serviceFor('something nobody sells'), null);
});
