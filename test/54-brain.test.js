// Phase 6 Part 3 — the business brain, service by service.
//
// The theme of these tests is the same as the product: the numbers come from
// SQL, the model is optional, and everything that could reach a customer is a
// draft until the owner says otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate } from './helpers.js';

const dataDir = isolate('brain');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;

const BASE = {
  owner: { name: 'Example Owner', number: '923001234567', team: [] },
  business: {
    name: 'Demo Cafe',
    type: 'Restaurant',
    timezone: 'Asia/Karachi',
    hours: 'Daily 11:00–23:00',
    currency: 'PKR',
    offers: ['10% off your first order'],
  },
  catalog: { items: [{ name: 'Zinger Burger', kind: 'product', price: 650 }] },
  policies: {},
  features: {},
  brain: {},
};

function writeProfile(patch = {}) {
  const profile = {
    ...BASE,
    ...patch,
    business: { ...BASE.business, ...(patch.business || {}) },
    features: { ...BASE.features, ...(patch.features || {}) },
    brain: { ...BASE.brain, ...(patch.brain || {}) },
  };
  fs.writeFileSync(path.join(configDir, 'owner.json'), JSON.stringify(profile, null, 2));
  return profile;
}

writeProfile({ features: { businessBrain: true, reasoning: true } });

const db = await import('../src/utils/db.js');
const { config } = await import('../src/config/env.js');
const TENANT = config.tenant?.slug || null;
const { reloadProfile } = await import('../src/services/profile.js');
const { mockTransport, __testSetPlan, __testClearPlan } = await import('../src/dev/mockLlm.js');
const impact = await import('../src/services/impact.js');
const reasoning = await import('../src/services/reasoning.js');
const nba = await import('../src/services/nextBestAction.js');
const strategist = await import('../src/services/strategist.js');
const goals = await import('../src/services/goals.js');
const experiments = await import('../src/services/experiments.js');
const learning = await import('../src/services/learning.js');
const privacy = await import('../src/services/privacy.js');
const llm = await import('../src/core/llm.js');

await db.initDB();
mockTransport();

const NOW = new Date('2026-11-17T10:00:00Z'); // Tuesday, inside the current week
const DAY = 24 * 3600 * 1000;
const at = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60000).toISOString();

function msg(number, role, content, minutesAgo) {
  db.run('INSERT INTO messages (number, role, kind, content, created_at) VALUES (?,?,?,?,?)', [
    number,
    role,
    'text',
    content,
    at(minutesAgo),
  ]);
}

function contact(number, { name = 'Test Customer', blocked = 0, pausedUntil = null } = {}) {
  db.run('INSERT OR REPLACE INTO contacts (number, name, push_name, is_blocked, bot_paused_until) VALUES (?,?,?,?,?)', [
    number,
    name,
    name,
    blocked,
    pausedUntil,
  ]);
}

function clearBrain() {
  for (const table of ['messages', 'leads', 'orders', 'bookings', 'review_asks', 'growth_sends', 'growth_optouts', 'contacts']) {
    db.run(`DELETE FROM ${table}`);
  }
  for (const table of ['brain_decisions', 'brain_proposals', 'goals', 'experiments', 'experiment_sends', 'brain_weights']) {
    db.run(`DELETE FROM ${table}`);
  }
  db.run("DELETE FROM settings WHERE key LIKE 'brain_%'");
}

// ── the flags ──────────────────────────────────────────────

test('the brain is off unless the flag is on, and off changes nothing', () => {
  writeProfile();
  reloadProfile();
  assert.equal(impact.brainEnabled(), false);
  assert.equal(reasoning.reasoningEnabled(), false);
  assert.equal(nba.nbaEnabled(), false);
  assert.equal(goals.goalsEnabled(), false);
  assert.equal(experiments.experimentsEnabled(), false);
  assert.equal(learning.learningEnabled(), false);
  assert.equal(strategist.strategistEnabled(), false);

  // With it off, a report is still produced from the same numbers — it just is
  // not what the owner is shown anywhere.
  const report = impact.impactReport({ now: NOW });
  assert.match(report.text, /Impact/);

  writeProfile({ features: { businessBrain: true, reasoning: true } });
  reloadProfile();
  assert.equal(impact.brainEnabled(), true);
  assert.equal(reasoning.reasoningEnabled(), true);
});

// ── impact ─────────────────────────────────────────────────

