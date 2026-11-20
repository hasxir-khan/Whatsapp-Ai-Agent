// platform/settings.js
// The settings screen, over the config that already exists.
//
// There is no second configuration system here. Every value a customer changes
// is a path inside the tenant's own `config/owner.json`, and every write goes
// through the same two things the bot uses: `validateProfile()` decides whether
// the file is legal, and `writeTenantProfile()` writes it atomically. What the
// platform adds is:
//
//   • a catalogue — paths, labels, ranges, and which plan may touch them;
//   • per-field errors, so "scope must be one of …" arrives attached to the
//     field the customer is looking at;
//   • a backup and an undo token for every write, plus one audit row that names
//     the fields and never their content;
//   • the plan gate: a setting the plan does not include is shown, disabled,
//     with the upgrade it needs.
//
// Settings that live in the tenant's `.env` (voice replies) are marked `env` and
// written with `writeTenantEnvValue`, for the same reason: it is the switch the
// bot already reads.

import { get, all, run } from './db.js';
import { randomId } from './crypto.js';
import { recordAudit } from './audit.js';
import { planForTenant } from './plans.js';
import { tenantForAccount } from './provisioning.js';
import {
  readTenantUndo, writeTenantUndo, readTenantProfile, writeTenantProfile, readTenantEnv, writeTenantEnvValue, validateTenantProfile,
} from '../src/services/adminPanel.js';
import { SCOPES, OFF_TOPIC_MODES, DEFAULTS } from '../src/services/conversation.js';
import { MAX_INTAKE_FIELDS, validateIntake, defaultIntakeFor } from '../src/core/projectIntake.js';
import { DECISION_TYPES } from '../src/services/decisionTeam.js';
import { DEFAULT_TIMING } from '../src/core/timing.js';
import { validateAgent, MAX_AGENTS, INSTRUCTIONS_MAX, AGENT_ROLES } from '../src/services/agents.js';

/** A missing profile is "not set up yet", not an exception. */
function profileOrEmpty(slug) {
  try {
    return readTenantProfile(slug) || {};
  } catch {
    return {};
  }
}

export { MAX_INTAKE_FIELDS };
export const AGENT_INSTRUCTIONS_MAX = INSTRUCTIONS_MAX;
export const UNDO_LIMIT = 20;

const clone = (value) => JSON.parse(JSON.stringify(value ?? {}));
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function getPath(object, dotted) {
  return String(dotted || '')
    .split('.')
    .filter(Boolean)
    .reduce((node, part) => (node == null ? undefined : node[/^\d+$/.test(part) ? Number(part) : part]), object);
}

export function setPath(object, dotted, value) {
  const parts = String(dotted || '').split('.').filter(Boolean);
  let node = object;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (!isObject(node[part]) && !Array.isArray(node[part])) {
      node[part] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    node = node[part];
  }
  const last = parts[parts.length - 1];
  node[/^\d+$/.test(last) ? Number(last) : last] = value;
  return object;
}

/**
 * The catalogue. `requires` names the plan feature (or `voice` for the minutes
 * limit) that must be present before the setting can be changed.
 */
