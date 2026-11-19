// src/services/conversation.js
// Conversation Control V1 — the owner's rules for *how* a chat is conducted,
// kept apart from what the business knows.
//
// Everything here is data: `business.conversation` in owner.json, editable with
// `.set business.conversation.scope open` or the admin panel. The defaults are
// the cautious ones, and a profile with no `business.conversation` block behaves
// exactly as it did before this feature existed.
//
// This module only reads and validates. The rules that act on the settings live
// in decision.js (what to do with a message) and abuse.js (what to do with an
// insult), so a setting can be tested without a chat and a rule can be tested
// without a profile.

import { profile, featureOn } from './profile.js';

export const SCOPES = ['business_only', 'business_plus_light_chat', 'open'];
export const OFF_TOPIC_MODES = ['redirect', 'warn_then_stop', 'ignore'];
export const ACTIONS = ['reply', 'clarify', 'redirect', 'handover', 'react', 'ignore'];

/** The cautious defaults. Anything omitted from owner.json reads as this. */
export const DEFAULTS = Object.freeze({
  scope: 'business_only',
  // What happens to "count 1 to 100" and "tell me a joke".
  offTopic: 'redirect',
  // How many redirects before warn_then_stop goes quiet (and tells the owner).
  warningsBeforeStop: 1,
  // How long "stop engaging" lasts after an insult repeats.
  coolDownMinutes: 120,
  // Boundary then stop: how many insults before the cool-down starts.
  abuseLimit: 2,
  // A reply longer than this is cut by brevity.js, which already exists.
  maxSentences: 3,
  // Reply in the language the customer wrote in.
  languageMatching: true,
  handover: {
    keywords: [],
    // "I don't understand", repeated — a person would notice by the third time.
    confusionRepeats: 3,
    angryTone: true,
  },
  // Actions that need the owner's yes before the bot does them.
  approvalRequired: ['refund'],
  // A hard ceiling on how much the bot says to one person in a day.
  dailyMessageCap: 40,
  // After this many bot turns, offer a human instead of carrying on.
  maxBotTurnsBeforeHuman: 12,
  // Let a small model classify only when the rules are unsure.
  classifier: true,
  // Ping the owner when the bot has to stay quiet.
  notifyOwner: true,
});

const int = (v, fallback, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
};

const oneOf = (v, allowed, fallback) => {
  const s = String(v ?? '').trim().toLowerCase();
  return allowed.includes(s) ? s : fallback;
};

const list = (v) =>
  Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 30) : [];

/** Is Conversation Control on? Off means every old code path, unchanged. */
export function controlEnabled() {
  return featureOn('conversationControl');
}