test('automation rate is counted from the database, not estimated', () => {
  clearBrain();
  // Four conversations this week. In one of them the owner wrote back.
  contact('923001110001');
  contact('923001110002');
  contact('923001110003');
  contact('923001110004');
  for (const n of ['923001110001', '923001110002', '923001110003']) {
    msg(n, 'user', 'menu?', 300);
    msg(n, 'assistant', 'Here it is.', 295);
  }
  msg('923001110004', 'user', 'order?', 290);
  msg('923001110004', 'owner', 'I will handle this one.', 285);

  const numbers = impact.impactNumbers({ now: NOW });
  assert.equal(numbers.conversations, 4);
  assert.equal(numbers.handledByBot, 3);
  assert.equal(numbers.automationRate, 75);
  assert.equal(numbers.hoursSaved, Math.round(((4 * 6) / 60) * 10) / 10);
  assert.equal(numbers.thin, true, 'under 20 conversations is thin data');
});

test('the report says "not enough data" instead of inventing a trend', () => {
  const text = impact.impactReport({ now: NOW }).text;
  assert.match(text, /Not enough data/i);
  assert.match(text, /counts, not rates/i);
});

test('a bot-handled order is attributed, an owner-handled one is not', () => {
  clearBrain();
  contact('923001110010');
  contact('923001110011');
  msg('923001110010', 'user', 'I want the burger', 200);
  msg('923001110010', 'assistant', 'Sure.', 195);
  msg('923001110011', 'user', 'I want the burger', 190);
  msg('923001110011', 'owner', 'Confirming for you.', 185);
  db.run("INSERT INTO orders (chat, total, status, created_at) VALUES (?,?,?,?)", ['923001110010@s.whatsapp.net', 650, 'paid', at(150)]);
  db.run("INSERT INTO orders (chat, total, status, created_at) VALUES (?,?,?,?)", ['923001110011@s.whatsapp.net', 650, 'paid', at(140)]);

  const numbers = impact.impactNumbers({ now: NOW });
  assert.equal(numbers.orders, 2, 'both paid orders count');
  assert.equal(numbers.botOrders, 1, 'only the one the owner never touched is the bot\'s');
  assert.equal(numbers.revenue, 1300);
  assert.equal(numbers.botRevenue, 650);
});

test('the week window starts on Monday UTC and has a previous week', () => {
  const w = impact.weekWindow(NOW);
  assert.equal(w.from, '2026-11-16T00:00:00.000Z');
  assert.equal(w.to, '2026-11-23T00:00:00.000Z');
  assert.equal(w.prevFrom, '2026-11-09T00:00:00.000Z');
});

// ── the router ─────────────────────────────────────────────

test('a simple turn takes the normal path and a complex one does not', () => {
  const simple = reasoning.classifyTurn({ text: 'price?' });
  assert.equal(simple.complex, false);

  const complex = reasoning.classifyTurn({
    text: 'I was charged twice for the same order, the delivery was late, and I want a refund plus the second payment reversed — can you do that today or should I call the bank?',
  });
  assert.equal(complex.complex, true);
  assert.ok(complex.reasons.includes('multi-step') || complex.reasons.includes('high-value'));

  // Roman Urdu, two questions and a refund: complex for the same reasons.
  const ur = reasoning.classifyTurn({ text: 'mujhe refund chahiye kyunki order late tha, aur bill bhi galat hai. kya karein?' });
  assert.equal(ur.complex, true);

  // An Urdu-script complaint is complex too, not because of length but intent.
  const script = reasoning.classifyTurn({ text: 'میرا آرڈر غلط آیا ہے اور رقم واپس چاہیے، کیا کریں؟' });
  assert.equal(script.complex, true);
});

test('the plan is used for the turn and reduced to a short rationale', async () => {
  __testSetPlan(['check the order record', 'confirm the refund policy', 'ask once what went wrong']);
  const turn = await reasoning.reasonAboutTurn({
    text: 'I want a refund and also a replacement, and this is the second time it happened. What will you do?',
    langInfo: { code: 'en', name: 'English' },
    now: NOW,
  });
  assert.equal(turn.used, true, JSON.stringify(turn));
  assert.ok(turn.plan.steps.length <= 3);
  assert.ok(turn.plan.rationale.length <= 300);

  // The specification: no chain of thought is stored — only the one-line
  // rationale, and it says what was checked, not what was thought.
  const rows = db.all("SELECT * FROM brain_decisions WHERE kind = 'reasoning'");
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.ok(String(row.rationale).length <= 300);
    assert.ok(!/step 1|first I|then I|because I think/i.test(String(row.rationale)));
  }
});

