// platform/models.js
// Which models a tenant may pick, per provider — a list, not a text box.
//
// Free-text model names are how a customer ends up on a model that has been
// retired, a preview that costs money, or a typo that fails at 2 a.m. So a
// model is chosen from this table, and the platform refuses anything else. The
// table is deliberately short: one recommended model plus the two or three that
// are genuinely useful to fall back to.
//
// `freeTier` is a *label about the provider's published free tier*, not a
// promise about a bill. The dashboard shows it next to a link to the provider's
// own terms, which is the only place the numbers can be current.

export const PROVIDERS = [
  {
    id: 'groq',
    label: 'Groq',
    envPrefix: 'GROQ_API_KEY',
    consoleUrl: 'https://console.groq.com/keys',
    termsUrl: 'https://console.groq.com/docs/legal',
    freeTier: 'A free tier exists and is usually rate limited per minute and per day.',
    keyHint: 'Starts with `gsk_`.',
    help: [
      'Open console.groq.com and sign in with Google or GitHub.',
      'API Keys → Create API Key. Give it a name you will recognise later.',
      'Copy it once — Groq shows it a single time — and paste it here.',
      'Free keys are rate limited; a second key is a useful backup, not a way around the limit.',
    ],
    models: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B (recommended)', recommended: true },
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (cheap)' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (fastest)' },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    envPrefix: 'GEMINI_API_KEY',
    consoleUrl: 'https://aistudio.google.com/app/apikey',
    termsUrl: 'https://ai.google.dev/gemini-api/terms',
    freeTier: 'AI Studio keys have a free tier with daily request limits.',
    keyHint: 'Starts with AQ. or AIza.',
    help: [
      'Open aistudio.google.com/app/apikey and sign in with a Google account.',
      'Create API key → pick (or create) a Google Cloud project.',
      'Paste the key here. It is stored on this server and sent only to Google for inference.',
      'The free tier is per project: one key per project, not three keys on one.',
    ],
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (recommended)', recommended: true },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)' },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    envPrefix: 'OPENROUTER_API_KEY',
    consoleUrl: 'https://openrouter.ai/keys',
    termsUrl: 'https://openrouter.ai/terms',
    freeTier: 'Some models end in `:free` and are rate limited; others are paid per token.',
    keyHint: 'Starts with `sk-or-`.',
    help: [
      'Open openrouter.ai/keys and sign in.',
      'Create Key. Set a credit limit if you want a hard ceiling.',
      'Copy it and paste it here.',
      'Only models with a `:free` suffix are free; a paid model needs credit on the account.',
    ],
    models: [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (free, recommended)', recommended: true },
      { id: 'google/gemini-2.0-flash-exp:free', label: 'Gemini 2.0 Flash (free)' },
    ],
  },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function providerIds() {
  return PROVIDERS.map((p) => p.id);
}

export function provider(id) {
  return BY_ID.get(String(id || '').toLowerCase()) || null;
}

export function isProvider(id) {
  return !!provider(id);
}

export function modelsFor(id) {
  return provider(id)?.models || [];
}

/** The one model a new key starts on. Never invented at the call site. */
export function defaultModel(id) {
  const models = modelsFor(id);
  return (models.find((m) => m.recommended) || models[0])?.id || null;
}

/** Allowlist check. `true` only for an exact id this table lists. */
export function isSupportedModel(id, model) {
  return modelsFor(id).some((m) => m.id === String(model || ''));
}

/** What the dashboard shows next to a provider (steps, console link, caveats). */
export function helpFor(id) {
  const entry = provider(id);
  if (!entry) return null;
  return {
    id: entry.id,
    label: entry.label,
    consoleUrl: entry.consoleUrl,
    termsUrl: entry.termsUrl,
    freeTier: entry.freeTier,
    keyHint: entry.keyHint,
    help: entry.help,
    models: entry.models,
    defaultModel: defaultModel(entry.id),
  };
}

export function allHelp() {
  return PROVIDERS.map((p) => helpFor(p.id));
}

/** A cheap, honest shape check before anything is encrypted. */
export function keyShapeProblem(id, value) {
  const entry = provider(id);
  if (!entry) return 'Unknown provider.';
  const clean = String(value || '').trim();
  if (!clean) return 'Paste the key first.';
  if (clean.length < 16) return 'That is too short to be an API key.';
  if (clean.length > 200) return 'That is too long to be an API key.';
  if (/\s/.test(clean)) return 'An API key has no spaces in it.';
  if (!/^[A-Za-z0-9._\-]+$/.test(clean)) return 'That contains characters an API key does not have.';
  if (entry.id === 'groq' && !clean.startsWith('gsk_')) return 'A Groq key starts with `gsk_`.';
  if (entry.id === 'gemini' && !/^(AIza|AQ\.)/.test(clean)) return 'Expected a Google AI Studio API key.';
  if (entry.id === 'openrouter' && !clean.startsWith('sk-or-')) return 'An OpenRouter key starts with `sk-or-`.';
  return null;
}

export default { PROVIDERS, providerIds, provider, isProvider, modelsFor, defaultModel, isSupportedModel, helpFor, allHelp, keyShapeProblem };
