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
import { sentenceCount } from '../core/brevity.js';
import { endsMidSentence, extractRanges, checkPersona } from '../core/replyGuard.js';

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

/** Every published price band in the profile: [{min, max}] */
function priceBands(profile = {}) {
  const bands = [];
  const push = (item) => {
    const min = Number(item?.min ?? item?.price);
    const max = Number(item?.max ?? item?.price ?? item?.min);
    if (Number.isFinite(min) && min > 0) bands.push({ min, max: Number.isFinite(max) && max > 0 ? max : min });
  };
  const items = Array.isArray(profile.catalog) ? profile.catalog : profile.catalog?.items || [];
  for (const item of items) push(item);
  for (const item of profile.owner?.services || []) push(item);
  for (const item of profile.owner?.addons || []) push(item);
  return bands;
}

/** A guard event's problems, whether the detail is JSON or free text. */
function guardProblems(event) {
  const detail = event?.detail;
  if (!detail) return [];
  if (typeof detail === 'object') return Array.isArray(detail.problems) ? detail.problems : [];
  try {
    const parsed = JSON.parse(detail);
    if (Array.isArray(parsed?.problems)) return parsed.problems.map(String);
  } catch {
    /* not JSON: fall through to the plain-text form */
  }
  return [String(detail)];
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

  // ── the assistant that answered ───────────────────────────
  // Only scenarios that name an assistant are judged on it, so every existing
  // scenario is untouched.
  if (a.agent || Array.isArray(a.agents)) {
    const trail = (run.agentTrail || []).map((x) => x.agent).filter(Boolean);
    if (a.agent) {
      const last = trail[trail.length - 1] || null;
      checks.push(
        failIfAny('agent', last === a.agent ? [] : [`expected "${a.agent}", saw "${last || 'none'}"`], { hard: true })
      );
    }
    if (Array.isArray(a.agents)) {
      const seen = [...new Set(trail)].sort();
      const want = [...a.agents].sort();
      const same = seen.length === want.length && seen.every((id, i) => id === want[i]);
      checks.push(
        failIfAny('agents', same ? [] : [`expected [${want.join(', ')}], saw [${seen.join(', ')}]`], { hard: true })
      );
    }
  }

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
    // A number inside a published price band is a quote, not an invention:
    // 155,000 for a store listed at 120,000–350,000 is derived from the price
    // list, while 90,000 is below its floor and still fails.
    const bands = priceBands(run.profile);
    const inBand = (raw) => {
      const n = Number(String(raw).replace(/,/g, ''));
      return Number.isFinite(n) && bands.some((b) => n >= b.min && n <= b.max);
    };
    const problems = digitGaps(replies, allowed).filter((line) => {
      const m = line.match(/^"([^"]+)"/);
      return !(m && inBand(m[1]));
    });
    // A draft the pipeline had to throw away still counts: the model invented a
    // price, and the fact that the customer never saw it is the repair working,
    // not the model behaving.
    if (!a.expectGuardRepair) {
      for (const event of events) {
        if (!/^reply_guard_rejected$/.test(String(event.type || ''))) continue;
        for (const line of guardProblems(event)) {
          const hit = String(line).match(/number "([^"]+)" is not in the catalogue/);
          if (hit) problems.push(`the model invented "${hit[1]}" and the draft was replaced`);
        }
      }
    }
    checks.push(
      failIfAny('numbers', problems, {
        hard: !softNumbers,
        okDetail: `every number came from the fixture (${allowed.size} known)`,
      })
    );
  }

  // ── one customer message, one reply ───────────────────────
  // The batch pipeline has many senders; a customer must never get two answers
  // to one message, and two answers must never be glued into one bubble.
  // Counted in logical replies (one per batch), not bubbles: an answer split
  // over three bubbles on a phone is still one answer.
  const batchesOf = (turn) => {
    const t = (run.turns || []).find((x) => x.index === turn);
    if (t && Number.isFinite(t.batches)) return t.batches;
    return replies.filter((r) => r.turn === turn).length;
  };
  const turnsWithReplies = [...new Set(replies.map((r) => r.turn))];
  if (a.oneReplyPerTurn !== false) {
    const multi = [];
    let total = 0;
    for (const turn of turnsWithReplies) {
      const n = batchesOf(turn);
      total += n;
      if (n > 1) multi.push(`turn ${turn}: ${n} separate replies`);
    }
    checks.push(failIfAny('one_reply', multi, { okDetail: `${total} repl${total === 1 ? 'y' : 'ies'}, one per message` }));
  }
  if (a.maxReplies !== undefined) {
    const total = turnsWithReplies.reduce((n, turn) => n + batchesOf(turn), 0);
    checks.push(
      failIfAny('max_replies', total > Number(a.maxReplies) ? [`${total} replies > ${a.maxReplies}`] : [], {
        okDetail: `${total} ≤ ${a.maxReplies}`,
      })
    );
  }

  // ── brevity: how many sentences did the customer have to read? ──
  // Optional, so no existing scenario changes meaning. A quote or a list is
  // exempt in the pipeline itself, and scenarios that expect one simply do not
  // set this.
  if (a.maxSentences !== undefined) {
    const over = [];
    for (const r of replies) {
      const n = sentenceCount(r.text);
      if (n > Number(a.maxSentences)) over.push(`turn ${r.turn}: ${n} sentences > ${a.maxSentences} — "${r.text.slice(0, 70)}"`);
    }
    checks.push(failIfAny('max_sentences', over, { okDetail: `≤ ${a.maxSentences} sentence(s) per reply` }));
  }

  // ── a reaction instead of a reply ─────────────────────────
  // "ok" and "thanks" get a 👍 (or nothing at all), never a paragraph.
  if (a.reactionOnly) {
    const reactions = run.reactions || [];
    const problems = [];
    if (!reactions.length) problems.push('no reaction was sent');
    if (replies.length) problems.push(`${replies.length} text repl${replies.length === 1 ? 'y' : 'ies'} sent, expected none`);
    checks.push(failIfAny('reaction_only', problems, { okDetail: `${reactions.length} reaction(s), no text` }));
  }

  // ── nothing ends mid-sentence ─────────────────────────────
  if (a.noMidSentence !== false) {
    const cut = [];
    for (const r of replies) {
      const verdict = endsMidSentence(r.text);
      if (verdict.cut) cut.push(`turn ${r.turn}: ${verdict.reason} — "${r.text.slice(-40)}"`);
    }
    checks.push(failIfAny('no_mid_sentence', cut, { okDetail: 'every reply ends on a finished sentence' }));
  }

  // ── the same project is never quoted two different ranges ──
  if (a.samePrice !== false) {
    const ranges = [];
    for (const r of replies) {
      for (const range of extractRanges(r.text)) ranges.push({ turn: r.turn, ...range });
    }
    const distinct = new Set(ranges.map((r) => `${r.lo}-${r.hi}`));
    checks.push(
      failIfAny('same_price', distinct.size > 1 ? [`ranges differ: ${[...distinct].join(' vs ')}`] : [], {
        okDetail: ranges.length ? `one range: ${[...distinct][0]}` : 'no price range quoted',
      })
    );
  }

  // ── one voice ─────────────────────────────────────────────
  if (a.persona === 'strict' || a.persona === true) {
    const mixed = [];
    for (const r of replies) {
      const problems = checkPersona(r.text, { strict: false });
      if (problems.length) mixed.push(`turn ${r.turn}: ${problems[0]}`);
    }
    checks.push(failIfAny('persona', mixed, { okDetail: 'one voice in every reply' }));
  }

  // ── a document answer only says what the file says ────────
  if (a.documentGrounded) {
    // Every number in the reply must appear in the document the customer sent,
    // or in the profile/seeds (a price the business published).
    const sourceText = (scenario.turns || [])
      .map((t) => (t.document && t.document.text) || '')
      .join('\n');
    const docNumbers = new Set((sourceText.match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[,.]$/, '')));
    const groundedAllowed = allowedNumbers({
      profile: run.profile,
      scenario,
      seeds: run.seedEcho || [],
      extra: [...(run.extraNumbers || []), ...docNumbers],
    });
    const problems = [];
    for (const r of replies) {
      for (const m of r.text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
        const raw = m[0].replace(/,/g, '');
        if (groundedAllowed.has(raw) || docNumbers.has(raw)) continue;
        problems.push(`"${m[0]}" in turn ${r.turn} is not in the document`);
        break;
      }
    }
    checks.push(failIfAny('document_grounded', problems, { okDetail: 'only what the file says' }));
  }

  // ── the fallback really happened ──────────────────────────
  if (a.providerFallback) {
    const traces = run.traces || [];
    const fellBack = traces.some((t) => t.fallback) || (run.events || []).some((e) => /llm_fallback|reply_cut_detected/.test(String(e.type)));
    checks.push(
      failIfAny('provider_fallback', fellBack ? [] : ['no fallback was recorded, the chain was never exercised'], {
        okDetail: 'the chain moved to a fallback and answered once',
      })
    );
  }

  // ── the repair really ran ─────────────────────────────────
  // A scenario that says "the draft will be caught" must actually have caught
  // one; otherwise it is measuring a pipeline that never needed to repair.
  if (a.expectGuardRepair) {
    const rejected = events.filter((e) => /^reply_guard_rejected$/.test(String(e.type || '')));
    const repaired = events.filter((e) => /^reply_guard_(repaired|safe_line)$/.test(String(e.type || '')));
    checks.push(
      failIfAny(
        'guard_repair',
        [
          ...(rejected.length ? [] : ['no draft was rejected — the scenario did not exercise the guard']),
          ...(repaired.length ? [] : ['a draft was rejected but the run did not record a repair']),
        ],
        { okDetail: `${rejected.length} rejected, ${repaired.length} repaired` }
      )
    );
  }

  // ── the right language ────────────────────────────────────
  // Checked twice: on what the customer actually received, and on what the
  // model actually wrote. The pipeline may replace an off-language draft with a
  // safe line, which is the right behaviour — but the model's mistake still has
  // to show up in the report instead of hiding behind the repair.
  const wrongLanguage = [];
  for (const reply of replies) {
    const seen = languageOf(reply.text);
    if (seen === 'empty') continue;
    if (seen !== expectLang) {
      wrongLanguage.push(`turn ${reply.turn}: expected ${expectLang}, got ${seen} — "${reply.text.slice(0, 60)}…"`);
    }
  }
  for (const event of run.events || []) {
    if (!/^reply_guard_rejected$/.test(String(event.type || ''))) continue;
    const lines = guardProblems(event).filter((line) => /^language:/.test(String(line)));
    if (!lines.length) continue;
    wrongLanguage.push(`the model answered in the wrong language and was replaced: ${lines[0]}`);
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
