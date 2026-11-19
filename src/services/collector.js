// src/services/collector.js
// The conversational half of the requirement collector.
//
// projectIntake.js already does the hard part: it extracts fields from a
// message, keeps the ones it knows, and names the single next thing to ask. What
// a client notices missing is the *politeness* of it: "that's three answers at
// once — did you get them right?", and "you said 50k earlier and 80k now, which
// one?".
//
// So this module writes two kinds of turn, in the client's language, from data
// the intake already extracted:
//
//   • a confirmation when one message filled two or more fields — one short
//     "here is what I understood … right?" and nothing else;
//   • a correction acknowledgement when the client changes an earlier answer,
//     naming what changed so they can see it landed.
//
// No model is called. The fields are the client's own words, read back.

import { intakeSpec } from '../core/projectIntake.js';

const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

// "actually", "no I meant", "sorry, it's", "galat", "درست" — a correction.
const CORRECTION =
  /\b(actually|sorry,? (i|it)|i meant|i mean|not that|correction|scratch that|instead|change (it|that|my)|update (it|that|my)|let me correct)\b/i;
const CORRECTION_ROMAN = /\b(actually|asal mein|galti se|galat|theek karta|badal (do|dein)|correction|matlab)\b/i;
const CORRECTION_URDU = /(اصل میں|غلطی|درست|بدل دیں|تصحیح)/;

export function isCorrection(text = '') {
  const clean = String(text || '');
  return CORRECTION.test(clean) || CORRECTION_ROMAN.test(clean) || CORRECTION_URDU.test(clean);
}

const label = (spec, id) => spec.labels[id] || id;
const value = (v) => {
  if (v === undefined || v === null) return '';
  return String(Array.isArray(v) ? v.join(', ') : v).replace(/\s+/g, ' ').trim().slice(0, 120);
};

const OPEN = {
  en: 'Here is what I understood:',
  'roman-ur': 'Yeh samjha main ne:',
  ur: 'میں نے یہ سمجھا:',
};
const RIGHT = {
  en: 'Is that right?',
  'roman-ur': 'Sahi hai?',
  ur: 'درست ہے؟',
};
const UPDATED = {
  en: 'Updated:',
  'roman-ur': 'Update kar diya:',
  ur: 'اپ ڈیٹ کر دیا:',
};

/**
 * The turn to send instead of a model reply, or null when the normal flow
 * should continue.
 *
 * @param {{number?:string, updates?:object, previous?:object, lang?:string, text?:string}} input
 * @returns {{kind:'confirm'|'correct', reply:string, fields:string[]}|null}
 */
export function collectorTurn({ updates = {}, previous = {}, lang = 'en', text = '' } = {}) {
  const spec = intakeSpec();
  if (!spec.ids.length) return null;
  const keys = Object.keys(updates || {}).filter((k) => spec.ids.includes(k));
  if (!keys.length) return null;

  const changed = [];
  const filled = [];
  for (const key of keys) {
    const next = value(updates[key]);
    if (!next) continue;
    const before = value(previous?.[key]);
    if (before && norm(before) !== norm(next)) changed.push({ key, before, after: next });
    else if (!before) filled.push({ key, after: next });
  }

  const correcting = isCorrection(text) || changed.length > 0;

  if (correcting && (changed.length || filled.length)) {
    const parts = [...changed.map((c) => `${label(spec, c.key)}: ${c.after}`), ...filled.map((f) => `${label(spec, f.key)}: ${f.after}`)];
    return {
      kind: 'correct',
      fields: [...changed.map((c) => c.key), ...filled.map((f) => f.key)],
      reply: `${UPDATED[lang] || UPDATED.en} ${parts.join(' · ')}. ${RIGHT[lang] || RIGHT.en}`,
    };
  }

  // Two or more answers in one message deserve reading back. One does not: it
  // would turn every message into a receipt.
  if (filled.length >= 2) {
    const parts = filled.map((f) => `${label(spec, f.key)}: ${f.after}`);
    return {
      kind: 'confirm',
      fields: filled.map((f) => f.key),
      reply: `${OPEN[lang] || OPEN.en} ${parts.join(' · ')}. ${RIGHT[lang] || RIGHT.en}`,
    };
  }

  return null;
}

/**
 * Two different answers for the same field, without a correction word: name the
 * uncertainty and ask once. ("50k" … later "80k")
 */
export function conflictTurn({ updates = {}, previous = {}, lang = 'en' } = {}) {
  const spec = intakeSpec();
  const keys = Object.keys(updates || {}).filter((k) => spec.ids.includes(k));
  for (const key of keys) {
    const before = value(previous?.[key]);
    const after = value(updates[key]);
    if (!before || !after) continue;
    if (norm(before) === norm(after)) continue;
    return {
      kind: 'conflict',
      field: key,
      reply: `${label(spec, key)}: ${before} → ${after}. ${label(spec, key)} — ${(lang === 'ur' ? 'کون سی درست ہے؟' : lang === 'roman-ur' ? 'kaun si sahi hai?' : 'which one should I use?')}`,
    };
  }
  return null;
}

/** "Here is what I understood" for a whole brief, used by the owner command. */
export function understoodAll(fields = {}, lang = 'en') {
  const spec = intakeSpec();
  const parts = spec.ids
    .filter((id) => fields?.[id] !== undefined && fields[id] !== null && String(fields[id]).trim())
    .map((id) => `${label(spec, id)}: ${value(fields[id])}`);
  if (!parts.length) return null;
  return `${OPEN[lang] || OPEN.en} ${parts.join(' · ')}.`;
}

export default { collectorTurn, conflictTurn, isCorrection, understoodAll };
