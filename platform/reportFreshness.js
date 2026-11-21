// Freshness is the age of the WORKER observation, not the last import, model
// call, or HTTP request. Use the same strict cutoff on pages and in doctor.
export const STALE_MINUTES = 15;
export const staleBefore = (now) => new Date(Number(now) - STALE_MINUTES * 60000).toISOString();
export function workerFreshness(at, now) {
  const elapsed = Number(now) - Date.parse(at);
  if (!Number.isFinite(elapsed)) return { minutes: null, state: 'missing' };
  return {
    minutes: Math.max(0, Math.floor(elapsed / 60000)),
    state: elapsed > STALE_MINUTES * 60000 ? 'stale' : 'fresh',
  };
}
