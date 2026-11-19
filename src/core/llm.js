// src/core/llm.js
// One small provider-agnostic LLM client.
//
// Why roll our own instead of one SDK? Because the whole thing has to keep
// running for $0: if Groq retires a model or a key hits its daily limit, the
// assistant silently falls back to another model or another free provider
// instead of going offline. No SDK lock-in, ~200 lines.

import { config } from '../config/env.js';
import { bumpUsage, getUsage, todayKey, logEvent, tenantUsage, bumpTenantUsage } from '../utils/db.js';
import { GEMINI_BASE, geminiHeaders, isKeyError, explainGeminiError } from '../utils/gemini.js';
import * as providerTrace from '../services/providerTrace.js';
import { recordUsage, estimateTokens, isRecording } from '../services/usageEvents.js';

let fetchImpl = globalThis.fetch;

/** Test seam — lets us run the whole pipeline with a fake provider. */
export function __setFetch(fn) {
  fetchImpl = fn || globalThis.fetch;
}

export class QuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuotaError';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sticky choice: once a provider+model answers, keep using it.
// Phase 6 Part 3 fix: stickiness is per conversation, not per process. Two
// customers on two providers is fine; one customer flipping provider mid-chat
// is not, and it is what produced two differently-worded replies.
const sticky = { chat: null, small: null };
const conversationSticky = new Map(); // chatKey -> { chat:|small: {provider, model} }
const flightSeq = new Map(); // chatKey -> newest request id

export class StaleResponseError extends Error {
  constructor(message = 'a newer reply superseded this one') {
    super(message);
    this.name = 'StaleResponseError';
    this.stale = true;
  }
}

function pickSticky(chatKey, mode) {
  // Per conversation: a fresh chat starts at the top of the chain, even if the
  // last one ended up on a fallback. The process-wide value only helps calls
  // that have no conversation (a summary, a batch job).
  if (chatKey) {
    const entry = conversationSticky.get(chatKey);
    return entry?.[mode] || null;
  }
  return sticky[mode] || null;
}

function setSticky(chatKey, mode, value) {
  sticky[mode] = value;
  if (!chatKey) return;
  const entry = conversationSticky.get(chatKey) || {};
  entry[mode] = value;
  conversationSticky.set(chatKey, entry);
  // Keep the map small on a long-running box.
  if (conversationSticky.size > 2000) {
    const first = conversationSticky.keys().next().value;
    conversationSticky.delete(first);
  }
}

export function stickyFor(chatKey, mode = 'chat') {
  return pickSticky(chatKey, mode);
}

export function _resetProviderState() {
  sticky.chat = null;
  sticky.small = null;
  conversationSticky.clear();
  flightSeq.clear();
}

/** OpenRouter may only answer with a model named in the config allowlist. */
export function openrouterModels() {
  const allow = config.llm.openrouterAllowlist || config.llm.openrouterTextModels || [];
  return allow.map((m) => String(m).trim()).filter(Boolean);
}

export function providerModels(provider) {
  return candidatesFor(provider, false);
}

export function providersAvailable() {
  const out = [];
  if (config.keys.groq) out.push('groq');
  if (config.keys.gemini) out.push('gemini');
  if (config.keys.openrouter) out.push('openrouter');
  return out;
}

export function hasLLM() {
  return providersAvailable().length > 0;
}

function candidatesFor(provider, small) {
  if (provider === 'groq') return small ? config.llm.groqSmallModels : config.llm.groqModels;
  if (provider === 'gemini') return config.llm.geminiModels;
  return openrouterModels();
}

function orderedProviders(chatKey = null, mode = 'chat') {
  const available = providersAvailable();
  const wanted = config.llm.providers.filter((p) => available.includes(p));
  for (const p of available) if (!wanted.includes(p)) wanted.push(p);

  // OpenRouter is last by policy: it is the most variable of the three, so it
  // only answers when the two direct providers could not. It is also dropped
  // entirely when no model is on the allowlist — an unnamed model is not a
  // fallback, it is a surprise.
  let chain = wanted.filter((p) => p !== 'openrouter');
  if (wanted.includes('openrouter') && openrouterModels().length) chain.push('openrouter');

  const s = pickSticky(chatKey, mode);
  if (s?.provider && chain.includes(s.provider)) {
    chain = [s.provider, ...chain.filter((p) => p !== s.provider)];
  }
  return chain;
}