export const SETTINGS = [
  // ── conversation control ──────────────────────────────────
  { id: 'conversation.scope', path: 'business.conversation.scope', group: 'conversation', label: 'What it talks about', type: 'enum', options: SCOPES, requires: 'conversationControl' },
  { id: 'conversation.offTopic', path: 'business.conversation.offTopic', group: 'conversation', label: 'Off-topic messages', type: 'enum', options: OFF_TOPIC_MODES, requires: 'conversationControl' },
  { id: 'conversation.warningsBeforeStop', path: 'business.conversation.warningsBeforeStop', group: 'conversation', label: 'Warnings before it stops', type: 'int', min: 0, max: 5, requires: 'conversationControl' },
  { id: 'conversation.abuseLimit', path: 'business.conversation.abuseLimit', group: 'conversation', label: 'Insults before a cool-down', type: 'int', min: 1, max: 10, requires: 'conversationControl' },
  { id: 'conversation.coolDownMinutes', path: 'business.conversation.coolDownMinutes', group: 'conversation', label: 'Cool-down length (minutes)', type: 'int', min: 5, max: 1440, requires: 'conversationControl' },
  { id: 'conversation.maxSentences', path: 'business.conversation.maxSentences', group: 'conversation', label: 'Longest reply (sentences)', type: 'int', min: 1, max: 6, requires: 'conversationControl' },
  { id: 'conversation.languageMatching', path: 'business.conversation.languageMatching', group: 'conversation', label: 'Reply in the customer’s language', type: 'bool', requires: 'conversationControl' },
  { id: 'conversation.dailyMessageCap', path: 'business.conversation.dailyMessageCap', group: 'conversation', label: 'Messages per person per day', type: 'int', min: 1, max: 500, requires: 'conversationControl' },
  { id: 'conversation.maxBotTurnsBeforeHuman', path: 'business.conversation.maxBotTurnsBeforeHuman', group: 'conversation', label: 'Bot turns before offering a human', type: 'int', min: 1, max: 200, requires: 'conversationControl' },
  { id: 'conversation.handoverKeywords', path: 'business.conversation.handover.keywords', group: 'conversation', label: 'Words that mean “get me a person”', type: 'list', maxItems: 20, requires: 'conversationControl' },
  { id: 'conversation.approvalRequired', path: 'business.conversation.approvalRequired', group: 'conversation', label: 'Actions that need your yes', type: 'list', options: ['refund', 'discount', 'booking', 'order', 'cancellation'], maxItems: 10, requires: 'conversationControl' },
  { id: 'voice.mode', path: 'VOICE_REPLY_MODE', group: 'conversation', label: 'Voice replies', type: 'enum', options: ['off', 'match_voice'], env: true, requires: 'voice' },
  { id: 'conversation.replyTiming', path: 'business.tone.replyTiming', group: 'conversation', label: 'Reply timing (ms)', type: 'timing' },

  // ── intake ────────────────────────────────────────────────
  { id: 'intake.fields', path: 'business.intake.fields', group: 'intake', label: 'Questions it asks', type: 'fields' },
  { id: 'intake.required', path: 'business.intake.required', group: 'intake', label: 'Answers it must have', type: 'list', maxItems: MAX_INTAKE_FIELDS },

  // ── team and escalations ──────────────────────────────────
  { id: 'decisions.team', path: 'business.decisions.team.members', group: 'team', label: 'Your team', type: 'team', requires: 'multiAgent' },
  { id: 'decisions.chains', path: 'business.decisions.chains', group: 'team', label: 'Who decides what', type: 'chains', requires: 'multiAgent' },
  { id: 'decisions.enabledTypes', path: 'business.decisions.enabledTypes', group: 'team', label: 'Decisions that come to you', type: 'list', options: DECISION_TYPES, maxItems: 10, requires: 'multiAgent' },

  // ── payment ───────────────────────────────────────────────
  { id: 'payment.account', path: 'business.payment.account', group: 'payment', label: 'Account number', type: 'string', maxLength: 34 },
  { id: 'payment.accountTail', path: 'business.payment.accountTail', group: 'payment', label: 'Last digits customers see', type: 'string', maxLength: 6 },
  { id: 'payment.accountName', path: 'business.payment.accountName', group: 'payment', label: 'Account title', type: 'string', maxLength: 80 },
  { id: 'payment.rejectReasons', path: 'business.payment.rejectReasons', group: 'payment', label: 'Why a payment gets rejected', type: 'reasons' },
  { id: 'payment.retentionDays', path: 'business.decisions.proofs.retentionDays', group: 'payment', label: 'Keep payment screenshots (days)', type: 'int', min: 1, max: 365 },

  // ── business ──────────────────────────────────────────────
  { id: 'business.hours', path: 'business.hours', group: 'business', label: 'Opening hours', type: 'string', maxLength: 200 },
  { id: 'business.city', path: 'business.city', group: 'business', label: 'City', type: 'string', maxLength: 80 },
];