test('verify catches an invented price, the wrong language and an unconfirmed side effect', () => {
  const digits = reasoning.allowedDigits();

  const invented = reasoning.verifyAnswer({ reply: 'The burger is 999 rupees.', langInfo: { code: 'en' }, digits });
  assert.equal(invented.ok, false);
  assert.ok(invented.problems.join(' ').includes('999'));

  const honest = reasoning.verifyAnswer({ reply: 'The Zinger Burger is 650 rupees.', langInfo: { code: 'en' }, digits });
  assert.equal(honest.ok, true, honest.problems.join('; '));

  const wrongLanguage = reasoning.verifyAnswer({
    reply: 'Yes, the burger is 650 rupees.',
    langInfo: { code: 'ur', name: 'Urdu' },
    digits,
  });
  assert.equal(wrongLanguage.ok, false);
  assert.ok(wrongLanguage.problems.join(' ').includes('language'));

  const unconfirmed = reasoning.verifyAnswer({
    reply: 'Done, I booked it for you.',
    langInfo: { code: 'en' },
    digits,
    sideEffects: { bookings: 1, orders: 0 },
    pendingBefore: false,
  });
  assert.equal(unconfirmed.ok, false);
  assert.ok(unconfirmed.problems.join(' ').includes('confirmation'));
});

test('the daily reasoning budget is a hard stop', async () => {
  writeProfile({ features: { businessBrain: true, reasoning: true }, brain: { dailyReasoningCalls: 1 } });
  reloadProfile();
  db.run("DELETE FROM settings WHERE key LIKE 'brain_reasoning_%'");

  assert.equal(reasoning.canReason(NOW).ok, true);
  reasoning.noteReasoningCall(NOW);
  assert.equal(reasoning.canReason(NOW).ok, false);

  __testSetPlan(['check the record']);
  const turn = await reasoning.reasonAboutTurn({
    text: 'refund please, and this is the second time — the bill is also wrong',
    now: NOW,
  });
  assert.equal(turn.used, false);
  assert.equal(turn.reason, 'budget');
});

test('a provider failure falls back to the normal brain, it does not throw', async () => {
  writeProfile({ features: { businessBrain: true, reasoning: true }, brain: { dailyReasoningCalls: 50 } });
  reloadProfile();
  db.run("DELETE FROM settings WHERE key LIKE 'brain_reasoning_%'");

  llm.__setFetch(async () => {
    throw new Error('network is down');
  });
  try {
    const plan = await reasoning.makePlan({ text: 'refund and a replacement please', now: NOW });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'provider_error');

    const turn = await reasoning.reasonAboutTurn({ text: 'refund and a replacement please, second time', now: NOW });
    assert.equal(turn.used, false);
  } finally {
    mockTransport(); // put the offline provider back for the rest of the file
  }
});

test('a holding reply and a hand-off exist in every supported language', () => {
  for (const lang of ['en', 'roman-ur', 'ur']) {
    assert.ok(reasoning.holdingReply(lang).length > 20, lang);
    assert.ok(reasoning.verifyHandoff(lang).length > 20, lang);
  }
  assert.notEqual(reasoning.holdingReply('en'), reasoning.holdingReply('ur'));
});

// ── next best action ───────────────────────────────────────

test('a quoted, quiet lead produces a quote reminder with a reason', () => {
  clearBrain();
  contact('923001120001', { name: 'Ayesha' });
  msg('923001120001', 'user', 'please send the quote', 4000);
  db.run("INSERT INTO leads (number, status, score, project_type, created_at) VALUES (?,?,?,?,?)", [
    '923001120001',
    'quoted',
    70,
    'cake',
    at(5000),
  ]);
  const result = nba.nextBestAction('923001120001', { now: NOW });
  assert.equal(result.action, 'quote_reminder');
  assert.match(result.reason, /quoted/i);
  assert.ok(result.draft && result.draft.length > 10);
});

