// src/eval/report.js
// Turning results into something a human can act on: one line per scenario, one
// line per category, and a JSON file that can be compared with yesterday's run.

import fs from 'node:fs';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

export const REPORT_VERSION = 2;

/** Counts per category, and a score out of 100 (PASS = 1, WARN = 0.5). */
export function summarise(results) {
  const byCategory = {};
  const totals = { total: results.length, pass: 0, warn: 0, fail: 0 };
  for (const r of results) {
    const cat = r.category || 'other';
    byCategory[cat] ||= { total: 0, pass: 0, warn: 0, fail: 0 };
    byCategory[cat].total += 1;
    if (r.status === 'PASS') {
      byCategory[cat].pass += 1;
      totals.pass += 1;
    } else if (r.status === 'WARN') {
      byCategory[cat].warn += 1;
      totals.warn += 1;
    } else {
      byCategory[cat].fail += 1;
      totals.fail += 1;
    }
  }
  const categories = Object.entries(byCategory)
    .map(([name, c]) => ({ name, ...c, score: Math.round(((c.pass + c.warn * 0.5) / c.total) * 100) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const score = totals.total ? Math.round(((totals.pass + totals.warn * 0.5) / totals.total) * 100) : 0;
  return { ...totals, score, categories };
}

export function buildReport({ mode, results, meta = {} }) {
  return {
    version: REPORT_VERSION,
    mode,
    generatedAt: new Date().toISOString(),
    summary: summarise(results),
    ...meta,
    scenarios: results.map((r) => ({
      id: r.id,
      title: r.title,
      category: r.category,
      language: r.language,
      template: r.template,
      status: r.status,
      score: r.status === 'PASS' ? 1 : r.status === 'WARN' ? 0.5 : 0,
      reasons: r.reasons || [],
      checks: (r.checks || []).map((c) => ({ id: c.id, status: c.status, detail: c.detail })),
      modelCalls: r.modelCalls || 0,
      replies: (r.replies || []).map((x) => x.text),
    })),
  };
}

export function writeReport(file, report) {
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

export function readReport(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function badge(status) {
  if (status === 'PASS') return `${C.green}PASS${C.reset}`;
  if (status === 'WARN') return `${C.yellow}WARN${C.reset}`;
  return `${C.red}FAIL${C.reset}`;
}

export function printReport(report, { colour = true } = {}) {
  const c = (code, text) => (colour ? `${code}${text}${C.reset}` : text);
  const lines = [];
  lines.push('');
  lines.push(c(C.bold, `Golden chat eval — ${report.mode} mode`));
  lines.push(c(C.dim, '─'.repeat(78)));

  const width = Math.min(44, Math.max(...report.scenarios.map((s) => s.id.length), 10) + 2);
  for (const s of report.scenarios) {
    const label = s.id.padEnd(width);
    const head = `${colour ? badge(s.status) : s.status.padEnd(4)}  ${label}`;
    const why = s.reasons?.length ? `  ${c(C.dim, s.reasons[0].slice(0, 90))}` : '';
    lines.push(`${head}${why}`);
  }

  lines.push(c(C.dim, '─'.repeat(78)));
  for (const cat of report.summary.categories) {
    lines.push(
      `  ${cat.name.padEnd(12)} ${String(cat.score).padStart(3)}%  ${c(C.dim, `${cat.pass} pass · ${cat.warn} warn · ${cat.fail} fail`)}`
    );
  }
  const { pass, warn, fail, total, score } = report.summary;
  const verdict = fail ? c(C.red, `${fail} FAIL`) : warn ? c(C.yellow, `${warn} WARN`) : c(C.green, 'all clear');
  lines.push(c(C.dim, '─'.repeat(78)));
  const noun = total === 1 ? 'scenario' : 'scenarios';
  lines.push(`  ${total} ${noun} · ${pass} pass · ${warn} warn · ${fail} fail · score ${score}% · ${verdict}`);
  lines.push('');
  console.log(lines.join('\n'));
}

/**
 * Compare against an older report: what got worse, and what got better.
 * A regression is anything that was PASS and is not any more, or a check that
 * used to pass and now fails.
 */
export function compareReports(oldReport, newReport) {
  const before = new Map((oldReport.scenarios || []).map((s) => [s.id, s]));
  const after = new Map((newReport.scenarios || []).map((s) => [s.id, s]));
  const rank = { PASS: 2, WARN: 1, FAIL: 0 };

  const regressions = [];
  const fixes = [];
  const added = [];
  const removed = [];

  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was) {
      added.push(id);
      continue;
    }
    if ((rank[now.status] ?? 0) < (rank[was.status] ?? 0)) {
      regressions.push({ id, from: was.status, to: now.status, why: now.reasons?.[0] || '' });
      continue;
    }
    if ((rank[now.status] ?? 0) > (rank[was.status] ?? 0)) {
      fixes.push({ id, from: was.status, to: now.status });
      continue;
    }
    // Same status, but a check that used to pass may now be failing.
    const oldChecks = new Map((was.checks || []).map((c) => [c.id, c.status]));
    for (const chk of now.checks || []) {
      if (oldChecks.get(chk.id) === 'PASS' && chk.status === 'FAIL') {
        regressions.push({ id, from: 'PASS', to: 'FAIL', why: `${chk.id}: ${chk.detail}` });
      }
    }
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);

  return { regressions, fixes, added, removed, oldScore: oldReport.summary?.score ?? null, newScore: newReport.summary?.score ?? null };
}

export function printComparison(diff, { colour = true } = {}) {
  const c = (code, text) => (colour ? `${code}${text}${C.reset}` : text);
  const lines = [''];
  lines.push(c(C.bold, `Compared with the previous run (${diff.oldScore}% → ${diff.newScore}%)`));
  if (!diff.regressions.length) lines.push(c(C.green, '  no regressions'));
  for (const r of diff.regressions) lines.push(c(C.red, `  ↓ ${r.id}: ${r.from} → ${r.to}${r.why ? ` — ${r.why}` : ''}`));
  for (const f of diff.fixes) lines.push(c(C.green, `  ↑ ${f.id}: ${f.from} → ${f.to}`));
  for (const id of diff.added) lines.push(c(C.cyan, `  + ${id} (new scenario)`));
  for (const id of diff.removed) lines.push(c(C.yellow, `  - ${id} (no longer in the suite)`));
  lines.push('');
  console.log(lines.join('\n'));
  return diff.regressions.length;
}

export default { summarise, buildReport, writeReport, readReport, printReport, compareReports, printComparison, REPORT_VERSION };
