// src/services/reasoning.js
// Phase 6 Part 3 — the reasoning router.
//
// Most messages do not need a reasoning model. The cheap rules here decide what
// "complex" means, and only those turns go through plan → act → verify → answer.
//
// Two things this module never does:
//   • store or show a chain of thought — the plan stays in memory for the turn
//     and only a rationale of at most 300 characters is written down;
//   • claim a number it did not read from the database. The verify step is the
//     gate for that, and a draft that fails it is retried once, then handed to
//     the owner.
//
// Additive: with features.reasoning off, every function returns "not used",
// and the normal brain answers exactly as it does today.

import { featureOn, business, profile } from './profile.js';
import { config } from '../config/env.js';
import * as db from '../utils/db.js';
import { chat, hasLLM } from '../core/llm.js';
import { detectLanguage } from './language.js';
import { fenceUntrusted } from '../core/injection.js';

const MAX_RATIONALE = 300;
const DAY = 24 * 3600 * 1000;

export const REASONING_PROVIDERS = [
  { id: 'gemini-thinking', provider: 'gemini', model: 'gemini-2.5-flash', label: 'Gemini thinking' },
  { id: 'groq-reasoning', provider: 'groq', model: 'deepseek-r1-distill-llama-70b', label: 'Groq reasoning' },
];

export function reasoningEnabled() {
  return featureOn('reasoning');
}

