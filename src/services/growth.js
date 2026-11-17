// src/services/growth.js
// The shared safety layer for every proactive message this bot ever sends.
//
// Growth agents are the only part of the assistant that talks to someone who
// did not just ask it something. That deserves rules, and the rules live here
// once so no agent can forget them:
//
//   1. "stop" means stop — permanently, in every language the bot speaks.
//   2. Not at night. 21:00–09:00 in the *business's* timezone, never.
//   3. One proactive message per person per 24 hours, and a daily ceiling for
//      the whole bot (lower on Baileys, where bursts get numbers flagged).
//   4. On the Cloud API, outside the 24-hour window only a template may go
//      out — otherwise skip, and say why in the log.
//   5. Every attempt is recorded, sent or skipped. Nothing is invisible.

import { config } from '../config/env.js';
import { partsInTz } from './hours.js';
import { business } from './profile.js';
import {
  isOptedOut, optOut, optIn, logGrowthSend, growthCountFor, growthStatsSince,
  optOutList, optOutCount,
} from '../utils/db.js';
import { logEvent } from '../utils/db.js';

// ── opt-out detection ──────────────────────────────────────
// Word-boundary-free at the end: Urdu and emoji do not have word boundaries,
// and "stop." / "stop 🙏" must still count.

const OPT_OUT_PATTERNS = [
  // English — a bare "stop" only counts when it *is* the message. "stop by the
  // shop tomorrow" is an errand, not an opt-out.
  /^(please\s+)?(stop|stop\s+it|unsubscribe|opt\s*out|remove\s+me)(\s+(now|please|it|thanks|thank\s+you))?[\s.!،,🙏👍✋]*$/i,
  /\b(stop\s+(messaging|texting|sending|contacting|these)|don'?t\s+(message|text|contact|send)(\s+me)?\b|no\s+more\s+(messages|msgs|texts)|unsubscribe\s+me|remove\s+me\s+from|leave\s+me\s+alone)\b/i,
  // Roman Urdu
  /\b(band\s*karo|band\s*kar\s*do|band\s*kr\s*do|mat\s*bhejo|mat\s*bhejna|mat\s*bhej|message\s*mat|msg\s*mat|pareshan\s*mat|tang\s*mat|nahi\s*chahiye\s*message)\b/i,
  // Urdu script
  /(بند\s*کرو|بند\s*کر\s*دو|مت\s*بھیجو|مت\s*بھیجیں|میسج\s*مت|پریشان\s*مت|نہیں\s*چاہیے)/,
];

const OPT_IN_PATTERNS = [
  /^(please\s+)?(start|resume|subscribe|opt\s*in)(\s+(again|please|it))?[\s.!،,🙏]*$/i,
  /\b(start\s+(sending|the\s+messages|again)|send\s+(me\s+)?(messages|updates)\s+again|message\s+me\s+again)\b/i,
  /\b(shuru\s*karo|dobara\s*bhejo|phir\s*se\s*bhejo|wapas\s*shuru)\b/i,
  /(شروع\s*کرو|دوبارہ\s*بھیجو|پھر\s*سے\s*بھیجو)/,
];

export function detectOptOut(text = '') {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 200) return false; // a sentence, not a rant
  return OPT_OUT_PATTERNS.some((re) => re.test(clean));
}

export function detectOptIn(text = '') {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 200) return false;
  return OPT_IN_PATTERNS.some((re) => re.test(clean));
}

/** The one polite confirmation — no persuasion, no "are you sure?". */
export function optOutConfirmation(lang = 'en') {
  if (lang === 'ur') return 'ٹھیک ہے — اب آپ کو کوئی یاد دہانی نہیں بھیجوں گا۔ اگر کبھی چاہیں تو «شروع کرو» لکھ دیجیے۔';
  if (lang === 'roman') return 'Theek hai — ab aap ko koi reminder nahi bhejunga. Kabhi chahiye to "start" likh dein.';
  return "Understood — no more reminders from me. If you ever want them back, just say \"start\".";
}

/** Record the opt-out. Returns true when this was news (first time). */
export function recordOptOut(number, { reason = 'asked to stop', source = 'message' } = {}) {
  const already = isOptedOut(number);
  optOut(number, { reason, source });
  logEvent('growth_optout', number, { source, already });
  return !already;
}

export function recordOptIn(number) {
  const was = isOptedOut(number);
  optIn(number);
  logEvent('growth_optin', number, null);
  return was;
}

