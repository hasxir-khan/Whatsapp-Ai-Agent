/**
 * Who may answer an owner decision — and in what order they are asked.
 *
 * Two blocks in owner.json back this file:
 *
 *   business.decisions.team.members = [
 *     { "name": "Ayesha", "number": "923001112233", "roles": ["view", "payments"], "hours": "09:00-21:00" }
 *   ]
 *   business.decisions.chains = {
 *     "payment": [{ "who": "owner", "afterMinutes": 0 }, { "who": "923001112233", "afterMinutes": 15 }]
 *   }
 *
 * The owner is always first and always allowed. A member only sees what their
 * roles allow: `payments` may answer a payment, `discounts` may answer a
 * discount above the cap, `admin` may reverse a decision. Nobody here can
 * accept money on the customer's behalf — that is a different, human act.
 */
import { config } from '../config/env.js';

/** Roles a teammate can hold. `view` reads, `chat` replies, `payments` and
 * `discounts` decide, `admin` may also reverse a decision. */
export const DECISION_ROLES = ['view', 'chat', 'payments', 'discounts', 'admin'];

/** Every decision type the engine understands. The first three are fully
 * implemented; the rest run on the same machinery and are enabled by config. */
export const DECISION_TYPES = [
  'payment',
  'discount_above_cap',
  'refund',
  'custom_quote',
  'cancellation',
  'delivery_exception',
  'other',
];

/** Types that are wired end to end today. */
export const READY_TYPES = ['payment', 'discount_above_cap', 'refund'];

/** Which role answers which type. Admin answers everything. */
const TYPE_ROLE = {
  payment: 'payments',
  refund: 'payments',
  discount_above_cap: 'discounts',
  custom_quote: 'discounts',
  cancellation: 'chat',
  delivery_exception: 'chat',
  other: 'chat',
};

/** Default reminder ladder for the owner, in minutes. 15 min, 1 h, 3 h. */
export const DEFAULT_REMINDER_MINUTES = [15, 60, 180];

/** Never more than this many nudges a day, however long it stays open. */
export const DEFAULT_MAX_REMINDERS = 4;

/** Team size with no plan entitlement is capped here. */
export const DEFAULT_TEAM_LIMIT = 10;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const digits = (v) => String(v || '').replace(/\D/g, '');

/** `92300…` (or `+92 300 …`) to a bare number, or '' when it is not one. */
export function normalizeMemberNumber(value) {
  const n = digits(value);
  if (n.length < 8 || n.length > 15) return '';
  return n;
}

function ownerNumber() {
  return digits(config.owner?.number);
}

/** The current settings block, normalised. Missing pieces become defaults, so a
 * half-written owner.json still runs instead of throwing. */
export function decisionSettings(profileObj = config.owner?.profile || {}) {
  const raw = isObject(profileObj?.business?.decisions) ? profileObj.business.decisions : {};
  const team = isObject(raw.team) ? raw.team : {};
  const members = (Array.isArray(team.members) ? team.members : [])
    .map((m) => normalizeMember(m))
    .filter((m) => m.number);

  const reminders = (Array.isArray(raw.reminderMinutes) ? raw.reminderMinutes : DEFAULT_REMINDER_MINUTES)
    .map((n) => Math.round(Number(n)))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const maxReminders = Math.min(10, Math.max(1, Math.round(Number(raw.maxRemindersPerDay) || DEFAULT_MAX_REMINDERS)));

  const chains = {};
  const rawChains = isObject(raw.chains) ? raw.chains : {};
  for (const type of DECISION_TYPES) {
    chains[type] = normalizeChain(rawChains[type], type, members);
  }
  // A member who cannot decide a type is never put first on its chain.
  const enabledTypes = (Array.isArray(raw.enabledTypes) ? raw.enabledTypes : READY_TYPES)
    .map((t) => String(t).toLowerCase())
    .filter((t) => DECISION_TYPES.includes(t));

  const proofs = isObject(raw.proofs) ? raw.proofs : {};

  return {
    members,
    chains,
    enabledTypes: enabledTypes.length ? enabledTypes : [...READY_TYPES],
    reminderMinutes: reminders.length ? reminders : [...DEFAULT_REMINDER_MINUTES],
    maxRemindersPerDay: maxReminders,
    maxProofsPerDay: Math.max(1, Math.round(Number(proofs.maxPerDay) || 5)),
    retentionDays: Math.max(1, Math.round(Number(proofs.retentionDays) || 90)),
    expectedResponseMinutes: Number(raw.expectedResponseMinutes) > 0 ? Math.round(Number(raw.expectedResponseMinutes)) : null,
    // Keep the money side of a forgotten customer's orders (accounting needs it)
    // while removing everything that names them.
    anonymiseOnForget: raw.anonymiseOnForget === true,
    source: raw,
  };
}