const BY_ID = new Map(SETTINGS.map((s) => [s.id, s]));

export function settingById(id) {
  return BY_ID.get(String(id || '')) || null;
}

function entitlement(slug) {
  const found = planForTenant(slug);
  const plan = found?.plan || null;
  return {
    planId: plan?.id || null,
    planName: plan?.name || null,
    features: new Set(plan?.features || []),
    voiceMinutes: Number(plan?.limits?.voice_minutes || 0),
  };
}

function gateFor(setting, ent) {
  if (!setting?.requires) return null;
  if (setting.requires === 'voice') {
    if (ent.voiceMinutes > 0) return null;
    return {
      reason: 'plan',
      message: `Voice replies are not on the ${ent.planName || 'Free'} plan. Upgrade to turn them on.`,
      upgradeTo: 'Starter',
    };
  }
  if (ent.features.has(setting.requires)) return null;
  return {
    reason: 'plan',
    message: `This setting belongs to the ${setting.requires} feature, which is not on the ${ent.planName || 'Free'} plan.`,
    upgradeTo: 'Growth',
  };
}

// ── intake helpers ──────────────────────────────────────────
/** Starter questions per business type — a starting point, not a rule. */
export function intakeDefaults(template) { return defaultIntakeFor(template); }

export function validateIntakeFields(fields) {
  if (!Array.isArray(fields)) return ['Expected a list of questions.'];
  const { errors } = validateIntake({ fields });
  if (errors.length) return errors;
  const seen = new Set();
  for (const [index, f] of fields.entries()) {
    if (!String(f.ask || '').trim() || !String(f.label || '').trim()) errors.push(`Question ${index + 1} needs a label and a prompt.`);
    if (f.askIf != null) {
      const c = f.askIf;
      if (!isObject(c) || !seen.has(c.field) || !(typeof c.equals === 'string' || typeof c.includes === 'string')) {
        errors.push(`Question ${index + 1}: askIf must name an earlier field and a value to match (equals or includes).`);
      }
    }
    seen.add(f.id);
  }
  return errors;
}

function validateReasons(value) {
  if (!isObject(value)) return ['business.payment.rejectReasons must be an object'];
  const errors = [];
  for (const [reason, messages] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(reason)) errors.push(`reject reason "${reason}" must be lower_snake_case`);
    if (!isObject(messages)) {
      errors.push(`reject reason "${reason}" needs per-language messages`);
      continue;
    }
    for (const [lang, text] of Object.entries(messages)) {
      if (!['en', 'ur', 'roman-ur'].includes(lang)) errors.push(`reject reason "${reason}": unknown language "${lang}"`);
      if (typeof text !== 'string' || !text.trim()) errors.push(`reject reason "${reason}" (${lang}) needs text`);
      if (String(text).length > 240) errors.push(`reject reason "${reason}" (${lang}) is longer than 240 characters`);
    }
  }
  return errors;
}

function coerce(setting, value) {
  if (setting.type === 'int') {
    const n = Number(value);
    if (value === '' || !Number.isInteger(n)) return { error: `${setting.label} must be a number` };
    if (n < setting.min || n > setting.max) return { error: `${setting.label} must be between ${setting.min} and ${setting.max}` };
    return { value: Math.round(n) };
  }
  if (setting.type === 'bool') {
    if (typeof value === 'boolean') return { value };
    if (['true', '1', 'yes', 'on'].includes(String(value).toLowerCase())) return { value: true };
    if (['false', '0', 'no', 'off'].includes(String(value).toLowerCase())) return { value: false };
    return { error: `${setting.label} must be true or false` };
  }
  if (setting.type === 'enum') {
    const wanted = String(value || '').trim();
    if (!setting.options.includes(wanted)) return { error: `${setting.label} must be one of ${setting.options.join(', ')}` };
    return { value: wanted };
  }
  if (setting.type === 'list') {
    const list = Array.isArray(value) ? value : String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (setting.maxItems && list.length > setting.maxItems) return { error: `${setting.label}: at most ${setting.maxItems} entries` };
    if (setting.options) {
      const bad = list.filter((item) => !setting.options.includes(String(item)));
      if (bad.length) return { error: `${setting.label}: unknown ${bad.join(', ')}. Allowed: ${setting.options.join(', ')}` };
    }
    return { value: list.map((item) => String(item).trim()).filter(Boolean) };
  }
  if (setting.type === 'string') {
    const text = String(value ?? '').trim();
    if (setting.maxLength && text.length > setting.maxLength) return { error: `${setting.label} is longer than ${setting.maxLength} characters` };
    return { value: text };
  }
  return { value };
}

