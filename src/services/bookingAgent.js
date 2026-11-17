// src/services/bookingAgent.js
// The booking agent (Phase 3, behind features.bookingAgent).
//
// It does four things, and refuses to do a fifth:
//   offer   — 2–3 slots that are genuinely free (opening hours ∩ not already booked)
//   book    — through the same createBooking() the tools use, so the unique
//             index still has the last word on double-booking
//   remind  — 24h and 2h before, inside the growth safety layer's rules
//   recover — one polite rebook message if they no-show, then silence
//   …and it never invents a slot the business is not open for.

import { config } from '../config/env.js';
import { business, featureOn } from './profile.js';
import { parseHours, nextSlots, localDateString, zonedToUtc, partsInTz, isOpen } from './hours.js';
import { sendProactively, nextAllowedMoment } from './growth.js';
import { pushBooking, calendarConfigured } from './calendar.js';
import { logEvent } from '../utils/db.js';
import {
  all,
  createBooking, getBooking, isSlotTaken, cancelBooking, rescheduleBooking,
  nextBookingFor, bookingsOn, bookingsBetween, upcomingBookings, addReminder,
  dueReminders, setReminderStatus, remindersFor, setBookingStatus, staleBookings,
} from '../utils/db.js';

const REMINDER_KINDS = [
  { kind: '24h', hoursBefore: 24 },
  { kind: '2h', hoursBefore: 2 },
];

export function bookingAgentEnabled() {
  return featureOn('bookingAgent');
}

// ── slots ──────────────────────────────────────────────────
/**
 * Real, bookable slots: inside opening hours, not in the past, not taken.
 * @returns {Array<{date,time,at,label}>}
 */
export function bookableSlots({ service = null, from = new Date(), count = 3, stepMinutes = 30 } = {}) {
  const b = business();
  const hours = parseHours(b.hours || '');
  const timeZone = b.timezone || config.timezone;

  const raw = nextSlots({ hours, timeZone, from, count: count * 6, stepMinutes });
  const free = [];
  for (const slot of raw) {
    // A slot is taken if anyone holds it — the service name is a detail, the
    // chair is not. This is what stops two tables being sold as one.
    const taken = service ? isSlotTaken(service, slot.date, slot.time) : slotIsTaken(slot.date, slot.time);
    if (taken) continue;
    free.push(slot);
    if (free.length >= count) break;
  }
  return free;
}

function slotIsTaken(date, time) {
  // NB: db.all() returns [] when nothing matches — an empty array is truthy in
  // JS, so this must test length, not existence.
  const rows = all("SELECT id FROM bookings WHERE date = ? AND time = ? AND status IN ('booked','confirmed') LIMIT 1", [
    date,
    time,
  ]);
  return rows.length > 0;
}

export function slotLine(slots = []) {
  return slots.map((s, i) => `${i + 1}. ${s.label}`).join('\n');
}

// ── booking ────────────────────────────────────────────────
/**
 * Book, sync, schedule reminders. Returns what the caller should say.
 * @returns {{ok:boolean, problem?:string, booking?:object, slots?:Array}}
 */
export async function book({ number, chat, service, date, time, name = null, notes = null, now = new Date() }) {
  const tz = business().timezone || config.timezone;
  const when = zonedToUtc(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)),
    Number(date.slice(8, 10)),
    Number(time.slice(0, 2)),
    Number(time.slice(3, 5)),
    tz
  );
  if (when.getTime() <= now.getTime()) {
    return { ok: false, problem: 'in_the_past', slots: bookableSlots({ service, from: now, count: 3 }) };
  }

  // Opening hours are the owner's rule, not a suggestion: a 3 a.m. table is
  // not a booking we can keep.
  const hours = parseHours(business().hours || '');
  if (hours.known) {
    const verdict = isOpen(when, { hours, timeZone: tz });
    if (!verdict.open) {
      return {
        ok: false,
        problem: verdict.reason || 'outside_hours',
        slots: bookableSlots({ service, from: now, count: 3 }),
      };
    }
  }

  const { booking, created, conflict } = createBooking({ chat, service, date, time, name, notes });
  if (conflict) {
    return {
      ok: false,
      problem: 'slot_taken',
      slots: bookableSlots({ service, from: now, count: 3 }),
    };
  }

  // One person, one chair at a time: the same customer cannot hold two slots
  // at the same moment under different service names.
  const duplicatePerson = nextBookingFor(chat);
  if (duplicatePerson && duplicatePerson.id !== booking.id) {
    const sameMoment = duplicatePerson.date === date && duplicatePerson.time === time;
    if (sameMoment) {
      cancelBooking(duplicatePerson.id, { by: 'system', reason: 'duplicate' });
    }
  }

  scheduleReminders(booking, { now });

  // Optional calendar push — never blocks, never throws.
  const calendar = calendarConfigured() ? await pushBooking(booking) : { synced: false, reason: 'not_configured' };
  logEvent('booking_created', number, { id: booking.id, date, time, calendar: calendar.synced });

  return { ok: true, booking, created, calendar };
}

