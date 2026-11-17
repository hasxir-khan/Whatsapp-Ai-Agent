// src/handlers/ownerCommands.js
// Commands the owner can type from his own WhatsApp (self-chat or any chat).
// Everything is prefixed with a dot so normal messages never trigger them.

import fs from 'node:fs';
import { config, normalizePhone } from '../config/env.js';
import {
  listLeads, getLead, listContacts, blockContact, setContactPaused, setSetting,
  getSetting, dbStats, getUsage, listIntakes, exportAll, writeExport, countLeads,
} from '../utils/db.js';
import { buildReport } from '../services/report.js';
import { buildOwnerBrief } from '../services/memory.js';
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

const HELP = `*Bot commands*

.chats – latest conversations
.leads [status] – pipeline
.lead 92300… – full dossier on one client
.pause 92300… [min] – bot goes quiet in that chat
.resume 92300… – give the chat back to the bot
.block / .unblock 92300…
.reset 92300… – clear project intake for a chat
.quote 92300… – rebuild + send a quote
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

function fmtLead(lead, index) {
  const who = lead.name || `+${lead.number}`;
  const price = lead.quote_min
    ? ` · ${formatMoney(lead.quote_min, lead.quote_currency || 'PKR')}–${formatMoney(lead.quote_max, lead.quote_currency || 'PKR')}`
    : '';
  return `${index ? `${index}. ` : ''}${who} — ${lead.project_type || 'unknown'}${price} · ${lead.status}`;
}

export function isCommand(text = '') {
  return /^[.!/]\w+/i.test(String(text).trim());
}

/**
 * @returns {Promise<{handled:boolean, reply?:string, voice?:object}>}
 */
export async function handleOwnerCommand(sock, chatJid, text) {
  const input = String(text).trim();
  const [rawCmd, ...args] = input.slice(1).split(/\s+/);
  const cmd = (rawCmd || '').toLowerCase();
  const arg = args.join(' ').trim();
  const target = args.length ? parseTarget(args[0]) : null;

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
      const leads = listLeads(status, 15);
      if (!leads.length) return { handled: true, reply: 'No leads yet.' };
      const lines = [`*Leads${status ? ` (${status})` : ''}*`];
      leads.forEach((lead, i) => lines.push(fmtLead(lead, i + 1)));
      lines.push(`\nTotal open: ${countLeads()}`);
      return { handled: true, reply: lines.join('\n') };
    }

    case 'lead': {
      if (!target) return { handled: true, reply: 'Usage: .lead 923001234567' };
      const lead = getLead(target);
      const brief = buildOwnerBrief(target);
      if (!lead) return { handled: true, reply: brief };
      const lines = [brief, '', `📁 ${lead.project_type || '—'} · ${lead.status}`];
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

    default:
      return { handled: true, reply: `Unknown command .${cmd}\n\n${HELP}` };
  }
}

export default { handleOwnerCommand, isCommand, HELP };
