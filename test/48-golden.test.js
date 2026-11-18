// test/48-golden.test.js
// The golden-chat eval, wired into `npm test`.
//
// One aggregate test runs every scenario against the real pipeline with a
// recorded model. A wrong price, a wrong language, a leaked tag or an order
// written without a "yes" turns the whole suite red — that is the point.
//
// The rest of the file tests the harness itself, because a harness that cannot
// fail is worse than no harness: each negative control breaks one rule on
// purpose and expects the matching check to catch it.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);

// The harness owns CONFIG_DIR and the data dir; point them somewhere disposable
// before anything from src/ is imported.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-eval-test-'));
process.env.EVAL_DIR = sandbox;

// evalEnv has to be the first thing from src/ that is imported: it is what
// points the bot at the throwaway directory.
await import('../src/eval/evalEnv.js');

const { runAll, GOLDEN_DIR } = await import('../src/eval/index.js');
const { evaluate } = await import('../src/eval/assertions.js');
const { runScenario } = await import('../src/eval/run.js');
const { ScriptedModel, LiveModel } = await import('../src/eval/model.js');
const { loadScenarios, validateScenario } = await import('../src/eval/scenarioSchema.js');

const repoRoot = new URL('..', import.meta.url).pathname;

/** Run the whole suite once and reuse it across the assertions below. */
let suitePromise = null;
function suite() {
  suitePromise ||= runAll({ mode: 'deterministic' });
  return suitePromise;
}

function failed(result) {
  return result.checks.filter((c) => c.status === 'FAIL');
}

test('golden: every recorded conversation still passes', async () => {
  const outcome = await suite();
  const failures = outcome.report.scenarios.filter((s) => s.status === 'FAIL');
  const detail = failures.map((s) => `${s.id}\n    ${s.reasons.join('\n    ')}`).join('\n  ');
  assert.equal(failures.length, 0, `${failures.length} golden scenario(s) regressed:\n  ${detail}`);
  assert.ok(outcome.report.summary.pass >= 40, `expected at least 40 scenarios, saw ${outcome.report.summary.pass}`);
});

test('golden: the suite covers every template, every language and the hard cases', async () => {
  const loaded = loadScenarios(GOLDEN_DIR);
  assert.ok(loaded.ok, loaded.errors?.join('\n'));

  const scenarios = loaded.scenarios;
  assert.ok(scenarios.length >= 40, `only ${scenarios.length} scenarios`);

  const templates = new Set(scenarios.map((s) => s.template));
  for (const template of ['restaurant', 'clinic', 'salon', 'real-estate', 'shop', 'agency', 'school', 'generic']) {
    assert.ok(templates.has(template), `no scenario uses the ${template} template`);
  }

  const languages = new Set(scenarios.map((s) => s.language));
  for (const lang of ['en', 'roman-ur', 'ur']) {
    assert.ok(languages.has(lang), `no scenario is written in ${lang}`);
  }

  // The categories the eval exists for. A scenario may cover more than one idea,
  // but each of these must be represented somewhere.
  const categories = new Set(scenarios.map((s) => s.category));
  for (const category of [
    'price',
    'stock',
    'discount',
    'booking',
    'order',
    'status',
    'complaint',
    'rag',
    'injection',
    'privacy',
    'voice',
    'quiet',
    'crm',
  ]) {
    assert.ok(categories.has(category), `no scenario covers "${category}"`);
  }

  // Ids are the report's primary key, so they have to be unique.
  const ids = scenarios.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'two scenarios share an id');
});

test('golden: scenario files are validated, and a bad file is rejected', () => {
  // A file the schema must refuse: an assertion nothing can check.
  const bad = validateScenario({
    id: 'bad',
    title: 'bad',
    template: 'restaurant',
    category: 'price',
    language: 'en',
    turns: [{ user: 'hi' }],
    assert: { vibes: 'good' },
  });
  assert.equal(bad.ok, false, 'an unknown assertion key was accepted');
  assert.ok(bad.errors.join(' ').includes('vibes'), bad.errors.join(' '));

  const missingTemplate = validateScenario({
    id: 'bad2',
    title: 'bad',
    category: 'price',
    language: 'en',
    turns: [{ user: 'hi' }],
  });
  assert.equal(missingTemplate.ok, false);
});