export function confirmationText(booking = {}, tz = business().timezone || config.timezone) {
  const when = new Date(zonedToUtc(
    Number(booking.date.slice(0, 4)),
    Number(booking.date.slice(5, 7)),
    Number(booking.date.slice(8, 10)),
    Number(booking.time.slice(0, 2)),
    Number(booking.time.slice(3, 5)),
    tz
  ));
  const label = when.toLocaleString('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Done — ${booking.service} on ${label}. Booking #${booking.id}. Reply "cancel" any time.`;
}

// ── reminders ──────────────────────────────────────────────
export function scheduleReminders(booking, { now = new Date(), force = false } = {}) {
  if (!booking?.date || !booking?.time) return [];
  const tz = business().timezone || config.timezone;
  const at = zonedToUtc(
    Number(booking.date.slice(0, 4)),
    Number(booking.date.slice(5, 7)),
    Number(booking.date.slice(8, 10)),
    Number(booking.time.slice(0, 2)),
    Number(booking.time.slice(3, 5)),
    tz
  );

  const existing = remindersFor(booking.id);
  const created = [];
  for (const { kind, hoursBefore } of REMINDER_KINDS) {
    if (!force && existing.some((r) => r.kind === kind && r.status !== 'cancelled')) continue;
    const due = new Date(at.getTime() - hoursBefore * 3600 * 1000);
    if (due.getTime() <= now.getTime()) continue; // the slot is too close for that nudge
    created.push(addReminder({ bookingId: booking.id, number: booking.number || null, kind, dueAt: due.toISOString() }));
  }
  return created;
}

export function reminderText(booking, kind = '24h') {
  const when = `${booking.date} at ${booking.time}`;
  if (kind === '24h') {
    return `Reminder: your ${booking.service} is tomorrow (${when}). Reply "yes" to confirm, or "cancel" if plans changed.`;
  }
  return `See you soon — your ${booking.service} is in about 2 hours (${when}). Reply "cancel" if you can't make it.`;
}

/**
 * Send whatever is due. Runs on a timer; also callable from tests with a fake clock.
 */
export async function runReminders({ transport, now = new Date(), limit = 20 } = {}) {
  const due = dueReminders(now.toISOString(), limit);
  const results = [];

  for (const reminder of due) {
    const booking = getBooking(reminder.booking_id);
    if (!booking || !['booked', 'confirmed'].includes(booking.status)) {
      setReminderStatus(reminder.id, 'cancelled');
      continue;
    }

    const number = reminder.number || String(booking.chat || '').split('@')[0];
    const text = reminderText(booking, reminder.kind);
    const outcome = await sendProactively({
      transport,
      number,
      text,
      agent: 'reminder',
      reason: `booking #${booking.id} ${reminder.kind}`,
      now,
      transactional: true, // they booked it; the 1/24h lead cap does not apply
    });

    if (outcome.sent) {
      setReminderStatus(reminder.id, 'sent');
    } else if (outcome.reason === 'quiet_hours') {
      // Try again later tonight/tomorrow — the booking still exists.
      const later = nextAllowedMoment(now);
      setReminderStatus(reminder.id, 'pending');
      reminder.due_at = later.toISOString();
    } else {
      setReminderStatus(reminder.id, 'cancelled');
    }
    results.push({ reminder, outcome });
  }

  return results;
}

// ── no-shows ───────────────────────────────────────────────
/**
 * A booking whose time has passed and that nobody confirmed: one polite offer
 * to rebook, then we stop. Never twice.
 */
export async function runNoShows({ transport, now = new Date(), graceMinutes = 60 } = {}) {
  // Bookings store a wall-clock date and time, so the cutoff must be wall-clock
  // too — comparing a Karachi "20:00" against a UTC ISO string is how a no-show
  // fires six hours early.
  const tz = business().timezone || config.timezone;
  const cutoffDate = new Date(now.getTime() - graceMinutes * 60 * 1000);
  const p = partsInTz(cutoffDate, tz);
  const pad = (n) => String(n).padStart(2, '0');
  const cutoff = `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
  const stale = staleBookings(cutoff);
  const results = [];

  for (const booking of stale) {
    const number = String(booking.chat || '').split('@')[0];
    const already = remindersFor(booking.id).some((r) => r.kind === 'noshow');
    if (already) {
      setBookingStatus(booking.id, 'no_show');
      continue;
    }

    const text = `Sorry we missed you for the ${booking.service} (${booking.date} ${booking.time}). Want to try another time? Just tell me a day and I'll find you a slot.`;
    const outcome = await sendProactively({
      transport,
      number,
      text,
      agent: 'rebook',
      reason: `no-show booking #${booking.id}`,
      now,
      transactional: true,
    });

    // Not now is not never: a night-time or capped attempt leaves the booking
    // exactly as it was and we try again on the next tick.
    if (!outcome.sent && outcome.reason !== 'opted_out') {
      results.push({ booking, outcome, retry: true });
      continue;
    }

    // The marker exists whether or not it went out: one attempt, then silence.
    addReminder({ bookingId: booking.id, number, kind: 'noshow', dueAt: now.toISOString() });
    setReminderStatus(
      remindersFor(booking.id).find((r) => r.kind === 'noshow')?.id,
      outcome.sent ? 'sent' : 'cancelled'
    );
    setBookingStatus(booking.id, 'no_show');
    results.push({ booking, outcome });
  }

  return results;
}