// ── reading ─────────────────────────────────────────────────
export function readSettings(slug) {
  const profile = profileOrEmpty(slug);
  const env = readTenantEnv(slug);
  const ent = entitlement(slug);
  const groups = new Map();

  for (const setting of SETTINGS) {
    const gate = gateFor(setting, ent);
    let value = setting.env ? env[setting.path] ?? 'off' : getPath(profile, setting.path);
    if (setting.id === 'conversation.replyTiming') {
      const timing = { ...DEFAULT_TIMING, ...profile.tone?.replyTiming, ...value };
      value = { targetMinMs: timing.targetMinMs, targetMaxMs: timing.targetMaxMs };
    } else if (setting.path.startsWith('business.conversation.')) value ??= getPath(DEFAULTS, setting.path.slice('business.conversation.'.length));
    else if (setting.group === 'intake') value ??= getPath(profile, setting.id);
    const group = groups.get(setting.group) || { id: setting.group, entries: [] };
    group.entries.push({
      id: setting.id,
      label: setting.label,
      type: setting.type,
      value: value === undefined ? null : value,
      options: setting.options || null,
      min: setting.min ?? null,
      max: setting.max ?? null,
      maxLength: setting.maxLength || null,
      maxItems: setting.maxItems || null,
      disabled: !!gate,
      gate,
    });
    groups.set(setting.group, group);
  }

  // Agents are their own list: add/remove is a different operation from "set a
  // value", so they are read from the array rather than addressed by path.
  const agents = Array.isArray(profile.agents) ? profile.agents : [];
  const agentGate = gateFor({ requires: 'multiAgent' }, ent);
  groups.set('agents', {
    id: 'agents',
    entries: agents.slice(0, MAX_AGENTS).map((agent, index) => ({
      id: `agents.${index}`,
      label: agent?.name || agent?.id || `Agent ${index + 1}`,
      type: 'agent',
      value: {
        id: agent?.id || null,
        name: agent?.name || null,
        role: agent?.role || 'custom',
        enabled: agent?.enabled === true,
        instructions: agent?.instructions || '',
        persona: agent?.persona || '',
        hours: agent?.hours || '',
        handoff: agent?.handoff || '',
      },
      disabled: !!agentGate,
      gate: agentGate,
    })),
  });

  return {
    slug,
    plan: { id: ent.planId, name: ent.planName },
    groups: [...groups.values()],
    intakePreset: intakeDefaults(get('SELECT template FROM tenants WHERE slug = ?', [slug])?.template),
    agentRoles: AGENT_ROLES,
    limits: { intakeFields: MAX_INTAKE_FIELDS, agents: MAX_AGENTS, instructions: AGENT_INSTRUCTIONS_MAX },
  };
}

// ── writing ─────────────────────────────────────────────────
function pruneUndo(slug) {
  const rows = all('SELECT id FROM settings_undo WHERE slug = ? ORDER BY created_at DESC, id DESC', [String(slug)]);
  for (const row of rows.slice(UNDO_LIMIT)) run('DELETE FROM settings_undo WHERE id = ?', [row.id]);
}

/**
 * Write a set of settings in one go.
 *
 * @param {object} input
 * @param {object} input.patch `{settingId | profile.path: value}` — an id from the
 *   catalogue, or a literal path for agents (`agents.0.enabled`).
 */
