// platform/mailer.js
// How a one-time code leaves the platform.
//
// There is no mail provider wired up, and pretending otherwise would be worse
// than saying so: the default transport writes the message to a 0700 file under
// platform/data/outbox and reports `mode: 'file'`. A real deployment plugs its
// provider in through `setMailer()`. Tests read the outbox file.
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

export async function sendMail(message) {
  const chosen = transport || fileMailer;
  try {
    const res = await chosen.send(message);
    return { ok: res?.ok !== false, mode: res?.mode || chosen.mode || 'custom' };
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
