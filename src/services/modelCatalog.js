// Availability is account-specific. Never guess from a built-in list, spend an
// inference call, log a key/remote error, or treat an incomplete list as empty.
import { config } from '../config/env.js';
import { GEMINI_BASE, authHeadersFor } from '../utils/gemini.js';
import { EMBED_MODELS } from './embeddings.js';
import { activeProvider, reasoningConfig, REASONING_PROVIDERS } from './reasoning.js';
import { configuredKeys, PROVIDERS } from './keyChain.js';

export function configuredModels(provider) {
  const { llm, vision, stt, tts, embed } = config;
  const candidates = {
    groq: [
      ...llm.groqModels,
      ...llm.groqSmallModels,
      ...vision.groqModels,
      stt.model,
      stt.fallbackModel,
      tts.groqModelEnglish,
      tts.groqModelArabic,
    ],
    gemini: [...llm.geminiModels, ...vision.geminiModels, ...(embed.model ? [embed.model] : EMBED_MODELS)],
    openrouter: [...llm.openrouterTextModels, ...(llm.openrouterAllowlist || []), ...vision.openrouterModels],
  }[provider];
  // Include an explicitly configured reasoning model even if this worker
  // currently routes pinned calls through the managed chat chain.
  const cfg = reasoningConfig();
  const reasoning =
    REASONING_PROVIDERS.find((p) => [p.id, p.provider].includes(cfg.provider)) || activeProvider(cfg);
  if (reasoning?.provider === provider) {
    if (cfg.provider === 'auto') candidates.push(reasoning.model);
    candidates.push(cfg.model || reasoning.model);
  }
  return [...new Set(candidates.filter(Boolean))];
}
const urls = {
  groq: 'https://api.groq.com/openai/v1/models',
  gemini: GEMINI_BASE + '/models',
  openrouter: 'https://openrouter.ai/api/v1/models',
};
async function catalog(provider, key, fetchImpl, style) {
  const google = provider === 'gemini',
    names = new Set(),
    tokens = new Set();
  const headers = google ? authHeadersFor(key, style) : { Authorization: 'Bearer ' + key };
  const signal = AbortSignal.timeout(8000);
  let token;
  do {
    const url = new URL(urls[provider]);
    if (google) url.searchParams.set('pageSize', '200');
    if (token) url.searchParams.set('pageToken', token);
    const res = await fetchImpl(url, { method: 'GET', headers, signal, redirect: 'error' });
    if (!res.ok) {
      await res.body?.cancel();
      return { status: res.status };
    }
    const json = await res.json(),
      list = google ? json.models : json.data;
    if (!Array.isArray(list)) return {};
    for (const item of list) {
      const id = google ? item.name : item.id;
      if (typeof id !== 'string' || !id) return {};
      names.add(google ? id.replace(/^models\//, '') : id);
    }
    token = google && json.nextPageToken;
    if (token && (typeof token !== 'string' || tokens.has(token) || tokens.size >= 50)) return {};
    tokens.add(token);
  } while (token);
  return { names };
}
export async function verifyModels({ providers = PROVIDERS, fetchImpl = globalThis.fetch } = {}) {
  const checks = [];
  for (const provider of providers) {
    const keys = configuredKeys(provider);
    if (!keys.length) {
      checks.push({ provider, state: 'no_key' });
      continue;
    }
    for (const { key, slot } of keys) {
      let result, alternateStyle;
      try {
        result = await catalog(provider, key, fetchImpl, config.geminiAuthStyle);
        if (provider === 'gemini' && [400, 401, 403].includes(result.status)) {
          const style = config.geminiAuthStyle === 'bearer' ? 'key' : 'bearer';
          const alternate = await catalog(provider, key, fetchImpl, style);
          if (alternate.names) {
            result = alternate;
            alternateStyle = style;
          }
        }
      } catch {
        result = {};
      }
      checks.push(
        result.names
          ? {
              provider,
              slot,
              state: 'listed',
              alternateStyle,
              unknown: configuredModels(provider).filter((m) => !result.names.has(m)),
            }
          : { provider, slot, state: 'unverified', status: result.status }
      );
    }
  }
  return checks;
}
export function modelWarnings(check) {
  const label = check.provider + (check.slot ? ' slot ' + check.slot : '');
  if (check.state === 'no_key') return [`${label}: no configured key; models not verified.`];
  if (check.state === 'unverified')
    return [
      `${label}: model list unavailable${check.status ? ' (HTTP ' + check.status + ')' : ''}; names not verified.`,
    ];
  const secrets = Object.entries(process.env)
    .filter(([k, v]) => /TOKEN|SECRET|API_KEY/.test(k) && v)
    .map(([, v]) => v);
  const warnings = check.unknown.map(
    (m) =>
      `${label}: unknown model ${/^[\w./:-]{1,140}$/.test(m) && !secrets.some((v) => m.includes(v)) ? m : '(check configuration)'} — not in the provider list.`
  );
  if (check.alternateStyle)
    warnings.push(
      `${label}: key works with GEMINI_AUTH_STYLE=${check.alternateStyle}; check the configured auth style.`
    );
  return warnings;
}