function normalizeMember(raw) {
  if (!isObject(raw)) return { name: '', number: '', roles: [], hours: null };
  const roles = (Array.isArray(raw.roles) ? raw.roles : raw.role ? [raw.role] : ['view'])
    .map((r) => String(r).toLowerCase())
    .filter((r) => DECISION_ROLES.includes(r));
  return {
    name: String(raw.name || '').trim().slice(0, 40),
    number: normalizeMemberNumber(raw.number),
    roles: [...new Set(roles.length ? roles : ['view'])],
    hours: typeof raw.hours === 'string' && /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(raw.hours.trim())
      ? raw.hours.trim()
      : null,
  };
}

function normalizeChain(rawChain, type, members) {
  const steps = [];
  if (Array.isArray(rawChain)) {
    for (const step of rawChain) {
      if (!isObject(step)) continue;
      const who = step.who === 'owner' ? 'owner' : normalizeMemberNumber(step.who);
      if (!who) continue;
      if (who !== 'owner' && !members.some((m) => m.number === who)) continue;
      steps.push({ who, afterMinutes: Math.max(0, Math.round(Number(step.afterMinutes) || 0)) });
    }
  }
  if (!steps.length) steps.push({ who: 'owner', afterMinutes: 0 });
  if (steps[0].who !== 'owner') steps.unshift({ who: 'owner', afterMinutes: 0 });
  return steps;
}

/** How many members this tenant may have: plan entitlement first, then the cap. */
export function teamLimit() {
  const raw =
    Number(config.tenant?.teamLimit) ||
    Number(config.limits?.teamMembers) ||
    Number(process.env.TEAM_MAX_MEMBERS) ||
    DEFAULT_TEAM_LIMIT;
  return Math.max(1, Math.round(raw));
}

/** The owner, then the members — one list the commands can print. */
export function teamRoster({ profileObj = null } = {}) {
  const s = decisionSettings(profileObj || config.owner?.profile || {});
  return [
    {
      who: 'owner',
      name: config.owner?.name || 'Owner',
      number: ownerNumber(),
      roles: [...DECISION_ROLES],
      hours: null,
      isOwner: true,
    },
    ...s.members.map((m) => ({ ...m, who: m.number, isOwner: false })),
  ];
}

/** The member record for a number, or null. The owner is handled separately. */
export function memberFor(number, { profileObj = null } = {}) {
  const n = normalizeMemberNumber(number);
  if (!n) return null;
  const s = decisionSettings(profileObj || config.owner?.profile || {});
  return s.members.find((m) => m.number === n) || null;
}

/** Does this person hold a role? The owner holds every role. */
export function canAct(number, role, { profileObj = null } = {}) {
  const n = normalizeMemberNumber(number);
  if (!n) return false;
  if (n === ownerNumber()) return true;
  const member = memberFor(n, { profileObj });
  if (!member) return false;
  if (member.roles.includes('admin')) return true;
  return member.roles.includes(role);
}

/** May this person decide this type of request? */
export function canDecide(number, type, { profileObj = null } = {}) {
  const role = TYPE_ROLE[type] || 'chat';
  return canAct(number, role, { profileObj });
}

