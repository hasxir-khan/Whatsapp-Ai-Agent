// src/eval/index.js
// The suite: load, validate, run, judge, summarise.
//
// `runAll` is what both the CLI and the aggregate test call, so "what CI runs"
// and "what you run by hand" are the same code path.

// Importing the sandbox first is not optional: src/core/llm.js reads config at
// import time, and a config read before EVAL_DIR is set points at the real data
// directory. Every harness entry point does it for that reason.
import './evalEnv.js';
import path from 'node:path';
import { loadScenarios } from './scenarioSchema.js';
import { evaluate } from './assertions.js';
import { ScriptedModel, LiveModel } from './model.js';
import { summarise, buildReport } from './report.js';

export const GOLDEN_DIR = new URL('../../test/golden/', import.meta.url).pathname;

export function scenarioDir(dir) {
  return dir || path.resolve(GOLDEN_DIR);
}

/**
 * Run every scenario that matches the filters.
 *
 * @param {object} opts
 * @param {string} [opts.mode]     deterministic | live
 * @param {string} [opts.only]     substring of the id
 * @param {string} [opts.category]
 * @param {number} [opts.maxCalls] live budget
 * @param {string} [opts.dir]
 * @param {Function} [opts.onScenario] progress callback
 */
export async function runAll({ mode = 'deterministic', only = null, category = null, maxCalls = 60, dir = null, onScenario = null } = {}) {
  const loaded = loadScenarios(scenarioDir(dir));
  if (!loaded.ok) {
    const err = new Error(`scenario files are invalid:\n${loaded.errors.join('\n')}`);
    err.code = 'INVALID_SCENARIOS';
    err.errors = loaded.errors;
    throw err;
  }

  let scenarios = loaded.scenarios;
  if (only) scenarios = scenarios.filter((s) => s.id.includes(only));
  if (category) scenarios = scenarios.filter((s) => s.category === category);
  if (!scenarios.length) {
    const err = new Error(only || category ? `no scenario matched ${only || category}` : 'no scenarios found');
    err.code = 'NO_SCENARIOS';
    throw err;
  }
  // A scenario may be marked "deterministic" only (it needs a recorded model).
  if (mode === 'live') scenarios = scenarios.filter((s) => s.mode !== 'deterministic');

  // The runner owns the environment; importing it late keeps config uncached.
  const { runScenario } = await import('./run.js');
  const model = mode === 'live' ? new LiveModel({ maxCalls }) : new ScriptedModel();

  const results = [];
  for (const [index, scenario] of scenarios.entries()) {
    const run = await runScenario(scenario, { mode, model, nonce: `e${String(index + 1).padStart(3, '0')}` });
    const verdict = evaluate({ scenario, run, mode });
    const result = {
      id: scenario.id,
      title: scenario.title,
      category: scenario.category,
      language: scenario.language,
      template: scenario.template,
      status: verdict.status,
      reasons: verdict.reasons,
      checks: verdict.checks,
      modelCalls: run.modelCalls,
      replies: run.replies,
      durationMs: 0,
    };
    results.push(result);
    if (typeof onScenario === 'function') onScenario(result);
  }

  const meta = {
    model: mode === 'live' ? 'live provider' : 'scripted recording',
    // Per-scenario calls, summed: the model object is reset between scenarios,
    // so its own counter only ever describes the last one.
    calls: mode === 'live' ? model.calls || 0 : results.reduce((n, r) => n + (r.modelCalls || 0), 0),
    tokens: model.tokens || 0,
    budget: mode === 'live' ? { maxCalls, used: model.calls || 0, blocked: model.blocked || 0 } : null,
  };

  return {
    results,
    summary: summarise(results),
    report: buildReport({ mode, results, meta }),
    meta,
  };
}

export default { runAll, scenarioDir, GOLDEN_DIR };
