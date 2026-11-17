// src/handlers/ownerCommands.js
// Commands the owner can type from his own WhatsApp (self-chat or any chat).
// Everything is prefixed with a dot so normal messages never trigger them.

import fs from 'node:fs';
import {
  config, normalizePhone, teamMembers, teamMember, can, teamPermissions,
} from '../config/env.js';
import {
  listLeads, getLead, listContacts, blockContact, setContactPaused, setSetting,
  getSetting, dbStats, getUsage, listIntakes, exportAll, writeExport, countLeads,
  assignContact, contactsFor, teamWorkload, recentCalls,
} from '../utils/db.js';
import { buildReport } from '../services/report.js';
import { buildOwnerBrief } from '../services/memory.js';
import { rankLeads, refreshLead, leadLine, pipelineSummary, priorityMeta } from '../services/leads.js';
import { formatMoney, localTime } from '../services/geo.js';
import { resetState, getState } from '../core/projectIntake.js';
import { buildQuote, formatQuote } from '../core/pricing.js';
import { llmStatus } from '../core/llm.js';
import { visionStatus } from '../services/vision.js';
import { ttsStatus } from '../services/tts.js';
import { videoCapabilities } from '../services/video.js';
import { sttEnabled } from '../services/transcription.js';
import { hasFfmpeg } from '../services/ffmpeg.js';
import { pendingFollowUps } from '../utils/db.js';
import { outboxStatus } from '../services/outbox.js';

const HELP = `*Bot commands*

.chats – latest conversations
.leads [status] – pipeline
.lead 92300… – full dossier on one client
.pause 92300… [min] – bot goes quiet in that chat
.resume 92300… – give the chat back to the bot
.block / .unblock 92300…
.reset 92300… – clear project intake for a chat
.quote 92300… – rebuild + send a quote
.team – who's on the team + workload
.mine – chats assigned to me
.takeover 92300… – I'm handling this one (bot steps back)
.release 92300… – give it back to the bot
.assign 92300… Name – hand a chat to a teammate
.calls – recent incoming calls
.report – today's brief
.usage – free-tier usage
.status – system health
.voice off|request|match|always
.ai on|off – global switch
.export – JSON backup of leads + chats
.sync – push leads to Google Sheets
.id – current chat id
.ping`;

function parseTarget(raw = '') {
  const cleaned = raw.replace(/[+()\s-]/g, '');
  const num = normalizePhone(cleaned);
  return num && num.length >= 8 ? num : null;
}

async function dbNotify(sock, text) {
  try {
    await sock.sendMessage(config.owner.jid, { text });
  } catch {
    /* ignore */
  }
}

export function isCommand(text = '') {
  return /^[.!/]\w+/i.test(String(text).trim());
}

// Which permission each command needs. Anything not listed is harmless
// read-only stuff that every teammate may use.
const COMMAND_PERMISSION = {
  pause: 'pause',
  resume: 'pause',
  block: 'pause',
  unblock: 'pause',
  reset: 'pause',
  quote: 'quotes',
  report: 'report',
  assign: 'assign',
  takeover: 'pause',
  release: 'pause',
  calls: 'calls',
  leads: 'leads',
  lead: 'leads',
  intakes: 'intakes',
  sync: 'owner',
  export: 'owner',
  ai: 'owner',
  voice: 'owner',
  team: 'chats',
};

const OWNER_ONLY = new Set(['export', 'sync', 'ai', 'voice', 'block', 'unblock']);

/**
 * @returns {Promise<{handled:boolean, reply?:string, voice?:object}>}
 */