export function applySettings({ slug, accountId = null, patch = {}, ip = null, now = Date.now() } = {}) {
  const membership = tenantForAccount(accountId, slug);
  if (!membership) return { ok: false, status: 404, error: 'not_found' };
  if (membership.member_role !== 'owner') {
    return { ok: false, status: 403, error: 'owner_only', message: 'Staff accounts can look at the settings, not change them.' };
  }

  if (!isObject(patch) || !Object.keys(patch).length) return { ok: false, status: 400, error: 'nothing_to_change' };
  const current = profileOrEmpty(slug);
  if (!Object.keys(current).length) return { ok: false, status: 409, error: 'profile_missing' };
  const ent = entitlement(slug), next = clone(current), env = readTenantEnv(slug);
  const edits = [], errors = [];
  for (const [id, input] of Object.entries(patch)) {
    const agent = /^agents\.(\d+)\.(enabled|name|role|persona|instructions|hours|handoff)$/.exec(id);
    const setting = settingById(id) || SETTINGS.find((s) => s.path === id) || (agent && {
      id, path: id, requires: 'multiAgent', label: agent[2], type: agent[2] === 'enabled' ? 'bool' : agent[2] === 'role' ? 'enum' : 'string', options: AGENT_ROLES,
    });
    const reject = (message) => errors.push({ field: id, message });
    if (!setting) { reject('Unknown setting.'); continue; }
    const gate = gateFor(setting, ent);
    if (gate) return { ok: false, status: 403, error: 'plan_disallowed', field: id, ...gate };
    if (agent && (!next.agents?.[Number(agent[1])] || Number(agent[1]) >= MAX_AGENTS)) { reject('No such agent.'); continue; }
    let { value, error } = coerce(setting, input);
    if (error) { reject(error); continue; }
    if (setting.type === 'fields') validateIntakeFields(value).forEach(reject);
    if (setting.type === 'reasons') validateReasons(value).forEach(reject);
    if (setting.type === 'timing') {
      const lo = value?.targetMinMs, hi = value?.targetMaxMs;
      if (![lo,hi].every(Number.isInteger) || lo < 0 || hi > 60000 || hi < lo) { reject('Set a targetMinMs and targetMaxMs between 0 and 60000, minimum first.'); continue; }
      value = { ...getPath(next, setting.path), targetMinMs: lo, targetMaxMs: hi };
    }
    // Be careful not to retain a whole .env or a snapshot of unrelated fields.
    if (edits.some((e) => e.path === setting.path)) { reject('Setting specified twice.'); continue; }
    const before = setting.env ? env[setting.path] : getPath(current, setting.path);
    if (setting.env) value = String(value);
    else setPath(next, setting.path, value);
    if (agent) validateAgent(next.agents[Number(agent[1])]).errors.forEach(reject);
    edits.push({ id: setting.id, path: setting.path, env: !!setting.env, value, before });
  }
  if (errors.length) return { ok: false, status: 400, error: 'invalid', errors };
  if (edits.some((e) => e.id.startsWith('intake.'))) {
    const fields = next.business?.intake?.fields || next.intake?.fields || [];
    for (const id of next.business?.intake?.required || []) if (!Array.isArray(fields) || !fields.some((f) => f?.id === id)) errors.push({ field: 'intake.required', message: `Unknown question: ${id}` });
  }
  if (errors.length) return { ok: false, status: 400, error: 'invalid', errors };
  const token = randomId(12),
    applied = edits.map((e) => e.id);
  try {
    writeTenantUndo(slug, token, JSON.stringify(edits));
  } catch {
    return { ok: false, status: 409, error: 'tenant_files_unavailable' };
  }
  const written = persist(slug, current, next, edits);
  if (!written.ok) return written;
  run('INSERT INTO settings_undo (id,slug,token,before,changed,account_id,created_at) VALUES (?,?,?,?,?,?,?)',
    [randomId(12), slug, token, 'tenant-backup', JSON.stringify(applied), accountId, new Date(now).toISOString()]);
  pruneUndo(slug);
  recordAudit({ action: 'settings_changed', accountId, tenant: slug, ip, detail: { fields: applied } });
  return { ok: true, applied, warnings: written.warnings, backup: written.backup, undoToken: token, restartRequired: true };
}

