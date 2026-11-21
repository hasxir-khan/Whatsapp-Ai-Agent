import {billingLimit} from './billingLease.js';
// src/services/agents.js
// Custom multi-agent assistants (Phase 6, part 1).
//
// One WhatsApp number, several named agents per business. This module owns
// everything that is *about agents*: the config shape, who answers a message,
// working hours, hand-offs, the per-agent breaker/budget and the numbers the
// dashboard shows.
//
// Everything here is additive: nothing in this file runs unless the owner has
// switched `features.multiAgent` on. With the flag off `agentsEnabled()` is
// false and the caller keeps its pre-Phase-6 behaviour exactly.

import { detectInjection } from '../core/injection.js';
import { chat, hasLLM } from '../core/llm.js';
import { featureOn, profile, business } from './profile.js';
import { parseHours, isOpen } from './hours.js';
import * as db from '../utils/db.js';
import { packFor } from './agentPacks.js';

export const AGENT_ROLES = ['sales', 'support', 'booking', 'orders', 'custom'];
export const MAX_AGENTS = 8;
export const INSTRUCTIONS_MAX = 400;
export const PERSONA_MAX = 240;
export const MAX_HANDOFFS = 2;
export const DEFAULT_BUDGET_SHARE = 0.25;
export const BREAKER_THRESHOLD = 3;
export const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;
export const BREAKER_WINDOW_MS = 5 * 60 * 1000;

// Fields an owner may set with `.agent set <id> <field> <value>`.
export const EDITABLE = ['name', 'role', 'persona', 'instructions', 'languages', 'tools', 'knowledge', 'hours', 'handoff', 'escalate', 'routing', 'never', 'enabled'];

/** The flag that turns this whole module on. Off by default. */
export function agentsEnabled() {
  return featureOn('multiAgent');
}

const str = (v) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());
const arr = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

/** Raw agents[] from the profile, tolerant of a missing section. */
export function agentsRaw() {
  const list = profile()?.agents;
  return Array.isArray(list) ? list.slice(0, billingLimit('agents', list.length)) : [];
}

/**
 * Normalise one raw config entry. Never throws: an agent that cannot be read
 * is dropped rather than taking the bot down.
 */
export function normalizeAgent(raw = {}, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = str(raw.id).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 24);
  if (!id) return null;
  const role = AGENT_ROLES.includes(str(raw.role).toLowerCase()) ? str(raw.role).toLowerCase() : 'custom';
  return {
    id,
    name: str(raw.name) || id,
    role,
    persona: str(raw.persona).slice(0, PERSONA_MAX),
    instructions: str(raw.instructions).slice(0, INSTRUCTIONS_MAX),
    languages: arr(raw.languages),
    tools: arr(raw.tools),
    knowledge: arr(raw.knowledge),
    routing: arr(raw.routing),
    escalate: arr(raw.escalate),
    // "never do" rules: short, owner-written, shown to the model verbatim.
    never: arr(raw.never).map((r) => str(r).slice(0, 160)).filter(Boolean).slice(0, 6),
    hours: raw.hours ?? null,
    handoff: str(raw.handoff),
    enabled: raw.enabled === true,
    isDefault: raw.default === true || index === 0,
    order: index,
  };
}

/** Every configured agent, enabled or not. */
export function listAgents() {
  return agentsRaw()
    .slice(0, MAX_AGENTS)
    .map((raw, i) => normalizeAgent(raw, i))
    .filter(Boolean);
}

/** Only the ones the owner switched on. */
export function enabledAgents() {
  return listAgents().filter((a) => a.enabled);
}

export function getAgent(id) {
  const key = str(id).toLowerCase();
  return listAgents().find((a) => a.id === key) || null;
}

/** The agent that answers when nobody else fits: the first enabled one. */
export function defaultAgent(list = enabledAgents()) {
  if (!list.length) return null;
  return list.find((a) => a.isDefault) || list[0];
}

/** Tools an agent may use: its own list ∩ what the tenant already allows. */
export function agentTools(agent, tenantAllowed = null) {
  if (!agent) return tenantAllowed;
  const mine = agent.tools.length ? agent.tools : null;
  if (!mine) return tenantAllowed; // inherits the tenant's tools
  if (!tenantAllowed) return new Set(mine); // tenant has no restriction
  return new Set(mine.filter((t) => tenantAllowed.has(t)));
}