export function reasoningConfig() {
  const b = profile()?.brain || {};
  return {
    provider: String(b.reasoningProvider || 'auto'),
    model: String(b.reasoningModel || ''),
    dailyCalls: clampInt(b.dailyReasoningCalls, 200, 0, 100000),
    planTimeoutMs: clampInt(b.planTimeoutMs, 4000, 500, 20000),
    turnLatencyMs: clampInt(b.turnLatencyMs, 12000, 1000, 60000),
    maxRetries: clampInt(b.verifyRetries, 1, 0, 2),
  };
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// ── which provider ───────────────────────────────────────────

/** The reasoning adapter to use, or null when nothing is available. */
export function activeProvider(cfg = reasoningConfig()) {
  const available = new Set(config.llm?.providers || []);
  if (cfg.provider && cfg.provider !== 'auto') {
    const named = REASONING_PROVIDERS.find((p) => p.id === cfg.provider || p.provider === cfg.provider);
    if (named && available.has(named.provider)) {
      return cfg.model ? { ...named, model: cfg.model } : named;
    }
    return null; // explicitly configured providers do not silently substitute
  }
  return REASONING_PROVIDERS.find((p) => available.has(p.provider)) || null;
}

export function providerAvailable() {
  return Boolean(activeProvider()) && hasLLM();
}

// ── the daily budget ─────────────────────────────────────────

function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

const BUDGET_KEY = (now) => `brain_reasoning_${dayKey(now)}`;

export function reasoningUsedToday(now = new Date()) {
  const raw = db.getSetting(BUDGET_KEY(now), '0');
  return Math.max(0, Number(raw) || 0);
}

export function canReason(now = new Date(), cfg = reasoningConfig()) {
  if (cfg.dailyCalls <= 0) return { ok: false, reason: 'budget', used: 0, limit: cfg.dailyCalls };
  const used = reasoningUsedToday(now);
  return { ok: used < cfg.dailyCalls, reason: used < cfg.dailyCalls ? 'ok' : 'budget', used, limit: cfg.dailyCalls };
}

export function reasoningBudget(cfg = reasoningConfig()) {
  return cfg.dailyCalls;
}

export function noteReasoningCall(now = new Date()) {
  const used = reasoningUsedToday(now) + 1;
  db.setSetting(BUDGET_KEY(now), String(used));
  return used;
}

// ── the router ───────────────────────────────────────────────

const HIGH_VALUE = /\b(refund|compensation|lawyer|legal|cancel (my|the) (order|booking)|bulk|wholesale|invoice|debt|damage[sd]?|injur|allerg)\b/i;
const HIGH_VALUE_UR = /(رقم واپس|واپس کریں|شکایت|وکیل|منسوخ|بل)/;
const AMBIGUOUS = /^(kya|kia|hai\?|hmm+|ok\??|theek|acha|hello|hi|salam|help)\s*[?.!]*$/i;
const MULTI_STEP = /(\band then\b|\balso\b|\baur phir\b|\bphir\b|\bbaqi\b|\?{2,})/i;

/**
 * Decide whether a turn needs the reasoning path. Rules only — no model.
 * @returns {{complex:boolean, score:number, reasons:string[]}}
 */
export function classifyTurn({ text = '', history = [], mood = null } = {}) {
  const body = String(text || '').trim();
  const reasons = [];
  let score = 0;
  const words = body.split(/\s+/).filter(Boolean);

  if (!body) return { complex: false, score: 0, reasons: ['empty'] };

  const questions = (body.match(/\?/g) || []).length + (body.match(/؟/g) || []).length;
  if (questions >= 2 || MULTI_STEP.test(body)) {
    score += 2;
    reasons.push('multi-step');
  }
  if (body.length > 180 || words.length > 35) {
    score += 1;
    reasons.push('long message');
  }
  if (HIGH_VALUE.test(body) || HIGH_VALUE_UR.test(body)) {
    score += 2;
    reasons.push('high-value');
  }
  if (/\d{4,}/.test(body) && /(budget|total|discount|%|rupees|pkr|rs)/i.test(body)) {
    score += 1;
    reasons.push('money in the message');
  }
  if (history.length >= 12) {
    score += 1;
    reasons.push('long history');
  }
  if (AMBIGUOUS.test(body) || (words.length <= 2 && !/\d/.test(body))) {
    score += 1;
    reasons.push('ambiguous');
  }
  // Two different quantities for the same ask usually means a comparison.
  const quantities = [...body.matchAll(/\b(\d{1,3})\b/g)].map((m) => m[1]);
  if (new Set(quantities).size >= 3 && /\b(or|ya|but|lekin)\b/i.test(body)) {
    score += 1;
    reasons.push('conflicting numbers');
  }
  if (mood === 'angry' || mood === 'frustrated') {
    score += 1;
    reasons.push('upset customer');
  }

  return { complex: score >= 2, score, reasons };
}

// ── plan ─────────────────────────────────────────────────────

/**
 * Ask the reasoning provider for a plan. The plan is *not* stored: it exists
 * for one turn and is reduced to a short rationale.
 */
export async function makePlan({ text = '', langInfo = null, history = [], now = new Date(), cfg = reasoningConfig(), provider = activeProvider(cfg) } = {}) {
  if (!provider) return { ok: false, reason: 'no_provider' };
  const budget = canReason(now, cfg);
  if (!budget.ok) return { ok: false, reason: 'budget', used: budget.used, limit: budget.limit };

  const recent = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'customer' : 'business'}: ${String(m.content || '').slice(0, 160)}`)
    .join('\n');

  const started = Date.now();
  try {
    const res = await chat({
      system: [
        'You plan, you do not answer.',
        'Given a WhatsApp message from a customer, list at most three things the assistant must check or do before replying.',
        'Rules: never invent a price or availability; escalate refunds, legal and medical questions; keep the customer\'s language.',
        'Reply as JSON: {"steps":["..."],"risk":"low|medium|high"}.',
      ].join(' '),
      messages: [
        {
          role: 'user',
          content: `Recent conversation:\n${fenceUntrusted(recent || '(none)')}\n\nNew message:\n${fenceUntrusted(text)}\n\nLanguage: ${langInfo?.name || 'unknown'}`,
        },
      ],
      json: true,
      maxTokens: 220,
      temperature: 0.2,
      timeoutMs: cfg.planTimeoutMs,
      provider: provider.provider,
      model: provider.model,
    });
    noteReasoningCall(now);

    let data = null;
    try {
      data = JSON.parse(String(res?.text || '').replace(/```(?:json)?/gi, '').trim());
    } catch {
      data = null;
    }
    const steps = Array.isArray(data?.steps)
      ? data.steps.map((s) => String(s).trim()).filter(Boolean).slice(0, 3)
      : [];
    if (!steps.length) return { ok: false, reason: 'empty_plan', provider: provider.id, ms: Date.now() - started };
    return {
      ok: true,
      steps,
      risk: ['low', 'medium', 'high'].includes(data?.risk) ? data.risk : 'medium',
      provider: provider.id,
      model: provider.model,
      ms: Date.now() - started,
      rationale: summarisePlan(steps),
    };
  } catch (err) {
    return { ok: false, reason: 'provider_error', detail: String(err.message || err).slice(0, 120), provider: provider.id, ms: Date.now() - started };
  }
}

