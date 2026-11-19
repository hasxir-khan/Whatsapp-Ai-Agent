// src/handlers/agentCommands.js
// Owner-facing commands for custom agents (phase 6):
//
//   .agents                          the roster, with what each one did today
//   .agent add <id> <Name> [role]    a new agent, switched off until you enable it
//   .agent set <id> <field> <value>  edit one field (validated before it is saved)
//   .agent on|off <id>               enable or disable
//   .agent test <id> "<message>"     dry run: who would answer, and why
//   .agent rm <id>                   delete
//
// Nothing here is reachable by a customer: the owner command handler already
// refuses anyone who is not the owner or team.

import { profile, savePatch } from '../services/profile.js';
import { featureOn } from '../services/profile.js';
import {
  AGENT_ROLES,
  MAX_AGENTS,
  EDITABLE,
  listAgents,
  getAgent,
  validateAgent,
  normalizeAgent,
  agentStats,
  agentPrompt,
  routeToAgent,
  agentsEnabled,
} from '../services/agents.js';

const USAGE = [
  '.agents — who is on the team of assistants',
  '.agent add <id> <Name> [role] — create one (off until you enable it)',
  '.agent set <id> <field> <value> — persona, instructions, hours, tools…',
  '.agent on|off <id> — enable or disable',
  '.agent test <id> "message" — dry run, nothing is sent',
  '.agent rm <id> — delete',
].join('\n');

function rawAgents() {
  const list = profile()?.agents;
  return Array.isArray(list) ? list.map((a) => ({ ...a })) : [];
}

function persist(list) {
  savePatch({ agents: list });
}

