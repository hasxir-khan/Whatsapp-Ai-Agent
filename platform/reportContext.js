import { get } from './db.js';
import { planForTenant } from './plans.js';
import { isSupportedModel } from './models.js';
import { platformSecret } from './env.js';
import { retention, alias, masked, dimension } from '../src/services/reportContract.js';
import { localDateString, shiftDay } from '../src/services/reportCalendar.js';
export function bounds(
  slug,
  now = new Date(),
  zone = get('SELECT zone FROM r_state WHERE slug=?', [slug])?.zone ||
    get('SELECT zone FROM r_cursor WHERE slug=?', [slug])?.zone ||
    'UTC',
) {
  const days = retention(planForTenant(slug)?.plan),
    today = localDateString(now, zone);
  return { zone, days, today, earliest: shiftDay(today, 1 - days) };
}
const extraModels = new Set([
  'gemini-embedding-001',
  'text-embedding-004',
  'whisper-large-v3',
  'whisper-large-v3-turbo',
  'canopylabs/orpheus-v1-english',
  'canopylabs/orpheus-arabic-saudi',
]);
export function safeUsageLabels(slug, provider, model, agent) {
  const secret = platformSecret() + '\0' + slug;
  return {
    provider: ['groq', 'gemini', 'openrouter', 'edge'].includes(provider) ? provider : 'unknown',
    model:
      isSupportedModel(provider, model) || extraModels.has(model) || masked(model)
        ? model
        : alias(model || 'unknown', secret, 'model'),
    agent: masked(agent) ? agent : dimension('agent', agent || 'unknown', secret),
  };
}

export function replayIdentity(slug, uid, conversation, errorCategory, salt) {
  const key = salt + '\0' + slug;
  const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
  return {
    uid: !uid ? null : uuid.test(uid) || masked(uid) ? uid : alias(uid, key, 'uid'),
    conversation: !conversation ? null : masked(conversation) ? conversation : alias(conversation, key, 'chat'),
    errorCategory: !errorCategory
      ? null
      : ['invalid', 'rate_limited', 'quota', 'failing', 'unsupported_model', 'provider_error'].includes(
            errorCategory,
          )
        ? errorCategory
        : 'provider_error',
  };
}