/** What we keep: one short line, never the steps themselves. */
export function summarisePlan(steps = []) {
  const line = `Checked: ${steps.map((s) => String(s).toLowerCase()).join('; ')}`;
  return line.length > MAX_RATIONALE ? `${line.slice(0, MAX_RATIONALE - 1)}…` : line;
}

// ── verify ───────────────────────────────────────────────────

const FORBIDDEN = [
  /you are a helpful/i,
  /system prompt/i,
  /<\/?(untrusted|system|instructions?)>/i,
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bgsk_[A-Za-z0-9]{8,}\b/,
  /\bAIza[0-9A-Za-z_-]{10,}\b/,
];

/** Every number the panel of facts contains — the only digits a reply may use. */
export function allowedDigits({ orders = null } = {}) {
  const p = profile() || {};
  const texts = [];
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string' || typeof v === 'number') texts.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(p.catalog);
  walk(p.policies);
  walk(p.business);
  walk(p.faqs);
  walk(p.owner);
  const set = new Set();
  for (const text of texts) for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) set.add(m[0].replace(/,/g, ''));

  // Ids and totals the customer legitimately sees back.
  try {
    const rows = orders || db.all('SELECT id, total FROM orders ORDER BY id DESC LIMIT 50');
    for (const row of rows) {
      if (row.id !== null && row.id !== undefined) set.add(String(row.id));
      if (row.total !== null && row.total !== undefined) set.add(String(row.total));
    }
    for (const row of db.all('SELECT id, rating FROM bookings ORDER BY id DESC LIMIT 50')) {
      if (row.id !== null && row.id !== undefined) set.add(String(row.id));
    }
  } catch {
    /* no database yet */
  }
  return set;
}

/**
 * The gate. A draft that fails here is never sent as-is.
 * @returns {{ok:boolean, problems:string[]}}
 */
