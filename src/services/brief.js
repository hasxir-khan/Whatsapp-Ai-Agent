// src/services/brief.js
// `.brief <number>` — what we understood, what is still missing, what to ask next.
//
// This is a *view* of the intake state, not a second collector: the fields, the
// next question and the completeness all come from projectIntake.js, which the
// conversation already writes. Nothing here can invent an answer, and nothing
// is stored: a brief is generated from the row that exists.
//
// Two things it deliberately does NOT do:
//   • it never prints a price or a timeline the owner did not publish. If a
//     budget is missing it says so; if the client stated a budget it is quoted
//     back as *their* words, labelled as such.
//   - it never includes a sensitive field's value in the owner message unless
//     the owner asked for the brief (the command itself is owner-only), and it
//     never writes one into the event log.

import { get, all } from '../utils/db.js';
import { getState, intakeSpec, missingFields, completeness, nextField } from '../core/projectIntake.js';

export const STALL_HOURS_DEFAULT = 6;

const isBlank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const clean = (v) => String(Array.isArray(v) ? v.join(', ') : v).replace(/\s+/g, ' ').trim();

/**
 * The brief for one contact.
 * @returns {{number:string, fields:Array, missing:Array, openQuestions:string[],
 *            complete:boolean, stalled:boolean, stage:string, percent:number}}
 */
export function briefFor(number, { now = new Date(), stallHours = STALL_HOURS_DEFAULT } = {}) {
  const state = getState(number);
  const spec = intakeSpec();
  const fields = spec.fields.map((f) => ({
    id: f.id,
    label: f.label,
    required: spec.required.includes(f.id),
    sensitive: f.sensitive === true,
    value: isBlank(state.fields[f.id]) ? null : clean(state.fields[f.id]),
  }));
  const missing = missingFields(state);
  const next = nextField(state);
  const percent = Math.round(completeness(state) * 100);
  const updatedAt = state.updatedAt ? new Date(state.updatedAt) : null;
  const stalled = Boolean(updatedAt) && now.getTime() - updatedAt.getTime() > stallHours * 3600_000;

  const openQuestions = [];
  if (next) {
    openQuestions.push(`Next question: ${spec.asks[next] || spec.labels[next]}`);
  }
  for (const m of missing) {
    if (m.id === next) continue;
    openQuestions.push(`${m.required ? 'Required' : 'Optional'}: ${m.label}`);
  }
  if (state.quote) openQuestions.push('A price was already sent — do not quote a different range.');

  return {
    number: String(number),
    fields,
    missing,
    openQuestions: openQuestions.slice(0, 12),
    complete: missing.filter((m) => m.required).length === 0 && !next,
    stalled,
    stage: state.stage,
    percent,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    source: spec.source,
  };
}

/** The markdown the owner reads. Labelled by the business type where it helps. */
export function briefMarkdown(number, { now = new Date(), stallHours = STALL_HOURS_DEFAULT, businessType = null } = {}) {
  const brief = briefFor(number, { now, stallHours });
  const title = businessType ? `${businessType} brief` : 'Brief';
  const lines = [`# ${title} — ${brief.number}`, ''];

  lines.push(`Status: ${brief.complete ? 'complete' : 'in progress'} · ${brief.percent}% · stage ${brief.stage}`);
  if (brief.updatedAt) lines.push(`Last updated: ${brief.updatedAt}`);
  if (brief.stalled) lines.push(`⚠️ Stalled: nothing new for more than ${stallHours} h.`);
  lines.push('');

  lines.push('## Collected');
  const filled = brief.fields.filter((f) => f.value !== null);
  if (!filled.length) lines.push('_Nothing yet._');
  for (const f of filled) {
    // A sensitive value is labelled, so the owner knows what they are reading.
    lines.push(`- **${f.label}**${f.sensitive ? ' _(sensitive)_' : ''}: ${f.value}`);
  }
  lines.push('');

  lines.push('## Missing information');
  if (!brief.missing.length) lines.push('_Nothing — every field is answered._');
  for (const m of brief.missing) lines.push(`- ${m.label}${m.required ? ' **(required)**' : ''}`);

  if (brief.openQuestions.length) {
    lines.push('', '## Open questions');
    for (const q of brief.openQuestions) lines.push(`- ${q}`);
  }

  lines.push('', '---', '_Generated from the intake row. No price or timeline is stated here unless the owner published one._');
  return lines.join('\n');
}

/** One line for a notification, so the owner does not have to open anything. */
export function briefSummaryLine(number, { now = new Date() } = {}) {
  const brief = briefFor(number, { now });
  const filled = brief.fields.filter((f) => f.value !== null).length;
  return `📋 Brief ready for +${number} — ${filled}/${brief.fields.length} fields, ${brief.percent}%${brief.missing.length ? `, still missing ${brief.missing.slice(0, 3).map((m) => m.label).join(', ')}` : ', complete'}`;
}

// ── when to send one ────────────────────────────────────────
/**
 * A brief goes to the owner when the required fields are done, or when the
 * conversation has been stalled for N hours. The second case is the one that
 * matters: a client who answered four of nine questions and went quiet is
 * exactly who the owner should call.
 */
export function briefDue(number, { now = new Date(), stallHours = STALL_HOURS_DEFAULT } = {}) {
  const brief = briefFor(number, { now, stallHours });
  if (brief.complete) return { due: true, because: 'complete', brief };
  if (brief.stalled && brief.fields.some((f) => f.value !== null)) return { due: true, because: 'stalled', brief };
  return { due: false, because: null, brief };
}

const sentKey = (number) => `brief_sent:${number}`;

export function briefAlreadySent(number) {
  try {
    return Boolean(get("SELECT id FROM events WHERE type = 'brief_sent' AND number = ? ORDER BY id DESC LIMIT 1", [String(number)]));
  } catch {
    return false;
  }
}

/** Intake rows worth a look, for `.brief` with no argument. */
export function openBriefs({ limit = 10 } = {}) {
  try {
    return all('SELECT number, stage, updated_at FROM intake ORDER BY updated_at DESC LIMIT ?', [Math.max(1, Math.min(50, limit))]);
  } catch {
    return [];
  }
}

export default {
  STALL_HOURS_DEFAULT,
  briefAlreadySent,
  briefDue,
  briefFor,
  briefMarkdown,
  briefSummaryLine,
  openBriefs,
};
