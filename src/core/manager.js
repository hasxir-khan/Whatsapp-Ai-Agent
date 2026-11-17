// src/core/manager.js
// Intent routing — which specialist should answer this message.
//
// Order of work, cheapest first:
//   1. rules: keywords in the languages this bot actually receives, plus the
//      mood brain.js already detected. Most messages stop here, at zero cost.
//   2. cache: if this chat was routed a moment ago, remember the answer for
//      the current conversation instead of re-deciding every message.
//   3. the model: only when the rules are genuinely unsure, with a small
//      model, JSON output and a 3 second leash.
//
// If all of that fails, the caller gets `other` and the normal brain answers.
// Routing must never be the reason a customer waits.

import { chat, hasLLM } from './llm.js';
import { featureOn } from '../services/profile.js';

export const INTENTS = ['sales', 'support', 'booking', 'complaint', 'other'];

/**
 * Each agent keeps the persona and language rules from brain.js; what changes
 * is its job, its prompt addendum and the tools it may use.
 */
export const AGENTS = {
  sales: {
    label: 'Sales',
    emoji: '💬',
    tools: ['check_stock', 'send_quote', 'create_order', 'book_slot', 'handoff'],
    prompt:
      'SALES MODE. Their interest is real, so help them decide. Qualify quickly, answer the price question directly from the list, and move one step forward (a quote, an order, a booking). One question at a time — never an interrogation.',
  },
  support: {
    label: 'Support',
    emoji: '🛠️',
    tools: ['check_stock', 'handoff'],
    prompt:
      'SUPPORT MODE. They already bought or already have a problem. Solve first, sell nothing. Ask for the one detail you need, give a concrete next step, and hand off to the owner if it needs a human decision.',
  },
  booking: {
    label: 'Booking',
    emoji: '📅',
    tools: ['check_stock', 'book_slot', 'handoff'],
    prompt:
      'BOOKING MODE. Get the three things a booking needs — what, which day, what time — then confirm it. Offer real times only; if their time is outside opening hours, say so and offer the nearest ones.',
  },
  complaint: {
    label: 'Complaint',
    emoji: '😟',
    tools: ['handoff'],
    prompt:
      'COMPLAINT MODE. Stop selling completely — no prices, no offers, no "anything else I can get you". Apologise once, plainly, without excuses or corporate language. Get the one fact that helps (what happened, what they want), say the owner will personally look at it, and hand off. Do not argue, do not defend the business, do not promise a refund you cannot authorise.',
  },
  other: {
    label: 'General',
    emoji: '🤖',
    tools: null, // the default brain, all tools
    prompt: '',
  },
};

// ── rules ──────────────────────────────────────────────────
// Written for English, Roman Urdu and Urdu script — the three shapes this bot
// sees most — with the strongest signals first.