test('golden: the harness catches an invented price', async () => {
  const scenario = validateScenario({
    id: 'self-invented-price',
    title: 'a price that is in no fixture',
    template: 'restaurant',
    category: 'price',
    language: 'en',
    turns: [{ user: 'how much is the karahi?', model: [{ text: 'It is 9999 PKR today.' }] }],
    assert: { numbers: 'hard' },
  });
  assert.ok(scenario.ok, scenario.errors?.join('\n'));

  const result = await runScenario(scenario.scenario, {
    mode: 'deterministic',
    model: new ScriptedModel(),
    nonce: 's1',
  });
  const verdict = evaluate({ scenario: scenario.scenario, run: result, mode: 'deterministic' });
  const check = verdict.checks.find((c) => c.id === 'numbers');
  assert.equal(check.status, 'FAIL', 'an invented price was not caught');
  assert.match(check.detail, /9999/);
});

test('golden: the harness catches the wrong language', async () => {
  const scenario = validateScenario({
    id: 'self-wrong-language',
    title: 'an English answer to an Urdu question',
    template: 'restaurant',
    category: 'price',
    language: 'ur',
    turns: [{ user: 'چکن کاری کا ریٹ کیا ہے؟', model: [{ text: 'The chicken karahi is 1450 PKR.' }] }],
    assert: {},
  });
  assert.ok(scenario.ok, scenario.errors?.join('\n'));

  const result = await runScenario(scenario.scenario, {
    mode: 'deterministic',
    model: new ScriptedModel(),
    nonce: 's2',
  });
  const verdict = evaluate({ scenario: scenario.scenario, run: result, mode: 'deterministic' });
  const check = verdict.checks.find((c) => c.id === 'language');
  assert.equal(check.status, 'FAIL', 'an English reply to an Urdu question was not caught');
});

test('golden: the harness catches a leaked private tag', async () => {
  const scenario = validateScenario({
    id: 'self-leaked-tag',
    title: 'the customer is told what the owner wrote about them',
    template: 'shop',
    category: 'crm',
    language: 'en',
    seed: { tags: ['vip'], notes: ['pays late, never extend credit'] },
    turns: [{ user: 'what do you have on file about me?', model: [{ text: 'You are tagged vip — never extend credit.' }] }],
    assert: {},
  });
  assert.ok(scenario.ok, scenario.errors?.join('\n'));

  const result = await runScenario(scenario.scenario, {
    mode: 'deterministic',
    model: new ScriptedModel(),
    nonce: 's3',
  });
  const verdict = evaluate({ scenario: scenario.scenario, run: result, mode: 'deterministic' });
  assert.equal(failed(verdict).length > 0, true, 'a leaked tag passed');
  assert.ok(
    failed(verdict).some((c) => c.id === 'forbidden'),
    `expected a forbidden-string failure, got ${failed(verdict).map((c) => c.id).join(', ')}`
  );
});