/** Is this agent inside its working hours right now? */
export function agentOpen(agent, now = new Date(), timeZone = business()?.timezone || profile()?.owner?.timezone || 'UTC') {
  if (!agent?.hours) return { open: true, known: false };
  try {
    return isOpen(now, { hours: parseHours(agent.hours), timeZone });
  } catch {
    return { open: true, known: false, reason: 'hours_unreadable' };
  }
}

/**
 * Pick the agent that should answer *when the chosen one is closed*.
 * Never returns null while any agent is enabled: a message is never dropped.
 */
export function fallbackForClosed(chosen, list = enabledAgents(), now = new Date()) {
  if (!list.length) return null;
  const open = list.filter((a) => agentOpen(a, now).open);
  const pool = open.length ? open : list;
  const sameRole = pool.find((a) => a.role === chosen?.role && a.id !== chosen?.id);
  if (sameRole) return { agent: sameRole, reason: 'same_role_open' };
  const def = pool.find((a) => a.isDefault) || pool[0];
  return { agent: def, reason: def.id === chosen?.id ? 'closed_but_only_agent' : 'default_agent_open' };
}

// ── validation (owner input, never customer input) ─────────

/**
 * Validate one agent entry. Used by `.agent add/set`, the tenant wizard, the
 * admin panel and the doctor.
 * @returns {{errors: string[], warnings: string[], agent: object|null}}
 */
export function validateAgent(raw = {}) {
  const errors = [];
  const warnings = [];
  const agent = normalizeAgent(raw, raw.order ?? 0);
  if (!agent) return { errors: ['agent needs an id (letters, numbers, - or _)'], warnings, agent: null };

  if (!raw.role) warnings.push(`${agent.id}: no role set, defaulting to custom`);
  if (str(raw.instructions).length > INSTRUCTIONS_MAX) {
    errors.push(`${agent.id}: instructions are ${str(raw.instructions).length} chars, the cap is ${INSTRUCTIONS_MAX}`);
  }
  if (str(raw.persona).length > PERSONA_MAX) {
    errors.push(`${agent.id}: persona is ${str(raw.persona).length} chars, the cap is ${PERSONA_MAX}`);
  }
  // An instruction is owner text, but it is still text that reaches a model.
  // Anything that looks like a prompt-injection attempt is refused outright.
  for (const [field, value] of [['instructions', str(raw.instructions)], ['persona', str(raw.persona)], ['name', str(raw.name)]]) {
    const hit = value ? detectInjection(value) : null;
    if (hit?.found) {
      errors.push(`${agent.id}: ${field} looks like a prompt injection (${hit.hits?.[0] || 'suspicious'})`);
    }
  }
  if (!agent.instructions) warnings.push(`${agent.id}: no instructions — it will answer like the default assistant`);
  if (agent.hours) {
    const parsed = parseParsed(agent.hours);
    if (!parsed.known) warnings.push(`${agent.id}: hours "${str(agent.hours)}" could not be read, it will answer 24/7`);
  }
  if (agent.handoff) {
    const team = arr(profile()?.owner?.team).map((m) => str(m?.name).toLowerCase());
    const target = agent.handoff.toLowerCase();
    if (target !== 'owner' && !team.includes(target)) {
      warnings.push(`${agent.id}: hand-off target "${agent.handoff}" is not on the team and is not "owner"`);
    }
  }
  return { errors, warnings, agent };
}

function parseParsed(hours) {
  try {
    return parseHours(hours);
  } catch {
    return { known: false };
  }
}

/** Overlapping routing keywords between two agents — a doctor warning. */
export function overlappingRules(list = listAgents()) {
  const seen = new Map();
  const clashes = [];
  for (const a of list) {
    for (const kw of a.routing) {
      const key = kw.toLowerCase();
      if (!key) continue;
      if (seen.has(key) && seen.get(key) !== a.id) clashes.push({ keyword: kw, a: seen.get(key), b: a.id });
      else seen.set(key, a.id);
    }
  }
  return clashes;
}

