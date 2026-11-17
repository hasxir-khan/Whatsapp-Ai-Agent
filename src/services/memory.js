// src/services/memory.js
// Long-term memory. Three layers, all persisted:
//   1. recent turns        → verbatim, last ~16 messages
//   2. rolling summary     → what the whole relationship is about
//   3. structured facts    → company, country, budget, preferences…
// The AI sees all three, so it can pick up a conversation from weeks ago the
// way a human would.

import { config } from '../config/env.js';
import {
  getContact, upsertContact, saveMessage, getMessages, countMessages,
  setFact, getFacts, getSummary, setSummary, getIntake, getLead, logEvent,
} from '../utils/db.js';
import { lookupNumber, localTime } from './geo.js';
import { chatJson, hasLLM } from '../core/llm.js';

const FACT_KEYS = new Set([
  'name', 'company', 'country', 'city', 'role', 'industry', 'team_size',
  'website', 'email', 'budget', 'timeline', 'deadline', 'tech', 'platform',
  'goal', 'preferred_language', 'timezone', 'how_found_us', 'decision_maker',
  'other', 'notes',
]);

const KEY_ALIASES = {
  name: 'name', fullname: 'name', 'first name': 'name',
  company: 'company', business: 'company', brand: 'company', organization: 'company',
  country: 'country', location: 'country', city: 'city',
  role: 'role', job: 'role', title: 'role', position: 'role',
  industry: 'industry', niche: 'industry',
  team: 'team_size', 'team size': 'team_size', employees: 'team_size',
  website: 'website', site: 'website', url: 'website',
  email: 'email', mail: 'email',
  budget: 'budget', price: 'budget', spend: 'budget',
  timeline: 'timeline', deadline: 'deadline', launch: 'deadline',
  tech: 'tech', stack: 'tech', technology: 'tech',
  platform: 'platform',
  goal: 'goal', objective: 'goal', purpose: 'goal',
  language: 'preferred_language', 'preferred language': 'preferred_language',
  timezone: 'timezone', tz: 'timezone',
  'how found us': 'how_found_us', source: 'how_found_us', referral: 'how_found_us',
  'decision maker': 'decision_maker', decisionmaker: 'decision_maker',
};

function normalizeFactKey(key) {
  const k = String(key || '').toLowerCase().trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const mapped = KEY_ALIASES[k] || k.replace(/\s+/g, '_');
  return FACT_KEYS.has(mapped) ? mapped : 'notes';
}

export function rememberFacts(number, facts = {}) {
  if (!facts || typeof facts !== 'object') return;
  for (const [rawKey, rawValue] of Object.entries(facts)) {
    if (rawValue === null || rawValue === undefined) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue).trim();
    if (!value || value.length < 2 || /^(unknown|n\/?a|none|null)$/i.test(value)) continue;
    setFact(number, normalizeFactKey(rawKey), value);
  }
}

export function saveUserTurn(number, content, kind = 'text', meta = null) {
  saveMessage(number, 'user', content, kind, meta);
}

export function saveAssistantTurn(number, content, kind = 'text', meta = null) {
  saveMessage(number, 'assistant', content, kind, meta);
}

export function saveOwnerTurn(number, content) {
  saveMessage(number, 'owner', content, 'text');
}