// ── quiet hours ────────────────────────────────────────────
function parseClock(spec, fallback) {
  const m = /^(\d{1,2}):?(\d{2})?$/.exec(String(spec || '').trim());
  if (!m) return fallback;
  return parseInt(m[1], 10) * 60 + parseInt(m[2] || '0', 10);
}

export function quietWindow() {
  const b = business();
  return {
    start: parseClock(b.quietHours?.start || b.quietStart || config.growth.quietStart, 21 * 60),
    end: parseClock(b.quietHours?.end || b.quietEnd || config.growth.quietEnd, 9 * 60),
    timeZone: b.timezone || config.timezone,
  };
}

/** Is `now` inside the quiet window, in the business's timezone? */
export function inQuietHours(now = new Date()) {
  const { start, end, timeZone } = quietWindow();
  const { hour, minute } = partsInTz(now, timeZone);
  const minutes = hour * 60 + minute;

  // A window that crosses midnight (21:00 → 09:00) is the normal case.
  if (start <= end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

/** The next moment we are allowed to speak, as a Date. */
export function nextAllowedMoment(now = new Date()) {
  const { start, end, timeZone } = quietWindow();
  if (!inQuietHours(now)) return now;

  // Walk forward in 5-minute steps until we leave the window. Cheap, obvious,
  // and daylight-saving-proof because every check re-reads the wall clock.
  let cursor = new Date(now.getTime());
  for (let i = 0; i < 24 * 12 + 2; i++) {
    cursor = new Date(cursor.getTime() + 5 * 60 * 1000);
    if (!inQuietHours(cursor)) return cursor;
    void start;
    void end;
    void timeZone;
  }
  return cursor;
}

// ── caps ───────────────────────────────────────────────────
export function dailyCapFor(transportKind = config.transport) {
  // Baileys is an unofficial client: a burst of messages is exactly what gets
  // a number limited. The ceiling is lower there on purpose.
  return transportKind === 'baileys' ? config.growth.baileysCap : config.growth.dailyCap;
}

export function dayStartIso(now = new Date()) {
  const { timeZone } = quietWindow();
  // Local midnight → ISO, without pulling in a date library.
  const p = partsInTz(now, timeZone);
  const minutesNow = p.hour * 60 + p.minute + now.getSeconds() / 60;
  return new Date(now.getTime() - minutesNow * 60 * 1000).toISOString();
}

/**
 * May we send this person a proactive message right now?
 * @returns {{ok:boolean, reason:string, detail?:string}}
 */
export function canSendProactively(number, { now = new Date(), agent = 'growth', transportKind = config.transport, transactional = false } = {}) {
  if (!number) return { ok: false, reason: 'no_number' };
  if (isOptedOut(number)) return { ok: false, reason: 'opted_out' };

  if (inQuietHours(now)) return { ok: false, reason: 'quiet_hours', detail: quietWindowLabel() };

  // The 1-per-24h cap exists to stop us pestering leads. A reminder for an
  // appointment the customer themselves booked is not that, so it is exempt —
  // opt-out, quiet hours and the daily ceiling still apply to it.
  if (!transactional) {
    const perContact = growthCountFor(number, new Date(now.getTime() - 24 * 3600 * 1000).toISOString());
    if (perContact >= config.growth.contactCap) {
      return { ok: false, reason: 'contact_cap', detail: `already ${perContact} in 24h` };
    }
  }

  const today = growthStatsSince(dayStartIso(now));
  const sentToday = today.filter((r) => r.result === 'sent').reduce((a, r) => a + r.count, 0);
  const cap = dailyCapFor(transportKind);
  if (sentToday >= cap) return { ok: false, reason: 'daily_cap', detail: `${sentToday}/${cap}` };

  void agent;
  return { ok: true, reason: 'ok' };
}

function quietWindowLabel() {
  const { start, end, timeZone } = quietWindow();
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${fmt(start)}–${fmt(end)} ${timeZone}`;
}

// ── the only way an agent is allowed to send ───────────────
/**
 * @param {object} opts
 * @param {object} opts.transport  a transport (sendMessage + kind + can)
 * @param {string} opts.number
 * @param {string} opts.text
 * @param {string} opts.agent     booking | reminder | followup | rebook
 * @param {string} opts.reason    why we are writing (goes in the log)
 */
export async function sendProactively({
  transport,
  number,
  text,
  agent = 'growth',
  reason = null,
  now = new Date(),
  allowQuiet = false,
  transactional = false,
} = {}) {
  if (!number || !text) return { sent: false, reason: 'bad_request' };

  const transportKind = transport?.kind || config.transport;

  // The Cloud API rule is part of the safety layer too: outside the 24-hour
  // window, only an approved template may go out, and this is a plain text.
  if (!allowQuiet) {
    const gate = canSendProactively(number, { now, agent, transportKind, transactional });
    if (!gate.ok) {
      logGrowthSend({ agent, number, reason, result: 'skipped', detail: gate.reason, at: now.toISOString() });
      logEvent('growth_skipped', number, { agent, reason: gate.reason });
      return { sent: false, reason: gate.reason, detail: gate.detail };
    }
  }

  if (transportKind === 'cloud' && transport?.windowOpen && !transport.windowOpen(number)) {
    // Outside the window only an approved template may go out. If one is
    // configured the transport builds it; if not, we skip — and say so loudly
    // enough that `.growth` can explain it later.
    if (transport.template?.name) {
      try {
        await transport.sendMessage(`${number}@s.whatsapp.net`, { text });
        logGrowthSend({
          agent, number, reason, result: 'sent',
          detail: `template ${transport.template.name}`, at: now.toISOString(),
        });
        logEvent('growth_template_sent', number, { agent, template: transport.template.name });
        return { sent: true, template: transport.template.name };
      } catch (err) {
        logGrowthSend({
          agent, number, reason, result: 'failed',
          detail: String(err.message).slice(0, 160), at: now.toISOString(),
        });
        return { sent: false, reason: 'send_failed', error: err.message };
      }
    }

    logGrowthSend({
      agent, number, reason, result: 'held',
      detail: 'outside 24h window · no approved template configured', at: now.toISOString(),
    });
    logEvent('growth_held', number, { agent, why: 'no_template' });
    return { sent: false, reason: 'window_closed', detail: 'no_template' };
  }

  const jid = `${number}@s.whatsapp.net`;
  try {
    await transport.sendMessage(jid, { text });
  } catch (err) {
    const held = /24h|window|template/i.test(err.message || '');
    logGrowthSend({
      agent,
      number,
      reason,
      result: held ? 'held' : 'failed',
      detail: String(err.message).slice(0, 180),
      at: now.toISOString(),
    });
    logEvent('growth_failed', number, { agent, error: err.message });
    return { sent: false, reason: held ? 'window_closed' : 'send_failed', error: err.message };
  }

  logGrowthSend({ agent, number, reason, result: 'sent', at: now.toISOString() });
  logEvent('growth_sent', number, { agent });
  return { sent: true };
}

/**
 * Owner-directed messages (the weekly report) still respect quiet hours, but
 * they are not marketing: the 1-per-24h per-contact cap would silence the
 * second half of a two-part report, so they are marked transactional.
 */
export async function sendToOwner({ transport, text, agent = 'analyst', reason = null, now = new Date() } = {}) {
  const number = config.owner.number;
  if (!number) return { sent: false, reason: 'no_owner' };
  return sendProactively({ transport, number, text, agent, reason, now, transactional: true });
}

// ── the owner's view ───────────────────────────────────────
export function growthSummary(now = new Date()) {
  const since = dayStartIso(now);
  const rows = growthStatsSince(since);
  const byAgent = {};
  for (const row of rows) {
    byAgent[row.agent] = byAgent[row.agent] || { sent: 0, skipped: 0, held: 0, failed: 0 };
    byAgent[row.agent][row.result] = (byAgent[row.agent][row.result] || 0) + row.count;
  }
  const sent = rows.filter((r) => r.result === 'sent').reduce((a, r) => a + r.count, 0);
  return {
    byAgent,
    sent,
    cap: dailyCapFor(),
    transport: config.transport,
    optOuts: optOutCount(),
    quiet: quietWindowLabel(),
    inQuiet: inQuietHours(now),
  };
}

export { optOutList, optOutCount, isOptedOut, dayStartIso as todayStartIso };

export default {
  detectOptOut, detectOptIn, recordOptOut, recordOptIn, optOutConfirmation, sendToOwner,
  inQuietHours, nextAllowedMoment, quietWindow, canSendProactively, sendProactively,
  growthSummary, dailyCapFor, isOptedOut, optOutList,
};