function parseList(value = '') {
  return String(value)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `.agents` — the roster plus a one-line summary of each agent's traffic. */
export function agentsReply() {
  if (!agentsEnabled()) {
    return `Custom agents are off. Turn them on with:\n  .set features.multiAgent true\n\nThen: ${USAGE.split('\n')[0]}`;
  }
  const list = listAgents();
  if (!list.length) return `No agents configured yet.\n\n${USAGE}`;

  const stats = new Map(agentStats({ days: 1 }).map((s) => [s.id, s]));
  const lines = [`🧑‍💼 Agents (${list.length}/${MAX_AGENTS}) — ${list.filter((a) => a.enabled).length} on\n`];
  for (const a of list) {
    const s = stats.get(a.id) || { conversations: 0, handoffs: 0, avgFirstReplySec: null };
    const state = a.enabled ? '✅' : '⏸️';
    const hours = a.hours ? ` · ${a.hours}` : '';
    const tools = a.tools.length ? ` · tools: ${a.tools.join(', ')}` : '';
    // Phase 6 Part 2: a pack agent carries its industry "never do" rules, so
    // the owner can see what it is forbidden to do before switching it on.
    const never = a.never?.length ? `\n   never: ${a.never[0]}${a.never.length > 1 ? ` (+${a.never.length - 1} more)` : ''}` : '';
    lines.push(
      `${state} ${a.name} (${a.id}, ${a.role})${hours}${tools}${never}\n` +
        `   today: ${s.conversations} chat${s.conversations === 1 ? '' : 's'} · ${s.handoffs} hand-off${s.handoffs === 1 ? '' : 's'}` +
        (s.avgFirstReplySec !== null ? ` · first reply ${s.avgFirstReplySec}s` : '')
    );
  }
  lines.push('\n.agent test <id> "message" — dry run   ·   .agent off <id> — disable');
  return lines.join('\n');
}

/** `.agent test <id> "<msg>"` — route only, nothing is sent, no model call. */
export async function agentTestReply(id, message) {
  const agent = getAgent(id);
  if (!agent) return `No agent "${id}". Try .agents`;
  const text = String(message || '').replace(/^["“]|["”]$/g, '').trim();
  if (!text) return 'Usage: .agent test <id> "a customer message"';

  const route = await routeToAgent({ text, chatId: `test:${Date.now()}`, useModel: false });
  const chosen = route.agent || agent;
  return [
    `🧪 Dry run — nothing was sent.`,
    ``,
    `Message: "${text.slice(0, 160)}"`,
    `Would answer: ${chosen?.name || 'none'} (${chosen?.id || '—'})`,
    chosen?.id === agent.id ? `✅ that is ${agent.name}` : `⚠️ that is not ${agent.name} — check its routing keywords`,
    `Why: ${route.reason} (${route.source})`,
    ``,
    `Prompt it would add:`,
    agentPrompt(chosen).slice(0, 400),
  ].join('\n');
}

/**
 * The `.agent …` entry point.
 * @returns {{handled:true, reply:string}}
 */
export async function handleAgentCommand({ sub = '', args = [], raw = '' } = {}) {
  const action = String(sub || '').toLowerCase();
  const rest = args.slice(1);

  if (!featureOn('multiAgent')) {
    return { handled: true, reply: 'Custom agents are off. Turn them on with `.set features.multiAgent true`.' };
  }

  switch (action) {
    case '':
    case 'list':
      return { handled: true, reply: agentsReply() };

    case 'add': {
      const id = String(args[1] || '').toLowerCase();
      const name = args.slice(2).join(' ').trim();
      if (!id) return { handled: true, reply: 'Usage: .agent add <id> <Name> [role]' };
      const list = rawAgents();
      if (list.some((a) => String(a.id).toLowerCase() === id)) return { handled: true, reply: `There is already an agent "${id}".` };
      if (list.length >= MAX_AGENTS) return { handled: true, reply: `You already have ${MAX_AGENTS} agents — the maximum.` };

      const roleArg = name.match(/\s+(\w+)$/)?.[1]?.toLowerCase();
      const role = AGENT_ROLES.includes(roleArg) ? roleArg : 'custom';
      const cleanName = roleArg && AGENT_ROLES.includes(roleArg) ? name.slice(0, -(roleArg.length + 1)).trim() : name;

      const candidate = { id, name: cleanName || id, role, enabled: false, handoff: 'owner', default: list.length === 0 };
      const { errors, warnings, agent } = validateAgent(candidate);
      if (errors.length) return { handled: true, reply: `Can't add that agent:\n${errors.map((e) => `• ${e}`).join('\n')}` };

      list.push({ ...candidate, id: agent.id });
      persist(list);
      const note = warnings.length ? `\n\nNotes:\n${warnings.map((w) => `• ${w}`).join('\n')}` : '';
      return {
        handled: true,
        reply: `✅ Added ${agent.name} (${agent.id}, ${agent.role}) — switched off for now.\nSet it up with .agent set ${agent.id} instructions <text>, then .agent on ${agent.id}.${note}`,
      };
    }

    case 'set': {
      const id = String(args[1] || '').toLowerCase();
      const field = String(args[2] || '').toLowerCase();
      const value = rest.slice(2).join(' ').trim();
      const list = rawAgents();
      const index = list.findIndex((a) => String(a.id).toLowerCase() === id);
      if (index < 0) return { handled: true, reply: `No agent "${id}". Try .agents` };
      if (!EDITABLE.includes(field)) {
        return { handled: true, reply: `Field "${field}" is not editable. One of: ${EDITABLE.join(', ')}` };
      }

      const next = { ...list[index] };
      if (['languages', 'tools', 'knowledge', 'escalate', 'routing'].includes(field)) next[field] = parseList(value);
      else if (field === 'enabled') next[field] = /^(true|on|yes|1)$/i.test(value);
      else next[field] = value;

      const { errors, warnings, agent } = validateAgent({ ...next, order: index });
      if (errors.length) return { handled: true, reply: `Not saved:\n${errors.map((e) => `• ${e}`).join('\n')}` };

      list[index] = { ...next, id: agent.id };
      persist(list);
      const shown = Array.isArray(next[field]) ? next[field].join(', ') || '(empty)' : String(next[field] ?? '').slice(0, 120) || '(empty)';
      const note = warnings.length ? `\n\nNotes:\n${warnings.map((w) => `• ${w}`).join('\n')}` : '';
      return { handled: true, reply: `✅ ${agent.id}.${field} = ${shown}${note}` };
    }

    case 'on':
    case 'off': {
      const id = String(args[1] || '').toLowerCase();
      const list = rawAgents();
      const index = list.findIndex((a) => String(a.id).toLowerCase() === id);
      if (index < 0) return { handled: true, reply: `No agent "${id}". Try .agents` };
      list[index] = { ...list[index], enabled: action === 'on' };
      persist(list);
      return { handled: true, reply: `${action === 'on' ? '✅ On' : '⏸️ Off'}: ${list[index].name || id}` };
    }

    case 'rm':
    case 'remove':
    case 'delete': {
      const id = String(args[1] || '').toLowerCase();
      const list = rawAgents();
      const index = list.findIndex((a) => String(a.id).toLowerCase() === id);
      if (index < 0) return { handled: true, reply: `No agent "${id}".` };
      const [gone] = list.splice(index, 1);
      persist(list);
      return { handled: true, reply: `🗑️ Removed ${gone.name || id}.` };
    }

    case 'test': {
      const id = String(args[1] || '').toLowerCase();
      const message = args.slice(2).join(' ');
      return { handled: true, reply: await agentTestReply(id, message) };
    }

    default:
      return { handled: true, reply: `Unknown .agent subcommand "${action}".\n\n${USAGE}` };
  }
}

export { USAGE as AGENT_USAGE, normalizeAgent, rawAgents as _rawAgents };
