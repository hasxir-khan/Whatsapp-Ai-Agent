// src/core/projectIntake.js
// The project-discovery brain. It decides what we already know, what is still
// missing, and what (single) question to ask next — the way a good developer
// qualifies a client: one question at a time, never repeating, and ready to
// quote the moment the picture is clear.
//
// State lives in the database, so a restart in the middle of a conversation
// doesn't lose the client's answers.

import { config } from '../config/env.js';
import { getIntake, saveIntake, upsertContact, logEvent, getContact } from '../utils/db.js';
import { chatJson, hasLLM } from './llm.js';
import { buildQuote, parseBudget } from './pricing.js';

const FIELDS = config.owner.profile?.intake?.fields || [];
const REQUIRED = config.owner.profile?.intake?.required || ['projectType', 'goal', 'features'];
const FIELD_IDS = FIELDS.map((f) => f.id);
const FIELD_LABELS = Object.fromEntries(FIELDS.map((f) => [f.id, f.label]));
const FIELD_ASKS = Object.fromEntries(FIELDS.map((f) => [f.id, f.ask]));

const cache = new Map();

export function getState(number) {
  if (cache.has(number)) return cache.get(number);

  const row = getIntake(number);
  const state = {
    number,
    stage: row?.stage || 'open',
    fields: row?.fields || {},
    asked: row?.asked || [],
    quote: row?.quote || null,
    quotedAt: row?.quoted_at || null,
    updatedAt: row?.updated_at || null,
  };
  cache.set(number, state);
  return state;
}

function persist(state) {
  saveIntake(state.number, {
    stage: state.stage,
    fields: state.fields,
    asked: state.asked,
    quote: state.quote,
    quoted_at: state.quotedAt,
  });
  state.updatedAt = new Date().toISOString();
  cache.set(state.number, state);
  return state;
}

export function resetState(number) {
  cache.delete(number);
  saveIntake(number, { stage: 'open', fields: {}, asked: [], quote: null, quoted_at: null });
  return getState(number);
}

const isEmpty = (v) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

export function completeness(state) {
  const filled = FIELD_IDS.filter((id) => !isEmpty(state.fields[id])).length;
  const requiredFilled = REQUIRED.filter((id) => !isEmpty(state.fields[id])).length;
  const requiredScore = requiredFilled / REQUIRED.length;
  const overall = filled / FIELD_IDS.length;
  return Math.round((requiredScore * 0.75 + overall * 0.25) * 100) / 100;
}

/** The single next thing worth asking. */
export function nextField(state) {
  for (const id of REQUIRED) {
    if (isEmpty(state.fields[id])) return id;
  }
  // Optional fields, but stop nagging after four of them
  const optionalAsked = state.asked.filter((id) => !REQUIRED.includes(id)).length;
  if (optionalAsked >= 4) return null;
  for (const id of FIELD_IDS) {
    if (!REQUIRED.includes(id) && isEmpty(state.fields[id]) && !state.asked.includes(id)) return id;
  }
  return null;
}

/** Merge fields that came from somewhere other than chat (e.g. a PDF brief). */
export function mergeExternalFields(number, updates = {}) {
  const state = getState(number);
  state.fields = mergeFields(state.fields, updates);
  if (Object.keys(state.fields).length) state.stage = state.quote ? 'quoted' : 'discovering';
  persist(state);
  return state;
}

export function isIntakeActive(state) {
  return state && (state.stage === 'discovering' || state.stage === 'quoted' || Object.keys(state.fields).length > 0);
}

export function markAsked(state, fieldId) {
  if (!fieldId) return state;
  if (!state.asked.includes(fieldId)) state.asked.push(fieldId);
  return persist(state);
}

export function markQuoted(state, quote) {
  state.quote = quote;
  state.quotedAt = new Date().toISOString();
  state.stage = 'quoted';
  persist(state);
  upsertContact(state.number, { stage: 'quoted' });
  return state;
}