// ── what the customer can do by chat ───────────────────────
export function cancelByChat(number, { reason = 'customer asked' } = {}) {
  const booking = nextBookingFor(`${number}@s.whatsapp.net`);
  if (!booking) return { ok: false, problem: 'no_booking' };
  const result = cancelBooking(booking.id, { by: 'customer', reason });
  logEvent('booking_cancelled', number, { id: booking.id });
  return { ...result, booking: result.booking };
}

export function rescheduleByChat(number, { date, time } = {}) {
  const chat = `${number}@s.whatsapp.net`;
  const booking = nextBookingFor(chat);
  if (!booking) return { ok: false, problem: 'no_booking' };

  // Someone else's request may not hijack a taken slot.
  if (isSlotTaken(booking.service, date, time)) {
    return { ok: false, problem: 'slot_taken', slots: bookableSlots({ service: booking.service, count: 3 }) };
  }

  const result = rescheduleBooking(booking.id, { date, time });
  if (!result.ok) return { ...result, slots: bookableSlots({ service: booking.service, count: 3 }) };

  scheduleReminders(result.booking, { force: true });
  logEvent('booking_rescheduled', number, { id: booking.id, date, time });
  return result;
}

export function confirmByChat(number) {
  const booking = nextBookingFor(`${number}@s.whatsapp.net`);
  if (!booking) return { ok: false, problem: 'no_booking' };
  setBookingStatus(booking.id, 'confirmed');
  logEvent('booking_confirmed', number, { id: booking.id });
  return { ok: true, booking: getBooking(booking.id) };
}


// ════════════════════════════════════════════════════════════
// The conversation — deterministic, no tokens, no invented slots
// ════════════════════════════════════════════════════════════

const OFFER_TTL_MS = 30 * 60 * 1000;
const offers = new Map(); // number -> { slots, at, service }

export function activeOffer(number, now = new Date()) {
  const entry = offers.get(number);
  if (!entry) return null;
  if (now.getTime() - entry.at > OFFER_TTL_MS) {
    offers.delete(number);
    return null;
  }
  return entry;
}

export function setOffer(number, slots, service = null, now = new Date()) {
  offers.set(number, { slots, at: now.getTime(), service });
  return offers.get(number);
}

export function clearOffer(number) {
  offers.delete(number);
}

export function clearOffers() {
  offers.clear();
}

const BOOKING_INTENT =
  /\b(book|booking|reserve|reservation|appointment|table for \d+|slot|book karna|table chahiye|appointment chahiye|time mil)\b|(بکنگ|اپائنٹمنٹ|ٹیبل)/i;
const CANCEL_INTENT = /\b(cancel|call it off|cancel kar|radd|mat karo|nahi aana)\b|(کینسل|رد)/i;
const RESCHEDULE_INTENT = /\b(reschedule|change (the )?(time|slot|booking)|move it|shift kar|time change|badal)\b|(تبدیل|وقت بدل)/i;
const CONFIRM_INTENT = /^(yes|yeah|yep|haan|han|ji|confirm|ok(ay)?|theek|thik|ٹھیک|جی ہاں)[\s!.]*$/i;
const DECLINE_INTENT = /^(no|nahi|nah|nope|not coming|نہیں)[\s!.]*$/i;