test('an opt-out holds every proactive suggestion', () => {
  clearBrain();
  contact('923001120002');
  msg('923001120002', 'user', 'ok', 4000);
  db.run("INSERT INTO leads (number, status, score, created_at) VALUES (?,?,?,?)", ['923001120002', 'quoted', 70, at(5000)]);
  db.run('INSERT INTO growth_optouts (number, reason, source, created_at) VALUES (?,?,?,?)', ['923001120002', 'stop', 'message', at(3000)]);

  const result = nba.nextBestAction('923001120002', { now: NOW });
  assert.equal(result.action, 'wait');
  assert.ok(result.blocked.includes('opted_out') || /opted out/i.test(result.reason));
});

test('the suggestion never exceeds the growth caps', () => {
  clearBrain();
  contact('923001120003');
  msg('923001120003', 'user', 'ok', 4000);
  db.run("INSERT INTO leads (number, status, score, created_at) VALUES (?,?,?,?)", ['923001120003', 'quoted', 70, at(5000)]);
  // Spend the daily cap on other people.
  for (let i = 0; i < 60; i += 1) {
    db.run("INSERT INTO growth_sends (agent, number, reason, result, created_at) VALUES (?,?,?,?,?)", [
      'followup',
      `9230011299${String(i).padStart(2, '0')}`,
      'test',
      'sent',
      at(30),
    ]);
  }
  const result = nba.nextBestAction('923001120003', { now: NOW });
  assert.equal(result.action, 'wait');
  assert.ok(/held|caps|cap/i.test(result.reason), result.reason);
});

// ── the strategist ─────────────────────────────────────────

function seedBusyWeek() {
  clearBrain();
  for (let i = 0; i < 25; i += 1) {
    const number = `9230011300${String(i).padStart(2, '0')}`;
    contact(number);
    msg(number, 'user', i % 2 ? 'Do you have gift cards?' : 'How much is the burger?', 300 + i);
    msg(number, 'assistant', 'Let me check that for you.', 295 + i);
  }
  db.run("INSERT INTO orders (chat, total, status, created_at) VALUES (?,?,?,?)", ['923001130000@s.whatsapp.net', 650, 'paid', at(100)]);
}

test('the weekly review quotes the same numbers SQL does', async () => {
  seedBusyWeek();
  const review = await strategist.weeklyReview({ now: NOW });
  const numbers = impact.impactNumbers({ now: NOW });
  assert.match(review.text, new RegExp(`conversations ${numbers.conversations}\\b`));
  assert.match(review.text, new RegExp(`paid orders ${numbers.orders}\\b`));
  // The question that repeats is named, with its count.
  assert.match(review.text, /gift cards/i);
});

test('at most five ranked actions, each with effort, a labelled estimate and a command', async () => {
  writeProfile({
    features: { businessBrain: true, reasoning: true },
    brain: {},
    business: { offers: ['10% off your first order'], hours: 'Daily 11:00–23:00' },
  });
  reloadProfile();
  seedBusyWeek();

  const { actions } = strategist.proposeActions({ now: NOW });
  assert.ok(actions.length >= 1 && actions.length <= 5, `saw ${actions.length}`);
  for (let i = 1; i < actions.length; i += 1) assert.ok(actions[i - 1].score >= actions[i].score, 'ranked');
  for (const action of actions) {
    assert.ok(action.effort, 'every action says what it costs');
    assert.match(action.effect, /estimated/i, 'the effect is labelled as an estimate, never a promise');
    assert.match(action.command, /^\.do \d$/);
  }
});

test('a prepared action is a draft: nothing is sent and nothing is saved to the customer', async () => {
  seedBusyWeek();
  const before = db.get('SELECT COUNT(*) AS n FROM messages')?.n;
  const result = await strategist.prepareAction(1, { now: NOW });
  assert.equal(result.ok, true);
  assert.match(result.text, /draft|nothing sent|preview/i);

  const after = db.get('SELECT COUNT(*) AS n FROM messages')?.n;
  assert.equal(after, before, 'preparing an action must not message anyone');

  const drafted = db.all("SELECT * FROM brain_proposals WHERE status = 'drafted'");
  assert.ok(drafted.length >= 1, 'the proposal was recorded');
});

test('".why" explains a ranked action without inventing anything', () => {
  seedBusyWeek();
  const why = strategist.whyAction(1, { now: NOW });
  assert.equal(why.ok, true);
  assert.match(why.text, /Why 1/);
  assert.match(why.text, /estimate/i);
});

// ── goals ──────────────────────────────────────────────────

