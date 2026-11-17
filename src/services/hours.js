// src/services/hours.js
// Opening hours, in the business's own timezone.
//
// Everything the bot promises about availability has to agree with the hours
// the owner typed into owner.json — not with whatever clock the server happens
// to be on. A VPS in Frankfurt must still refuse 3 a.m. in Karachi.
//
// Supported shapes for business.hours:
//   "Daily 12:00–23:00"
//   "Mon–Sat 10:00–20:00, Sunday closed"
//   "Mon-Sat 10:00-14:00, 17:00-23:00; Sun closed"
//   "24/7"
//   { "mon": "10:00-20:00", "sun": "closed" }
//   { "mon": ["10:00-14:00", "17:00-23:00"] }

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const DAY_ALIASES = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const norm = (s) => String(s || '').replace(/[–—−]/g, '-').replace(/\s+/g, ' ').trim();

/** "9:00 am" / "21:30" / "9.30pm" → minutes from midnight */
export function parseTime(raw) {
  const text = norm(raw).toLowerCase();
  const match = text.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3];
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 24 || minute > 59) return null;
  return hour * 60 + minute;
}

export function formatTime(minutes) {
  if (minutes === 1440) return '24:00';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function expandDays(spec) {
  const text = norm(spec).toLowerCase();
  if (!text || /daily|every ?day|all days|7 days|week/.test(text)) return [0, 1, 2, 3, 4, 5, 6];

  // Mon–Fri / mon to sat
  const range = text.match(/([a-z]{3,9})\s*(?:-|to|through)\s*([a-z]{3,9})/);
  if (range) {
    const from = DAY_ALIASES[range[1]];
    const to = DAY_ALIASES[range[2]];
    if (from !== undefined && to !== undefined) {
      const days = [];
      let day = from;
      for (let i = 0; i < 7; i += 1) {
        days.push(day);
        if (day === to) break;
        day = (day + 1) % 7;
      }
      return days;
    }
  }

  const single = text.match(/\b([a-z]{3,9})\b/g) || [];
  const days = single.map((d) => DAY_ALIASES[d]).filter((d) => d !== undefined);
  return days.length ? [...new Set(days)] : null;
}

function parseRanges(segment) {
  const ranges = [];
  const re = /(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\s*-\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)/gi;
  const text = norm(segment);
  let match;
  while ((match = re.exec(text)) !== null) {
    let start = parseTime(match[1]);
    let end = parseTime(match[2]);
    if (start === null || end === null) continue;
    // "12:00-11:00pm" → the start shares the end's meridiem
    if (!/am|pm/i.test(match[1]) && /pm/i.test(match[2]) && start <= 12 * 60 && end > start) {
      start += 12 * 60;
    }
    if (end === 0 && start > 0) end = 1440; // "18:00-00:00"
    if (end <= start && end !== 1440) {
      // overnight shift, e.g. 18:00-02:00 → keep as is, handled at read time
    }
    ranges.push({ start, end });
  }
  return ranges;
}

/**
 * @returns {{ known:boolean, byDay:Array<Array<{start:number,end:number}>>, raw:any }}
 */
export function parseHours(spec) {
  const byDay = Array.from({ length: 7 }, () => []);
  let known = false;

  const assign = (days, ranges) => {
    known = true;
    for (const day of days) {
      if (ranges === null) byDay[day] = []; // explicitly closed
      else byDay[day] = [...(byDay[day] || []), ...ranges];
    }
  };

  if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    for (const [key, value] of Object.entries(spec)) {
      const lower = String(key).toLowerCase().slice(0, 3);
      const day = DAY_ALIASES[lower] ?? (Number.isInteger(Number(key)) ? Number(key) % 7 : undefined);
      if (day === undefined) continue;
      if (value === null || /closed|off|holiday/i.test(String(value))) {
        assign([day], null);
        continue;
      }
      const list = Array.isArray(value) ? value : [value];
      const ranges = list.flatMap((v) => parseRanges(v));
      if (ranges.length) assign([day], ranges);
    }
    return { known, byDay, raw: spec };
  }

  const text = norm(spec);
  if (!text) return { known: false, byDay, raw: spec };
  if (/24\s*\/\s*7|always open|open 24/i.test(text)) {
    assign([0, 1, 2, 3, 4, 5, 6], [{ start: 0, end: 1440 }]);
    return { known, byDay, raw: spec };
  }

  for (const chunk of text.split(/[;,]+/)) {
    const segment = chunk.trim();
    if (!segment) continue;

    const closed = /closed|off day|holiday/i.test(segment);
    const timePart = segment.replace(/(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\s*-\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)/gi, ' ');
    const days = expandDays(timePart) ?? [0, 1, 2, 3, 4, 5, 6];

    if (closed) {
      assign(days, null);
      continue;
    }
    const ranges = parseRanges(segment);
    if (ranges.length) assign(days, ranges);
  }

  return { known, byDay, raw: spec };
}

// ── timezone helpers (no dependencies) ─────────────────────