/** Everything the AI needs to know about this person right now. */
export function getDossier(number, { recentLimit = config.llm.historyTurns } = {}) {
  const contact = getContact(number) || {};
  const geo = lookupNumber(number);
  const facts = getFacts(number);
  const summary = getSummary(number)?.summary || '';
  const intake = getIntake(number);
  const lead = getLead(number);
  const recent = getMessages(number, recentLimit);
  const total = countMessages(number);
  const now = localTime(number);

  return {
    number,
    jid: `${number}@s.whatsapp.net`,
    name: contact.name || contact.push_name || '',
    pushName: contact.push_name || '',
    category: contact.category || 'new',
    stage: contact.stage || 'new',
    language: contact.language || '',
    locale: contact.locale || (geo.region ? geo.region.toLowerCase() : ''),
    country: contact.country || geo.country,
    currency: contact.currency || geo.currency,
    timezone: geo.timezone,
    localTime: now,
    voicePref: contact.voice_pref || 'unknown',
    tone: contact.tone || 'neutral',
    assignedTo: contact.assigned_to || null,
    messageCount: total,
    isBlocked: !!contact.is_blocked,
    pausedUntil: contact.bot_paused_until || null,
    notes: contact.notes || '',
    firstSeen: contact.first_seen || null,
    lastSeen: contact.last_seen || null,
    facts: facts.map((f) => ({ key: f.key, value: f.value })),
    summary,
    intake,
    lead,
    recent,
  };
}

function timeAgo(iso) {
  if (!iso) return 'first contact';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}

/** Compact dossier block injected into the system prompt. */
export function buildDossierText(dossier, { compact = false } = {}) {
  if (!dossier) return '';
  const lines = [];
  const name = dossier.name || dossier.pushName;

  lines.push('── WHO YOU ARE TALKING TO ──');
  lines.push(
    `${name ? name : 'Unnamed contact'} (+${dossier.number}) · ${dossier.country} · ${dossier.currency}` +
      (dossier.localTime?.label ? ` · their clock: ${dossier.localTime.label}` : '')
  );
  lines.push(`Status: ${dossier.stage} · relationship depth: ${dossier.messageCount} messages · last spoke ${timeAgo(dossier.lastSeen)}`);

  if (dossier.facts?.length) {
    const shown = compact ? dossier.facts.slice(0, 6) : dossier.facts.slice(0, 16);
    lines.push('Known facts: ' + shown.map((f) => `${f.key}=${f.value}`).join(' | '));
  }

  if (dossier.summary) {
    lines.push('');
    lines.push('── WHAT HAPPENED BEFORE (your memory of this client) ──');
    lines.push(compact ? dossier.summary.slice(0, 600) : dossier.summary);
  }

  if (dossier.intake?.fields && Object.keys(dossier.intake.fields).length) {
    lines.push('');
    lines.push('── PROJECT INTAKE SO FAR (never re-ask anything already here) ──');
    for (const [key, value] of Object.entries(dossier.intake.fields)) {
      if (!value) continue;
      const v = Array.isArray(value) ? value.join(', ') : String(value);
      lines.push(`${key}: ${v.slice(0, 300)}`);
    }
    if (dossier.intake.quote) {
      lines.push(`Quote already sent: ${dossier.intake.quote.local?.minText || ''} – ${dossier.intake.quote.local?.maxText || ''} (${dossier.intake.quoted_at || ''})`);
    }
  }

  if (dossier.lead?.features) {
    lines.push(`Saved lead: ${dossier.lead.project_type || ''} / ${dossier.lead.status || ''}`);
  }

  return lines.join('\n');
}

/** Recent turns as chat messages for the model. */
export function buildHistoryMessages(dossier, limit = config.llm.historyTurns) {
  const recent = (dossier?.recent || []).slice(-limit);
  const out = [];
  for (const msg of recent) {
    if (!msg.content) continue;
    if (msg.role === 'user') {
      const tag = msg.kind && msg.kind !== 'text' ? `[${msg.kind}] ` : '';
      out.push({ role: 'user', content: `${tag}${msg.content}`.slice(0, 2000) });
    } else if (msg.role === 'assistant') {
      out.push({ role: 'assistant', content: String(msg.content).slice(0, 2000) });
    } else if (msg.role === 'owner') {
      // The owner replying personally is important context — the bot should
      // not contradict what he said.
      out.push({ role: 'assistant', content: `(Hashir himself replied: ${String(msg.content).slice(0, 500)})` });
    }
  }
  // Models dislike two consecutive user turns — merge them
  const merged = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) prev.content += `\n${m.content}`;
    else merged.push({ ...m });
  }
  return merged;
}