function persist(slug, current, next, edits) {
  const { errors } = validateTenantProfile(slug, next);
  const invalid = (messages) => ({ ok: false, status: 400, error: 'invalid', errors: messages.map((message) => ({ field: fieldForMessage(message), message })) });
  if (errors.length) return invalid(errors);
  const done = [];
  try {
    // Profile replacement is atomic. If the final write fails, restore any
    // preceding env switches, so a failed patch does not half-apply.
    for (const e of edits.filter((e) => e.env)) { writeTenantEnvValue(slug, e.path, e.value ?? ''); done.push(e); }
    const written = writeTenantProfile(slug, next, { backup: true });
    if (!written.ok) throw new Error('profile_rejected');
    return written;
  } catch {
    for (const e of done.reverse()) writeTenantEnvValue(slug, e.path, e.before ?? '');
    return { ok: false, status: 409, error: 'tenant_files_unavailable' };
  }
}

export function undoSettings({ slug, accountId, token, ip = null } = {}) {
  const t = tenantForAccount(accountId, slug);
  if (!t) return { ok: false, status: 404, error: 'not_found' };
  if (t.member_role !== 'owner') return { ok: false, status: 403, error: 'owner_only' };
  const row = get('SELECT * FROM settings_undo WHERE slug = ? AND undone_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1', [slug]);
  if (!row || (token && token !== row.token)) return { ok: false, status: 409, error: 'not_latest_change' };
  const current = profileOrEmpty(slug), next = clone(current), env = readTenantEnv(slug), ent = entitlement(slug);
  let edits;
  try {
    edits = row.before === 'tenant-backup' ? readTenantUndo(slug, row.token) : JSON.parse(row.before);
  } catch {
    return { ok: false, status: 409, error: 'backup_unavailable' };
  }
  for (const e of edits) {
    const gate = gateFor(settingById(e.id) || { requires: 'multiAgent' }, ent);
    if (gate) return { ok: false, status: 403, error: 'plan_disallowed', ...gate };
    const actual = e.env ? env[e.path] : getPath(current, e.path);
    if (JSON.stringify(actual) !== JSON.stringify(e.value)) return { ok: false, status: 409, error: 'setting_changed_since' };
    if (!e.env) setPath(next, e.path, e.before); // JSON serialisation omits an absent property
  }
  const result = persist(slug, current, next, edits.map((e) => ({ ...e, value: e.before, before: e.value })));
  if (!result.ok) return result;
  run('UPDATE settings_undo SET undone_at = ? WHERE id = ?', [new Date().toISOString(), row.id]);
  recordAudit({ action: 'settings_undone', tenant: slug, accountId, ip, detail: { fields: edits.map((e) => e.id) } });
  return { ok: true, restartRequired: true };
}

/** Best-effort mapping from a validator message to the field it is about. */
export function fieldForMessage(message) {
  const text = String(message || '');
  const agent = text.match(/^([a-z0-9_-]+):/i);
  if (agent && /instructions|persona|hours|role/.test(text)) return `agents.${agent[1]}`;
  const known = [
    ['business.conversation.', 'conversation.'],
    ['business.intake.', 'intake.'],
    ['business.decisions.', 'decisions.'],
    ['business.payment.', 'payment.'],
    ['business.hours', 'business.hours'],
    ['business.city', 'business.city'],
    ['intake.fields', 'intake.fields'],
    ['intake.required', 'intake.required'],
  ];
  for (const [prefix, replacement] of known) {
    if (text.includes(prefix)) {
      const tail = text.split(prefix)[1]?.split(/[\s,]/)[0] || '';
      return (replacement + tail).replace(/\.+$/, '');
    }
  }
  return null;
}

export default {
  SETTINGS,
  MAX_INTAKE_FIELDS,
  AGENT_INSTRUCTIONS_MAX,
  settingById,
  readSettings,
  applySettings,
  undoSettings,
  intakeDefaults,
  validateIntakeFields,
  fieldForMessage,
  getPath,
  setPath,
};