export const bookingIntent = (text = '') => BOOKING_INTENT.test(String(text));
export const cancelIntent = (text = '') => CANCEL_INTENT.test(String(text));
export const rescheduleIntent = (text = '') => RESCHEDULE_INTENT.test(String(text));
export const confirmIntent = (text = '') => CONFIRM_INTENT.test(String(text).trim());
export const declineIntent = (text = '') => DECLINE_INTENT.test(String(text).trim());

const WEEKDAYS = {
  sunday: 0, sun: 0, itwar: 0, اتوار: 0,
  monday: 1, mon: 1, peer: 1, pir: 1, پیر: 1,
  tuesday: 2, tue: 2, tues: 2, mangal: 2, منگل: 2,
  wednesday: 3, wed: 3, budh: 3, بدھ: 3,
  thursday: 4, thu: 4, thurs: 4, jumerat: 4, جمعرات: 4,
  friday: 5, fri: 5, juma: 5, جمعہ: 5,
  saturday: 6, sat: 6, hafta: 6, ہفتہ: 6,
};

/**
 * A date and time out of ordinary words: "tomorrow 7pm", "kal 8 baje",
 * "Friday at 20:00", "2030-06-07 19:30".
 * @returns {{date:string,time:string}|null} in the business timezone
 */
export function parseWhen(text = '', { now = new Date(), timeZone = business().timezone || config.timezone } = {}) {
  const raw = String(text || '').toLowerCase();

  let date = null;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) {
    date = iso[0];
  } else {
    const today = localDateString(now, timeZone);
    const dayOffset = /tomorrow|\bkal\b|کل/.test(raw) && !/\bparson\b/.test(raw) ? 1
      : /today|\baaj\b|آج/.test(raw) ? 0
        : null;

    if (dayOffset !== null) {
      date = localDateString(new Date(now.getTime() + dayOffset * 24 * 3600 * 1000), timeZone);
    } else {
      for (const [word, index] of Object.entries(WEEKDAYS)) {
        const re = new RegExp(`\\b${word}\\b|${word}`, 'i');
        if (re.test(raw)) {
          const todayIndex = partsInTz(now, timeZone).weekday;
          let delta = (index - todayIndex + 7) % 7;
          if (delta === 0) delta = 7; // "Friday" said on a Friday means next week
          date = localDateString(new Date(now.getTime() + delta * 24 * 3600 * 1000), timeZone);
          break;
        }
      }
      if (!date) date = today; // a bare time means today, if it is still ahead
    }
  }

  // Time: 19:30, 7pm, 7.30 pm, "8 baje"
  let time = null;
  const hm = /\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/.exec(raw);
  const ampm = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(raw);
  // No trailing \b after the Urdu word: Arabic script characters are not
  // "word" characters in JS regex, so a boundary there would never match.
  const baje = /(\d{1,2})\s*(?:baje\b|بجے)/.exec(raw);

  if (ampm) {
    let hour = Number(ampm[1]);
    if (ampm[3] === 'pm' && hour < 12) hour += 12;
    if (ampm[3] === 'am' && hour === 12) hour = 0;
    time = `${String(hour).padStart(2, '0')}:${ampm[2] || '00'}`;
  } else if (hm) {
    let hour = Number(hm[1]);
    if (hm[3] === 'pm' && hour < 12) hour += 12;
    if (hm[3] === 'am' && hour === 12) hour = 0;
    if (!hm[3] && hour >= 1 && hour <= 7) hour += 12; // "7:30" from a customer usually means evening
    time = `${String(hour).padStart(2, '0')}:${hm[2]}`;
  } else if (baje) {
    let hour = Number(baje[1]);
    if (hour >= 1 && hour <= 7) hour += 12;
    time = `${String(hour).padStart(2, '0')}:00`;
  }

  if (!time) return null;

  // "8 baje" and "8:00" are genuinely ambiguous. If the morning reading is
  // outside opening hours and the evening one is inside, they meant the evening.
  const ambiguous = !ampm && (!!baje || !!hm);
  if (ambiguous && date) {
    const hours = parseHours(business().hours || '');
    if (hours.known) {
      const [h, m] = time.split(':').map(Number);
      const inside = (hour) => {
        const at = zonedToUtc(
          Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)), hour, m,
          business().timezone || config.timezone
        );
        return isOpen(at, { hours, timeZone: business().timezone || config.timezone }).open;
      };
      if (!inside(h) && h < 12 && inside(h + 12)) time = `${String(h + 12).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }

  return { date, time };
}

const SAY = {
  choose: (lang, list) => {
    if (lang === 'ur') return `یہ اوقات خالی ہیں — نمبر لکھ دیجیے:\n${list}`;
    if (lang === 'roman-ur') return `Ye slots khali hain — number likh dein:\n${list}`;
    return `I have these times free — just reply with the number:\n${list}`;
  },
  booked: (lang, label, id) => {
    if (lang === 'ur') return `ہو گیا — ${label} پر بکنگ #${id}۔ کینسل کرنے کے لیے "cancel" لکھیں۔`;
    if (lang === 'roman-ur') return `Ho gaya — ${label} par booking #${id}. Cancel karne ke liye "cancel" likh dein.`;
    return `Done — ${label}. Booking #${id}. Reply "cancel" any time.`;
  },
  taken: (lang, list) => {
    if (lang === 'ur') return `وہ وقت کسی اور نے لے لیا۔ یہ خالی ہیں:\n${list}`;
    if (lang === 'roman-ur') return `Wo slot kisi aur ne le liya. Ye khali hain:\n${list}`;
    return `That slot just went. These are still free:\n${list}`;
  },
  noSlots: (lang) => {
    if (lang === 'ur') return 'اس ہفتے کوئی وقت خالی نہیں۔ کون سا دن اور وقت چاہیے؟';
    if (lang === 'roman-ur') return 'Is hafte koi slot khali nahi. Kaun sa din aur waqt chahiye?';
    return "Nothing free this week, sorry. Which day and time would suit you?";
  },
  cancelled: (lang, booking) => {
    if (lang === 'ur') return `ٹھیک ہے — ${booking.date} ${booking.time} کی بکنگ منسوخ۔ وقت خالی ہے۔`;
    if (lang === 'roman-ur') return `Theek hai — ${booking.date} ${booking.time} ki booking cancel. Slot khali hai.`;
    return `Cancelled — ${booking.date} ${booking.time} is free again. Want another time?`;
  },
  noBooking: (lang) => {
    if (lang === 'ur') return 'آپ کی کوئی بکنگ نہیں ملی۔';
    if (lang === 'roman-ur') return 'Aap ki koi booking nahi mili.';
    return "I can't find a booking under this number.";
  },
  confirmed: (lang) => {
    if (lang === 'ur') return 'شکریہ — میں نے آپ کی آمد لکھ لی۔';
    if (lang === 'roman-ur') return 'Shukriya — aap ki aamad note kar li.';
    return "Thanks — I've marked you as confirmed.";
  },
};