// ── heuristics used when the model is unavailable or the text is trivial ──
function heuristicExtract(text) {
  const updates = {};
  const lower = text.toLowerCase();

  const budget = parseBudget(text);
  if (budget && /\$|pkr|rs\.?|usd|budget|pay|cost|charge|price|kitna|between|around/i.test(text)) {
    updates.budget = budget.text;
  }

  const timeline =
    text.match(/\b(\d+)\s*(day|days|week|weeks|month|months)\b/i) ||
    text.match(/\b(tomorrow|next week|next month|asap|urgent|by (january|february|march|april|may|june|july|august|september|october|november|december))\b/i);
  if (timeline) updates.timeline = timeline[0];

  const typeMap = [
    [/\b(landing page|portfolio|one page)\b/, 'landing page'],
    [/\b(ecommerce|e-commerce|online store|shopify|store|shop)\b/, 'e-commerce store'],
    [/\b(mobile app|android|ios|flutter)\b/, 'mobile app'],
    [/\b(web app|dashboard|crm|saas|portal|admin panel)\b/, 'web app'],
    [/\b(ai|chatbot|bot|automation|gpt|llm)\b/, 'AI bot / automation'],
    [/\b(website|web site|business site)\b/, 'business website'],
  ];
  for (const [re, label] of typeMap) {
    if (re.test(lower) && !updates.projectType) {
      updates.projectType = label;
      break;
    }
  }

  const featureWords = ['login', 'signup', 'payment', 'stripe', 'paypal', 'jazzcash', 'easypaisa', 'admin', 'dashboard', 'chat', 'notification', 'email', 'sms', 'search', 'filter', 'upload', 'api', 'multi language', 'blog', 'booking', 'cart', 'checkout', 'analytics', 'report'];
  const found = featureWords.filter((f) => lower.includes(f));
  if (found.length) updates.features = found.join(', ');

  if (/\b(dark|light|modern|minimal|clean|colorful|reference|figma|design)\b/i.test(text) && !updates.design) {
    updates.design = text.length < 240 ? text : text.slice(0, 200);
  }

  return updates;
}

function mergeFields(fields, updates = {}) {
  const merged = { ...fields };
  for (const [key, value] of Object.entries(updates)) {
    if (!FIELD_IDS.includes(key)) continue;
    if (isEmpty(value)) continue;
    if (key === 'features') {
      const existing = merged.features;
      const incoming = Array.isArray(value) ? value : String(value).split(/[,;\n]/);
      const all = [
        ...(Array.isArray(existing) ? existing : existing ? String(existing).split(/[,;\n]/) : []),
        ...incoming,
      ]
        .map((s) => String(s).trim())
        .filter(Boolean);
      merged.features = [...new Set(all)].slice(0, 15).join(', ');
    } else if (key === 'extra') {
      merged.extra = [merged.extra, Array.isArray(value) ? value.join(', ') : value].filter(Boolean).join(' · ').slice(0, 600);
    } else {
      const str = Array.isArray(value) ? value.join(', ') : String(value);
      merged[key] = str.slice(0, 500);
    }
  }
  return merged;
}

const TRIVIAL = /^(hi|hey|hello|salam|assalam|asalam|aoa|thanks|thank you|ok|okay|k|hmm|yes|no|sure|great|cool|👍|🙏|shukriya|theek|thik|han|haan|good morning|good evening)[\s!.,?👍🙏😊]*$/i;

/**
 * Learn from one client message.
 * @returns {Promise<{state, updates, intent, readyToQuote, nextField, completeness, quote}>}
 */