export function verifyAnswer({
  reply = '',
  langInfo = null,
  digits = null,
  sideEffects = null,
  pendingBefore = false,
  expectLanguage = true,
} = {}) {
  const problems = [];
  const body = String(reply || '').trim();
  if (!body) return { ok: false, problems: ['empty reply'] };

  for (const re of FORBIDDEN) {
    const hit = body.match(re);
    if (hit) problems.push(`forbidden text: "${String(hit[0]).slice(0, 24)}"`);
  }

  if (expectLanguage && langInfo?.code) {
    // Script first, because that is the mismatch a customer actually notices.
    // Between two Latin-script languages the detector is only trustworthy when
    // its own markers voted — franc will happily call a short English sentence
    // Hungarian, and handing every such reply to the owner would be worse than
    // the mistake it is meant to catch.
    const want = String(langInfo.code);
    const got = detectLanguage(body);
    const romanMarkers = /\b(hai|hain|kya|nahi|nahin|aap|yaar|bhai|chahiye|karo|mujhe|kitna|kitne|theek|acha|bilkul|zaroor|karein|hoga|hai)\b/i;
    const latin = (code, script) => script === 'latin' || ['en', 'roman-ur', 'unknown'].includes(code);
    const wantLatin = latin(want, null);
    const gotLatin = latin(got.code, got.script);

    if (wantLatin && !gotLatin) {
      problems.push(`language: expected ${want}, got ${got.code}`);
    } else if (!wantLatin && gotLatin) {
      problems.push(`language: expected ${want}, got ${got.code}`);
    } else if (want === 'roman-ur' && got.code === 'en' && !romanMarkers.test(body)) {
      problems.push('language: expected roman-ur, got en');
    } else if (want === 'en' && got.code === 'roman-ur' && Number(got.confidence) >= 0.6) {
      problems.push('language: expected en, got roman-ur');
    }
  }

  const allowed = digits || allowedDigits();
  for (const m of body.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const n = m[0].replace(/,/g, '');
    if (/^(19|20)\d{2}$/.test(n)) continue; // a year is not a claim
    if (n.replace(/\D/g, '').length < 2) continue; // "2 items", "7 days" read from config anyway
    if (!allowed.has(n)) problems.push(`number "${n}" is not in the catalogue, orders or bookings`);
  }

  if (sideEffects) {
    const created = Number(sideEffects.orders || 0) + Number(sideEffects.bookings || 0);
    if (created > 0 && !pendingBefore && !sideEffects.confirmed) {
      problems.push('a booking or order was written without a confirmation');
    }
  }

  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

// ── the turn ─────────────────────────────────────────────────

/**
 * The whole reasoning pass for one turn: classify, plan (if complex), and hand
 * back the plan plus the checks the caller must run after generating a reply.
 */
export async function reasonAboutTurn({ text = '', langInfo = null, history = [], now = new Date(), cfg = reasoningConfig(), chat = null } = {}) {
  const verdict = { used: false, complex: false, reasons: [], plan: null, provider: null, problems: [] };
  if (!reasoningEnabled()) return { ...verdict, reason: 'disabled' };

  const cls = classifyTurn({ text, history });
  verdict.complex = cls.complex;
  verdict.reasons = cls.reasons;
  if (!cls.complex) return { ...verdict, reason: 'simple' };

  const provider = activeProvider(cfg);
  if (!provider || !hasLLM()) return { ...verdict, reason: 'no_provider' };

  const budget = canReason(now, cfg);
  if (!budget.ok) return { ...verdict, reason: 'budget', budgetUsed: budget.used, budgetLimit: budget.limit };

  const plan = await makePlan({ text, langInfo, history, now, cfg, provider });
  if (!plan.ok) {
    return { ...verdict, reason: plan.reason, provider: provider.id, problems: plan.detail ? [plan.detail] : [] };
  }

  verdict.used = true;
  verdict.plan = plan;
  verdict.provider = provider.id;
  // The only thing written down: one short line saying what was checked. The
  // steps themselves are not stored, logged or shown.
  recordDecision({
    chat,
    kind: 'reasoning',
    action: 'plan',
    rationale: plan.rationale,
    payload: { provider: provider.id, ms: plan.ms, reasons: cls.reasons },
    outcome: 'planned',
    now,
  });
  return verdict;
}

/** A precedence line the model is allowed to see (never the reasoning itself). */
export function planAddendum(plan) {
  if (!plan?.steps?.length) return '';
  return [
    'Before answering, check these points (internal checklist, do not mention it):',
    ...plan.steps.map((s, i) => `${i + 1}. ${s}`),
    'If any check fails, ask the one question you need instead of guessing.',
  ].join('\n');
}

/** Record the decision — a short rationale only, never the chain of thought. */
export function recordDecision({ chat = null, kind = 'reasoning', action = '', rationale = '', payload = null, outcome = null, now = new Date() } = {}) {
  try {
    const short = String(rationale || '').slice(0, MAX_RATIONALE);
    db.run(
      'INSERT INTO brain_decisions (tenant, chat, kind, action, rationale, payload, outcome, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [config.tenant?.slug || null, chat, kind, action, short, payload ? JSON.stringify(payload).slice(0, 2000) : null, outcome, now.toISOString()]
    );
    db.logEvent('brain_decision', chat, { kind, action: String(action).slice(0, 80) });
    return true;
  } catch {
    return false;
  }
}

/** The holding reply used when a complex turn runs out of time. */
export function holdingReply(lang = 'en') {
  const lines = {
    en: "I'm checking this properly for you — one moment. If it needs a person, the owner will pick it up from here.",
    'roman-ur': 'Main is ko theek se check kar raha hoon — ek lamha. Agar kisi insaan ki zaroorat hui to owner khud dekh lein ge.',
    ur: 'میں اسے ٹھیک سے دیکھ رہا ہوں — ایک لمحہ۔ اگر کسی شخص کی ضرورت ہوئی تو مالک خود دیکھیں گے۔',
  };
  return lines[lang] || lines.en;
}

/** Hand-off text after a verify failure that could not be repaired. */
export function verifyHandoff(lang = 'en') {
  const lines = {
    en: "I don't want to give you a wrong detail on this one, so I'm passing it to the owner — they will reply here shortly.",
    'roman-ur': 'Main is par galat detail nahi dena chahta, is liye owner ko de raha hoon — woh yahin reply karein ge.',
    ur: 'میں اس پر غلط تفصیل نہیں دینا چاہتا، اس لیے مالک کو دے رہا ہوں — وہ یہیں جواب دیں گے۔',
  };
  return lines[lang] || lines.en;
}

export default {
  reasoningEnabled,
  reasoningConfig,
  REASONING_PROVIDERS,
  activeProvider,
  providerAvailable,
  canReason,
  reasoningUsedToday,
  noteReasoningCall,
  classifyTurn,
  makePlan,
  summarisePlan,
  verifyAnswer,
  allowedDigits,
  reasonAboutTurn,
  planAddendum,
  recordDecision,
  holdingReply,
  verifyHandoff,
};
