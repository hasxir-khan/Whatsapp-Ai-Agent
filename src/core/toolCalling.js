// src/core/toolCalling.js
// The conversation loop that lets the model ask for actions.
//
// Two protocols, same validation and the same whitelist underneath:
//   1. native function calling (Groq, Gemini, OpenRouter) when the provider
//      supports it
//   2. a JSON action object in the reply text, for models that do not
//
// Hard limits: 3 tool calls per message, 10 seconds per call. When a call
// fails the loop keeps going with a neutral note — the customer gets an
// ordinary reply, never an error message.

import { chat } from './llm.js';
import {
  TOOL_DEFS,
  MAX_CALLS_PER_MESSAGE,
  TOOL_TIMEOUT_MS,
  executeTool,
  toolsPrompt,
  toolJsonProtocol,
  parseToolRequest,
} from './tools.js';

// Providers that rejected `tools` once are remembered, so we do not pay for the
// failed round trip on every message.
const nativeUnsupported = new Set();

export function resetNativeSupport() {
  nativeUnsupported.clear();
}

function looksUnsupported(err) {
  const body = String(err?.body || err?.message || '').toLowerCase();
  const status = err?.status || 0;
  if (status === 400 || status === 404 || status === 422) {
    return /tool|function|unsupported|unknown field|invalid argument/.test(body);
  }
  return /does not support tools|function calling/i.test(body);
}

/** The three tools the model sees, in each provider's favourite shape. */
export function providerTools() {
  return TOOL_DEFS.map((def) => ({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
  }));
}

/** Results of earlier calls in this turn, as plain text for the next round. */
function resultsNote(results) {
  if (!results.length) return '';
  const lines = ['── RESULTS OF YOUR ACTIONS THIS TURN ──'];
  for (const entry of results) {
    lines.push(`${entry.name} → ${JSON.stringify(entry.payload).slice(0, 600)}`);
  }
  lines.push('Use these results as facts. Do not call the same action again unless something new is needed.');
  return lines.join('\n');
}

async function modelTurn({ system, messages, native }) {
  if (native) {
    return chat({ system, messages, tools: providerTools() });
  }
  return chat({ system: `${system}\n\n${toolJsonProtocol()}`, messages });
}

/**
 * Generate a reply that may use tools.
 *
 * @param {object} opts
 * @param {string} opts.system          system prompt (persona + knowledge)
 * @param {Array}  opts.messages        conversation messages
 * @param {object} opts.ctx             { chat, tenant, number, send, notifyOwner, who }
 * @param {Function} [opts.onToolResult] called after each tool for logging/UI
 * @returns {Promise<{text:string, provider?:string, model?:string, calls:Array, status:string}>}
 */
export async function generateWithTools({ system, messages, ctx = {}, onToolResult = null }) {
  const baseSystem = `${system}\n\n${toolsPrompt()}`;
  const transcript = [];
  const calls = [];
  let native = true;
  let last = null;

  for (let round = 0; round < MAX_CALLS_PER_MESSAGE + 1; round += 1) {
    const note = resultsNote(transcript);
    const systemNow = note ? `${baseSystem}\n\n${note}` : baseSystem;
    const finalRound = calls.length >= MAX_CALLS_PER_MESSAGE;

    let response;
    try {
      response = await modelTurn({
        system: finalRound ? `${systemNow}\n\nYou have used all the actions available for this message. Answer the customer now in words.` : systemNow,
        messages,
        native: native && !finalRound,
      });
    } catch (err) {
      if (native && looksUnsupported(err)) {
        native = false;
        // remember per provider so we do not spend a failed call every message
        if (response?.provider || err?.provider) nativeUnsupported.add(err.provider || 'provider');
        continue;
      }
      throw err;
    }

    last = response;

    const nativeCalls = response.toolCalls || [];
    const requested = nativeCalls.length
      ? nativeCalls.map((c) => ({ name: c.name, args: c.args }))
      : (() => {
          const parsed = parseToolRequest(response.text || '');
          return parsed ? [parsed] : [];
        })();

    if (!requested.length || finalRound) {
      return { text: cleanText(response.text), provider: response.provider, model: response.model, calls, status: 'ok' };
    }

    for (const call of requested) {
      if (calls.length >= MAX_CALLS_PER_MESSAGE) break;

      const outcome = await executeTool(call.name, call.args, ctx);
      calls.push({ name: call.name, status: outcome.status, ...outcome });

      const payload =
        outcome.status === 'ok'
          ? outcome.result
          : outcome.status === 'needs_confirmation'
            ? { needs_customer_confirmation: true, summary: outcome.summary }
            : { unavailable: true };

      transcript.push({ name: call.name, payload });
      if (typeof onToolResult === 'function') {
        try {
          await onToolResult({ name: call.name, outcome });
        } catch {
          /* logging a tool must never break the reply */
        }
      }

      // A side effect that needs a yes ends the turn: the customer has to
      // answer, and the stored arguments are what will run.
      if (outcome.status === 'needs_confirmation') {
        return {
          text: '',
          provider: response.provider,
          model: response.model,
          calls,
          status: 'needs_confirmation',
          confirmation: { summary: outcome.summary, tool: call.name },
        };
      }
    }

    // Ask again with the results in hand; the loop protects against a model
    // that keeps asking forever.
    if (calls.length >= MAX_CALLS_PER_MESSAGE) {
      const closing = await modelTurn({
        system: `${systemNow}\n\n${resultsNote(transcript)}\n\nYou have used all the actions available for this message. Answer the customer now in words.`,
        messages,
        native: false,
      });
      return { text: cleanText(closing.text), provider: closing.provider, model: closing.model, calls, status: 'ok' };
    }
  }

  return { text: cleanText(last?.text), provider: last?.provider, model: last?.model, calls, status: 'ok' };
}

/** Strip any leaked tool JSON out of a customer-facing reply. */
export function cleanText(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (parseToolRequest(raw)) return '';
  return raw;
}

export { MAX_CALLS_PER_MESSAGE, TOOL_TIMEOUT_MS };
export default { generateWithTools, providerTools, cleanText, resetNativeSupport };
