// src/dev/demoAi.js
// Which brain does `npm run demo` use?
//
// The rule the owner asked for: if a real key is present, the demo talks to the
// real model — same code path as production, nothing canned. If there is no key,
// the demo still runs, but only the deterministic parts answer (catalogue,
// pricing, bookings, opt-outs) and it says so out loud instead of pretending.
//
// This lives in its own file so it can be tested without starting a server.

// Keys the demo itself writes when it is running without a real one.
const PLACEHOLDER_KEYS = new Set([
  'demo-key-never-used',
  'mock-groq-key',
  'mock-gemini-key',
  'mock-openrouter-key',
]);

function usable(value) {
  const key = String(value || '').trim();
  if (!key) return false;
  if (PLACEHOLDER_KEYS.has(key)) return false;
  if (/^(your|xxx|changeme|placeholder)/i.test(key)) return false;
  return key.length >= 12;
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ mode: 'real' | 'canned', provider: 'Groq' | 'Gemini' | null }}
 */
export function aiMode(env = process.env) {
  if (usable(env.GROQ_API_KEY)) return { mode: 'real', provider: 'Groq' };
  if (usable(env.GEMINI_API_KEY)) return { mode: 'real', provider: 'Gemini' };
  return { mode: 'canned', provider: null };
}

/** One line for the terminal and the inbox bar. Never includes the key. */
export function aiModeLabel(ai) {
  if (ai && ai.mode === 'real') {
    return `Real AI — ${ai.provider}. Every reply comes from the model, exactly as on your own number.`;
  }
  return 'No API key: catalogue, prices, bookings and opt-outs are real; the AI wording is canned. Add a free GROQ_API_KEY to .env and restart for real replies.';
}

export default { aiMode, aiModeLabel };