/** The chain for a type: who, and how many minutes after the request opened. */
export function chainFor(type, { profileObj = null } = {}) {
  const s = decisionSettings(profileObj || config.owner?.profile || {});
  return s.chains[type] || [{ who: 'owner', afterMinutes: 0 }];
}

/** Everyone who should see the card when a request opens: the whole chain. */
export function chainRecipients(type, { profileObj = null } = {}) {
  const s = decisionSettings(profileObj || config.owner?.profile || {});
  const numbers = new Set([ownerNumber()]);
  for (const step of s.chains[type] || []) {
    if (step.who === 'owner') numbers.add(ownerNumber());
    else numbers.add(step.who);
  }
  return [...numbers].filter(Boolean);
}

/** Is `hours` ("09:00-21:00") open at this moment, in the tenant timezone? */
export function withinWorkingHours(hours, at = new Date()) {
  if (!hours) return true;
  const [fromRaw, toRaw] = String(hours).split('-');
  const from = parseHHMM(fromRaw);
  const to = parseHHMM(toRaw);
  if (from === null || to === null) return true;
  let local;
  try {
    local = parseHHMM(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: config.timezone || 'Asia/Karachi',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
        .format(at)
    );
  } catch {
    local = at.getHours() * 60 + at.getMinutes();
  }
  if (from <= to) return local >= from && local <= to;
  // A window that wraps midnight (22:00-02:00).
  return local >= from || local <= to;
}