/** Problems the doctor should surface about the agents section. */
export function agentDiagnostics() {
  const errors = [];
  const warnings = [];
  const list = listAgents();
  if (!agentsEnabled()) return { errors, warnings };

  if (!list.length) warnings.push('features.multiAgent is on but agents[] is empty — the built-in assistant answers');
  const configured = agentsRaw().length;
  if (configured > MAX_AGENTS) errors.push(`${configured} agents configured, the maximum is ${MAX_AGENTS}`);
  if (list.length && !enabledAgents().length) warnings.push('every agent is switched off — the built-in assistant answers');

  for (const raw of agentsRaw()) {
    const { errors: e, warnings: w } = validateAgent(raw);
    errors.push(...e);
    warnings.push(...w);
  }

  for (const clash of overlappingRules(list)) {
    warnings.push(`agents ${clash.a} and ${clash.b} both route on "${clash.keyword}"`);
  }
  return { errors, warnings };
}

// ── breaker + budget ───────────────────────────────────────
// One broken agent must not take the bot down, and one agent must not spend
// the whole day's model budget.

const breakers = new Map(); // id -> { failures: [ts], openedAt }
const spend = new Map(); // id -> { day, tokens }
const counters = { totalTokens: 0, day: dayKey(new Date()) };

function dayKey(d) {
  return d.toISOString().slice(0, 10);
}

function rollDay() {
  const today = dayKey(new Date());
  if (counters.day !== today) {
    counters.day = today;
    counters.totalTokens = 0;
    spend.clear();
  }
}

export function noteAgentFailure(id) {
  if (!id) return;
  const now = Date.now();
  const entry = breakers.get(id) || { failures: [], openedAt: null };
  entry.failures = [...entry.failures.filter((t) => now - t < BREAKER_WINDOW_MS), now];
  if (entry.failures.length >= BREAKER_THRESHOLD) entry.openedAt = now;
  breakers.set(id, entry);
}

export function noteAgentSuccess(id) {
  if (!id) return;
  const entry = breakers.get(id);
  if (!entry) return;
  entry.failures = [];
  entry.openedAt = null;
  breakers.set(id, entry);
}

/** True while the agent's breaker is open (it answers with the default one). */
export function breakerOpen(id, now = Date.now()) {
  const entry = breakers.get(id);
  if (!entry?.openedAt) return false;
  if (now - entry.openedAt > BREAKER_COOLDOWN_MS) {
    breakers.set(id, { failures: [], openedAt: null });
    return false;
  }
  return true;
}

export function breakerState() {
  const out = {};
  for (const [id, e] of breakers) if (e.openedAt && Date.now() - e.openedAt <= BREAKER_COOLDOWN_MS) out[id] = e.openedAt;
  return out;
}

export function resetBreakers() {
  breakers.clear();
  spend.clear();
  counters.totalTokens = 0;
  counters.day = dayKey(new Date());
}

/** Tokens a day the install may spend; a share of this is each agent's ceiling. */
export const AGENT_DAILY_TOKENS = 200000;

export function budgetShare() {
  const raw = Number(process.env.AGENT_BUDGET_SHARE ?? DEFAULT_BUDGET_SHARE);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_BUDGET_SHARE;
  return Math.min(raw, 1);
}

/** May this agent spend more of the tenant's model budget today? */
export function budgetAllows(id, tokens = 0) {
  if (!id) return true;
  rollDay();
  const mine = spend.get(id)?.tokens || 0;
  // The share is of the tenant's *daily allowance*, not of whatever has been
  // spent so far: with one agent answering, "spent / total spent" would be 100%
  // and the only working assistant would switch itself off.
  const allowance = AGENT_DAILY_TOKENS * budgetShare();
  return mine + tokens <= allowance;
}

export function noteAgentTokens(id, tokens = 0) {
  if (!id || !tokens) return;
  rollDay();
  const entry = spend.get(id) || { day: counters.day, tokens: 0 };
  entry.tokens += tokens;
  spend.set(id, entry);
  counters.totalTokens += tokens;
}

export function budgetState() {
  rollDay();
  return { day: counters.day, total: counters.totalTokens, share: budgetShare(), perAgent: Object.fromEntries([...spend].map(([k, v]) => [k, v.tokens])) };
}

// ── state: sticky routing + hand-offs ──────────────────────
// Kept in memory for speed and mirrored to the database so a restart does not
// forget which agent a conversation belongs to.

