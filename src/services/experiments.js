// src/services/experiments.js
// Phase 6 Part 3 — A/B tests the owner approves.
//
// Two variants, a stable split by contact (so the same person always sees the
// same wording), and a result that is only reported when each arm has enough
// sends. A winner is *suggested*, never rolled out: `.experiment adopt <n>` is
// an owner decision.

import { featureOn } from './profile.js';
import { config } from '../config/env.js';
import * as db from '../utils/db.js';

export const EXPERIMENT_KINDS = ['followup', 'offer', 'review_ask'];
export const DEFAULT_MIN_SAMPLE = 30;
export const MIN_SAMPLE_FLOOR = 10;

export function experimentsEnabled() {
  return featureOn('businessBrain');
}

const tenant = () => config.tenant?.slug || null;

/** FNV-1a — stable across processes, unlike Math.random or a JS Map order. */
function hash(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Which arm this contact is in. Never changes for a given experiment. */
export function variantFor(number, experimentId) {
  const h = hash(`${String(number).replace(/\D/g, '')}:${Number(experimentId)}`);
  return h % 2 === 0 ? 'a' : 'b';
}

export function createExperiment({ kind = 'followup', variantA = '', variantB = '', minSample = DEFAULT_MIN_SAMPLE, now = new Date() } = {}) {
  const k = String(kind).toLowerCase();
  if (!EXPERIMENT_KINDS.includes(k)) {
    return { ok: false, reason: `kind must be one of: ${EXPERIMENT_KINDS.join(', ')}` };
  }
  const a = String(variantA || '').trim();
  const b = String(variantB || '').trim();
  if (!a || !b) return { ok: false, reason: 'both variants need text: .experiment new followup "text A" | "text B"' };
  if (a === b) return { ok: false, reason: 'the variants are identical — there is nothing to test' };
  const running = db.all("SELECT id FROM experiments WHERE tenant = ? AND status = 'running' AND kind = ?", [tenant(), k]);
  if (running.length) return { ok: false, reason: `experiment #${running[0].id} is already running for ${k}` };

  const sample = Math.max(MIN_SAMPLE_FLOOR, Math.min(100000, Number(minSample) || DEFAULT_MIN_SAMPLE));
  db.run('INSERT INTO experiments (tenant, kind, variant_a, variant_b, min_sample, status, created_at) VALUES (?,?,?,?,?,?,?)', [
    tenant(),
    k,
    a,
    b,
    sample,
    'running',
    now.toISOString(),
  ]);
  const experiment = db.get('SELECT * FROM experiments WHERE tenant = ? ORDER BY id DESC LIMIT 1', [tenant()]);
  return { ok: true, experiment };
}

export function listExperiments() {
  return db.all('SELECT * FROM experiments WHERE tenant = ? ORDER BY id DESC', [tenant()]);
}

export function getExperiment(id) {
  return db.get('SELECT * FROM experiments WHERE tenant = ? AND id = ?', [tenant(), Number(id)]) || null;
}

/** Record that a variant went out, and later what happened. */
export function recordSend({ experimentId, number, variant = null, now = new Date() } = {}) {
  const experiment = getExperiment(experimentId);
  if (!experiment) return { ok: false, reason: 'no such experiment' };
  const arm = variant || variantFor(number, experimentId);
  const existing = db.get('SELECT id FROM experiment_sends WHERE experiment_id = ? AND number = ?', [experimentId, number]);
  if (existing) return { ok: true, duplicate: true, variant: arm };
  db.run('INSERT INTO experiment_sends (experiment_id, number, variant, outcome, created_at) VALUES (?,?,?,?,?)', [
    experimentId,
    number,
    arm,
    'none',
    now.toISOString(),
  ]);
  return { ok: true, variant: arm };
}

export function recordOutcome({ experimentId, number, outcome = 'none' } = {}) {
  const experiment = getExperiment(experimentId);
  if (!experiment) return { ok: false, reason: 'no such experiment' };
  const row = db.get('SELECT id FROM experiment_sends WHERE experiment_id = ? AND number = ?', [experimentId, number]);
  if (!row) return { ok: false, reason: 'that contact was never in this experiment' };
  db.run('UPDATE experiment_sends SET outcome = ? WHERE id = ?', [outcome, row.id]);
  return { ok: true };
}

/**
 * The numbers, and a verdict only when each arm has `min_sample` sends.
 * "too early" and "inconclusive" are results too — pretending otherwise is how
 * owners end up rolling out noise.
 */
export function experimentResult(id) {
  const experiment = getExperiment(id);
  if (!experiment) return { ok: false, reason: 'no such experiment' };

  const rows = db.all('SELECT variant, outcome FROM experiment_sends WHERE experiment_id = ?', [experiment.id]);
  const arms = { a: { sent: 0, replied: 0, converted: 0 }, b: { sent: 0, replied: 0, converted: 0 } };
  for (const row of rows) {
    const arm = arms[row.variant] || (arms[row.variant] = { sent: 0, replied: 0, converted: 0 });
    arm.sent += 1;
    if (row.outcome === 'replied') arm.replied += 1;
    if (row.outcome === 'converted') arm.converted += 1;
    if (row.outcome === 'converted') arm.replied += 0; // a conversion is not a reply, keep them separate
  }

  const rate = (arm) => (arm.sent ? arm.replied / arm.sent : 0);
  const minSample = Number(experiment.min_sample) || DEFAULT_MIN_SAMPLE;
  const enough = arms.a.sent >= minSample && arms.b.sent >= minSample;

  let verdict = 'too early';
  let detail = `each variant needs ${minSample} sends (A has ${arms.a.sent}, B has ${arms.b.sent})`;
  let winner = null;

  if (enough) {
    const a = rate(arms.a);
    const b = rate(arms.b);
    // Rough significance: the gap has to clear two standard errors of the
    // difference. No p-values, no jargon — just "is this more than noise".
    const pooled = (arms.a.replied + arms.b.replied) / (arms.a.sent + arms.b.sent);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / arms.a.sent + 1 / arms.b.sent)) || 0;
    if (Math.abs(a - b) <= Math.max(0.05, 2 * se)) {
      verdict = 'inconclusive';
      detail = `A ${(a * 100).toFixed(0)}% vs B ${(b * 100).toFixed(0)}% — inside the noise for this many sends`;
    } else {
      winner = a > b ? 'a' : 'b';
      verdict = 'likely better';
      detail = `${winner.toUpperCase()} at ${((winner === 'a' ? a : b) * 100).toFixed(0)}% vs ${((winner === 'a' ? b : a) * 100).toFixed(0)}% — a real gap at this sample size`;
    }
  }

  return {
    ok: true,
    experiment: {
      id: experiment.id,
      kind: experiment.kind,
      variantA: experiment.variant_a,
      variantB: experiment.variant_b,
      status: experiment.status,
      minSample,
    },
    arms,
    rates: { a: rate(arms.a), b: rate(arms.b) },
    verdict,
    winner,
    detail,
    adopted: experiment.winner || null,
  };
}

