import { exponents, formatMinor } from '../public/billing-money.js';
// Pure UTC calendar and fixed-point money rules. No host timezone or floating-point tax.
export class BillingError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.status = status;
  }
}
export function need(ok, code, status = 400) {
  if (!ok) throw new BillingError(code, status);
}
export const stamp = (n) => new Date(n).toISOString();
export const DAY = 86400000;
export function monthsAfter(value, n) {
  need(Number.isInteger(n) && n >= 0 && n <= 120, 'invalid_duration');
  const d = new Date(value),
    day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(d);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  d.setUTCDate(Math.min(day, last.getUTCDate()));
  return d.toISOString();
}
const currencies = new Set(Object.keys(exponents));
export function currencyCode(s) {
  need(currencies.has(s), 'invalid_currency');
  return s;
}
export function minor(n) {
  need(Number.isSafeInteger(n) && n >= 0 && n <= 1e12, 'invalid_minor_amount');
  return n;
}
export function totals(subtotal, taxBps = 0, paid = 0) {
  minor(subtotal);
  minor(paid);
  need(Number.isInteger(taxBps) && taxBps >= 0 && taxBps <= 10000, 'invalid_tax');
  const tax = Number((BigInt(subtotal) * BigInt(taxBps) + 5000n) / 10000n);
  const total = minor(subtotal + tax);
  return { subtotal, tax, total, paid, due: Math.max(0, total - paid) };
}
const digits = (c) => exponents[currencyCode(c)];
export const money = (n, c) => formatMinor(minor(n), currencyCode(c));
export function fromDecimal(s, c) {
  const k = digits(c),
    m = /^(\d{1,12})(?:\.(\d+))?$/.exec(String(s).replaceAll(',', ''));
  if (!m || (m[2] || '').length > k) return null;
  const n = Number(m[1] + (m[2] || '').padEnd(k, '0'));
  return Number.isSafeInteger(n) && n <= 1e12 ? n : null;
}
export function bounded(n, lo, hi, code = 'invalid_limit') {
  need(Number.isSafeInteger(n) && n >= lo && n <= hi, code);
  return n;
}
export function choice(value, set, code = 'invalid_option') {
  need(set.includes(value), code);
  return value;
}
export const policyText =
  'Paid months use the UTC calendar, clamped to the last day. Renewals extend from the later of now or the paid end. An operator-priced upgrade changes the plan immediately, not the end date. A downgrade starts at the period end; it does not buy another period. No automatic debits.';
