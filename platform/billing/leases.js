import { termNotice, pausedBehaviour } from '../../src/services/billingNotices.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tenantDir } from '../../src/services/adminPanel.js';
import { all } from '../db.js';
import { entitlementsFor } from './subscriptions.js';
import { settings } from './catalog.js';
import { stamp, DAY } from './rules.js';
export function reminderDays(e, now) {
  if (e.canceling || !['trialing', 'active'].includes(e.state)) return null;
  const left = Math.ceil((Date.parse(e.end) - Number(new Date(now))) / DAY);
  return [1, 3, 7].find((n) => left > 0 && left <= n) || null;
}
// Render from the current term, not the mail outbox or a potentially offline worker.
export function billingBanner(e, now = Date.now()) {
  if (!e) return null;
  if (!e.canRun) return termNotice('paused', e.end, e.pausedReply);
  if (e.state === 'grace') return `Grace ends on ${e.until.slice(0, 10)} UTC. ${pausedBehaviour(e.pausedReply)}`;
  const days = reminderDays(e, now);
  return days ? termNotice('remind_' + days, e.end, e.pausedReply) : null;
}
// Fail closed on a missing tenant mount (do not create a replacement tenant).
export function publishLease(slug, now = Date.now()) {
  const e = entitlementsFor(slug, now);
  if (!e) return false;
  const days = reminderDays(e, now),
    dir = path.join(tenantDir(slug), 'data');
  const kind = !e.canRun ? 'paused' : days ? 'remind_' + days : null;
  const notices = kind
    ? all("SELECT id FROM b_delivery WHERE sid=? AND channel='whatsapp' AND kind=? AND object=? AND at>=?", [
        e.sid,
        kind,
        e.end,
        stamp(+new Date(now) - 30 * DAY),
      ]).map((r) => ({ kind, days, end: e.end, id: createHash('sha256').update(r.id).digest('hex') }))
    : [];
  const file = path.join(dir, 'billing-lease.json');
  const lease = {
    slug,
    at: stamp(now),
    until: e.validUntil,
    expires: stamp(+new Date(now) + settings().cacheHours * 3600000),
    canRun: e.canRun,
    limits: e.limits,
    features: e.features,
    pausedReply: e.pausedReply,
    notices,
  };
  try {
    fs.writeFileSync(file + '.tmp', JSON.stringify(lease), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    return true;
  } catch {
    return false;
  }
}
export function readUsage(slug, now = Date.now()) {
  const month = stamp(now).slice(0, 7),
    out = { month, conversations_month: 0, voice_seconds: 0, videos_month: 0, limits: [], reported: false };
  try {
    const file = path.join(tenantDir(slug), 'data', 'billing-usage.json');
    if (fs.statSync(file).size > 4096) return out;
    const x = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (x.month !== month) return out;
    for (const k of ['conversations_month', 'voice_seconds', 'videos_month'])
      if (Number.isSafeInteger(x[k]) && x[k] >= 0) out[k] = x[k];
    out.limits = ['conversations_month', 'voice_minutes', 'videos_month'].filter((k) =>
      x.limits?.includes(k)
    );
    out.reported = true;
  } catch {}
  return out;
}
