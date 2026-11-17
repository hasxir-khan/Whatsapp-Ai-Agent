// src/services/templates.js
// Industry starter profiles. A template is a partial owner.json: a business
// block, an example price list, policies, FAQs, tone, goals and escalation —
// everything a new business needs before it can hold a real conversation.
//
// Templates never invent prices for the owner: the numbers are clearly
// example starting points and the setup wizard shows them for editing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_KEYS } from './profile.js';

// Anchored to this file, not to the working directory: the templates always
// live in the repo, even when a tenant runs from its own folder.
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = path.join(HERE, '..', '..', 'config', 'templates');

export const TEMPLATE_IDS = [
  'restaurant',
  'clinic',
  'salon',
  'real-estate',
  'shop',
  'agency',
  'school',
  'generic',
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Every available template with just enough metadata to show a menu. */
export function listTemplates() {
  const out = [];
  for (const id of TEMPLATE_IDS) {
    const data = readJson(path.join(TEMPLATES_DIR, `${id}.json`));
    if (!data) continue;
    out.push({
      id,
      label: data._template?.label || id,
      emoji: data._template?.emoji || '🏪',
      description: data._template?.description || '',
      goodFor: data._template?.goodFor || '',
      items: data.catalog?.items?.length || 0,
      faqs: data.faqs?.length || 0,
    });
  }
  return out;
}

export function isTemplate(id) {
  return TEMPLATE_IDS.includes(String(id || '').trim());
}

export function loadTemplate(id) {
  const key = String(id || '').trim();
  if (!isTemplate(key)) {
    throw new Error(`Unknown template "${id}". Available: ${TEMPLATE_IDS.join(', ')}`);
  }
  const data = readJson(path.join(TEMPLATES_DIR, `${key}.json`));
  if (!data) throw new Error(`Template "${key}" is missing or not valid JSON.`);
  return data;
}

/**
 * Build a complete tenant owner.json from a template.
 * Everything the owner said in setup wins over the template defaults.
 */
export function buildProfileFromTemplate(id, {
  name = '',
  brand = '',
  number = '',
  timezone = 'Asia/Karachi',
  city = '',
  languages = null,
  currency = 'PKR',
  hours = '',
  escalationNumber = '',
} = {}) {
  const t = loadTemplate(id);
  const businessName = brand || name || '';

  const business = {
    ...(t.business || {}),
    name: businessName,
  };
  if (city) business.city = city;
  if (languages?.length) business.languages = languages;
  if (hours) business.hours = hours;

  const esc = { ...(t.escalation || {}) };
  const escNumber = escalationNumber || number;
  if (escNumber) {
    esc.number = escNumber;
    esc.whatsapp = escNumber;
  }

  const policies = { ...(t.policies || {}) };

  return {
    business,
    catalog: { items: [...(t.catalog?.items || [])] },
    tone: { ...(t.tone || {}) },
    goals: { ...(t.goals || {}) },
    escalation: esc,
    policies,
    faqs: [...(t.faqs || [])],
    // Every flag is written explicitly so the owner can see what exists and
    // what is off; a template only turns on what it needs.
    features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, t.features?.[k] === true])),
    owner: {
      name,
      brand: businessName,
      role: t.business?.type || 'Owner',
      timezone,
      location: city || 'Pakistan',
      bio: businessName
        ? `${businessName} — ${String(t.business?.type || 'business').toLowerCase()}${city ? ` in ${city}` : ''}. Write one honest sentence here about what makes you worth choosing.`
        : 'EDIT ME — one or two sentences about this business, in the owner’s voice.',
      availability: hours || t.business?.hours || 'Mon–Sat, 10:00–19:00',
      responsePromise: 'usually replies within a few hours',
      // The catalog is the price list for a templated business; legacy
      // services stay empty so there is exactly one place to edit.
      services: [],
      addons: [],
      payment: {
        terms: policies.payment || '50% advance, 50% on delivery.',
        methods: [],
      },
      portfolio: [],
      team: [],
      friends: [],
    },
    bot: {
      name: businessName ? `${businessName} Assistant` : 'Assistant',
      formality: 'auto',
      persona: 'Warm, sharp and slightly informal. Short WhatsApp messages, natural rhythm, no corporate script.',
    },
    currency: { base: currency, displayForForeignClients: true },
  };
}

export default { listTemplates, loadTemplate, isTemplate, buildProfileFromTemplate, TEMPLATE_IDS, TEMPLATES_DIR };
