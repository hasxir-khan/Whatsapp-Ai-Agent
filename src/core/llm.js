// src/core/llm.js
// One small provider-agnostic LLM client.
//
// Why roll our own instead of one SDK? Because the whole thing has to keep
// running for $0: if Groq retires a model or a key hits its daily limit, the
// assistant silently falls back to another model or another free provider
// instead of going offline. No SDK lock-in, ~200 lines.

import { config } from '../config/env.js';
import { bumpUsage, getUsage, todayKey, logEvent } from '../utils/db.js';
import { GEMINI_BASE, geminiHeaders, isKeyError, explainGeminiError } from '../utils/gemini.js';

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
const sticky = { chat: null, small: null };

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
  return config.llm.openrouterTextModels;
}

function orderedProviders() {
  const available = providersAvailable();
  const wanted = config.llm.providers.filter((p) => available.includes(p));
  for (const p of available) if (!wanted.includes(p)) wanted.push(p);
  return wanted;
}

function checkQuota() {
  const usage = getUsage(todayKey());
  if (usage.llm_calls >= config.limits.dailyLlmCalls) {
    throw new QuotaError(`Daily AI call limit reached (${config.limits.dailyLlmCalls})`);
  }
}

function isModelProblem(status, bodyText = '') {
  if (status === 404) return true;
  if (status === 400 && /model|unsupported|invalid argument/i.test(bodyText)) return true;
  if (status === 403 && /model|permission|not found/i.test(bodyText)) return true;
  return false;
}

// ── OpenAI-compatible chat (Groq + OpenRouter) ──────────────
async function openAiCompatible({ provider, model, system, messages, temperature, maxTokens, json, signal }) {
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

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  };
  if (!isGroq) {
    headers['HTTP-Referer'] = 'https://github.com/hasxir-khan/Whatsapp-Ai-Agent';
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
  return { text, tokens: data.usage?.total_tokens || 0, model };
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

async function gemini({ model, system, messages, temperature, maxTokens, json, signal }) {
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
  return { text, tokens: data.usageMetadata?.totalTokenCount || 0, model };
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
  timeoutMs = 45000,
} = {}) {
  checkQuota();

  const mode = small ? 'small' : 'chat';
  const providers = orderedProviders();
  if (!providers.length) throw new Error('No AI provider configured');

  // put the sticky provider first
  const stickyProvider = sticky[mode]?.provider;
  if (stickyProvider && providers.includes(stickyProvider)) {
    providers.splice(providers.indexOf(stickyProvider), 1);
    providers.unshift(stickyProvider);
  }

  let lastError = null;

  for (const provider of providers) {
    let models = candidatesFor(provider, small);
    const stickyModel = sticky[mode]?.provider === provider ? sticky[mode]?.model : null;
    if (stickyModel && models.includes(stickyModel)) {
      models = [stickyModel, ...models.filter((m) => m !== stickyModel)];
    }

    for (const model of models) {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const result = await callProvider(provider, {
          model, system, messages, temperature, maxTokens, json, signal,
        });
        if (!result.text) throw new Error(`${provider}/${model}: empty response`);

        sticky[mode] = { provider, model };
        bumpUsage('llm_calls', 1);
        if (result.tokens) bumpUsage('llm_tokens', result.tokens);
        return { ...result, provider };
      } catch (err) {
        lastError = err;
        const status = err.status || 0;

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

export default { chat, chatJson, extractJson, hasLLM, providersAvailable, llmStatus, QuotaError };
