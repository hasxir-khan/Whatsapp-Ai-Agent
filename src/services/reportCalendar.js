// Calendar labels are not 24-hour durations. Resolve both endpoints separately
// in the business IANA zone (spring-forward days have 23 hours; fall-back 25).
import { localDateString, partsInTz, zonedToUtc } from './hours.js';
export { localDateString, partsInTz };
export const DAY_MS = 86400000;
export function validDay(s) {
  return (
    typeof s === 'string' &&
    /^\d{4}-\d\d-\d\d$/.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s
  );
}
export const shiftDay = (day, n) => new Date(Date.parse(day) + n * DAY_MS).toISOString().slice(0, 10);
const boundaries = new Map();
export function midnight(day, zone) {
  const key = `${zone}:${day}`;
  if (boundaries.has(key)) return boundaries.get(key);
  const [y, m, d] = day.split('-').map(Number);
  let instant = +zonedToUtc(y, m, d, 0, 0, zone);
  // Some IANA zones skip 00:00, or repeat it. Use the first instant of
  // this calendar date, not an assumed wall-clock time on the previous date.
  if (localDateString(new Date(instant), zone) < day || localDateString(new Date(instant - 1), zone) >= day) {
    let lo = Date.parse(day) - 2 * DAY_MS,
      hi = Date.parse(day) + 2 * DAY_MS;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (localDateString(new Date(mid), zone) < day) lo = mid;
      else hi = mid;
    }
    instant = hi;
  }
  const iso = new Date(instant).toISOString();
  if (boundaries.size >= 2048) boundaries.clear();
  boundaries.set(key, iso);
  return iso;
}
export function period(now, zone, days) {
  const last = localDateString(now, zone),
    first = shiftDay(last, 1 - days);
  return { first, last, from: midnight(first, zone), to: midnight(shiftDay(last, 1), zone) };
}
