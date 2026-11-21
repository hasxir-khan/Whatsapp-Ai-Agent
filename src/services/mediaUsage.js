// Content-free metering for non-chat providers. Only opted-in managed workers
// emit usage to the platform; standalone protected turns keep local metadata.
import { recordUsage } from './usageEvents.js';
import { logEvent } from '../utils/db.js';
import { config } from '../config/env.js';
export function mediaUsage(
  kind,
  provider,
  model,
  { input = 0, output = 0, estimated = false, error = null, protectedCall = false } = {},
) {
  // A standalone tenant has no platform journal, but still needs an honest
  // usage estimate. Errors have unknown usage, not a claim of zero cost.
  if (protectedCall)
    logEvent('media_provider', null, {
      kind,
      provider,
      tokens: error ? null : (Number(input) || 0) + (Number(output) || 0),
      estimated,
      outcome: error ? 'failed' : 'ok',
    });
  if (process.env.TENANT_DASHBOARD !== '1') return;
  const key = config.keys[provider];
  recordUsage({
    kind,
    provider,
    model,
    agent: 'assistant',
    keySlot: key ? 1 : null,
    keyLast4: key?.slice(-4),
    promptTokens: input,
    completionTokens: output,
    estimated,
    errorCategory: error,
  });
}