const state = new Map(); // chat -> { agent, handoffs, at }

function tenant() {
  try {
    return profile()?.tenant?.slug || process.env.TENANT || 'default';
  } catch {
    return 'default';
  }
}

export function currentAgent(chat) {
  if (!chat) return null;
  const bare = String(chat).replace(/@.*$/, '');
  const jid = `${bare}@s.whatsapp.net`;
  for (const key of [chat, bare, jid]) {
    const mem = state.get(key);
    if (mem) return mem;
  }
  try {
    const row = db.get('SELECT agent, handoffs, updated_at FROM agent_chats WHERE tenant = ? AND chat IN (?, ?, ?)', [tenant(), String(chat), bare, jid]);
    if (row?.agent) {
      const entry = { agent: row.agent, handoffs: row.handoffs || 0, at: Date.parse(row.updated_at) || Date.now() };
      state.set(chat, entry);
      return entry;
    }
  } catch {
    /* no database yet — memory only */
  }
  return null;
}

export function setCurrentAgent(chat, agentId, { handoffs = null } = {}) {
  if (!chat || !agentId) return null;
  const prev = currentAgent(chat);
  const entry = { agent: agentId, handoffs: handoffs === null ? prev?.handoffs || 0 : handoffs, at: Date.now() };
  state.set(chat, entry);
  try {
    db.run(
      `INSERT INTO agent_chats (tenant, chat, agent, handoffs, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(tenant, chat) DO UPDATE SET agent = excluded.agent, handoffs = excluded.handoffs, updated_at = excluded.updated_at`,
      [tenant(), chat, agentId, entry.handoffs, new Date(entry.at).toISOString()]
    );
  } catch {
    /* analytics table missing — memory is still correct */
  }
  return entry;
}

export function clearAgentState(chat = null) {
  if (!chat) {
    state.clear();
    return;
  }
  // A chat is known by its jid in one path and by its bare number in another;
  // forgetting must clear both or the customer keeps being routed.
  state.delete(chat);
  const bare = String(chat).replace(/@.*$/, "");
  state.delete(bare);
  state.delete(`${bare}@s.whatsapp.net`);
}

/** Log an agent event. Never throws: analytics must not break a reply. */
export function logAgentEvent(chat, agent, kind, detail = null) {
  try {
    db.run('INSERT INTO agent_events (tenant, chat, agent, kind, detail, created_at) VALUES (?,?,?,?,?,?)', [
      tenant(),
      chat || null,
      agent || null,
      kind,
      detail === null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
      new Date().toISOString(),
    ]);
  } catch {
    /* nothing to do: the reply matters, the counter does not */
  }
}

/**
 * Hand a chat from one agent to another.
 * @returns {{ok:boolean, reason?:string, handoffs:number, target?:string}}
 */
export function handoff(chat, fromId, toId, { summary = '', requester = 'agent' } = {}) {
  const entry = currentAgent(chat);
  const used = entry?.handoffs || 0;
  if (used >= MAX_HANDOFFS) {
    logAgentEvent(chat, fromId, 'handoff_refused', { to: toId, used });
    return { ok: false, reason: 'handoff_limit', handoffs: used };
  }
  const target = toId === 'owner' ? 'owner' : toId;
  const cleanSummary = summarise(summary);
  setCurrentAgent(chat, target, { handoffs: used + 1 });
  logAgentEvent(chat, fromId, 'handoff', { to: target, summary: cleanSummary, requester });
  return { ok: true, handoffs: used + 1, target };
}

/** A hand-off summary is short and carries no secrets or raw customer text. */
export function summarise(text = '') {
  const clean = String(text)
    .replace(/\b(gsk|AIza|sk-|ghp|AQ\.)[A-Za-z0-9._-]+/g, '[key]')
    .replace(/\b\d{9,15}\b/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, 160);
}

// ── routing ────────────────────────────────────────────────

/**
 * Rule scoring. Cheap, deterministic and testable: keywords the owner wrote,
 * the agent's role vocabulary, the languages it speaks and the contact's tags.
 */