export async function handleOwnerCommand(sock, chatJid, text, from = config.owner.number) {
  const input = String(text).trim();
  const [rawCmd, ...args] = input.slice(1).split(/\s+/);
  const cmd = (rawCmd || '').toLowerCase();
  const arg = args.join(' ').trim();
  const target = args.length ? parseTarget(args[0]) : null;

  // ── who is asking? ───────────────────────────────────────
  const sender = normalizePhone(from || config.owner.number);
  const member = teamMember(sender);
  const isOwner = sender === config.owner.number;
  const known = isOwner || !!member;
  const me = member?.name || (isOwner ? 'owner' : sender);

  if (!known) {
    return { handled: true, reply: 'This bot is private. Commands only work for the owner and the team.' };
  }

  const needed = COMMAND_PERMISSION[cmd];
  if (!isOwner) {
    if (OWNER_ONLY.has(cmd)) {
      return { handled: true, reply: `.${cmd} is owner-only.` };
    }
    if (needed && !can(sender, needed)) {
      const perms = [...teamPermissions(sender)].join(', ');
      return { handled: true, reply: `Your role (${member.role}) can't use .${cmd}.\nYou can: ${perms}` };
    }
  }

  switch (cmd) {
    case 'help':
    case 'h':
      return { handled: true, reply: HELP };

    case 'ping':
      return { handled: true, reply: `pong · ${new Date().toISOString()}` };

    case 'id':
      return {
        handled: true,
        reply: `Chat: ${chatJid}\nNumber: ${chatJid.split('@')[0]}\nOwner: +${config.owner.number}`,
      };

    case 'status':
    case 'stats': {
      const stats = dbStats();
      const llm = llmStatus();
      const vision = visionStatus();
      const voice = ttsStatus();
      const video = videoCapabilities();
      const lines = [
        '*System status*',
        `Owner: ${config.owner.name} (+${config.owner.number})`,
        `Memory: ${stats.contacts} contacts · ${stats.messages} msgs · ${stats.leads} leads`,
        `AI: ${llm.providers.join(', ') || 'none'} (${llm.quota.used}/${llm.quota.limit} calls today)`,
        `Eyes: ${vision.providers.join(', ') || 'none'}${vision.nativeVideo ? ' · video native' : video.frames ? ' · video via frames' : ''}`,
        `Ears: ${sttEnabled() ? 'whisper' : 'off'}`,
        `Voice replies: ${voice.enabled ? `${voice.mode} (${voice.providers.join(', ')})` : 'off'}`,
        `ffmpeg: ${hasFfmpeg() ? 'yes (real voice notes)' : 'no (voice sent as audio file)'}`,
        `Pending follow-ups: ${stats.pendingFollowUps}`,
        `Outbox: ${outboxStatus().pending} queued · ${outboxStatus().failed} failed`,
        `Bot globally: ${getSetting('bot_enabled', true) ? 'ON' : 'OFF'}`,
      ];
      return { handled: true, reply: lines.join('\n') };
    }

    case 'usage': {
      const u = getUsage();
      return {
        handled: true,
        reply: [
          '*Today*',
          `AI calls: ${u.llm_calls}/${config.limits.dailyLlmCalls}`,
          `Tokens: ${u.llm_tokens}`,
          `Images/videos: ${u.vision_calls}/${config.limits.dailyVisionCalls}`,
          `Audio: ${Math.round(u.stt_seconds)}s`,
          `Voice chars: ${u.tts_chars}/${config.limits.dailyTtsChars}`,
        ].join('\n'),
      };
    }

    case 'chats': {
      const contacts = listContacts(12);
      if (!contacts.length) return { handled: true, reply: 'No conversations yet.' };
      const lines = ['*Recent chats*'];
      for (const c of contacts) {
        const t = localTime(c.number);
        lines.push(`• ${c.name || c.push_name || `+${c.number}`} — ${c.stage} · ${c.message_count} msgs · ${t.clock}`);
      }
      return { handled: true, reply: lines.join('\n') };
    }

    case 'leads': {
      const status = args[0] && !target ? args[0].toLowerCase() : null;
      const leads = rankLeads({ status, limit: 12 });
      if (!leads.length) return { handled: true, reply: 'No leads yet.' };
      const summary = pipelineSummary();
      const lines = [
        `*Leads${status ? ` (${status})` : ''}* — 🔥 ${summary.byPriority.hot} hot · 🌤️ ${summary.byPriority.warm} warm · ❄️ ${summary.byPriority.cold} cold`,
      ];
      leads.slice(0, 8).forEach((lead) => lines.push(leadLine(lead)));
      lines.push(`\nTotal open: ${countLeads()} · pipeline value ≈ ${formatMoney(Math.round(summary.valuePkr), 'PKR')}`);
      lines.push('More detail: .lead 92300…');
      return { handled: true, reply: lines.join('\n') };
    }

    case 'lead': {
      if (!target) return { handled: true, reply: 'Usage: .lead 923001234567' };
      const lead = getLead(target);
      const brief = buildOwnerBrief(target);
      if (!lead) return { handled: true, reply: brief };
      const scored = refreshLead(target) || {};
      const meta = priorityMeta(scored.priority || 'cold');
      const lines = [brief, ''];
      if (scored.score !== undefined) {
        lines.push(`${meta.emoji} *${scored.score}/100 — ${meta.label}*`);
        if (scored.reasons?.length) lines.push(`Good: ${scored.reasons.slice(0, 3).join(', ')}`);
        if (scored.risks?.length) lines.push(`Watch: ${scored.risks.slice(0, 3).join(', ')}`);
        if (scored.nextAction) lines.push(`👉 Next: ${scored.nextAction}`);
        lines.push('');
      }
      lines.push(`📁 ${lead.project_type || '—'} · ${lead.status}`);
      if (lead.quote_min) lines.push(`💰 ${formatMoney(lead.quote_min, lead.quote_currency || 'PKR')}–${formatMoney(lead.quote_max, lead.quote_currency || 'PKR')}`);
      if (lead.budget) lines.push(`🗒️ Their budget: ${lead.budget}`);
      const followups = pendingFollowUps(target);
      if (followups.length) lines.push(`⏰ Follow-up: ${new Date(followups[0].due_at).toLocaleString('en-GB', { timeZone: config.timezone })}`);
      return { handled: true, reply: lines.join('\n') };
    }

    case 'pause': {
      if (!target) return { handled: true, reply: 'Usage: .pause 923001234567 [minutes]' };
      const minutes = parseInt(args[1], 10) || config.behavior.handoffMinutes;
      const until = new Date(Date.now() + minutes * 60000).toISOString();
      setContactPaused(target, until);
      return { handled: true, reply: `Bot paused in +${target} for ${minutes} min. You can talk to them yourself.` };
    }

    case 'resume': {
      if (!target) return { handled: true, reply: 'Usage: .resume 923001234567' };
      setContactPaused(target, null);
      return { handled: true, reply: `Bot is back on +${target}.` };
    }

    case 'block': {
      if (!target) return { handled: true, reply: 'Usage: .block 923001234567' };
      blockContact(target, true);
      return { handled: true, reply: `Blocked +${target}.` };
    }

    case 'unblock': {
      if (!target) return { handled: true, reply: 'Usage: .unblock 923001234567' };
      blockContact(target, false);
      return { handled: true, reply: `Unblocked +${target}.` };
    }

    case 'reset': {
      if (!target) return { handled: true, reply: 'Usage: .reset 923001234567' };
      resetState(target);
      return { handled: true, reply: `Intake cleared for +${target}.` };
    }

    case 'quote': {
      if (!target) return { handled: true, reply: 'Usage: .quote 923001234567' };
      const state = getState(target);
      if (!Object.keys(state.fields || {}).length) {
        return { handled: true, reply: `Nothing collected for +${target} yet — no quote possible.` };
      }
      const quote = buildQuote(state.fields, target);
      const jid = `${target}@s.whatsapp.net`;
      const text = formatQuote(quote, state.fields);
      try {
        await sock.sendMessage(jid, { text });
        return { handled: true, reply: `Quote sent to +${target}:\n\n${text}` };
      } catch (err) {
        return { handled: true, reply: `Could not send: ${err.message}` };
      }
    }

    case 'report': {
      return { handled: true, reply: buildReport() };
    }

    case 'voice': {
      const mode = (args[0] || '').toLowerCase();
      const map = {
        off: 'off', on: 'on_request', request: 'on_request',
        on_request: 'on_request', match: 'match_voice', match_voice: 'match_voice',
        always: 'always', all: 'always',
      };
      if (!map[mode]) return { handled: true, reply: 'Usage: .voice off|request|match|always' };
      setSetting('tts_mode', map[mode]);
      return { handled: true, reply: `Voice replies: ${map[mode]}` };
    }

    case 'ai': {
      const mode = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(mode)) return { handled: true, reply: 'Usage: .ai on|off' };
      setSetting('bot_enabled', mode === 'on');
      return { handled: true, reply: `Bot is now ${mode === 'on' ? 'ON' : 'OFF'} for everyone.` };
    }

    case 'export': {
      const data = exportAll();
      const file = writeExport(data);
      try {
        await sock.sendMessage(chatJid, {
          document: fs.readFileSync(file),
          fileName: `hasdevs-export-${new Date().toISOString().slice(0, 10)}.json`,
          mimetype: 'application/json',
          caption: `📦 Export: ${data.contacts.length} contacts · ${data.leads.length} leads`,
        });
        return { handled: true };
      } catch (err) {
        return { handled: true, reply: `Export failed: ${err.message}` };
      }
    }

    case 'sync': {
      const { saveLeadToSheet, sheetsEnabled } = await import('../services/sheets.js');
      if (!sheetsEnabled()) return { handled: true, reply: 'Google Sheets is not configured.' };
      const leads = listLeads(null, 200);
      let ok = 0;
      for (const lead of leads) {
        if (await saveLeadToSheet(lead)) ok++;
      }
      return { handled: true, reply: `Synced ${ok}/${leads.length} leads to Google Sheets.` };
    }

    case 'intakes': {
      const rows = listIntakes(10);
      if (!rows.length) return { handled: true, reply: 'No active intakes.' };
      const lines = ['*Active intakes*'];
      for (const row of rows) {
        const fields = row.fields || {};
        lines.push(`• +${row.number} — ${fields.projectType || 'unknown'} (${row.stage})`);
      }
      return { handled: true, reply: lines.join('\n') };
    }

    // ── team (multi-user) ───────────────────────────────────
    case 'team': {
      const workload = Object.fromEntries(teamWorkload().map((w) => [w.operator, w]));
      const lines = ['*Team*', `• ${config.owner.name} — owner · +${config.owner.number}`];
      for (const m of teamMembers()) {
        const load = workload[m.name]?.chats || 0;
        lines.push(`• ${m.name} — ${m.role} · +${m.number} · ${load} chat${load === 1 ? '' : 's'}`);
      }
      if (!teamMembers().length) {
        lines.push('', 'No teammates yet. Add them to config/owner.json → owner.team');
      }
      lines.push('', 'Add: {"number":"92300…","name":"Ayesha","role":"sales"}');
      return { handled: true, reply: lines.join('\n') };
    }

    case 'mine': {
      if (isOwner) return { handled: true, reply: 'You own everything — try .leads or .chats.' };
      const chats = contactsFor(me, 10);
      if (!chats.length) return { handled: true, reply: `No chats assigned to you yet.\nTake one with: .takeover 92300…` };
      const lines = [`*Your chats (${chats.length})*`];
      for (const c of chats) {
        const t = localTime(c.number);
        lines.push(`• ${c.name || c.push_name || `+${c.number}`} — ${c.stage} · ${c.message_count} msgs · ${t.clock}`);
      }
      return { handled: true, reply: lines.join('\n') };
    }

    case 'takeover': {
      if (!target) return { handled: true, reply: 'Usage: .takeover 923001234567' };
      const minutes = parseInt(args[1], 10) || config.behavior.handoffMinutes;
      assignContact(target, me, minutes);
      dbNotify(sock, `🙋 ${me} took over +${target} for ${minutes} min.`);
      return {
        handled: true,
        reply: `You've got +${target} for the next ${minutes} min — the bot is quiet there.\nSee the dossier with .lead ${target}`,
      };
    }

    case 'release': {
      if (!target) return { handled: true, reply: 'Usage: .release 923001234567' };
      assignContact(target, null, null);
      setContactPaused(target, null);
      dbNotify(sock, `↩️ ${me} released +${target} back to the bot.`);
      return { handled: true, reply: `+${target} is back with the bot.` };
    }

    case 'assign': {
      const name = args.slice(1).join(' ').trim();
      if (!target || !name) {
        return { handled: true, reply: 'Usage: .assign 923001234567 Ayesha\n(team: ' + (teamMembers().map((m) => m.name).join(', ') || 'none') + ')' };
      }
      const person = teamMembers().find((m) => m.name.toLowerCase() === name.toLowerCase());
      if (!person) return { handled: true, reply: `No teammate called "${name}". Try .team` };
      assignContact(target, person.name, config.behavior.handoffMinutes);
      try {
        await sock.sendMessage(`${person.number}@s.whatsapp.net`, {
          text: `📌 ${me} assigned you a chat: +${target}.\nOpen it and send .lead ${target} for the full picture.`,
        });
      } catch {
        /* their number may not have WhatsApp */
      }
      return { handled: true, reply: `Assigned +${target} to ${person.name}.` };
    }

    case 'calls': {
      const calls = recentCalls(10);
      if (!calls.length) return { handled: true, reply: 'No calls yet.' };
      const lines = ['*Recent calls*'];
      for (const c of calls) {
        const when = new Date(c.created_at).toLocaleString('en-GB', { timeZone: config.timezone });
        lines.push(
          `• ${c.name || `+${c.number}`} — ${c.video ? 'video' : 'voice'} · ${c.status}${c.outcome ? ` · ${c.outcome}` : ''}\n  ${when}`
        );
      }
      return { handled: true, reply: lines.join('\n') };
    }

    default:
      return { handled: true, reply: `Unknown command .${cmd}\n\n${HELP}` };
  }
}

export default { handleOwnerCommand, isCommand, HELP };
