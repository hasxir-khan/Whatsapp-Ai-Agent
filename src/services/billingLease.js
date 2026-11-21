// No platform DB, provider credentials or network in a managed worker. Leases only
// project entitlementsFor(). A missed heartbeat can shorten permission, never extend it.
import fs from 'node:fs';
import path from 'node:path';
export const billedWorker = () => process.env.TENANT_BILLING === '1';
export function workerAccess(now = Date.now()) {
  if (!billedWorker()) return null;
  try {
    const file = path.join(process.env.DATA_DIR, 'billing-lease.json');
    if (fs.statSync(file).size > 16384) throw Error();
    const x = JSON.parse(fs.readFileSync(file, 'utf8'));
    const fresh =
      x.slug === process.env.TENANT &&
      +new Date(now) < Date.parse(x.expires) &&
      Date.parse(x.at) <= +new Date(now);
    return {
      ...x,
      canRun: fresh && x.canRun === true && +new Date(now) < Date.parse(x.until),
      pausedReply: fresh && x.pausedReply === true,
      notices: fresh ? x.notices : [],
    };
  } catch {
    return { canRun: false, pausedReply: false, limits: {}, features: [], notices: [] };
  }
}
export function billingLimit(key, legacy) {
  const e = workerAccess();
  return e ? (e.limits?.[key] ?? 0) : legacy;
}