test('goals are parsed from one line and refuse vague input', () => {
  const ok = goals.parseGoal('add 20 orders by 2026-12-31');
  assert.equal(ok.ok, true);
  assert.equal(ok.metric, 'orders');
  assert.equal(ok.target, 20);

  for (const bad of ['add 20 orders', 'add plenty of orders by 2026-12-31', 'add 5 leads by 2020-01-01']) {
    assert.equal(goals.parseGoal(bad).ok, false, bad);
  }
});

test('goal progress projects from the pace so far and warns when off track', () => {
  clearBrain();
  const created = new Date(NOW.getTime() - 30 * DAY).toISOString();
  const due = new Date(NOW.getTime() + 30 * DAY).toISOString();
  db.run('INSERT INTO goals (tenant, metric, target, due_at, status, created_at) VALUES (?,?,?,?,?,?)', [
    TENANT,
    'orders',
    20,
    due,
    'active',
    created,
  ]);
  // Two orders in the first half of the window: on this pace the goal is missed.
  for (let i = 0; i < 2; i += 1) {
    db.run("INSERT INTO orders (chat, total, status, created_at) VALUES (?,?,?,?)", ['923001140000@s.whatsapp.net', 650, 'paid', new Date(NOW.getTime() - 10 * DAY).toISOString()]);
  }
  const goal = goals.listGoals({ status: 'active' })[0];
  const progress = goals.goalProgress(goal, { now: NOW });
  assert.equal(progress.current, 2);
  assert.equal(progress.projected, 4);
  assert.equal(progress.status, 'off track');
  assert.equal(progress.warn, true);
});

test('three active goals at most', () => {
  clearBrain();
  for (let i = 0; i < 3; i += 1) {
    const added = goals.addGoal({
      metric: 'orders',
      target: 5 + i,
      dueAt: new Date(NOW.getTime() + 30 * DAY).toISOString(),
      now: NOW,
    });
    assert.equal(added.ok, true, `goal ${i + 1}`);
  }
  const fourth = goals.addGoal({
    metric: 'leads',
    target: 5,
    dueAt: new Date(NOW.getTime() + 30 * DAY).toISOString(),
    now: NOW,
  });
  assert.equal(fourth.ok, false);
  assert.match(fourth.reason, /already have 3/i);
});

// ── experiments ────────────────────────────────────────────

test('the split is stable for a contact and different across contacts', () => {
  const first = experiments.variantFor('923001150001', 7);
  for (let i = 0; i < 5; i += 1) assert.equal(experiments.variantFor('923001150001', 7), first);
  const variants = new Set();
  for (let i = 0; i < 40; i += 1) variants.add(experiments.variantFor(`9230011500${String(i).padStart(2, '0')}`, 7));
  assert.equal(variants.size, 2, 'both arms get traffic');
});

test('a result is only reported once each variant has enough sends', () => {
  clearBrain();
  const created = experiments.createExperiment({
    kind: 'followup',
    variantA: 'Want me to hold your usual table?',
    variantB: 'Shall I save your usual slot?',
    minSample: 10,
    now: NOW,
  });
  assert.equal(created.ok, true, created.reason);
  const id = created.experiment.id;

  // Five sends per arm: too early, and it says so.
  for (let i = 0; i < 10; i += 1) {
    const number = `9230011600${String(i).padStart(2, '0')}`;
    experiments.recordSend({ experimentId: id, number, variant: i % 2 ? 'a' : 'b', now: NOW });
  }
  let result = experiments.experimentResult(id);
  assert.equal(result.verdict, 'too early');
  assert.equal(result.winner, null);

  // Fill both arms; B answers often, A almost never.
  for (let i = 10; i < 40; i += 1) {
    const number = `9230011600${String(i).padStart(2, '0')}`;
    const variant = i % 2 ? 'a' : 'b';
    experiments.recordSend({ experimentId: id, number, variant, now: NOW });
    experiments.recordOutcome({ experimentId: id, number, outcome: variant === 'b' ? 'replied' : 'none' });
  }
  result = experiments.experimentResult(id);
  assert.equal(result.verdict, 'likely better');
  assert.equal(result.winner, 'b');

  // Nothing rolls out by itself: the experiment is still running until adopted.
  assert.equal(experiments.getExperiment(id).status, 'running');
  const adopted = experiments.adoptWinner(id, NOW);
  assert.equal(adopted.ok, true);
  assert.equal(experiments.getExperiment(id).status, 'adopted');
});

