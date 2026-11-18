// src/eval/scenarioSchema.js
// The shape of a golden scenario, and the rules a scenario file has to obey
// before anyone is allowed to draw conclusions from it.
//
// Validation is deliberately strict and boring. A scenario that is malformed
// must fail loudly at load time — never quietly measure nothing.

import fs from 'node:fs';

export const TEMPLATES = ['agency', 'clinic', 'generic', 'real-estate', 'restaurant', 'salon', 'school', 'shop'];

export const CATEGORIES = [
  'price',        // price/stock answered from the catalogue
  'discount',     // price objection, and the discount ceiling
  'booking',      // valid/invalid hours, double booking
  'order',        // order flow, confirmation, duplicate confirm
  'status',       // "where is my order?"
  'complaint',    // complaint → handoff
  'rag',          // knowledge hit / miss ("check with owner")
  'injection',    // prompt injection in text, doc or receipt text
  'privacy',      // opt-out, forget, data export
  'voice',        // voice note (transcript) input
  'quiet',        // proactive message held by quiet hours / caps
  'stock',        // out of stock
  'crm',          // tags and notes are never revealed to a customer
  'source',       // a tracked link/QR brings someone in, and the marker never leaks
];

export const LANGUAGES = ['en', 'roman-ur', 'ur'];

export const TURN_KINDS = ['user', 'owner', 'action'];

export const ACTIONS = [
  'payment_reminder', // orders.runPaymentReminders at a fixed clock
  'notify_customer',  // orders.notifyCustomer for a seeded order
  'transition',       // orders.transitionOrder (actor configurable)
  'reactivation_send',// reactivationAgent.startCampaign at a fixed clock
];

export const ASSERT_KEYS = [
  'numbers', 'language', 'maxLength', 'minReplies', 'require', 'forbid',
  'events', 'ownerNotified', 'confirmations', 'sideEffects', 'optout',
  'growthHold', 'noErrorEvents', 'maxChanges',
];

const MAX_TURNS = 12;
const MAX_REPLY = 1200;

// Fake-only numbers: 92300… (Pakistan, reserved for these tests), 4477009…
// (UK Ofcom drama range) and 1555… (US fiction). Anything else is refused, so a
// real customer's number can never end up in a golden file.
const FAKE_NUMBER = /^(?:92300\d{6}|4477009\d{5}|1555\d{7})$/;

// Anything that looks like a credential. Scenarios are checked text, so these
// must simply never appear.
const KEY_SHAPED = /\b(sk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{10,}|xox[baprs]-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{10,})\b/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (isPlainObject(value)) for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

/** Every phone-shaped run of digits in a scenario body. */
export function phoneNumbersIn(value) {
  const found = new Set();
  for (const text of collectStrings(value)) {
    for (const m of text.matchAll(/(?:\+?\d[\d\s-]{7,}\d)/g)) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length >= 10 && digits.length <= 15) found.add(digits);
    }
  }
  return [...found];
}

/**
 * Validate one scenario object.
 * @returns {{ok:boolean, errors:string[], warnings:string[], scenario?:object}}
 */