/**
 * Roll the conversation into a summary + structured facts.
 * Runs every ~12 messages (cheap model), and can be forced.
 */
export async function summarizeIfNeeded(number, { force = false } = {}) {
  if (!hasLLM()) return null;
  const total = countMessages(number);
  const existing = getSummary(number);
  const since = total - (existing?.msg_count || 0);
  if (!force && since < config.behavior.summaryEvery) return null;

  const dossier = getDossier(number, { recentLimit: 30 });
  const transcript = dossier.recent
    .filter((m) => m.content)
    .map((m) => `${m.role === 'user' ? 'CLIENT' : m.role === 'owner' ? 'OWNER' : 'ME'}: ${m.content}`)
    .join('\n')
    .slice(-6000);

  if (transcript.length < 60) return null;

  try {
    const { data } = await chatJson({
      small: true,
      temperature: 0.2,
      maxTokens: 700,
      system:
        'You maintain a CRM memory for a freelance developer on WhatsApp. Be factual, terse and never invent details. Return JSON only.',
      messages: [
        {
          role: 'user',
          content: `Previous memory:
${existing?.summary || '(none)'}

Known facts: ${JSON.stringify(Object.fromEntries((dossier.facts || []).map((f) => [f.key, f.value])))}

New conversation:
${transcript}

Return JSON with exactly these keys:
{
 "summary": "max 5 sentences: who this person is, what they want, what was agreed, what is still open",
 "facts": {"company":"","country":"","role":"","budget":"","timeline":"","tech":"","preferred_language":"","other":""},
 "stage": "new|discovering|quoted|negotiating|won|lost",
 "sentiment": "positive|neutral|negative",
 "next_step": "one short sentence"
}
Use "" for anything unknown. Do not guess.`,
        },
      ],
    });

    if (!data) return null;

    if (data.summary) setSummary(number, data.summary, total);
    if (data.facts) rememberFacts(number, data.facts);

    if (data.stage && ['new', 'discovering', 'quoted', 'negotiating', 'won', 'lost'].includes(data.stage)) {
      upsertContact(number, { stage: data.stage });
    }
    if (data.sentiment && data.sentiment !== 'neutral') {
      setFact(number, 'notes', `sentiment: ${data.sentiment}${data.next_step ? ` · next: ${data.next_step}` : ''}`);
    }
    logEvent('memory_summary', number, { messages: total, stage: data.stage });
    return data;
  } catch (err) {
    logEvent('memory_summary_error', number, err.message);
    return null;
  }
}

/** Context card the owner gets when the bot escalates a chat. */
export function buildOwnerBrief(number) {
  const dossier = getDossier(number, { recentLimit: 12 });
  const lines = [];
  lines.push(`👤 *${dossier.name || 'Unknown'}* (+${dossier.number})`);
  lines.push(`${dossier.country} · ${dossier.localTime?.label || ''}`);
  lines.push(`Status: ${dossier.stage} · ${dossier.messageCount} msgs · last ${timeAgo(dossier.lastSeen)}`);
  if (dossier.summary) lines.push(`\n🧠 ${dossier.summary}`);
  if (dossier.intake?.fields && Object.keys(dossier.intake.fields).length) {
    lines.push('\n📋 Project so far:');
    for (const [k, v] of Object.entries(dossier.intake.fields)) {
      if (!v) continue;
      lines.push(`• ${k}: ${Array.isArray(v) ? v.join(', ') : String(v).slice(0, 160)}`);
    }
  }
  const lastUser = [...dossier.recent].reverse().find((m) => m.role === 'user');
  if (lastUser) lines.push(`\n💬 Last message: "${String(lastUser.content).slice(0, 300)}"`);
  return lines.join('\n');
}

export default {
  rememberFacts, saveUserTurn, saveAssistantTurn, saveOwnerTurn,
  getDossier, buildDossierText, buildHistoryMessages, summarizeIfNeeded, buildOwnerBrief,
};