export async function ingest(number, text, { explicitPriceQuestion = false } = {}) {
  const state = getState(number);
  const clean = String(text || '').trim();

  let updates = {};
  let intent = 'unknown';
  let readySignal = false;

  const tooShort = clean.length < 8 || TRIVIAL.test(clean);

  if (!tooShort && hasLLM()) {
    const known = Object.fromEntries(
      Object.entries(state.fields).filter(([, v]) => !isEmpty(v)).map(([k, v]) => [k, String(v).slice(0, 300)])
    );

    try {
      const { data } = await chatJson({
        small: true,
        temperature: 0.1,
        maxTokens: 600,
        system:
          'You extract structured project requirements from WhatsApp messages. Never invent facts; only extract what the client actually said or clearly implied. Return JSON only.',
        messages: [
          {
            role: 'user',
            content: `A freelance developer is qualifying a client on WhatsApp. Extract the project details from the client's latest message(s).

Already known (do not repeat, only fill gaps or correct):
${JSON.stringify(known)}

Fields you may fill (use exactly these keys, omit if not mentioned):
- projectType: what is being built (website, e-commerce store, mobile app, web app/dashboard, AI bot, automation…)
- goal: the business goal + target audience
- features: list of concrete features/pages requested (array of short strings)
- design: design/style preferences, references, colours, brand
- content: who provides content/images
- timeline: deadline or urgency
- budget: any budget figure they mention
- tech: technical preferences, platforms, integrations
- extra: anything else relevant (languages, maintenance, SEO…)

Client's message:
"""
${clean.slice(0, 3000)}
"""

Return JSON:
{"intent":"project|question|price|smalltalk|not_interested","updates":{},"ready_to_quote":false,"name":"","company":""}
ready_to_quote is true only if they have told you what to build AND the main features AND at least one of timeline/budget, or they explicitly asked for a price/quote.`,
          },
        ],
      });

      if (data) {
        updates = data.updates && typeof data.updates === 'object' ? data.updates : {};
        intent = data.intent || 'unknown';
        readySignal = !!data.ready_to_quote;
        const hints = {};
        if (data.name) hints.name = data.name;
        if (data.company) hints.company = data.company;
        if (Object.keys(hints).length) {
          // store as facts later by the caller; keep on the state for now
          state.hints = { ...(state.hints || {}), ...hints };
        }
      }
    } catch (err) {
      logEvent('intake_llm_error', number, err.message);
    }
  }

  if (!updates || Object.keys(updates).length === 0) {
    updates = heuristicExtract(clean);
  }

  const before = JSON.stringify(state.fields);
  state.fields = mergeFields(state.fields, updates);

  // A "yes, that's everything" style message should not be re-asked
  if (TRIVIAL.test(clean) && state.asked.length) {
    // nothing to do — keeps the existing state
  }

  const changed = JSON.stringify(state.fields) !== before;
  if (changed || intent === 'project') {
    state.stage = state.quote ? 'quoted' : 'discovering';
  }
  persist(state);

  const complete = completeness(state);
  const requiredDone = REQUIRED.every((id) => !isEmpty(state.fields[id]));
  const hasPriceIntent = explicitPriceQuestion || intent === 'price';
  const readyToQuote =
    !state.quote &&
    ((requiredDone && complete >= 0.5 && (readySignal || !isEmpty(state.fields.timeline) || !isEmpty(state.fields.budget))) ||
      (hasPriceIntent && requiredDone && complete >= 0.4));

  if (changed) {
    const contact = getContact(number);
    if (!contact || contact.stage === 'new') {
      upsertContact(number, { stage: state.stage === 'quoted' ? 'quoted' : 'discovering', category: 'lead' });
    }
  }

  return {
    state,
    updates,
    intent,
    readyToQuote,
    quote: readyToQuote ? buildQuote(state.fields, number) : null,
    nextField: nextField(state),
    nextFieldLabel: FIELD_LABELS[nextField(state)] || null,
    nextFieldAsk: FIELD_ASKS[nextField(state)] || null,
    completeness: complete,
    hints: state.hints || {},
  };
}

/** Prompt fragment: what to ask next, phrased naturally by the model. */
export function intakePromptBlock(state) {
  const next = nextField(state);
  const lines = [];
  lines.push('── PROJECT INTAKE STATE ──');

  if (state.quote) {
    lines.push(`A quote was already sent on ${state.quotedAt || 'recently'}. Do not quote again unless they ask about price or change the scope.`);
  }

  const known = Object.entries(state.fields).filter(([, v]) => !isEmpty(v));
  if (known.length) {
    lines.push('Known: ' + known.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(', ') : String(v).slice(0, 200)}`).join(' | '));
  }

  if (next) {
    lines.push(`NEXT THING TO ASK (only one question, in your own natural words): ${FIELD_ASKS[next] || FIELD_LABELS[next]}.`);
    lines.push('If the client just answered it, acknowledge briefly and ask the next one. Never ask two questions at once and never re-ask anything under "Known".');
  } else {
    lines.push('You have everything needed. Do not ask more discovery questions — summarise what you understood and offer the next step.');
  }
  lines.push(`Completeness: ${Math.round(completeness(state) * 100)}%`);
  return lines.join('\n');
}

export default {
  getState, ingest, resetState, completeness, nextField, markAsked, markQuoted,
  intakePromptBlock, isIntakeActive, mergeExternalFields,
};