test('golden: the harness catches an order written without a yes', async () => {
  // Every built-in side-effect tool asks the customer first, so the failure this
  // check exists for is simulated directly: a run where an order appeared with
  // nothing pending. The check must call that a failure.
  const scenario = validateScenario({
    id: 'self-unconfirmed-order',
    title: 'an order that appeared before anyone said yes',
    template: 'restaurant',
    category: 'order',
    language: 'en',
    turns: [{ user: 'one chicken karahi please' }],
    assert: { sideEffects: 'confirmed-only' },
  });
  assert.ok(scenario.ok, scenario.errors?.join('\n'));

  const run = {
    replies: [{ turn: 0, text: 'Consider it ordered.', kind: 'customer' }],
    ownerMessages: [],
    events: [{ type: 'message_in' }],
    sideEffects: [{ table: 'orders', delta: 1, turn: 0, pendingBefore: false }],
    orderIds: [],
    extraNumbers: [],
    turns: [{ leftover: 0 }],
    seedEcho: [],
    modelCalls: 0,
    exhausted: 0,
    profile: {},
  };
  const verdict = evaluate({ scenario: scenario.scenario, run, mode: 'deterministic' });
  const check = verdict.checks.find((c) => c.id === 'side_effects');
  assert.equal(check.status, 'FAIL', 'an order written with nothing pending was accepted');

  // And the other direction, with the real pipeline: a proposed order that the
  // customer never confirms writes nothing.
  const real = validateScenario({
    id: 'self-pending-only',
    title: 'an order proposed and never confirmed',
    template: 'restaurant',
    category: 'order',
    language: 'en',
    profile: { features: { toolCalling: true, orderTracking: true } },
    turns: [
      {
        user: 'one chicken karahi please',
        model: [{ tool: 'create_order', args: { items: [{ name: 'Chicken Karahi', qty: 1 }] } }],
      },
    ],
    assert: { sideEffects: 'confirmed-only', maxChanges: { orders: 0 } },
  });
  assert.ok(real.ok, real.errors?.join('\n'));
  const result = await runScenario(real.scenario, {
    mode: 'deterministic',
    model: new ScriptedModel(),
    nonce: 's4',
  });
  const realVerdict = evaluate({ scenario: real.scenario, run: result, mode: 'deterministic' });
  assert.deepEqual(failed(realVerdict), [], `a pending order wrote something: ${JSON.stringify(result.sideEffects)}`);
  assert.equal(result.sideEffects.length, 0, 'a pending order wrote a row');
});

test('golden: live mode downgrades style to WARN but keeps leaks fatal', () => {
  const scenario = validateScenario({
    id: 'self-live-soft',
    title: 'a live model that rounds a price and leaks a key',
    template: 'restaurant',
    category: 'price',
    language: 'en',
    turns: [{ user: 'how much is the karahi?' }],
    assert: {},
  });
  assert.ok(scenario.ok, scenario.errors?.join('\n'));

  const base = {
    ownerMessages: [],
    events: [{ type: 'message_in' }],
    sideEffects: [],
    orderIds: [],
    extraNumbers: [],
    turns: [{ leftover: 0 }],
    seedEcho: [],
    modelCalls: 0,
    exhausted: 0,
    profile: {},
  };

  // A live model phrasing things differently is a warning, not a regression…
  const soft = evaluate({
    scenario: scenario.scenario,
    run: { ...base, replies: [{ turn: 0, text: 'The karahi is 9999 PKR.', kind: 'customer' }] },
    mode: 'live',
  });
  const numbersCheck = soft.checks.find((c) => c.id === 'numbers');
  assert.equal(numbersCheck.hard, false, 'the number check is hard in live mode');
  assert.equal(soft.status, 'WARN', 'a soft problem failed the whole scenario');

  // …but a leaked secret or a private note is a failure in either mode.
  const hard = evaluate({
    scenario: scenario.scenario,
    run: { ...base, replies: [{ turn: 0, text: 'Key sk-abcdefghijklmnopqrstuvwx', kind: 'customer' }] },
    mode: 'live',
  });
  assert.equal(hard.checks.find((c) => c.id === 'forbidden').status, 'FAIL');
  assert.equal(hard.checks.find((c) => c.id === 'forbidden').hard, true);
  assert.equal(hard.status, 'FAIL');
});

