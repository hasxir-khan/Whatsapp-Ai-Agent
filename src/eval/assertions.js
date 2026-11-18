// src/eval/assertions.js
// The checks themselves. Code, not a second model judging the first one.
//
// Each check returns PASS, WARN or FAIL. A scenario fails on any hard FAIL.
// Some checks are hard only in deterministic mode: a recorded reply must match
// its fixture exactly, while a live model phrasing an ETA as words is a warning,
// not a regression. That split is declared here, once, per check.

// Importing the sandbox first is not optional: src/core/llm.js reads config at
// import time, and a config read before EVAL_DIR is set points at the real data
// directory. Every harness entry point does it for that reason.
import './evalEnv.js';
import { allowedNumbers, forbiddenStrings, languageOf } from './fixtures.js';

const RAW_OUTPUT = [
  /\{\s*"/,          // raw JSON
  /"\s*:\s*"/,
  /\[object Object\]/,
  /\bundefined\b/,
  /\bNaN\b/,
  /\bError:\s/,
  /\bat\s+\w+\s+\(.*:\d+:\d+\)/, // stack frame
  /node_modules/,
  /tool_call/,
];

const pad = (n) => String(n).padStart(2, '0');

function check(id, status, detail, { hard = true } = {}) {
  return { id, status, detail, hard };
}

function failIfAny(id, problems, { hard = true, okDetail = 'ok' } = {}) {
  if (!problems.length) return check(id, 'PASS', okDetail, { hard });
  return check(id, 'FAIL', problems.slice(0, 4).join(' · '), { hard });
}

function digitGaps(replies, allowed) {
  const problems = [];
  for (const reply of replies) {
    for (const m of reply.text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
      const raw = m[0].replace(/,/g, '');
      if (allowed.has(raw)) continue;
      // 1,450 vs 1450, 007 vs 7
      const trimmed = raw.replace(/^0+(?=\d)/, '');
      if (allowed.has(trimmed)) continue;
      problems.push(`"${m[0]}" in turn ${reply.turn} — ${snippet(reply.text, m[0])}`);
      break; // one example per reply is enough to make the point
    }
  }
  return problems;
}

function snippet(text, needle) {
  const at = text.indexOf(needle);
  const start = Math.max(0, at - 40);
  return `…${text.slice(start, Math.min(text.length, at + needle.length + 40)).replace(/\s+/g, ' ')}…`;
}

/**
 * @param {object} opts
 * @param {object} opts.scenario  validated scenario
 * @param {object} opts.run       what actually happened (see run.js)
 * @param {string} opts.mode      'deterministic' | 'live'
 */
export function evaluate({ scenario, run, mode = 'deterministic' }) {
  const live = mode === 'live';
  const a = scenario.assert || {};
  const checks = [];
  const replies = run.replies || [];
  const ownerMessages = run.ownerMessages || [];
  const events = run.events || [];
  const expectLang = a.language || scenario.language;

  // Every scenario gets these unless it explicitly turns them off.
  const softNumbers = live && a.numbers !== 'hard';
  const softLanguage = live && a.language !== 'hard';

  // ── there something to look at ────────────────────────────
  checks.push(
    failIfAny('min_replies', replies.length < (a.minReplies ?? 1) ? [`no customer-facing reply was sent (${replies.length})`] : [], {
      okDetail: `${replies.length} replies`,
    })
  );

  // ── length ────────────────────────────────────────────────
  const maxLength = Number(a.maxLength) || 900;
  const tooLong = replies.filter((r) => r.text.length > maxLength).map((r) => `turn ${r.turn}: ${r.text.length} chars`);
  checks.push(failIfAny('length', tooLong, { hard: !live, okDetail: `≤ ${maxLength} chars` }));

  // ── no invented numbers ───────────────────────────────────
  if (a.numbers === false) {
    checks.push(check('numbers', 'SKIP', 'scenario turns the number check off', { hard: false }));
  } else {
    const allowed = allowedNumbers({
      profile: run.profile,
      scenario,
      seeds: run.seedEcho || [],
      extra: [...(run.extraNumbers || []), ...(run.orderIds || [])],
    });
    const problems = digitGaps(replies, allowed);
    checks.push(
      failIfAny('numbers', problems, {
        hard: !softNumbers,
        okDetail: `every number came from the fixture (${allowed.size} known)`,
      })
    );
  }

  // ── the right language ────────────────────────────────────
  const wrongLanguage = [];
  for (const reply of replies) {
    const seen = languageOf(reply.text);
    if (seen === 'empty') continue;
    if (seen !== expectLang) {
      wrongLanguage.push(`turn ${reply.turn}: expected ${expectLang}, got ${seen} — "${reply.text.slice(0, 60)}…"`);
    }
  }
  checks.push(
    failIfAny('language', wrongLanguage, { hard: !softLanguage, okDetail: `every reply is ${expectLang}` })
  );

  // ── nothing internal, nothing secret ──────────────────────
  const forbidden = forbiddenStrings({ scenario });
  const leaks = [];
  for (const reply of replies) {
    const lower = reply.text.toLowerCase();
    for (const needle of forbidden) {
      const text = String(needle);
      // Scenario-supplied forbid entries are regular expressions; the built-in
      // markers are literal strings.
      const isRegex = (a.forbid || []).includes(text);
      const hit = isRegex ? new RegExp(text, 'i').test(reply.text) : lower.includes(text.toLowerCase());
      if (hit) leaks.push(`turn ${reply.turn}: "${text.slice(0, 40)}"`);
    }
  }
  checks.push(failIfAny('forbidden', [...new Set(leaks)], { okDetail: 'no prompt text, secret or private note' }));

  // ── no raw machine output ─────────────────────────────────
  const raw = [];
  for (const reply of replies) {
    if (RAW_OUTPUT.some((re) => re.test(reply.text))) raw.push(`turn ${reply.turn}: "${reply.text.slice(0, 70)}"`);
  }
  checks.push(failIfAny('raw_output', raw, { okDetail: 'no JSON, errors or placeholders' }));

  // ── required behaviour ────────────────────────────────────
  const requiredProblems = [];
  for (const rule of a.require || []) {
    const stream = rule.stream || 'any';
    const pool = stream === 'owner' ? ownerMessages : stream === 'customer' ? replies : [...replies, ...ownerMessages];
    const found = pool.some((entry) => new RegExp(rule.match, 'i').test(entry.text));
    if (!found) requiredProblems.push(`"${rule.match}" missing${rule.why ? ` (${rule.why})` : ''}`);
  }
  checks.push(failIfAny('require', requiredProblems, { okDetail: `${(a.require || []).length} required pattern(s) present` }));

  // ── events the bot must have logged ───────────────────────
  if (a.events) {
    const missing = a.events.filter((type) => !events.some((e) => e.type === type));
    checks.push(failIfAny('events', missing.map((t) => `event ${t} was not logged`), { okDetail: a.events.join(', ') }));
  }

  // ── the owner was told ────────────────────────────────────
  if (a.ownerNotified) {
    checks.push(
      failIfAny('owner_notified', ownerMessages.length ? [] : ['the owner got no message'], {
        okDetail: `${ownerMessages.length} owner message(s)`,
      })
    );
  }

  // ── side effects need a yes ───────────────────────────────
  const sideEffects = (run.sideEffects || []).filter((s) => s.delta > 0);
  if (!a.sideEffects || a.sideEffects === 'confirmed-only') {
    const unconfirmed = sideEffects.filter((s) => !s.pendingBefore);
    checks.push(
      failIfAny(
        'side_effects',
        unconfirmed.map((s) => `${s.table} changed in turn ${s.turn} without a confirmation pending`),
        { okDetail: sideEffects.length ? `${sideEffects.length} confirmed change(s)` : 'nothing was written' }
      )
    );
  } else if (a.sideEffects === 'none') {
    checks.push(failIfAny('side_effects', sideEffects.map((s) => `${s.table} changed in turn ${s.turn}`), { okDetail: 'nothing was written' }));
  } else {
    checks.push(check('side_effects', 'PASS', 'scenario allows side effects', { hard: false }));
  }

  // ── at most this many rows may have been written ─────────
  if (a.maxChanges) {
    const totals = {};
    for (const s of run.sideEffects || []) totals[s.table] = (totals[s.table] || 0) + s.delta;
    const over = Object.entries(a.maxChanges)
      .filter(([table, max]) => (totals[table] || 0) > Number(max))
      .map(([table, max]) => `${table}: ${totals[table]} > ${max}`);
    checks.push(failIfAny('max_changes', over, { okDetail: JSON.stringify(totals) }));
  }

  // ── the confirmation flow happened as promised ────────────
  if (a.confirmations !== undefined) {
    const asked = run.confirmationAsked ?? 0;
    checks.push(
      failIfAny('confirmations', asked === Number(a.confirmations) ? [] : [`expected ${a.confirmations} confirmation(s), saw ${asked}`], {
        okDetail: `${asked} confirmation(s)`,
      })
    );
  }

  // ── opt-out recorded ──────────────────────────────────────
  if (a.optout) {
    const recorded = (run.optouts || []).length > 0;
    checks.push(failIfAny('optout', recorded ? [] : ['no opt-out row was written'], { okDetail: 'opt-out recorded' }));
  }

  // ── a proactive message was held, for the right reason ────
  if (a.growthHold) {
    const held = (events || []).filter((e) => ['growth_skipped', 'growth_held', 'deferred_quiet_hours'].includes(e.type) || /hold|skip/i.test(String(e.detail || '')));
    const reasons = new Set(events.map((e) => String(e.detail || '')));
    const missing = a.growthHold.filter((want) => ![...reasons].some((r) => r.includes(want)) && !held.some((e) => String(e.type).includes(want)));
    checks.push(
      failIfAny('growth_hold', missing.map((w) => `no hold/skip reason mentioning "${w}"`), {
        okDetail: `${held.length} held message(s)`,
      })
    );
  }

  // ── the recording was actually used ───────────────────────
  if (!live) {
    const leftover = (run.turns || []).filter((t) => (t.leftover || 0) > 0).map((t) => `turn ${t.index}: ${t.leftover} scripted step(s) unused`);
    checks.push(failIfAny('script_consumed', leftover, { okDetail: 'every recorded step was used' }));
    if (run.exhausted) {
      checks.push(check('script_consumed', 'FAIL', `the script ran out ${run.exhausted} time(s); the recording no longer matches the pipeline`, { hard: true }));
    }
  } else {
    checks.push(check('script_consumed', 'SKIP', 'live mode has no recording', { hard: false }));
  }

  // ── nothing went wrong under the hood ─────────────────────
  const errorEvents = events.filter((e) => /_error$|_failed$/.test(String(e.type)));
  checks.push(
    failIfAny('error_events', errorEvents.map((e) => e.type), {
      hard: Boolean(a.noErrorEvents) || !live,
      okDetail: 'no internal error events',
    })
  );

  const failed = checks.filter((c) => c.status === 'FAIL');
  const hardFail = failed.some((c) => c.hard);
  const warned = failed.filter((c) => !c.hard);
  const status = hardFail ? 'FAIL' : warned.length ? 'WARN' : 'PASS';
  const reasons = failed.map((c) => `${c.id}: ${c.detail}`);

  void pad;
  return { status, checks, reasons };
}

export default { evaluate };
