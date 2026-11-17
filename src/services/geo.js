// src/services/geo.js
// Country / timezone / currency inference from a WhatsApp number, plus money
// formatting. This is what lets the assistant treat an overseas client like a
// local one: right currency, right time of day, right greeting.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';

let COUNTRY_MAP = {};
try {
  COUNTRY_MAP = JSON.parse(
    fs.readFileSync(path.join(config.root, 'config', 'countries.json'), 'utf8')
  );
  delete COUNTRY_MAP['//'];
} catch (err) {
  console.error('⚠️  config/countries.json missing — country detection disabled');
}

const FALLBACK = { country: 'Unknown', timezone: 'UTC', currency: 'USD', region: '' };

/** Longest-prefix match on the phone number (923 before 92, etc.). */
export function lookupNumber(number) {
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits) return { ...FALLBACK, prefix: '' };
  const prefixes = Object.keys(COUNTRY_MAP).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (digits.startsWith(prefix)) return { ...COUNTRY_MAP[prefix], prefix };
  }
  return { ...FALLBACK, prefix: digits.slice(0, 2) };
}

export function isOwnerNumber(number) {
  return String(number) === String(config.owner.number);
}

export function isPakistani(number) {
  return lookupNumber(number).region === 'PK';
}

/** Local wall-clock time for a client. */
export function localTime(number, date = new Date()) {
  const { timezone } = lookupNumber(number);
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
    const hour = parseInt(parts.hour, 10) % 24;
    return {
      timezone,
      hour,
      minute: parseInt(parts.minute, 10),
      weekday: parts.weekday,
      clock: `${parts.hour}:${parts.minute}`,
      date: `${parts.day} ${parts.month}`,
      label: `${parts.weekday} ${parts.hour}:${parts.minute} (${timezone})`,
    };
  } catch {
    return { timezone: 'UTC', hour: date.getUTCHours(), minute: date.getUTCMinutes(), weekday: '', clock: '', date: '', label: 'UTC' };
  }
}

/** Is it a reasonable hour to message this person? */
export function isAwake(number, date = new Date(), { from = 8, to = 22 } = {}) {
  const { hour } = localTime(number, date);
  if (from <= to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

/** Next moment (ISO) that is inside the client's waking window. */
export function nextAwakeTime(number, date = new Date(), window = { from: 9, to: 21 }) {
  const probe = new Date(date.getTime());
  for (let i = 0; i < 48 * 4; i++) {
    if (isAwake(number, probe, window)) return probe.toISOString();
    probe.setTime(probe.getTime() + 15 * 60 * 1000);
  }
  return probe.toISOString();
}

export function currencyFor(number, fallback = 'USD') {
  return lookupNumber(number).currency || fallback;
}

// ── money ───────────────────────────────────────────────────
const SYMBOLS = config.owner.profile?.currency?.symbols || {};
const FX = config.owner.profile?.currency?.fxToPkr || { PKR: 1, USD: 280 };

// Friendly numbers, scaled to the currency (₹/USD need finer steps than PKR)
const roundFor = (n, currency = 'PKR') => {
  if (['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'SGD', 'NZD', 'CHF'].includes(currency)) {
    if (n >= 10000) return Math.round(n / 500) * 500;
    if (n >= 1000) return Math.round(n / 50) * 50;
    if (n >= 100) return Math.round(n / 10) * 10;
    return Math.round(n);
  }
  if (n >= 100000) return Math.round(n / 5000) * 5000;
  if (n >= 20000) return Math.round(n / 1000) * 1000;
  if (n >= 5000) return Math.round(n / 500) * 500;
  if (n >= 500) return Math.round(n / 100) * 100;
  return Math.round(n);
};

/** PKR → client currency (static, configurable rates — no API needed). */
export function fromPkr(pkr, currency = 'PKR') {
  const rate = FX[currency];
  if (!rate) return null;
  return roundFor(pkr / rate, currency);
}

/** Client currency → PKR. */
export function toPkr(amount, currency = 'PKR') {
  const rate = FX[currency];
  if (!rate) return null;
  return roundFor(amount * rate, 'PKR');
}

export function formatMoney(amount, currency = 'PKR') {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '';
  const symbol = SYMBOLS[currency] || currency;
  const n = Math.round(amount);
  const withSeparators = n.toLocaleString('en-US');
  return currency === 'PKR' ? `${symbol} ${withSeparators}` : `${symbol}${withSeparators}`;
}

/**
 * Best display currency for a client: locals see PKR, overseas clients see
 * their own currency, with the PKR figure in brackets for transparency.
 */
export function priceFor(number, pkrAmount) {
  const currency = currencyFor(number, 'USD');
  if (currency === 'PKR' || !FX[currency]) {
    return { amount: Math.round(pkrAmount), currency: 'PKR', text: formatMoney(pkrAmount, 'PKR') };
  }
  const converted = fromPkr(pkrAmount, currency);
  if (converted === null) {
    return { amount: Math.round(pkrAmount), currency: 'PKR', text: formatMoney(pkrAmount, 'PKR') };
  }
  return {
    amount: converted,
    currency,
    text: config.owner.profile?.currency?.displayForForeignClients
      ? `${formatMoney(converted, currency)} (≈ ${formatMoney(pkrAmount, 'PKR')})`
      : formatMoney(converted, currency),
  };
}

export default {
  lookupNumber, localTime, isAwake, nextAwakeTime, currencyFor,
  fromPkr, toPkr, formatMoney, priceFor, isOwnerNumber, isPakistani,
};