export function scoreAgents(text = '', { langInfo = null, tags = [], list = enabledAgents() } = {}) {
  const lower = String(text).toLowerCase();
  const scores = new Map();
  for (const agent of list) {
    let score = 0;
    const reasons = [];
    const keywords = [...agent.routing, ...roleKeywords(agent.role)];
    for (const kw of keywords) {
      const k = String(kw).toLowerCase().trim();
      if (!k) continue;
      const hit = k.includes(' ') ? lower.includes(k) : new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(k)}($|[^\\p{L}\\p{N}])`, 'u').test(lower);
      if (hit) {
        score += 2;
        reasons.push(`keyword:${k}`);
      }
    }
    if (langInfo?.code && agent.languages.length) {
      const code = String(langInfo.code).toLowerCase();
      if (agent.languages.some((l) => code.startsWith(String(l).toLowerCase().slice(0, 2)))) {
        score += 1;
        reasons.push(`language:${code}`);
      }
    }
    if (tags.length) {
      const tagHit = tags.map((t) => String(t).toLowerCase()).find((t) => agent.routing.map((r) => r.toLowerCase()).includes(t));
      if (tagHit) {
        score += 2;
        reasons.push(`tag:${tagHit}`);
      }
    }
    scores.set(agent.id, { score, reasons });
  }
  const ranked = [...scores.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.score - a.score || (list.find((a2) => a2.id === a.id)?.order ?? 0) - (list.find((a2) => a2.id === b.id)?.order ?? 0));
  return ranked;
}

function roleKeywords(role) {
  switch (role) {
    case 'sales':
      return ['price', 'cost', 'quote', 'buy', 'order', 'kitna', 'rate', 'discount', 'offer', 'قیمت', 'ریٹ'];
    case 'support':
      return ['help', 'problem', 'issue', 'broken', 'not working', 'complaint', 'refund', 'madad', 'kharab', 'مدد', 'خراب'];
    case 'booking':
      return ['book', 'booking', 'appointment', 'reserve', 'slot', 'table', 'timing', 'appointment chahiye', 'بکنگ', 'وقت'];
    case 'orders':
      return ['where is my order', 'delivery', 'track', 'shipped', 'status', 'order status', 'kahan hai', 'آرڈر'];
    default:
      return [];
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Contact tags, if the table is there. */
export function tagsFor(number) {
  try {
    return db.all('SELECT tag FROM contact_tags WHERE number = ?', [number]).map((r) => r.tag);
  } catch {
    return [];
  }
}

/**
 * The whole routing decision for one inbound message.
 *
 * Order: rules → sticky → model (only when unsure) → default agent.
 * A closed agent is swapped for the next suitable one, never dropped.
 *
 * @returns {Promise<{agent:object|null, source:string, confidence:number, reason:string,
 *   from:string|null, switched:boolean, hours?:object, handoff?:object}>}
 */
export async function routeToAgent({
  text = '',
  chatId = null,
  number = null,
  langInfo = null,
  now = new Date(),
  useModel = true,
  classify = null,
} = {}) {
  // The feature gate comes first: with multiAgent off this function must not
  // route, remember or log anything at all.
  if (!agentsEnabled()) {
    return { agent: null, source: 'disabled', confidence: 0, reason: 'multiAgent is off', from: null, switched: false };
  }

  const list = enabledAgents();
  if (!list.length) return { agent: null, source: 'disabled', confidence: 0, reason: 'no agents', from: null, switched: false };

  const sticky = currentAgent(chatId);
  const tags = number ? tagsFor(number) : [];
  const ranked = scoreAgents(text, { langInfo, tags, list });
  const top = ranked[0];
  const second = ranked[1];
  const clear = top && top.score >= 2 && (!second || top.score - second.score >= 2);

  let chosen = null;
  let source = 'fallback';
  let confidence = 0.2;
  let reason = 'default agent';

  if (clear) {
    chosen = list.find((a) => a.id === top.id) || null;
    source = 'rules';
    confidence = Math.min(0.95, 0.5 + top.score / 10);
    reason = `keywords (${top.score} vs ${second?.score ?? 0})`;
  } else if (sticky && list.some((a) => a.id === sticky.agent)) {
    chosen = list.find((a) => a.id === sticky.agent);
    source = 'sticky';
    confidence = 0.6;
    reason = 'same conversation';
  } else if (useModel && (classify || hasLLM())) {
    let picked = null;
    try {
      picked = await (classify || classifyAgentByModel)({ text, langInfo, agents: list });
    } catch {
      picked = null; // a router that throws is a router that abstains
    }
    if (picked && list.some((a) => a.id === picked)) {
      chosen = list.find((a) => a.id === picked);
      source = 'llm';
      confidence = 0.6;
      reason = 'model';
    }
  }

  if (!chosen) {
    chosen = defaultAgent(list);
    source = 'fallback';
    reason = 'default agent';
  }

  // A broken agent must not swallow the message.
  if (chosen && breakerOpen(chosen.id)) {
    const safe = defaultAgent(list.filter((a) => a.id !== chosen.id)) || chosen;
    logAgentEvent(chatId, chosen.id, 'breaker_fallback', { to: safe.id });
    chosen = safe;
    source = 'breaker';
    reason = 'circuit breaker open';
  }

  // An agent that has spent its share of the tenant budget steps aside today.
  if (chosen && !budgetAllows(chosen.id)) {
    const safe = defaultAgent(list.filter((a) => a.id !== chosen.id)) || chosen;
    if (safe.id !== chosen.id) {
      logAgentEvent(chatId, chosen.id, "budget_fallback", { to: safe.id });
      chosen = safe;
      source = "budget";
      reason = "agent budget share reached";
    }
  }

  // Outside its hours: next suitable or the default agent answers.
  let hours = { open: true, known: false };
  if (chosen) {
    hours = agentOpen(chosen, now);
    if (!hours.open) {
      const swap = fallbackForClosed(chosen, list, now);
      if (swap?.agent) {
        logAgentEvent(chatId, chosen.id, 'hours_fallback', { to: swap.agent.id, reason: hours.reason });
        chosen = swap.agent;
        source = 'hours';
        reason = `${hours.reason} → ${swap.reason}`;
      }
    }
  }

  const from = sticky?.agent || null;
  const switched = !!chosen && from !== chosen.id;
  if (chosen && switched) setCurrentAgent(chatId, chosen.id);
  if (chosen) logAgentEvent(chatId, chosen.id, 'route', { source, reason, switched });

  return { agent: chosen, source, confidence, reason, from, switched, hours };
}

// ── analytics ──────────────────────────────────────────────

/**
 * Per-agent numbers for the dashboard and the weekly report.
 * Empty rows are returned for agents with no traffic yet, so the owner sees
 * the whole roster rather than a partial one.
 */
export function agentStats({ days = 7, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const out = new Map();
  for (const a of listAgents()) {
    out.set(a.id, { id: a.id, name: a.name, role: a.role, enabled: a.enabled, conversations: 0, handoffs: 0, escalated: 0, resolved: 0, orders: 0, bookings: 0, revenue: 0, firstReplyMs: [], sources: {} });
  }
  const row = (id) => {
    if (!out.has(id)) out.set(id, { id, name: id, role: 'custom', enabled: false, conversations: 0, handoffs: 0, escalated: 0, resolved: 0, orders: 0, bookings: 0, revenue: 0, firstReplyMs: [], sources: {} });
    return out.get(id);
  };

  try {
    const events = db.all('SELECT chat, agent, kind, detail, created_at FROM agent_events WHERE created_at >= ?', [since]);
    const chats = new Map();
    for (const e of events) {
      if (!e.agent) continue;
      const r = row(e.agent);
      if (e.kind === 'route') {
        r.sources[JSON.parse(e.detail || '{}').source || 'rules'] = (r.sources[JSON.parse(e.detail || '{}').source || 'rules'] || 0) + 1;
        if (e.chat) chats.set(`${e.agent}\u0000${e.chat}`, true);
      } else if (e.kind === 'handoff') {
        r.handoffs += 1;
        r.escalated += 1;
      } else if (e.kind === 'first_reply') {
        try {
          const ms = JSON.parse(e.detail || '{}').ms;
          if (Number.isFinite(ms)) r.firstReplyMs.push(ms);
        } catch { /* ignore */ }
      } else if (e.kind === 'order') {
        r.orders += 1;
        r.resolved += 1;
        r.revenue += Number(JSON.parse(e.detail || '{}').total || 0);
      } else if (e.kind === 'booking') {
        r.bookings += 1;
        r.resolved += 1;
      }
    }
    for (const key of chats.keys()) {
      const [id] = key.split('\u0000');
      row(id).conversations += 1;
    }
  } catch {
    /* no table yet */
  }

  const rows = [...out.values()].map((r) => ({
    ...r,
    avgFirstReplySec: r.firstReplyMs.length ? Math.round(r.firstReplyMs.reduce((a, b) => a + b, 0) / r.firstReplyMs.length / 100) / 10 : null,
    firstReplyMs: undefined,
  }));
  return rows.sort((a, b) => b.conversations - a.conversations || a.name.localeCompare(b.name));
}

/** One agent, summarised for `.status` and the inbox. */
export function agentBadge(chat) {
  if (!agentsEnabled()) return null;
  const current = currentAgent(chat);
  if (!current?.agent) return null;
  const agent = getAgent(current.agent);
  return { id: current.agent, name: agent?.name || current.agent, role: agent?.role || 'custom', handoffs: current.handoffs || 0 };
}

/** Prompt addendum for a custom agent. Instructions first, then tone. */
export function agentPrompt(agent) {
  if (!agent) return '';
  const bits = [`You are "${agent.name}", the ${agent.role} assistant for this business.`];
  if (agent.persona) bits.push(`Tone: ${agent.persona}`);
  if (agent.instructions) bits.push(`How to do your job: ${agent.instructions}`);
  if (agent.never?.length) bits.push(`Never do these: ${agent.never.join(' ')}`);
  bits.push('Prices, totals and discounts come only from the catalogue and the pricing code. Never invent a price, a discount or a delivery time.');
  return bits.join('\n');
}

/**
 * Default assistants shipped with a template, disabled until the owner enables
 * them. The content lives in agentPacks.js so the wizard, .agents, the admin
 * panel and the tests all read the same two or three starters.
 */
export function templateAgents(templateId) {
  return packFor(templateId);
}

export default {
  agentsEnabled,
  listAgents,
  enabledAgents,
  getAgent,
  defaultAgent,
  agentTools,
  agentOpen,
  fallbackForClosed,
  validateAgent,
  overlappingRules,
  agentDiagnostics,
  routeToAgent,
  scoreAgents,
  handoff,
  currentAgent,
  setCurrentAgent,
  clearAgentState,
  agentStats,
  agentBadge,
  agentPrompt,
  templateAgents,
  breakerOpen,
  noteAgentFailure,
  noteAgentSuccess,
  budgetAllows,
  noteAgentTokens,
  budgetState,
  resetBreakers,
};

// ── the model router ───────────────────────────────────────

export const ROUTER_TIMEOUT_MS = 3000;

/**
 * Ask the small model which agent fits. Never throws, never outlives the
 * timeout — the same leash the built-in intent router uses.
 */
export async function classifyAgentByModel({ text = '', langInfo = null, agents = [], timeoutMs = ROUTER_TIMEOUT_MS } = {}) {
  if (!hasLLM() || !agents.length) return null;
  const roster = agents
    .map((a) => `- ${a.id}: ${a.name} (${a.role})${a.routing.length ? ` — keywords: ${a.routing.slice(0, 6).join(', ')}` : ''}`)
    .join('\n');
  const system = `You route WhatsApp messages to the right assistant for a business.\nReply with JSON only: {"agent":"<id>"} using one id from this list, or {"agent":null} when unsure.\n${roster}`;

  const work = (async () => {
    const res = await chat({
      system,
      messages: [
        {
          role: 'user',
          content: `Message: ${String(text).slice(0, 400)}${langInfo?.name ? `\nLanguage: ${langInfo.name}` : ''}\nAnswer:`,
        },
      ],
      maxTokens: 24,
      temperature: 0,
      small: true,
      json: true,
    });
    // JSON in, one id out. A model that rambles or answers "unsure" abstains,
    // and an abstaining router always leaves the default agent in place.
    let out = String(res?.text || '').trim();
    let picked = null;
    try {
      picked = JSON.parse(out)?.agent ?? null;
    } catch {
      picked = null;
    }
    if (!picked) {
      const word = out.toLowerCase().match(/\b([a-z][a-z0-9-]{1,30})\b/);
      picked = word && agents.some((a) => a.id === word[1]) ? word[1] : null;
    }
    return picked && agents.some((a) => a.id === picked) ? picked : null;
  })();

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return null;
  }
}