test('an experiment refuses to test the same two lines', () => {
  clearBrain();
  const same = experiments.createExperiment({ kind: 'offer', variantA: 'same', variantB: 'same', now: NOW });
  assert.equal(same.ok, false);
});

// ── learning loop ──────────────────────────────────────────

test('outcomes move readable weights, and they are clamped', () => {
  clearBrain();
  learning.recordOutcome({ action: 'followup', outcome: 'converted', now: NOW });
  assert.ok(Math.abs(learning.weightFor('nba:followup') - 1.05) < 1e-9);

  for (let i = 0; i < 40; i += 1) learning.recordOutcome({ action: 'offer', outcome: 'converted', now: NOW });
  assert.equal(learning.weightFor('nba:offer'), learning.MAX_WEIGHT, 'clamped at the top');

  for (let i = 0; i < 60; i += 1) learning.recordOutcome({ action: 'reactivate', outcome: 'none', now: NOW });
  assert.equal(learning.weightFor('nba:reactivate'), learning.MIN_WEIGHT, 'clamped at the bottom');

  const text = learning.weightsText();
  assert.match(text, /nba:followup/);
  assert.match(text, /reset/i);

  learning.resetWeights();
  assert.equal(learning.weightFor('nba:followup'), 1);
});

test('a reply credits the last proactive message once, not twice', () => {
  clearBrain();
  contact('923001170001');
  db.run("INSERT INTO growth_sends (agent, number, reason, result, created_at) VALUES (?,?,?,?,?)", [
    'followup',
    '923001170001',
    'silent for 3 days',
    'sent',
    at(300),
  ]);
  db.run("INSERT INTO growth_sends (agent, number, reason, result, created_at) VALUES (?,?,?,?,?)", [
    'followup',
    '923001170002',
    'silent for 5 days',
    'sent',
    at(5 * 24 * 60),
  ]);

  const first = learning.noteReplyOutcome('923001170001', { now: NOW });
  assert.equal(first.recorded, 1);
  assert.equal(first.outcome, 'replied');
  const second = learning.noteReplyOutcome('923001170001', { now: NOW });
  assert.equal(second.recorded, 0, 'the same send is not counted twice');

  // A send old enough with no reply is settled the other way.
  const swept = learning.sweepOutcomes({ now: NOW, quietDays: 3 });
  assert.equal(swept.swept, 1);
  assert.ok(learning.weightFor('nba:followup') < 1.1);
});

// ── privacy ────────────────────────────────────────────────

test('export includes the decision trail only when the brain is on', () => {
  clearBrain();
  contact('923001180001');
  msg('923001180001', 'user', 'hello', 100);
  reasoning.recordDecision({
    chat: '923001180001',
    kind: 'reasoning',
    action: 'plan',
    rationale: 'Checked the order record before answering',
    now: NOW,
  });

  writeProfile({ features: { businessBrain: true, privacyTools: true } });
  reloadProfile();
  let out = privacy.exportContact('923001180001');
  assert.ok(Array.isArray(out.payload.brainDecisions));
  assert.equal(out.payload.brainDecisions.length, 1);
  assert.match(out.payload.brainDecisions[0].rationale, /order record/);

  writeProfile({ features: { privacyTools: true } });
  reloadProfile();
  out = privacy.exportContact('923001180001');
  assert.equal(out.payload.brainDecisions, undefined, 'with the flag off the export keeps its old shape');
});

test('forget deletes the decision trail and the experiment rows for that contact', () => {
  clearBrain();
  contact('923001180002');
  msg('923001180002', 'user', 'hello', 100);
  reasoning.recordDecision({
    chat: '923001180002',
    kind: 'reasoning',
    action: 'plan',
    rationale: 'Checked the catalogue',
    now: NOW,
  });
  const experiment = experiments.createExperiment({ kind: 'followup', variantA: 'a', variantB: 'b', now: NOW });
  experiments.recordSend({ experimentId: experiment.experiment.id, number: '923001180002', now: NOW });

  const result = privacy.forgetContact('923001180002', { now: NOW });
  assert.equal(result.ok, true, result.reason);
  assert.equal(db.all('SELECT * FROM brain_decisions WHERE chat = ?', ['923001180002']).length, 0);
  assert.equal(db.all('SELECT * FROM experiment_sends WHERE number = ?', ['923001180002']).length, 0);
});

// restore the profile the rest of the process expects
writeProfile({ features: { businessBrain: true, reasoning: true } });
reloadProfile();