const RULES = {
  complaint: {
    strong: [
      /\b(refund|return my money|money back|rip.?off|scam|fraud|complaint|complain|sue|lawyer)\b/i,
      /\b(worst|terrible|awful|disgusting|pathetic|useless|rude|unacceptable|shut ?up)\b/i,
      /\b(cold food|stale|expired|wrong order|broken|damaged|defective|didn'?t arrive|never arrived)\b/i,
      /\b(charged (me )?twice|double.?charg|overcharg|extra charg)/i,
      /(شکایت|گلہ|ریفنڈ|خراب|غلط|دھوکہ|بدتمیزی)/,
      /\b(shikayat|shikait|gila|wapas|wapis|kharab|ghalat|dhoka|bad?tameez|bekaar|faltu)\b/i,
    ],
    weak: [/\b(late|delay|waiting|angry|disappointed|not happy|problem with my order)\b/i, /\b(pareshan|tang|naraz)\b/i],
  },
  booking: {
    strong: [
      /\b(book|booking|reserve|reservation|appointment|schedule a|slot|table for \d+)\b/i,
      /\b(book karna|appointment chahiye|time mil|slot chahiye|table chahiye)\b/i,
      /(بکنگ|اپائنٹمنٹ|وقت مل|ٹیبل)/,
    ],
    weak: [/\b(tomorrow|today|tonight|kal|aaj|monday|friday|weekend)\b/i, /\b(\d{1,2}\s*(am|pm)|at \d{1,2})\b/i],
  },
  sales: {
    strong: [
      /\b(price|prices|pricing|cost|rate|quote|estimate|how much|charges?|fees?)\b/i,
      /\b(buy|order|purchase|checkout|cart|package|packages|plan|plans|menu|availability)\b/i,
      /\b(kitna|kitne|kitni|qeemat|qimat|rate kya|price kya|order karna|lena hai)\b/i,
      /(قیمت|کتنا|کتنی|ریٹ|آرڈر|مینو)/,
    ],
    weak: [/\b(interested|demo|trial|details|brochure|catalog|catalogue)\b/i, /\b(chahiye|chahiyay)\b/i],
  },
  support: {
    strong: [
      /\b(not working|doesn'?t work|isn'?t working|error|bug|crash|can'?t log ?in|login issue|reset password|how do i|how to|setup|install|integrate)\b/i,
      /\b(madad|chalu nahi|kaam nahi|kaise|kese|kharab ho gaya|help chahiye)\b/i,
      /(مدد|کیسے|کام نہیں|چالو نہیں)/,
      /\b(madad|help chahiye|masla|sawal|kaam nahi kar)\b/i,
    ],
    weak: [/\b(help|support|issue|problem|question|guide|tutorial)\b/i, /\b(masla|sawal)\b/i],
  },
};

// Messages with no intent at all: greetings, thanks, one word replies.
const SMALL_TALK = /^(hi+|hello+|hey+|salam+|assalam[ou]?\s*alaikum|aoa|good (morning|evening|afternoon)|thanks?|thank you|shukriya|ok+|okay+|hmm+|👍|🙏|jazakallah)[\s!.،]*$/i;

function ruleScore(text) {
  const scores = { sales: 0, support: 0, booking: 0, complaint: 0, other: 0 };
  for (const [intent, patterns] of Object.entries(RULES)) {
    for (const re of patterns.strong) if (re.test(text)) scores[intent] += 3;
    for (const re of patterns.weak) if (re.test(text)) scores[intent] += 1;
  }
  return scores;
}

/**
 * Decide from rules alone.
 * @returns {{intent:string, confidence:number, sure:boolean}}
 */
export function classifyByRules(text = '', { mood = 'neutral' } = {}) {
  const clean = String(text || '').trim();

  if (!clean) return { intent: 'other', confidence: 1, sure: true, reason: 'empty' };
  if (SMALL_TALK.test(clean)) return { intent: 'other', confidence: 1, sure: true, reason: 'small talk' };

  const scores = ruleScore(clean);

  // A genuinely angry customer is a complaint whatever else they typed.
  if (mood === 'angry') {
    return { intent: 'complaint', confidence: 0.95, sure: true, reason: 'angry tone' };
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topIntent, topScore] = ranked[0];
  const [, secondScore] = ranked[1] || ['', 0];

  // A complaint signal always wins over a price question ("you charged me
  // twice, how much is that supposed to be?") — but only for real signals.
  if (scores.complaint >= 3 && topIntent !== 'complaint') {
    return { intent: 'complaint', confidence: 0.85, sure: true, reason: 'complaint keyword' };
  }

  if (topScore === 0) return { intent: 'other', confidence: 0.2, sure: false, reason: 'no keyword hit' };

  const clear = topScore >= 3 && topScore >= secondScore * 1.5;
  return {
    intent: topIntent,
    confidence: clear ? 0.8 : 0.45,
    sure: clear,
    reason: `keywords (${topScore} vs ${secondScore})`,
  };
}

// ── per-chat cache ─────────────────────────────────────────
// Routing is remembered for the current conversation so a long chat does not
// pay for a router call on every message.

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map(); // chat -> { intent, agent, source, at }

export function cachedRoute(chatId) {
  const entry = cache.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(chatId);
    return null;
  }
  return entry;
}

export function rememberRoute(chatId, route) {
  if (!chatId) return;
  cache.set(chatId, { ...route, at: Date.now() });
  // keep the map from growing forever on a busy number
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

export function clearRouteCache() {
  cache.clear();
}

// ── the model router ───────────────────────────────────────

const ROUTER_SYSTEM = `You route WhatsApp messages for a business assistant.
Answer with ONE word from this list and nothing else: sales, support, booking, complaint, other.
- sales: asking about prices, products, availability, or wants to buy/order.
- support: something they already bought is not working, or they need help using it.
- booking: wants an appointment, table, slot or reservation.
- complaint: angry, unhappy, wants a refund, or reports a bad experience.
- other: greetings, small talk, anything unclear.`;

const ROUTER_TIMEOUT_MS = 3000;

/**
 * Ask the small model. Never throws, never runs longer than the timeout.
 * @returns {Promise<{intent:string, confidence:number}|null>}
 */
export async function classifyByModel(text = '', { langInfo = null, timeoutMs = ROUTER_TIMEOUT_MS } = {}) {
  if (!hasLLM()) return null;
  const work = (async () => {
    const res = await chat({
      system: ROUTER_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Message: ${String(text).slice(0, 400)}${langInfo?.name ? `\nLanguage: ${langInfo.name}` : ''}\nAnswer:`,
        },
      ],
      maxTokens: 8,
      temperature: 0,
      small: true,
    });
    const word = String(res?.text || '').toLowerCase().match(/\b(sales|support|booking|complaint|other)\b/);
    if (!word) return null;
    return { intent: word[1], confidence: 0.6, source: 'llm' };
  })();

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return null;
  }
}

/**
 * The only entry point the handler needs.
 * @returns {Promise<{intent:string, agent:string, source:string, confidence:number, addendum:string, tools:string[]|null}>}
 */
export async function routeMessage({
  text = '',
  mood = 'neutral',
  langInfo = null,
  chatId = null,
  useModel = true,
  routerTimeoutMs = ROUTER_TIMEOUT_MS,
} = {}) {
  const rules = classifyByRules(text, { mood });

  if (rules.sure) {
    const route = { intent: rules.intent, source: 'rules', confidence: rules.confidence, reason: rules.reason };
    rememberRoute(chatId, route);
    return decorate(route);
  }

  const cached = cachedRoute(chatId);
  if (cached) {
    return decorate({ intent: cached.intent, source: 'cache', confidence: 0.5, reason: 'same conversation' });
  }

  if (useModel) {
    const modelled = await classifyByModel(text, { langInfo, timeoutMs: routerTimeoutMs });
    if (modelled) {
      const route = { intent: modelled.intent, source: 'llm', confidence: modelled.confidence, reason: 'model' };
      rememberRoute(chatId, route);
      return decorate(route);
    }
  }

  // Everything failed or was unsure and there is no history to lean on.
  const fallback = { intent: 'other', source: 'fallback', confidence: 0.2, reason: rules.reason };
  rememberRoute(chatId, fallback);
  return decorate(fallback);
}

function decorate(route) {
  const intent = INTENTS.includes(route.intent) ? route.intent : 'other';
  const agent = AGENTS[intent] ? intent : 'other';
  return {
    intent,
    agent,
    source: route.source,
    confidence: route.confidence,
    reason: route.reason,
    addendum: AGENTS[agent].prompt,
    tools: AGENTS[agent].tools,
  };
}

/** Owner-facing summary: "how many of what, today". */
export function intentSummary(counts = []) {
  const byIntent = { sales: 0, support: 0, booking: 0, complaint: 0, other: 0 };
  const bySource = { rules: 0, cache: 0, llm: 0, fallback: 0 };
  for (const row of counts) {
    byIntent[row.intent] = (byIntent[row.intent] || 0) + row.count;
    bySource[row.source] = (bySource[row.source] || 0) + row.count;
  }
  return { byIntent, bySource };
}

export function agentFor(intent) {
  return AGENTS[intent] || AGENTS.other;
}

/** Tools allowed for an agent, as a Set (null means "all"). */
export function allowedTools(agentKey) {
  const agent = AGENTS[agentKey] || AGENTS.other;
  return agent.tools ? new Set(agent.tools) : null;
}

/** Is the manager agent switched on for this business? */
export function managerEnabled() {
  // "manager" is the pre-release name; both are accepted so no config breaks.
  return featureOn('managerAgent') || featureOn('manager');
}

export default {
  INTENTS,
  AGENTS,
  routeMessage,
  classifyByRules,
  classifyByModel,
  cachedRoute,
  rememberRoute,
  clearRouteCache,
  intentSummary,
  agentFor,
  allowedTools,
};