const partsCache = new Map();
function formatterFor(timeZone) {
  if (!partsCache.has(timeZone)) {
    partsCache.set(
      timeZone,
      new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour12: false,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    );
  }
  return partsCache.get(timeZone);
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Calendar parts of an instant, in a timezone. */
export function partsInTz(date, timeZone = 'UTC') {
  let tz = timeZone;
  try {
    formatterFor(tz);
  } catch {
    tz = 'UTC';
  }
  const parts = formatterFor(tz).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = get('weekday');
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    weekday: WEEKDAY_INDEX[weekday] ?? 0,
  };
}

/** Build the UTC instant for a wall-clock time in a timezone. */
export function zonedToUtc(year, month, day, hour, minute, timeZone = 'UTC') {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const parts = partsInTz(new Date(guess), timeZone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const diff = target - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

export function localDateString(date, timeZone = 'UTC') {
  const p = partsInTz(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// ── the questions the bot actually asks ────────────────────

function rangesForDay(parsed, weekday) {
  return parsed.byDay?.[weekday] || [];
}

function minuteOfDay(parts) {
  return parts.hour * 60 + parts.minute;
}

function insideRange(ranges, minutes) {
  return ranges.some(({ start, end }) => {
    if (end === 1440) return minutes >= start;
    if (end <= start) return minutes >= start || minutes < end; // overnight
    return minutes >= start && minutes < end;
  });
}

/** Is this instant inside opening hours? */
export function isOpen(instant, { hours, timeZone = 'UTC' } = {}) {
  const parsed = hours?.byDay ? hours : parseHours(hours);
  const date = instant instanceof Date ? instant : new Date(instant);
  const parts = partsInTz(date, timeZone);
  const ranges = rangesForDay(parsed, parts.weekday);
  const minutes = minuteOfDay(parts);

  if (!parsed.known) return { open: true, known: false, reason: 'hours_not_set' };
  if (!ranges.length) {
    return { open: false, reason: 'closed_day', day: DAY_LABELS[parts.weekday], known: true };
  }
  if (!insideRange(ranges, minutes)) {
    return {
      open: false,
      reason: 'outside_hours',
      day: DAY_LABELS[parts.weekday],
      hours: ranges.map((r) => `${formatTime(r.start)}–${formatTime(r.end)}`),
      known: true,
    };
  }
  return { open: true, known: true };
}

/**
 * The next few times the business is actually open — offered to a customer who
 * asked for 3 a.m. or for a closed day.
 */
export function nextSlots({ hours, timeZone = 'UTC', from = new Date(), count = 3, stepMinutes = 30, minLeadMinutes = 0 } = {}) {
  const parsed = hours?.byDay ? hours : parseHours(hours);
  if (!parsed.known) return [];

  const start = from instanceof Date ? from : new Date(from);
  const earliest = start.getTime() + minLeadMinutes * 60_000;
  const slots = [];

  for (let dayOffset = 0; dayOffset < 14 && slots.length < count; dayOffset += 1) {
    const cursor = new Date(earliest + dayOffset * 24 * 3600 * 1000);
    const parts = partsInTz(cursor, timeZone);
    const ranges = rangesForDay(parsed, parts.weekday);

    for (const range of ranges) {
      const first = Math.ceil(range.start / stepMinutes) * stepMinutes;
      for (let minutes = first; minutes < Math.min(range.end, 1440); minutes += stepMinutes) {
        const when = zonedToUtc(parts.year, parts.month, parts.day, Math.floor(minutes / 60), minutes % 60, timeZone);
        if (when.getTime() < earliest) continue;
        // never suggest a time that has already gone by in the business day
        if (dayOffset === 0 && minutes < minuteOfDay(partsInTz(start, timeZone))) continue;

        const slotParts = partsInTz(when, timeZone);
        slots.push({
          date: `${slotParts.year}-${String(slotParts.month).padStart(2, '0')}-${String(slotParts.day).padStart(2, '0')}`,
          time: formatTime(minutes),
          at: when,
          label: `${DAY_LABELS[slotParts.weekday].slice(0, 3)} ${slotParts.day}/${slotParts.month}, ${formatTime(minutes)}`,
        });
        if (slots.length >= count) return slots;
      }
    }
  }

  return slots;
}

/** Human sentence for a refusal, so the bot never has to invent one. */
export function explainClosed(verdict, slots = []) {
  const offers = slots.length ? ` Next available: ${slots.map((s) => s.label).join(', ')}.` : '';
  if (verdict.reason === 'closed_day') return `We're closed on ${verdict.day}.${offers}`;
  if (verdict.reason === 'outside_hours') {
    const hours = (verdict.hours || []).join(', ');
    return `On ${verdict.day} we're open ${hours}, so that time doesn't work.${offers}`;
  }
  return `That time doesn't work.${offers}`;
}

export default { parseHours, isOpen, nextSlots, explainClosed, parseTime, formatTime, partsInTz, zonedToUtc, localDateString };
