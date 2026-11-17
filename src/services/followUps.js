// src/services/followUps.js
// Persistent follow-ups. Unlike the old in-memory timers, these survive a
// restart, are timed to the *client's* waking hours, and stop the moment the
// client replies. Max 2 nudges per lead so nobody gets spammed.

import { config } from '../config/env.js';
import {
  addFollowUp, dueFollowUps, updateFollowUp, cancelFollowUps, pendingFollowUps,
  getContact, getLead, getIntake, logEvent,
} from '../utils/db.js';
import { nextAwakeTime, localTime } from './geo.js';
import { sendTyping } from '../core/humanizer.js';

const MAX_ATTEMPTS = Math.max(1, config.behavior.followUpMax);

function friendlyTime(iso) {
  try {
    return new Date(iso).toLocaleString('en-GB', { timeZone: config.timezone, dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

/** Templates keep follow-ups cheap (no AI tokens) and predictable. */
function buildMessage(number, attempt = 1) {
  const lead = getLead(number) || {};
  const contact = getContact(number) || {};
  const intake = getIntake(number) || {};
  const name = (contact.name || contact.push_name || '').split(' ')[0];
  const project = lead.project_type || intake.fields?.projectType || 'the project';
  const greeting = name ? `Hi ${name}` : 'Hi';

  if (attempt === 1) {
    return `${greeting} — just checking in on ${project}. Did the scope and price make sense, or do you want me to adjust anything?`;
  }
  return `${greeting}, last nudge from me on ${project} 🙂 If the timing isn't right, no problem — tell me when to check back and I'll do that instead.`;
}

function pickDueTime(number, hours) {
  const base = new Date(Date.now() + hours * 3600_000);
  // Land inside the client's 09:00–21:00 window when possible
  const awake = nextAwakeTime(number, base, { from: 9, to: 21 });
  return awake;
}

export function scheduleFollowUp(number, { hours = config.behavior.followUpHours, attempt = 1 } = {}) {
  const existing = pendingFollowUps(number);
  if (existing.length >= MAX_ATTEMPTS) return null;
  if (existing.some((f) => f.attempt === attempt)) return null;

  const dueAt = pickDueTime(number, hours);
  addFollowUp(number, dueAt, buildMessage(number, attempt), attempt);
  logEvent('followup_scheduled', number, { attempt, dueAt });
  return dueAt;
}

export function cancelFor(number) {
  cancelFollowUps(number);
}

/**
 * Start the loop that actually sends them.
 * @param {(jid:string, text:string)=>Promise<any>} send
 */
export function startFollowUpLoop(sock) {
  const tick = async () => {
    let due = [];
    try {
      due = dueFollowUps();
    } catch {
      return;
    }

    for (const row of due) {
      const contact = getContact(row.number);
      if (!contact || contact.is_blocked) {
        updateFollowUp(row.id, 'cancelled');
        continue;
      }
      if (contact.bot_paused_until && new Date(contact.bot_paused_until) > new Date()) {
        updateFollowUp(row.id, 'cancelled');
        continue;
      }

      const jid = `${row.number}@s.whatsapp.net`;
      const text = row.message || buildMessage(row.number, row.attempt);

      try {
        await sendTyping(sock, jid, text, { delay: 1200 });
        updateFollowUp(row.id, 'sent');
        logEvent('followup_sent', row.number, { attempt: row.attempt });
        console.log(`⏰ Follow-up #${row.attempt} → ${row.number} (${localTime(row.number).label})`);
      } catch (err) {
        updateFollowUp(row.id, 'cancelled');
        logEvent('followup_failed', row.number, err.message);
        continue;
      }

      if (row.attempt < MAX_ATTEMPTS) {
        scheduleFollowUp(row.number, { attempt: row.attempt + 1, hours: 48 });
      }
    }
  };

  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  setTimeout(tick, 15_000).unref?.();
  console.log('⏰ Follow-up loop started');
  return timer;
}

export function pendingSummary() {
  return dueFollowUps().length;
}

export function describeFollowUps() {
  return pendingFollowUps;
}

export { friendlyTime, buildMessage };
export default { scheduleFollowUp, cancelFor, startFollowUpLoop, pendingSummary };
