// Media services don't use chat completions. Count their real attempts only in
// opted-in managed workers; never pass audio, tool arguments or transcripts.
import { recordUsage } from './usageEvents.js';
import { config } from '../config/env.js';
export function mediaUsage(
  kind,
  provider,
  model,
  { input = 0, output = 0, estimated = false, error = null } = {},
) {
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