export function tenantSlug() {
  return config.tenant?.slug || 'default';
}

/**
 * Per-tenant budget. On a box running several businesses, one busy tenant must
 * not be able to spend the whole free quota, so its calls are counted
 * separately and capped on their own.
 * @returns {{used:number, cap:number, exceeded:boolean}}
 */
export function tenantBudget(tenant = tenantSlug()) {
  const cap = config.limits.tenantDailyLlmCalls;
  const used = Number(tenantUsage(todayKey(), tenant)?.llm_calls || 0);
  return { used, cap, exceeded: cap > 0 && used >= cap, tenant };
}

export function assertTenantBudget(tenant = tenantSlug()) {
  const budget = tenantBudget(tenant);
  if (budget.exceeded) {
    logEvent('tenant_budget_hit', null, { tenant: budget.tenant, used: budget.used, cap: budget.cap });
    throw new QuotaError(`Daily AI budget for "${budget.tenant}" reached (${budget.used}/${budget.cap})`);
  }
  return budget;
}

function checkQuota() {
  const usage = getUsage(todayKey());
  if (usage.llm_calls >= config.limits.dailyLlmCalls) {
    throw new QuotaError(`Daily AI call limit reached (${config.limits.dailyLlmCalls})`);
  }
  assertTenantBudget();
}

function isModelProblem(status, bodyText = '') {
  if (status === 404) return true;
  if (status === 400 && /model|unsupported|invalid argument/i.test(bodyText)) return true;
  if (status === 403 && /model|permission|not found/i.test(bodyText)) return true;
  return false;
}

// ── OpenAI-compatible chat (Groq + OpenRouter) ──────────────
async function openAiCompatible({ provider, model, system, messages, temperature, maxTokens, json, tools, toolChoice, signal }) {
  const isGroq = provider === 'groq';
  const url = isGroq
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';
  const key = isGroq ? config.keys.groq : config.keys.openrouter;

  const body = {
    model,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' };
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: t }));
    if (toolChoice) body.tool_choice = toolChoice;
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  };
  if (!isGroq) {
    headers['X-Title'] = config.bot.name;
  }

  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const raw = await res.text();

  if (!res.ok) {
    const err = new Error(`${provider} ${res.status}: ${raw.slice(0, 300)}`);
    err.status = res.status;
    err.body = raw;
    err.retryAfter = parseFloat(res.headers?.get?.('retry-after') || '0') || 0;
    throw err;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${provider}: unreadable response`);
  }

  // Some free models wrap their answer in reasoning fields
  const msg = data.choices?.[0]?.message || {};
  const text = (msg.content ?? msg.reasoning_content ?? '').toString().trim();
  const toolCalls = (msg.tool_calls || []).map((call, index) => ({
    id: call.id || `call_${index}`,
    name: call.function?.name || '',
    args: safeParse(call.function?.arguments),
    raw: call.function?.arguments,
  }));
  return {
    text,
    toolCalls,
    tokens: data.usage?.total_tokens || 0,
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
    model,
  };
}

// ── Gemini (native API) ─────────────────────────────────────
function toGeminiContents(messages) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: Array.isArray(m.content)
      ? m.content
      : [{ text: String(m.content ?? '') }],
  }));
}

function safeParse(value) {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/** Gemini wants its own flavour of JSON-schema: upper-case types, no extras. */
export function toGeminiSchema(schema = {}) {
  const out = {};
  const type = String(schema.type || 'string').toUpperCase();
  out.type = type === 'INTEGER' ? 'NUMBER' : type;
  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum.map(String);
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      out.properties[key] = toGeminiSchema(value);
    }
  }
  if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required;
  return out;
}

async function gemini({ model, system, messages, temperature, maxTokens, json, tools, signal }) {
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`;

  const body = {
    contents: toGeminiContents(messages),
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      ...(json ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools?.length) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: toGeminiSchema(t.parameters || { type: 'object', properties: {} }),
        })),
      },
    ];
  }

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: geminiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal,
  });
  const raw = await res.text();

  if (!res.ok) {
    const err = new Error(explainGeminiError(res.status, raw));
    err.status = res.status;
    err.body = raw;
    err.model = model;
    err.keyInvalid = isKeyError(res.status, raw);
    err.retryAfter = parseFloat(res.headers?.get?.('retry-after') || '0') || 0;
    throw err;
  }

  const data = JSON.parse(raw);
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  const toolCalls = parts
    .filter((p) => p.functionCall)
    .map((p, index) => ({
      id: `gemini_${index}`,
      name: p.functionCall.name || '',
      args: safeParse(p.functionCall.args),
      raw: p.functionCall.args,
    }));
  return {
    text,
    toolCalls,
    tokens: data.usageMetadata?.totalTokenCount || 0,
    promptTokens: data.usageMetadata?.promptTokenCount || 0,
    completionTokens: data.usageMetadata?.candidatesTokenCount || 0,
    model,
  };
}