function labelFor(date, time, tz) {
  const at = zonedToUtc(
    Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)),
    Number(time.slice(0, 2)), Number(time.slice(3, 5)), tz
  );
  return at.toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * One turn of the booking conversation.
 * @returns {{handled:boolean, reply?:string, booking?:object}}
 */
export async function handleBookingTurn({ number, text = '', lang = 'en', now = new Date(), service = null } = {}) {
  if (!bookingAgentEnabled()) return { handled: false };

  const tz = business().timezone || config.timezone;
  const offer = activeOffer(number, now);
  const upcoming = nextBookingFor(`${number}@s.whatsapp.net`);

  // ── choosing from the offer we just made ────────────────
  if (offer) {
    const choice = String(text).trim().match(/^([1-9])$/)?.[1];
    const when = parseWhen(text, { now, timeZone: tz });

    let picked = choice ? offer.slots[Number(choice) - 1] : null;
    if (!picked && when) picked = offer.slots.find((s) => s.date === when.date && s.time === when.time) || null;

    if (picked) {
      clearOffer(number);
      const result = await book({
        number,
        chat: `${number}@s.whatsapp.net`,
        service: offer.service || service || business().bookingService || 'Appointment',
        date: picked.date,
        time: picked.time,
        name: null,
        now,
      });

      if (!result.ok) {
        const slots = result.slots || [];
        if (slots.length) setOffer(number, slots, offer.service, now);
        return {
          handled: true,
          reply: slots.length ? SAY.taken(lang, slotLine(slots)) : SAY.noSlots(lang),
        };
      }

      return {
        handled: true,
        reply: SAY.booked(lang, labelFor(picked.date, picked.time, tz), result.booking.id),
        booking: result.booking,
      };
    }

    if (cancelIntent(text) || declineIntent(text)) {
      clearOffer(number);
      return { handled: true, reply: lang === 'ur' ? 'ٹھیک ہے، کوئی بکنگ نہیں کی۔' : lang === 'roman-ur' ? 'Theek hai, koi booking nahi ki.' : 'No problem — nothing booked.' };
    }
    // Anything else: let the normal brain answer, but keep the offer alive.
  }

  // ── cancel / reschedule / confirm an existing booking ───
  if (upcoming) {
    if (cancelIntent(text)) {
      const res = cancelByChat(number, { reason: 'asked in chat' });
      return { handled: true, reply: res.ok ? SAY.cancelled(lang, res.booking) : SAY.noBooking(lang) };
    }

    if (rescheduleIntent(text)) {
      const when = parseWhen(text, { now, timeZone: tz });
      if (!when) {
        const slots = bookableSlots({ service: upcoming.service, from: now, count: 3 });
        if (!slots.length) return { handled: true, reply: SAY.noSlots(lang) };
        setOffer(number, slots, upcoming.service, now);
        return { handled: true, reply: SAY.choose(lang, slotLine(slots)) };
      }
      const res = rescheduleByChat(number, when);
      if (res.ok) {
        return { handled: true, reply: SAY.booked(lang, labelFor(when.date, when.time, tz), res.booking.id) };
      }
      const slots = res.slots || bookableSlots({ service: upcoming.service, from: now, count: 3 });
      if (slots.length) setOffer(number, slots, upcoming.service, now);
      return { handled: true, reply: slots.length ? SAY.taken(lang, slotLine(slots)) : SAY.noSlots(lang) };
    }

    if (confirmIntent(text)) {
      confirmByChat(number);
      return { handled: true, reply: SAY.confirmed(lang) };
    }
  }

  // ── a new booking request ───────────────────────────────
  if (bookingIntent(text)) {
    const when = parseWhen(text, { now, timeZone: tz });
    if (when) {
      const result = await book({
        number,
        chat: `${number}@s.whatsapp.net`,
        service: service || business().bookingService || 'Appointment',
        date: when.date,
        time: when.time,
        now,
      });
      if (result.ok) {
        return { handled: true, reply: SAY.booked(lang, labelFor(when.date, when.time, tz), result.booking.id), booking: result.booking };
      }
      const slots = result.slots || [];
      if (slots.length) setOffer(number, slots, service, now);
      return { handled: true, reply: slots.length ? SAY.taken(lang, slotLine(slots)) : SAY.noSlots(lang) };
    }

    const slots = bookableSlots({ service, from: now, count: 3 });
    if (!slots.length) return { handled: true, reply: SAY.noSlots(lang) };
    setOffer(number, slots, service, now);
    return { handled: true, reply: SAY.choose(lang, slotLine(slots)) };
  }

  return { handled: false };
}