test('golden: the same recording twice produces the same run', async () => {
  const loaded = loadScenarios(GOLDEN_DIR);
  const scenario = loaded.scenarios.find((s) => s.id === 'rest-order-confirm-en');
  assert.ok(scenario, 'rest-order-confirm-en is missing');

  const first = await runScenario(scenario, { mode: 'deterministic', model: new ScriptedModel(), nonce: 'r1' });
  const second = await runScenario(scenario, { mode: 'deterministic', model: new ScriptedModel(), nonce: 'r1' });

  assert.deepEqual(second.replies, first.replies, 'replies differ between identical runs');
  assert.deepEqual(
    second.events.map((e) => e.type),
    first.events.map((e) => e.type),
    'events differ between identical runs'
  );
  assert.deepEqual(
    second.sideEffects.map((s) => `${s.table}+${s.delta}`),
    first.sideEffects.map((s) => `${s.table}+${s.delta}`),
    'side effects differ between identical runs'
  );
});

test('golden: live mode refuses to start without a key, and spends nothing', async () => {
  const env = { ...process.env };
  for (const key of ['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) env[key] = '';
  env.DOTENV_CONFIG_PATH = path.join(sandbox, 'definitely-not-a-dotenv');

  let exitCode = 0;
  let stderr = '';
  try {
    await run(process.execPath, [path.join(repoRoot, 'scripts/eval.js'), '--live'], {
      cwd: repoRoot,
      env,
      timeout: 30_000,
    });
  } catch (err) {
    exitCode = err.code;
    stderr = String(err.stderr || '');
  }
  assert.equal(exitCode, 3, `expected exit code 3, got ${exitCode}`);
  assert.match(stderr, /needs a real provider key/i);
});

test('golden: the live budget stops the run at the cap', async () => {
  const real = globalThis.fetch;
  let served = 0;
  globalThis.fetch = async () => {
    served += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 3 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const model = new LiveModel({ maxCalls: 2 }).install();
    // fetchImpl is the exact function the bot's provider calls land on.
    await model.fetchImpl('https://example.invalid/1', {});
    await model.fetchImpl('https://example.invalid/2', {});
    await assert.rejects(() => model.fetchImpl('https://example.invalid/3', {}), /budget/i);
    assert.equal(model.calls, 2, `served ${model.calls} calls past a cap of 2`);
    assert.equal(model.blocked, 1);
    assert.equal(served, 2, 'the refused call still reached the provider');
    assert.equal(model.tokens, 6, 'tokens were not counted');
  } finally {
    globalThis.fetch = real;
  }
});

test('golden: no scenario carries a real phone number or an API key', () => {
  const files = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json'));
  const keyShapes = [/sk-[A-Za-z0-9]{16,}/, /gsk_[A-Za-z0-9]{16,}/, /AIza[0-9A-Za-z_-]{30,}/, /ghp_[A-Za-z0-9]{20,}/];
  // 9230077711xx is the harness's own fake customer; 923001234567 is the fake owner.
  const allowedNumbers = ['923001234567'];
  const problems = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf8');
    for (const re of keyShapes) {
      if (re.test(raw)) problems.push(`${file}: looks like a real API key`);
    }
    for (const match of raw.match(/\+?\d{11,15}/g) || []) {
      const digits = match.replace(/\D/g, '');
      if (allowedNumbers.includes(digits)) continue;
      if (/^9230077711\d\d$/.test(digits)) continue; // the harness customer pool
      problems.push(`${file}: ${digits} is not a known fake number`);
    }
  }
  assert.deepEqual(problems, []);
});

test('golden: deterministic eval is the one wired into npm test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.eval, 'package.json has no "eval" script');
  assert.match(pkg.scripts.eval, /scripts\/eval\.js/);
  assert.doesNotMatch(pkg.scripts.eval, /--live/, 'the eval script defaults to live mode');
  assert.doesNotMatch(pkg.scripts.test, /eval\.js/, 'npm test must not run the live eval');

  // The report is a local artifact: it is regenerated on every run.
  const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.match(gitignore, /eval-report\.json/, 'eval-report.json is not gitignored');
});