async function callProvider(provider, args) {
  return provider === 'gemini' ? gemini(args) : openAiCompatible({ provider, ...args });
}

/**
 * Main entry point.
 * @param {object} opts
 * @param {string} [opts.system]
 * @param {Array<{role:string, content:any}>} opts.messages
 * @param {boolean} [opts.json] ask for JSON output
 * @param {boolean} [opts.small] use the cheap/fast model
 * @returns {Promise<{text:string, provider:string, model:string, tokens:number}>}
 */
export async function chat({
  system,
  messages,
  temperature = config.llm.temperature,
  maxTokens = config.llm.maxTokens,
  json = false,
  small = false,
  tools = null,
  toolChoice = null,
  timeoutMs = config.llm.providerTimeoutMs || 45000,
  // Phase 6 Part 3: a specialised caller (the reasoning brain) may pin the
  // provider and model. Both are optional, and both fall back to the normal
  // preference list when the pinned pair is unavailable.
  provider: pinnedProvider = null,
  model: pinnedModel = null,
  // Which conversation this call belongs to — used for stickiness, for the
  // trace, and for the late-response guard. Optional: batch jobs pass nothing.
  chatKey = null,
  // When true, a reply that arrives after a newer request for the same chat
  // started is discarded instead of being sent: the timed-out primary cannot
  // answer over the top of the fallback that already replied.
  singleFlight = false,
  kind = null,
  // Which agent asked (manager, booking, analyst…) — recorded with usage so a
  // bill can say *what* was expensive. Optional and never used for routing.
  agent = null,
} = {}) {
  checkQuota();

  const mode = small ? 'small' : 'chat';
  const agentName = agent ? String(agent).slice(0, 40) : null;
  const started = Date.now();
  let seq = null;
  if (chatKey && singleFlight) {
    seq = (flightSeq.get(chatKey) || 0) + 1;
    flightSeq.set(chatKey, seq);
  }

  let providers = orderedProviders(chatKey, mode);
  if (pinnedProvider) providers = providers.filter((p) => p === pinnedProvider);
  if (!providers.length) {
    providerTrace.record({ chat: chatKey, kind: kind || mode, ok: false, reason: 'no provider configured', ms: Date.now() - started });
    throw new Error('No AI provider configured');
  }

  let lastError = null;
  const failures = []; // {provider, model, reason}

  for (const provider of providers) {
    let models = candidatesFor(provider, small);
    if (pinnedModel) models = [pinnedModel, ...models.filter((m) => m !== pinnedModel)];
    const stickyChoice = pickSticky(chatKey, mode);
    const stickyModel = stickyChoice?.provider === provider ? stickyChoice?.model : null;
    if (stickyModel && models.includes(stickyModel)) {
      models = [stickyModel, ...models.filter((m) => m !== stickyModel)];
    }

    for (const model of models) {
      // Explicit output budget: every provider gets the same one, so a longer
      // answer is never the accident of which model happened to answer.
      const budget = Math.max(64, Math.min(Number(maxTokens) || config.llm.maxTokens, 4000));
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const result = await callProvider(provider, {
          model, system, messages, temperature, maxTokens: budget, json, tools, toolChoice, signal,
        });
        // An empty text is fine when the model asked for a tool instead.
        if (!result.text && !result.toolCalls?.length) {
          throw new Error(`${provider}/${model}: empty response`);
        }

        // Late-response guard: if a newer request for this conversation exists,
        // this answer belongs to a message that was already answered.
        if (seq !== null && flightSeq.get(chatKey) !== seq) {
          throw new StaleResponseError(`${provider}/${model} answered after a newer request had started`);
        }

        setSticky(chatKey, mode, { provider, model });
        bumpUsage('llm_calls', 1);
        bumpTenantUsage(tenantSlug(), 1);
        if (result.tokens) bumpUsage('llm_tokens', result.tokens);

        const ms = Date.now() - started;

        // The one place a model call succeeds is the one place usage is
        // recorded. A provider that reports tokens is believed; one that says
        // nothing gets a flagged estimate instead of a silent zero. With the
        // platform off, `isRecording()` is false and none of this runs.
        if (isRecording()) {
          const reported = Number(result.promptTokens) > 0 || Number(result.completionTokens) > 0;
          const promptTokens = reported
            ? Number(result.promptTokens) || 0
            : estimateTokens(system || '') + estimateTokens(messages || []);
          const completionTokens = reported
            ? Number(result.completionTokens) || 0
            : estimateTokens(result.text || '');
          recordUsage({
            tenant: tenantSlug(),
            kind: kind || mode,
            provider,
            model,
            agent: agentName,
            chatKey,
            promptTokens,
            completionTokens,
            totalTokens: result.tokens || promptTokens + completionTokens,
            estimated: !reported,
            latencyMs: ms,
          });
        }
        providerTrace.record({
          chat: chatKey,
          kind: kind || mode,
          provider,
          model,
          ms,
          tokens: result.tokens || 0,
          fallback: failures.length ? `${failures[0].provider}/${failures[0].model}` : null,
          reason: failures.length ? failures[0].reason : null,
          ok: true,
        });
        return { ...result, provider, model, latencyMs: ms, stale: false };
      } catch (err) {
        if (err?.stale) {
          providerTrace.record({
            chat: chatKey,
            kind: kind || mode,
            provider,
            model,
            ms: Date.now() - started,
            ok: false,
            reason: 'late response discarded',
          });
          throw err;
        }
        lastError = err;
        const status = err.status || 0;
        const reason = status ? `HTTP ${status}` : err.name === 'TimeoutError' || /aborted|timeout/i.test(err.message) ? 'timeout' : err.message.slice(0, 80);
        failures.push({ provider, model, reason });

        if (err.keyInvalid) {
          // Wrong/expired key: every other model on this provider fails too.
          logEvent('llm_bad_key', null, { provider, model, status });
          console.error(`🔑 ${provider}: ${err.message}`);
          break;
        }

        if (status === 429) {
          // Rate limited on this model: brief retry, then fall through.
          const wait = Math.min(8000, Math.max(1500, (err.retryAfter || 3) * 1000));
          logEvent('llm_rate_limited', null, { provider, model });
          await sleep(wait);
          continue;
        }
        if (isModelProblem(status, err.body)) continue; // try next model
        if (status >= 500) { await sleep(800); continue; }
        if (err.name === 'TimeoutError' || /aborted|timeout/i.test(err.message)) continue;

        // Unknown error → next model, but keep the message for the final throw
        continue;
      }
    }
  }

  providerTrace.record({
    chat: chatKey,
    kind: kind || mode,
    ms: Date.now() - started,
    ok: false,
    reason: failures.length ? `all providers failed — ${failures.map((f) => `${f.provider}:${f.reason}`).join(', ').slice(0, 140)}` : 'no provider answered',
  });
  throw lastError || new Error('All AI providers failed');
}

/** Robust JSON helper — tolerates ```json fences and chatter around the JSON. */
export async function chatJson(opts) {
  const result = await chat({ ...opts, json: true });
  return { ...result, data: extractJson(result.text) };
}

export function extractJson(text = '') {
  const cleaned = String(text)
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through */
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const slice = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {
      try {
        // common LLM slips: trailing commas, smart quotes
        return JSON.parse(
          slice
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
        );
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function llmStatus() {
  return {
    providers: providersAvailable(),
    sticky: { ...sticky },
    quota: { used: getUsage().llm_calls, limit: config.limits.dailyLlmCalls },
  };
}

export default {
  chat, chatJson, extractJson, hasLLM, providersAvailable, llmStatus, QuotaError,
  tenantBudget, assertTenantBudget, tenantSlug, stickyFor, openrouterModels,
  StaleResponseError, _resetProviderState,
};
