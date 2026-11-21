// One worker owns a tenant DB. Admission and increment are synchronous (no
// await between them); reserve provider attempts, not just successful clips.
import { config } from '../config/env.js';
import { get, run, saveDB } from '../utils/db.js';
import { localDateString, shiftDay } from './reportCalendar.js';
import { breakerOpen, noteAgentFailure, noteAgentSuccess } from './agents.js';

const active = new Set();
export const MEDIA_COUNTERS = ['videos', 'vision', 'processed', 'refused', 'video_ms', 'voice', 'correct', 'errors'];
const dayOf = (now) => localDateString(now, config.owner.profile?.business?.timezone || config.timezone);
export class MediaStop extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export const defaultTenant = () => config.tenant.slug;
export function countMedia(field, amount = 1, tenant = defaultTenant(), now = new Date()) {
  if (!MEDIA_COUNTERS.includes(field) || !Number.isSafeInteger(amount) || amount < 0)
    throw Error('invalid_media_counter');
  const day = dayOf(now);
  if (!get('SELECT 1 FROM media_daily WHERE tenant=? AND day=?', [tenant, day]))
    run('DELETE FROM media_daily WHERE tenant=? AND day<?', [tenant, shiftDay(day, -89)]);
  run(
    `INSERT INTO media_daily(tenant,day,${field}) VALUES (?,?,?) ON CONFLICT(tenant,day) DO UPDATE SET ${field}=${field}+excluded.${field}`,
    [tenant, day, amount]
  );
}
export function mediaTotals(tenant = defaultTenant(), from = '0000', to = '9999') {
  return get(
    `SELECT ${MEDIA_COUNTERS.map((k) => `COALESCE(SUM(${k}),0) AS ${k}`).join(',')} FROM media_daily WHERE tenant=? AND day BETWEEN ? AND ?`,
    [tenant, from, to]
  );
}
export function quotaCode(field, tenant = defaultTenant(), now = new Date(), limits = config.media) {
  const day = dayOf(now),
    month = day.slice(0, 7) + '-01';
  if (mediaTotals(tenant, day, day)[field] >= limits[field + 'Day']) return `${field}_day`;
  const plan = process.env.TENANT_VIDEOS_MONTH;
  // An unprovisioned managed worker has no proven video entitlement.
  const entitlement =
    plan == null || plan === ''
      ? process.env.TENANT_DASHBOARD === '1'
        ? 0
        : Infinity
      : Math.max(0, Number(plan) || 0);
  const cap = Math.min(limits[field + 'Month'], field === 'videos' ? entitlement : Infinity);
  if (mediaTotals(tenant, month, day)[field] >= cap) return `${field}_month`;
  return null;
}
export function reserveMedia(field, tenant, limits, now = new Date()) {
  if (!['vision', 'videos'].includes(field)) throw Error('invalid_media_quota');
  const reason = quotaCode(field, tenant, now, limits);
  if (reason) throw new MediaStop(reason);
  countMedia(field, 1, tenant, now);
  saveDB(true); // a restarted worker must not get a second allowance
}
export async function withVideoSlot(tenant, work) {
  if (active.has(tenant)) throw new MediaStop('busy');
  active.add(tenant);
  try {
    return await work();
  } finally {
    active.delete(tenant);
  }
}
export function providerGate({ tenant = defaultTenant(), limits = config.media, beforeCall } = {}) {
  let errors = 0;
  return {
    timeoutMs: limits.timeoutMs,
    get errors() {
      return errors;
    },
    async attempt(kind, provider, call) {
      const key = `media:${tenant}:${kind}:${provider}`;
      if (breakerOpen(key)) throw new MediaStop('breaker');
      if (kind === 'vision') reserveMedia('vision', tenant, limits);
      beforeCall?.(kind, provider);
      try {
        const value = await call(AbortSignal.timeout(limits.timeoutMs));
        if (!value) throw Error('provider_empty');
        noteAgentSuccess(key);
        return value;
      } catch (e) {
        if (e instanceof MediaStop) throw e;
        noteAgentFailure(key);
        errors++;
        countMedia('errors', 1, tenant);
        throw new MediaStop('provider_error'); // never propagate bodies/paths
      }
    },
  };
}
export function mediaScorecard(tenant = defaultTenant(), now = new Date()) {
  const last = dayOf(now),
    totals = mediaTotals(tenant, last.slice(0, 7) + '-01', last);
  return `Media · month to date\nVoice reply language (automatic check): ${totals.voice ? Math.round((100 * totals.correct) / totals.voice) + '%' : '—'} (${totals.correct}/${totals.voice})\nVideos processed: ${totals.processed} · refused: ${totals.refused}\nAverage video processing: ${totals.processed + totals.refused ? Math.round(totals.video_ms / (totals.processed + totals.refused)) + ' ms' : '—'}\nMedia provider errors: ${totals.errors}`;
}