// ── owner views ────────────────────────────────────────────
export function bookingsForOwner(now = new Date()) {
  const tz = business().timezone || config.timezone;
  const today = localDateString(now, tz);
  const tomorrowDate = new Date(now.getTime() + 24 * 3600 * 1000);
  const tomorrow = localDateString(tomorrowDate, tz);
  return { today, tomorrow, todayRows: bookingsOn(today), tomorrowRows: bookingsOn(tomorrow) };
}

export function bookingsAhead(days = 7, now = new Date()) {
  const tz = business().timezone || config.timezone;
  const from = localDateString(now, tz);
  const to = localDateString(new Date(now.getTime() + days * 24 * 3600 * 1000), tz);
  return bookingsBetween(from, to);
}

/** The loop index.js starts when the flag is on. */
export function startBookingLoop(transport, { intervalMs = 60_000 } = {}) {
  if (!bookingAgentEnabled()) return null;

  const tick = async () => {
    try {
      await runReminders({ transport });
      await runNoShows({ transport });
    } catch (err) {
      logEvent('booking_loop_error', null, err.message);
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 12_000).unref?.();
  console.log('📅 Booking agent loop started (reminders + no-shows)');
  return timer;
}

export { upcomingBookings };
export default {
  bookingAgentEnabled, bookableSlots, book, scheduleReminders, runReminders,
  runNoShows, cancelByChat, rescheduleByChat, confirmByChat, startBookingLoop,
  handleBookingTurn, parseWhen, setOffer, activeOffer, clearOffer,
};