export function validateScenario(raw = {}) {
  const errors = [];
  const warnings = [];
  const s = isPlainObject(raw) ? raw : {};

  if (!s.id || !/^[a-z0-9][a-z0-9-]{2,60}$/.test(String(s.id))) {
    errors.push('id must be a lowercase slug (a-z, 0-9, dashes), 3–61 characters');
  }
  if (!s.title || String(s.title).length < 8) errors.push('title must be a readable sentence (8+ characters)');
  if (!TEMPLATES.includes(s.template)) errors.push(`template must be one of: ${TEMPLATES.join(', ')}`);
  if (!CATEGORIES.includes(s.category)) errors.push(`category must be one of: ${CATEGORIES.join(', ')}`);
  if (!LANGUAGES.includes(s.language)) errors.push(`language must be one of: ${LANGUAGES.join(', ')}`);
  if (s.mode && !['deterministic', 'live', 'both'].includes(s.mode)) {
    errors.push('mode must be deterministic, live or both');
  }

  if (!Array.isArray(s.turns) || !s.turns.length) {
    errors.push('turns must be a non-empty array');
  } else if (s.turns.length > MAX_TURNS) {
    errors.push(`turns must be ${MAX_TURNS} or fewer`);
  } else {
    s.turns.forEach((turn, i) => {
      const where = `turns[${i}]`;
      if (!isPlainObject(turn)) return errors.push(`${where} must be an object`);
      // A voice note is a "user" turn with no text of its own: the words arrive
      // from the transcript, not from the file.
      if (turn.image === true) {
        if (turn.user === undefined) errors.push(`${where} is an image and must still set "user": ""`);
        if (!turn.caption || String(turn.caption).length < 3) errors.push(`${where}.caption is required for an image`);
        return;
      }
      if (turn.voice === true) {
        if (turn.user === undefined) errors.push(`${where} is a voice note and must still set "user": ""`);
        if (!turn.voiceTranscript || String(turn.voiceTranscript).length < 3) {
          errors.push(`${where}.voiceTranscript is required for a voice note`);
        }
        return;
      }
      const kinds = TURN_KINDS.filter((k) => typeof turn[k] === 'string' && turn[k].trim());
      if (kinds.length !== 1) {
        return errors.push(`${where} needs exactly one of "user", "owner" or "action"`);
      }
      if (turn.action && !ACTIONS.includes(turn.action)) {
        errors.push(`${where}.action must be one of: ${ACTIONS.join(', ')}`);
      }
      if (turn.model !== undefined) {
        if (!Array.isArray(turn.model)) return errors.push(`${where}.model must be an array of steps`);
        turn.model.forEach((step, j) => {
          if (!isPlainObject(step)) return errors.push(`${where}.model[${j}] must be an object`);
          const hasText = typeof step.text === 'string';
          const hasTool = typeof step.tool === 'string';
          if (!hasText && !hasTool) errors.push(`${where}.model[${j}] needs "text" or "tool"`);
          if (hasTool && step.args !== undefined && !isPlainObject(step.args)) {
            errors.push(`${where}.model[${j}].args must be an object`);
          }
          if (hasText && step.text.length > MAX_REPLY) {
            errors.push(`${where}.model[${j}].text is longer than ${MAX_REPLY} characters`);
          }
        });
      }
      if (turn.expect && typeof turn.expect !== 'string') errors.push(`${where}.expect must be a string (why this turn exists)`);
    });
  }

  if (s.assert !== undefined) {
    if (!isPlainObject(s.assert)) errors.push('assert must be an object');
    else {
      for (const key of Object.keys(s.assert)) {
        if (!ASSERT_KEYS.includes(key)) errors.push(`assert.${key} is not a known assertion`);
      }
      if (s.assert.maxLength !== undefined && !(Number(s.assert.maxLength) > 0)) errors.push('assert.maxLength must be a positive number');
      if (s.assert.confirmations !== undefined && !Number.isInteger(Number(s.assert.confirmations))) {
        errors.push('assert.confirmations must be an integer');
      }
      if (s.assert.maxChanges !== undefined) {
        if (!isPlainObject(s.assert.maxChanges)) errors.push('assert.maxChanges must be an object like { "orders": 1 }');
        else {
          for (const [table, n] of Object.entries(s.assert.maxChanges)) {
            if (!Number.isInteger(Number(n)) || Number(n) < 0) errors.push(`assert.maxChanges.${table} must be a whole number`);
          }
        }
      }
      if (s.assert.sideEffects && !['confirmed-only', 'none', 'allowed'].includes(s.assert.sideEffects)) {
        errors.push('assert.sideEffects must be confirmed-only, none or allowed');
      }
      if (s.assert.require !== undefined) {
        if (!Array.isArray(s.assert.require)) errors.push('assert.require must be an array');
        else {
          s.assert.require.forEach((rule, i) => {
            if (!isPlainObject(rule) || !rule.match) return errors.push(`assert.require[${i}] needs a "match" string`);
            if (rule.stream && !['customer', 'owner', 'any'].includes(rule.stream)) {
              errors.push(`assert.require[${i}].stream must be customer, owner or any`);
            }
            try {
              new RegExp(rule.match);
            } catch {
              errors.push(`assert.require[${i}].match is not a valid regular expression`);
            }
          });
        }
      }
      for (const rule of s.assert.forbid || []) {
        try {
          new RegExp(rule);
        } catch {
          errors.push(`assert.forbid contains an invalid regular expression: ${rule}`);
        }
      }
      if (s.assert.language && !LANGUAGES.includes(s.assert.language)) errors.push('assert.language must be en, roman-ur or ur');
    }
  }

  // ── fake data only ────────────────────────────────────────
  for (const number of phoneNumbersIn(s)) {
    if (!FAKE_NUMBER.test(number)) errors.push(`phone number ${number} is not from a fake range (92300…, 4477009…, 1555…)`);
  }
  for (const text of collectStrings(s)) {
    if (KEY_SHAPED.test(text)) errors.push('scenario contains something that looks like an API key');
    if (/@s\.whatsapp\.net/.test(text)) warnings.push('scenario writes a full jid; the runner adds those itself');
  }

  if (!s.assert) errors.push('assert must describe what "pass" means');

  return { ok: !errors.length, errors, warnings, scenario: s };
}

/** Load and validate every scenario file in a directory. */
export function loadScenarios(dir) {
  if (!fs.existsSync(dir)) return { ok: false, errors: [`no scenario directory at ${dir}`], scenarios: [] };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
  const scenarios = [];
  const errors = [];
  for (const file of files) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(`${dir}/${file}`, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON (${err.message})`);
      continue;
    }
    const check = validateScenario(raw);
    if (!check.ok) {
      for (const e of check.errors) errors.push(`${file}: ${e}`);
      continue;
    }
    scenarios.push({ ...raw, file });
  }
  const ids = new Set();
  for (const s of scenarios) {
    if (ids.has(s.id)) errors.push(`duplicate scenario id: ${s.id}`);
    ids.add(s.id);
  }
  return { ok: !errors.length, errors, scenarios };
}

export default { validateScenario, loadScenarios, TEMPLATES, CATEGORIES, LANGUAGES, ACTIONS };
