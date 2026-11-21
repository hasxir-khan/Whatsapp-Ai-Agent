// ISO minor units for offered billing currencies. Locale formatting/CLDR cash
// rounding is not an accounting exponent (notably PKR). Never divide by 100.
export const exponents = Object.freeze({
  PKR: 2,
  INR: 2,
  AED: 2,
  SAR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  CHF: 2,
  CNY: 2,
  SGD: 2,
  BDT: 2,
  TRY: 2,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
});
export function formatMinor(n, c) {
  const k = exponents[c];
  if (!Number.isSafeInteger(n) || n < 0 || k === undefined) throw Error('invalid_money');
  const s = String(n).padStart(k + 1, '0');
  return `${c} ${k ? s.slice(0, -k) + '.' + s.slice(-k) : s}`;
}