function parseHHMM(value) {
  const m = HHMM.exec(String(value || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// ── validation ──────────────────────────────────────────────
/**
 * Checked before every write (`.set`, `.team`, the admin panel) and by the
 * doctor. A typo is a warning; something the engine cannot run with is an error.
 */
export function validateDecisions(raw, { owner = ownerNumber(), limit = teamLimit() } = {}) {
  const errors = [];
  const warnings = [];
  if (raw === null || raw === undefined || raw === '') return { errors, warnings };
  if (!isObject(raw)) {
    errors.push('business.decisions must be an object');
    return { errors, warnings };
  }

  const known = new Set([
    'team', 'chains', 'enabledTypes', 'reminderMinutes', 'maxRemindersPerDay', 'proofs',
    'expectedResponseMinutes', 'anonymiseOnForget',
  ]);
  for (const key of Object.keys(raw)) {
    if (key.startsWith('//') || key.startsWith('_')) continue;
    if (!known.has(key)) warnings.push(`unknown setting business.decisions.${key} (ignored)`);
  }

  const team = raw.team;
  if (team !== undefined) {
    if (!isObject(team)) {
      errors.push('business.decisions.team must be an object with a members list');
    } else {
      const members = team.members;
      if (members !== undefined && !Array.isArray(members)) {
        errors.push('business.decisions.team.members must be a list');
      } else {
        const list = Array.isArray(members) ? members : [];
        if (list.length > limit) {
          errors.push(`business.decisions.team.members holds ${list.length} people; the limit is ${limit}`);
        }
        const seen = new Set();
        list.forEach((m, i) => {
          const where = `business.decisions.team.members[${i}]`;
          if (!isObject(m)) return errors.push(`${where} must be an object`);
          if (!m.name || String(m.name).trim().length < 2) errors.push(`${where}.name is required`);
          const number = normalizeMemberNumber(m.number);
          if (!number) errors.push(`${where}.number must be a phone number (8–15 digits)`);
          else if (number === owner) errors.push(`${where}.number is the owner's own number`);
          else if (seen.has(number)) errors.push(`${where}.number is used twice`);
          seen.add(number);
          const roles = Array.isArray(m.roles) ? m.roles : m.role ? [m.role] : [];
          if (!roles.length) errors.push(`${where}.roles needs at least one of ${DECISION_ROLES.join(', ')}`);
          for (const r of roles) {
            if (!DECISION_ROLES.includes(String(r).toLowerCase())) {
              errors.push(`${where}.roles has "${r}" — allowed: ${DECISION_ROLES.join(', ')}`);
            }
          }
          if (m.hours !== undefined && m.hours !== null && m.hours !== '') {
            const ok = /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(String(m.hours).trim());
            const [a, b] = String(m.hours).split('-').map((x) => parseHHMM(x));
            if (!ok || a === null || b === null) errors.push(`${where}.hours must look like 09:00-21:00`);
          }
        });
      }
    }
  }

  if (raw.chains !== undefined) {
    if (!isObject(raw.chains)) {
      errors.push('business.decisions.chains must be an object keyed by decision type');
    } else {
      for (const [type, chain] of Object.entries(raw.chains)) {
        if (!DECISION_TYPES.includes(type)) {
          warnings.push(`business.decisions.chains.${type} is not a decision type (ignored)`);
          continue;
        }
        if (!Array.isArray(chain)) {
          errors.push(`business.decisions.chains.${type} must be a list of {who, afterMinutes}`);
          continue;
        }
        let last = -1;
        chain.forEach((step, i) => {
          const where = `business.decisions.chains.${type}[${i}]`;
          if (!isObject(step)) return errors.push(`${where} must be an object`);
          if (step.who !== 'owner' && !normalizeMemberNumber(step.who)) {
            errors.push(`${where}.who must be "owner" or a member number`);
          }
          const minutes = Number(step.afterMinutes);
          if (!Number.isFinite(minutes) || minutes < 0) errors.push(`${where}.afterMinutes must be 0 or more`);
          else if (minutes < last) warnings.push(`business.decisions.chains.${type} is not in time order`);
          else last = minutes;
        });
      }
    }
  }

  if (raw.enabledTypes !== undefined) {
    if (!Array.isArray(raw.enabledTypes)) errors.push('business.decisions.enabledTypes must be a list');
    else {
      for (const t of raw.enabledTypes) {
        if (!DECISION_TYPES.includes(String(t).toLowerCase())) {
          errors.push(`business.decisions.enabledTypes has "${t}" — allowed: ${DECISION_TYPES.join(', ')}`);
        }
      }
    }
  }

  if (raw.reminderMinutes !== undefined) {
    if (!Array.isArray(raw.reminderMinutes)) errors.push('business.decisions.reminderMinutes must be a list');
    else if (raw.reminderMinutes.some((n) => !(Number(n) > 0))) errors.push('business.decisions.reminderMinutes must be positive minutes');
  }
  if (raw.maxRemindersPerDay !== undefined) {
    const n = Number(raw.maxRemindersPerDay);
    if (!Number.isInteger(n) || n < 1 || n > 10) errors.push('business.decisions.maxRemindersPerDay must be 1–10');
  }
  if (raw.expectedResponseMinutes !== undefined && raw.expectedResponseMinutes !== null) {
    const n = Number(raw.expectedResponseMinutes);
    if (!Number.isFinite(n) || n <= 0) errors.push('business.decisions.expectedResponseMinutes must be a positive number of minutes');
  }
  if (raw.anonymiseOnForget !== undefined && typeof raw.anonymiseOnForget !== 'boolean') {
    errors.push('business.decisions.anonymiseOnForget must be true or false');
  }
  if (raw.proofs !== undefined) {
    if (!isObject(raw.proofs)) errors.push('business.decisions.proofs must be an object');
    else {
      for (const [key, min, max] of [
        ['retentionDays', 1, 3650],
        ['maxPerDay', 1, 50],
      ]) {
        if (raw.proofs[key] === undefined) continue;
        const n = Number(raw.proofs[key]);
        if (!Number.isInteger(n) || n < min || n > max) errors.push(`business.decisions.proofs.${key} must be ${min}–${max}`);
      }
    }
  }

  return { errors, warnings };
}

export default {
  DECISION_ROLES,
  DECISION_TYPES,
  READY_TYPES,
  decisionSettings,
  teamLimit,
  teamRoster,
  memberFor,
  canAct,
  canDecide,
  chainFor,
  chainRecipients,
  withinWorkingHours,
  validateDecisions,
};