export function experimentText(id) {
  const r = experimentResult(id);
  if (!r.ok) return r.reason || 'No such experiment.';
  const pct = (n) => `${Math.round(n * 100)}%`;
  const e = r.experiment;
  return [
    `🧪 *Experiment #${e.id} — ${e.kind}*`,
    '',
    `A: "${e.variantA}"`,
    `B: "${e.variantB}"`,
    '',
    `A: ${r.arms.a.sent} sent · ${r.arms.a.replied} replied (${pct(r.rates.a)})`,
    `B: ${r.arms.b.sent} sent · ${r.arms.b.replied} replied (${pct(r.rates.b)})`,
    '',
    `Verdict: *${r.verdict}* — ${r.detail}`,
    r.winner ? `\nNothing is rolled out automatically. .experiment adopt ${e.id} makes it the default.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Owner-only, and still only records the decision. */
export function adoptWinner(id, now = new Date()) {
  const r = experimentResult(id);
  if (!r.ok) return { ok: false, reason: r.reason };
  if (!r.winner) return { ok: false, reason: `not yet: ${r.detail}` };
  db.run("UPDATE experiments SET status = 'adopted', winner = ? WHERE id = ?", [r.winner, r.experiment.id]);
  db.logEvent('experiment_adopted', null, { id: r.experiment.id, winner: r.winner, at: now.toISOString() });
  return { ok: true, winner: r.winner, text: `✅ ${r.winner.toUpperCase()} is now the default for ${r.experiment.kind}.` };
}

export default { createExperiment, listExperiments, getExperiment, variantFor, recordSend, recordOutcome, experimentResult, experimentText, adoptWinner, EXPERIMENT_KINDS, DEFAULT_MIN_SAMPLE, experimentsEnabled };