/** The raw block, exactly as written (no defaults). */
export function rawConversation() {
  const raw = profile()?.business?.conversation;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/**
 * The settings in force, defaults applied and every value clamped. Safe to call
 * on every message: it reads the live profile object, which `.set` mutates.
 */
export function conversationSettings() {
  const raw = rawConversation();
  const handover = raw.handover && typeof raw.handover === 'object' ? raw.handover : {};
  return {
    scope: oneOf(raw.scope, SCOPES, DEFAULTS.scope),
    offTopic: oneOf(raw.offTopic ?? raw.off_topic, OFF_TOPIC_MODES, DEFAULTS.offTopic),
    warningsBeforeStop: int(raw.warningsBeforeStop, DEFAULTS.warningsBeforeStop, 0, 5),
    coolDownMinutes: int(raw.coolDownMinutes, DEFAULTS.coolDownMinutes, 5, 1440),
    abuseLimit: int(raw.abuseLimit, DEFAULTS.abuseLimit, 1, 10),
    maxSentences: int(raw.maxSentences, DEFAULTS.maxSentences, 1, 6),
    languageMatching: raw.languageMatching !== false,
    handover: {
      keywords: list(handover.keywords ?? raw.handoverKeywords),
      confusionRepeats: int(handover.confusionRepeats, DEFAULTS.handover.confusionRepeats, 1, 10),
      angryTone: handover.angryTone !== false,
    },
    approvalRequired: raw.approvalRequired === undefined ? [...DEFAULTS.approvalRequired] : list(raw.approvalRequired),
    dailyMessageCap: int(raw.dailyMessageCap, DEFAULTS.dailyMessageCap, 1, 500),
    maxBotTurnsBeforeHuman: int(raw.maxBotTurnsBeforeHuman, DEFAULTS.maxBotTurnsBeforeHuman, 1, 200),
    classifier: raw.classifier !== false,
    notifyOwner: raw.notifyOwner !== false,
  };
}

// Business types where "open" scope is a bad idea: a clinic that chats about
// anything can drift into advice, and a finance-shaped business into promises.
const REGULATED = /(clinic|hospital|medical|doctor|dentist|pharmacy|lab|health|therapy|legal|law|finance|bank|insurance|invest)/i;

/**
 * Validation, called by profile.js on every write and by the doctor.
 * @returns {{errors:string[], warnings:string[]}}
 */
export function validateConversation(raw = rawConversation()) {
  const errors = [];
  const warnings = [];
  if (raw === null || raw === undefined || raw === '') return { errors, warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('business.conversation must be an object');
    return { errors, warnings };
  }

  const known = new Set(Object.keys(DEFAULTS));
  for (const key of Object.keys(raw)) {
    if (key.startsWith('//') || key.startsWith('_')) continue;
    if (!known.has(key)) warnings.push(`unknown setting business.conversation.${key} (ignored)`);
  }

  if (raw.scope !== undefined && !SCOPES.includes(String(raw.scope).toLowerCase())) {
    errors.push(`business.conversation.scope must be one of ${SCOPES.join(', ')}`);
  }
  if (raw.offTopic !== undefined && !OFF_TOPIC_MODES.includes(String(raw.offTopic).toLowerCase())) {
    errors.push(`business.conversation.offTopic must be one of ${OFF_TOPIC_MODES.join(', ')}`);
  }
  for (const [key, min, max] of [
    ['warningsBeforeStop', 0, 5],
    ['coolDownMinutes', 5, 1440],
    ['abuseLimit', 1, 10],
    ['maxSentences', 1, 6],
    ['dailyMessageCap', 1, 500],
    ['maxBotTurnsBeforeHuman', 1, 200],
  ]) {
    if (raw[key] === undefined) continue;
    const n = Number(raw[key]);
    if (!Number.isFinite(n)) errors.push(`business.conversation.${key} must be a number`);
    else if (n < min || n > max) errors.push(`business.conversation.${key} must be between ${min} and ${max}`);
  }
  if (raw.handover !== undefined) {
    if (typeof raw.handover !== 'object' || Array.isArray(raw.handover)) {
      errors.push('business.conversation.handover must be an object');
    } else {
      if (raw.handover.keywords !== undefined && !Array.isArray(raw.handover.keywords)) {
        errors.push('business.conversation.handover.keywords must be a list');
      }
    }
  }
  if (raw.approvalRequired !== undefined && !Array.isArray(raw.approvalRequired)) {
    errors.push('business.conversation.approvalRequired must be a list');
  }
  return { errors, warnings };
}

/**
 * Risky combinations the doctor should say out loud. Pure: takes a profile, so
 * it can be tested without touching the filesystem.
 * @returns {string[]}
 */
export function conversationWarnings(p = profile()) {
  const flags = p?.features || {};
  if (flags.conversationControl !== true) return [];
  const raw = p?.business?.conversation || {};
  const s = conversationSettingsFrom(p);
  const out = [];
  const type = String(p?.business?.type || '');

  if (s.offTopic === 'ignore' && s.notifyOwner === false) {
    out.push(
      'conversation.offTopic is "ignore" and notifyOwner is false — the bot will go quiet on off-topic messages and you will never hear about it. Set business.conversation.notifyOwner true'
    );
  }
  if (s.scope === 'open' && REGULATED.test(type)) {
    out.push(
      `conversation.scope is "open" on a ${type} business — a clinic or a finance-shaped business that chats about anything can drift into advice or promises. "business_only" is the safe setting`
    );
  }
  if (s.offTopic === 'warn_then_stop' && s.warningsBeforeStop === 0) {
    out.push('conversation.warningsBeforeStop is 0 with warn_then_stop — the first off-topic message stops the chat with no warning. Try 1');
  }
  if (s.maxBotTurnsBeforeHuman > 30) {
    out.push(`conversation.maxBotTurnsBeforeHuman is ${s.maxBotTurnsBeforeHuman} — a confused customer could go that long before a human is offered`);
  }
  if (s.dailyMessageCap > 120) {
    out.push(`conversation.dailyMessageCap is ${s.dailyMessageCap} — that is not much of a cap`);
  }
  if (raw.handover && Array.isArray(raw.handover.keywords) && raw.handover.keywords.length === 0) {
    out.push('conversation.handover.keywords is empty — the bot will still hand over on explicit requests and complaints, but not on your own trigger words');
  }
  return out;
}

/** Same defaults, applied to a profile object instead of the live one. */
function conversationSettingsFrom(p) {
  const raw = p?.business?.conversation || {};
  const handover = raw.handover && typeof raw.handover === 'object' ? raw.handover : {};
  return {
    scope: oneOf(raw.scope, SCOPES, DEFAULTS.scope),
    offTopic: oneOf(raw.offTopic, OFF_TOPIC_MODES, DEFAULTS.offTopic),
    warningsBeforeStop: int(raw.warningsBeforeStop, DEFAULTS.warningsBeforeStop, 0, 5),
    coolDownMinutes: int(raw.coolDownMinutes, DEFAULTS.coolDownMinutes, 5, 1440),
    abuseLimit: int(raw.abuseLimit, DEFAULTS.abuseLimit, 1, 10),
    maxSentences: int(raw.maxSentences, DEFAULTS.maxSentences, 1, 6),
    languageMatching: raw.languageMatching !== false,
    handover: {
      keywords: list(handover.keywords),
      confusionRepeats: int(handover.confusionRepeats, DEFAULTS.handover.confusionRepeats, 1, 10),
      angryTone: handover.angryTone !== false,
    },
    approvalRequired: Array.isArray(raw.approvalRequired) ? list(raw.approvalRequired) : [...DEFAULTS.approvalRequired],
    dailyMessageCap: int(raw.dailyMessageCap, DEFAULTS.dailyMessageCap, 1, 500),
    maxBotTurnsBeforeHuman: int(raw.maxBotTurnsBeforeHuman, DEFAULTS.maxBotTurnsBeforeHuman, 1, 200),
    classifier: raw.classifier !== false,
    notifyOwner: raw.notifyOwner !== false,
  };
}

/** `.control` — the settings reference, on a phone. */
export function controlText() {
  if (!controlEnabled()) {
    return [
      'Conversation Control is off.',
      'Turn it on with: .set features.conversationControl true',
      '',
      'Off means the bot behaves exactly as it did before: no decisions, no scope modes, no boundaries.',
    ].join('\n');
  }
  const s = conversationSettings();
  return [
    '*Conversation Control*',
    `Scope: ${s.scope}`,
    `Off-topic: ${s.offTopic}${s.offTopic === 'warn_then_stop' ? ` (${s.warningsBeforeStop} warning${s.warningsBeforeStop === 1 ? '' : 's'})` : ''}`,
    `Insults: cool-down ${s.coolDownMinutes} min after ${s.abuseLimit}`,
    `Replies: max ${s.maxSentences} sentences · language matching ${s.languageMatching ? 'on' : 'off'}`,
    `Handover: ${s.handover.keywords.length ? s.handover.keywords.join(', ') : 'no extra keywords'} · confusion ×${s.handover.confusionRepeats} · angry tone ${s.handover.angryTone ? 'on' : 'off'}`,
    `Approval needed for: ${s.approvalRequired.length ? s.approvalRequired.join(', ') : 'nothing'}`,
    `Cap: ${s.dailyMessageCap} messages/day · after ${s.maxBotTurnsBeforeHuman} turns offer a human`,
    `Classifier when rules are unsure: ${s.classifier ? 'on' : 'off'} · owner notices: ${s.notifyOwner ? 'on' : 'off'}`,
    '',
    'Change one: .set business.conversation.scope open',
    'Never ignored: opt-out, privacy, a human request, emergency words, an active order or booking, and a new contact\'s first 3 messages.',
  ].join('\n');
}

export default {
  ACTIONS,
  DEFAULTS,
  OFF_TOPIC_MODES,
  SCOPES,
  controlEnabled,
  controlText,
  conversationSettings,
  conversationWarnings,
  rawConversation,
  validateConversation,
};
