// platform/mailer.js
// How a one-time code leaves the platform.
//
// The default file transport is for development. Production can select the
// HTTPS JSON adapter below, or inject an SMTP adapter with the same contract.
//
// The code itself is never logged, and never written anywhere a bot can read.

import fs from 'node:fs';
import path from 'node:path';
import { platformDir, ensurePlatformDir } from './env.js';

let transport = null;

/** Replace the delivery transport. `{ send: async ({to, subject, text}) => {ok} }` */
export function setMailer(next) {
  transport = next && typeof next.send === 'function' ? next : null;
  return transport;
}

function outboxFile() {
  return path.join(platformDir(), 'outbox.jsonl');
}

/** Default transport: append to the outbox. No network, no third party. */
export const fileMailer = {
  mode: 'file',
  async send({ to, subject, text }) {
    ensurePlatformDir();
    const line = JSON.stringify({ at: new Date().toISOString(), to, subject, text });
    fs.appendFileSync(outboxFile(), `${line}\n`, { mode: 0o600 });
    return { ok: true, mode: 'file' };
  },
};

/** Resend-compatible HTTPS API. Destinations and credentials are host
 * configuration, never request parameters; no redirects, no response bodies
 * in logs or responses, and no silent fallback to file on provider errors. */
export const httpMailer = {
  mode: 'http',
  async send({ to, subject, text }, fetchImpl = globalThis.fetch) {
    const url = new URL(process.env.PLATFORM_MAIL_URL || 'https://api.resend.com/emails');
    const token = process.env.PLATFORM_MAIL_TOKEN, from = process.env.PLATFORM_MAIL_FROM;
    if (url.protocol !== 'https:' || !token || !from) return { ok: false };
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }) });
    return { ok: response.ok };
  },
};
export function activeMailer() {
  if (transport) return transport;
  const mode = process.env.PLATFORM_MAILER || 'file';
  return mode === 'http' ? httpMailer : mode === 'file' ? fileMailer : { mode: 'invalid', send: async () => ({ ok: false }) };
}

export async function sendMail(message) {
  const chosen = activeMailer();
  try {
    const res = await chosen.send(message);
    return { ok: res?.ok === true, mode: chosen.mode || 'custom' };
  } catch {
    // A dead mail server must not turn a signup into a 500 with a stack trace.
    return { ok: false, mode: chosen.mode || 'custom' };
  }
}

/** Latest outbox entries — for the dev UI and for tests. */
export function readOutbox(limit = 20) {
  try {
    const lines = fs.readFileSync(outboxFile(), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Dev only: show the code in the API response so local setup needs no inbox.
 * Never in production, whatever the env file says — a code in a JSON body is a
 * login for anyone who can read that body.
 */
export function showCodesInResponse() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.PLATFORM_DEV_SHOW_CODES || '').toLowerCase());
}

export default { setMailer, sendMail, fileMailer, readOutbox, showCodesInResponse };
