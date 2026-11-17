// src/services/calendar.js
// Optional Google Calendar sync for bookings.
//
// Two ways in, both free:
//   • a service account (GOOGLE_SERVICE_ACCOUNT_FILE) — share the calendar with
//     the service account's email and it just works, no OAuth screens
//   • an OAuth refresh token (GOOGLE_CLIENT_ID / SECRET / REFRESH_TOKEN) for a
//     personal calendar
//
// With neither configured this module does nothing at all — bookings stay in
// SQLite (and the existing Sheets sync). A missing credential must never block
// a booking, and a failing Google must never lose one either.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { logEvent } from '../utils/db.js';

let tokenCache = { token: null, expiresAt: 0 };
let fetchImpl = null;

/** Test seam. */
export function __setFetch(fn) {
  fetchImpl = fn;
}

export function calendarConfigured() {
  const c = config.calendar;
  return !!c.id && (!!c.serviceAccountFile || (!!c.clientId && !!c.clientSecret && !!c.refreshToken));
}

export function calendarMode() {
  const c = config.calendar;
  if (!c.id) return 'off';
  if (c.serviceAccountFile) return 'service-account';
  if (c.clientId && c.clientSecret && c.refreshToken) return 'oauth';
  return 'misconfigured';
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A service-account JWT, signed RS256. ~20 lines instead of a 40 MB SDK. */
function serviceAccountAssertion(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: credentials.client_email,
      scope: 'https://www.googleapis.com/auth/calendar',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    })
  );
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(credentials.private_key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${header}.${claims}.${signature}`;
}

async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.token;

  const c = config.calendar;
  const doFetch = fetchImpl || globalThis.fetch;
  let body;

  if (c.serviceAccountFile) {
    const credentials = JSON.parse(fs.readFileSync(c.serviceAccountFile, 'utf8'));
    body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: serviceAccountAssertion(credentials),
    });
  } else {
    body = new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: 'refresh_token',
    });
  }

  const res = await doFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`calendar auth ${res.status}: ${text.slice(0, 160)}`);
  const data = JSON.parse(text);
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

/** "2030-06-07" + "20:00" + timezone → an RFC3339 window for Google. */
export function eventWindow({ date, time, minutes = 60, timeZone = config.timezone }) {
  const start = `${date}T${time}:00`;
  const [h, m] = String(time).split(':').map(Number);
  const endMinutes = h * 60 + (m || 0) + minutes;
  const endHour = String(Math.floor(endMinutes / 60) % 24).padStart(2, '0');
  const endMinute = String(endMinutes % 60).padStart(2, '0');
  // If it spills past midnight the end lands on the next day.
  const endDate = endMinutes >= 24 * 60 ? nextDay(date) : date;
  return {
    start: { dateTime: `${start}`, timeZone },
    end: { dateTime: `${endDate}T${endHour}:${endMinute}:00`, timeZone },
  };
}

function nextDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Create an event. Never throws.
 * @returns {Promise<{synced:boolean, id?:string, reason?:string}>}
 */
export async function pushBooking(booking = {}) {
  if (!calendarConfigured()) return { synced: false, reason: 'not_configured' };
  if (!booking.date || !booking.time) return { synced: false, reason: 'incomplete' };

  try {
    const token = await accessToken();
    const doFetch = fetchImpl || globalThis.fetch;
    const window = eventWindow({ date: booking.date, time: booking.time, timeZone: config.timezone });
    const body = {
      summary: `${booking.service || 'Booking'} — ${booking.name || 'customer'}`,
      description: `Booked over WhatsApp${booking.id ? ` · booking #${booking.id}` : ''}`,
      ...window,
    };

    const res = await doFetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendar.id)}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`calendar ${res.status}: ${text.slice(0, 160)}`);

    const data = JSON.parse(text);
    logEvent('calendar_synced', booking.chat || null, { id: data.id });
    return { synced: true, id: data.id };
  } catch (err) {
    // A calendar hiccup is a note in the log, never a lost booking.
    logEvent('calendar_failed', booking.chat || null, err.message);
    console.log(`📅 Calendar sync failed (booking kept): ${err.message}`);
    return { synced: false, reason: err.message };
  }
}

/** Best-effort removal when a customer cancels. */
export async function removeBooking(eventId) {
  if (!calendarConfigured() || !eventId) return { removed: false, reason: 'not_configured' };
  try {
    const token = await accessToken();
    const doFetch = fetchImpl || globalThis.fetch;
    const res = await doFetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendar.id)}/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    return { removed: res.ok };
  } catch (err) {
    logEvent('calendar_delete_failed', null, err.message);
    return { removed: false, reason: err.message };
  }
}

export function calendarStatus() {
  return { configured: calendarConfigured(), mode: calendarMode(), calendarId: config.calendar.id || null };
}

export default { pushBooking, removeBooking, calendarConfigured, calendarStatus, eventWindow };
