#!/usr/bin/env node
// scripts/eval.js
// The golden-chat eval.
//
//   npm run eval                     deterministic: recorded model, no keys, no network
//   npm run eval -- --live           the real provider, capped and counted
//   npm run eval -- --only price     one scenario (or a category: --category booking)
//   npm run eval -- --compare eval-report.json
//
// Exit codes: 0 = all pass (or only warnings), 1 = at least one hard failure,
// 2 = bad usage, 3 = refused to start (live mode without a key).

import fs from 'node:fs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

if (has('--help') || has('-h')) {
  console.log(`
Golden chat eval

  npm run eval                          deterministic (recorded model, offline)
  npm run eval -- --media               synthetic voice/video corpus, recorded providers
  npm run eval -- --live --media        real media providers, all HTTP/Edge attempts capped
  npm run eval -- --live                real provider, budget-capped
  npm run eval -- --only <id>           one scenario by id substring
  npm run eval -- --category <name>     one category
  npm run eval -- --compare <file>      regressions against an older report
  npm run eval -- --out <file>          where to write the report (default eval-report.json)
  npm run eval -- --max-calls <n>       live budget (default EVAL_LIVE_MAX_CALLS or 60)
  npm run eval -- --list                list the scenarios and exit
  npm run eval -- --no-colour           plain text

Live mode needs GROQ_API_KEY (or GEMINI_API_KEY / OPENROUTER_API_KEY) in .env.
Deterministic mode needs nothing at all.
`);
  process.exit(0);
}

const live = has('--live');
const only = typeof value('--only') === 'string' ? value('--only') : null;
const category = typeof value('--category') === 'string' ? value('--category') : null;
const compareWith = typeof value('--compare') === 'string' ? value('--compare') : null;
const out = typeof value('--out') === 'string' ? value('--out') : 'eval-report.json';
const maxCalls = Number(value('--max-calls', process.env.EVAL_LIVE_MAX_CALLS || 60)) || 60;
const colour = !has('--no-colour') && process.stdout.isTTY !== false;

if (has('--media')) {
  try {
    const { runMedia } = await import('../src/eval/media.js');
    const media = await runMedia({ live, only, maxCalls: Number(value('--max-calls', process.env.EVAL_LIVE_MAX_CALLS ?? 60)) });
    fs.writeFileSync(out, JSON.stringify({media}, null, 2) + '\n');
    process.exit(media.summary.fail ? 1 : 0);
  } catch (err) { console.error(err.message); process.exit(3); }
}

if (has('--live')) {
  // Check the real environment *before* the harness replaces it.
  const key = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!key || /^eval-not-a-real-key$/.test(key)) {
    console.error('✗ --live needs a real provider key (GROQ_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY).');
    console.error('  Nothing was run, so nothing was spent. Try `npm run eval` for the offline suite.');
    process.exit(3);
  }
  process.env.EVAL_REAL_KEY = key;
}

// Importing this module is what creates the sandbox and sets the env vars, so it
// has to happen after the checks above.
const { evalDir } = await import('../src/eval/evalEnv.js');
const { runAll } = await import('../src/eval/index.js');
const report = await import('../src/eval/report.js');

if (has('--list')) {
  const { loadScenarios } = await import('../src/eval/scenarioSchema.js');
  const loaded = loadScenarios(new URL('../test/golden/', import.meta.url).pathname);
  if (!loaded.ok) {
    console.error(loaded.errors.join('\n'));
    process.exit(1);
  }
  for (const s of loaded.scenarios) console.log(`${s.id.padEnd(38)} ${s.category.padEnd(10)} ${s.language.padEnd(9)} ${s.template}`);
  console.log(`\n${loaded.scenarios.length} scenarios · ${new Set(loaded.scenarios.map((s) => s.category)).size} categories · ${new Set(loaded.scenarios.map((s) => s.template)).size} templates`);
  process.exit(0);
}

const started = Date.now();
let outcome;
try {
  outcome = await runAll({ mode: live ? 'live' : 'deterministic', only, category, maxCalls });
} catch (err) {
  if (err.code === 'INVALID_SCENARIOS') {
    console.error('✗ scenario files are invalid:\n');
    for (const line of err.errors) console.error(`  • ${line}`);
    process.exit(1);
  }
  if (err.code === 'NO_SCENARIOS') {
    console.error(`✗ ${err.message}`);
    process.exit(2);
  }
  throw err;
}

report.printReport(outcome.report, { colour });
console.log(`  ${(Date.now() - started) / 1000}s · sandbox ${evalDir}`);

if (live) {
  const b = outcome.meta.budget;
  console.log(`  live: ${b.used}/${b.maxCalls} model calls · ${outcome.meta.tokens} tokens${b.blocked ? ` · ${b.blocked} call(s) refused by the budget` : ''}`);
  try {
    const db = await import('../src/utils/db.js');
    const usage = db.getUsage(db.todayKey());
    console.log(`  quota today: ${usage.llm_calls} calls · ${usage.llm_tokens} tokens`);
  } catch {
    /* quota display is a nicety */
  }
} else {
  console.log(`  deterministic: ${outcome.meta.calls} recorded model turns, no network`);
  if (!(await import('../src/services/ffmpeg.js')).hasFfmpeg()) console.log('  No ffmpeg: voice chat scenarios replay the recorded transcript as text (no STT).');
}

// A fresh process keeps the media recorder/tenant config out of the chat suite.
if (!live && !only && !category) {
  const { spawnSync } = await import('node:child_process');
  const mediaFile = `${evalDir}/media-result.json`;
  const child = spawnSync(process.execPath, [process.argv[1], '--media', '--out', mediaFile], { stdio: 'inherit' });
  if (fs.existsSync(mediaFile)) outcome.report.media = JSON.parse(fs.readFileSync(mediaFile, 'utf8')).media;
  if (child.status !== 0) { report.writeReport(out, outcome.report); process.exit(child.status || 1); }
}
const outPath = report.writeReport(out, outcome.report);
console.log(`  report → ${outPath}`);

let regressions = 0;
if (compareWith) {
  if (!fs.existsSync(compareWith)) {
    console.error(`✗ cannot compare: ${compareWith} does not exist yet (run once to create it).`);
    process.exit(2);
  }
  const old = report.readReport(compareWith);
  regressions = report.printComparison(report.compareReports(old, outcome.report), { colour });
}

const failed = outcome.summary.fail;
if (failed || regressions) {
  console.error(`\n✗ ${failed} scenario(s) failed${regressions ? `, ${regressions} regression(s)` : ''}.`);
  process.exit(1);
}
process.exit(0);
