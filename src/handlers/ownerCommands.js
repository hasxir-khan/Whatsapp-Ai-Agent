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
import { pendingFollowUps, intentStatsForDay } from '../utils/db.js';
import { intentSummary, managerEnabled, AGENTS } from '../core/manager.js';
import { getTransport } from '../transport/index.js';
import { growthSummary, optOutList, recordOptOut, recordOptIn, quietWindow } from '../services/growth.js';
import { bookingsForOwner, cancelByChat } from '../services/bookingAgent.js';
import { pendingDrafts, approveDraft, skipDraft } from '../services/followUpAgent.js';
import { getBooking, cancelBooking, isOptedOut, recentReferrals, getContact, all } from '../utils/db.js';
import { describeCapabilities } from '../transport/base.js';
import { outboxStatus } from '../services/outbox.js';
import { knowledgeSources, knowledgeStats, knowledgeEmbeddingStats, recentToolCalls, toolCallStats } from '../utils/db.js';
import { toolNames, toolCallingEnabled } from '../core/tools.js';
import {
  featureOn, business, effectiveCatalog, effectiveServices, faqList, tone as toneConfig,
  goals as goalConfig, escalation as escalationConfig, setPath, addService, addFaq, coerceValue,
  FEATURE_KEYS,
} from '../services/profile.js';

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
.profile – business profile summary
.services – price list the bot quotes from
.addservice Name | 1500 – add to the price list
.addfaq Question | Answer – add an FAQ
.set business.hours Daily 12:00–23:00 – edit any setting
.features – which capabilities are on
.knowledge – learned documents + vector status
.tools – last 10 actions the bot took
.intents – who answered what today (sales / support / booking / complaint)
.growth – proactive messages sent today, per agent, with caps
.optouts – everyone who asked to stop
.bookings – today and tomorrow
.cancel <id> – cancel a booking (frees the slot)
.approve <id> / .skip <id> – follow-up drafts waiting for you
.done <id> – a booking or order is finished (starts the review flow)
.paid <id> – confirm an order's payment actually arrived
.report week – last seven days vs the week before
.referrals – who has a code, and who arrived with one
.content now – this week's posts, statuses and a reel idea
.campaign preview – who would get a win-back message, and a sample
.campaign send / .campaign stop – start or halt it
.invoice <id> – the PDF for an order/quote (.invoice <id> send → to the client)
.rules – FAQ rules learned from your own replies, waiting for a yes/no
.approve-rule <id> / .reject-rule <id>
.ping`;

/** What this process is talking to, and what that transport cannot do. */
export function transportLines() {
  const t = getTransport();
  if (!t) return [`Transport: ${config.transport} (not connected in this process)`];
  const { supported, unsupported } = describeCapabilities(t.capabilities);
  const lines = [
    `Transport: ${t.kind}${t.kind === 'cloud' ? ` · webhook ${t.webhookPath}` : ''} · ${t.status}`,
  ];
  if (t.kind === 'cloud') {
    const stats = outboxStatus();
    lines.push(`Window: 24h customer-service rule${stats.held ? ` · ${stats.held} message(s) held` : ''}`);
  }
  if (unsupported.length) lines.push(`Not on ${t.kind}: ${unsupported.join(', ')}`);
  return lines;
}

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

const OWNER_ONLY = new Set([
  'export', 'sync', 'ai', 'voice', 'block', 'unblock', 'set', 'addservice', 'addfaq',
  'features', 'knowledge', 'tools', 'intents', 'growth', 'optouts', 'bookings', 'cancel', 'approve', 'skip',
  'done', 'paid', 'referrals', 'content', 'campaign', 'invoice', 'rules', 'approve-rule', 'reject-rule',
]);

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

    case 'profile': {
      const b = business();
      const items = effectiveCatalog();
      const faqs = faqList();
      const on = Object.entries(config.owner.profile?.features || {})
        .filter(([k, v]) => !k.startsWith('//') && v === true)
        .map(([k]) => k);
      const lines = [`*${b.name || config.owner.name}*${b.type ? ` · ${b.type}` : ''}`];
      if (b.city) lines.push(`City: ${b.city}`);
      if (b.hours) lines.push(`Hours: ${typeof b.hours === 'string' ? b.hours : Object.entries(b.hours).map(([d, h]) => `${d} ${h}`).join(', ')}`);
      if (b.languages?.length) lines.push(`Languages: ${b.languages.join(', ')}`);
      lines.push(`Price list: ${items.length} items · FAQs: ${faqs.length}`);
      const esc = escalationConfig();
      if (esc.number || esc.when) lines.push(`Escalates to: ${esc.number || '—'}${esc.when ? ` (${esc.when})` : ''}`);
      const t = toneConfig();
      if (t.style) lines.push(`Tone: ${t.style}`);
      const g = goalConfig();
      if (g.primary) lines.push(`Goal: ${g.primary}`);
      lines.push(`Features on: ${on.length ? on.join(', ') : 'none'}`);
      lines.push('');
      lines.push('Edit: .set <path> <value> · .addservice · .addfaq');
      return { handled: true, reply: lines.join('\n') };
    }

    case 'services':
    case 'catalog': {
      const items = effectiveCatalog();
      if (!items.length) {
        return {
          handled: true,
          reply: 'No price list yet.\nAdd one with: .addservice Logo design | 15000\nor run the wizard: node scripts/tenant.js setup <slug>',
        };
      }
      const cur = config.owner.profile?.currency?.base || 'PKR';
      const lines = [`*Price list* (${items.length})`];
      for (const item of items.slice(0, 40)) {
        const price =
          item.min === null
            ? 'no price'
            : item.min === item.max
              ? `${item.min.toLocaleString()} ${cur}`
              : `${item.min.toLocaleString()}–${item.max.toLocaleString()} ${cur}`;
        const bits = [`• ${item.name} — ${price}`];
        if (item.duration) bits.push(`${item.duration} min`);
        if (item.stock !== null) bits.push(item.stock > 0 ? `${item.stock} left` : 'out of stock');
        lines.push(bits.join(' · '));
      }
      const legacy = effectiveServices().filter((s) => !s.fromCatalog).length;
      if (legacy) lines.push(`\n(${legacy} older services from owner.services still work too)`);
      lines.push('\nAdd: .addservice Name | price');
      return { handled: true, reply: lines.join('\n') };
    }

    case 'addservice': {
      if (!featureOn('ownerEditing')) {
        return {
          handled: true,
          reply: 'Owner editing is off. Turn it on with:\n.set features.ownerEditing true',
        };
      }
      const [namePart, pricePart, ...rest] = arg.split('|').map((v) => v.trim());
      if (!namePart || !pricePart) {
        return {
          handled: true,
          reply: 'Usage: .addservice Logo design | 15000\nor a range: .addservice Website | 60000-180000',
        };
      }
      try {
        let entry;
        const range = pricePart.match(/^(\d[\d,.]*)\s*[-–to]+\s*(\d[\d,.]*)$/i);
        if (range) {
          entry = addService({
            name: namePart,
            min: Number(range[1].replace(/,/g, '')),
            max: Number(range[2].replace(/,/g, '')),
            description: rest.join(' | ') || undefined,
          });
        } else {
          entry = addService({
            name: namePart,
            price: Number(pricePart.replace(/[^\d.]/g, '')),
            description: rest.join(' | ') || undefined,
          });
        }
        const cur = config.owner.profile?.currency?.base || 'PKR';
        const priceText = entry.min === entry.max ? `${entry.min.toLocaleString()} ${cur}` : `${entry.min.toLocaleString()}–${entry.max.toLocaleString()} ${cur}`;
        return {
          handled: true,
          reply: `✔ Added *${entry.name}* — ${priceText}\n\nThe bot quotes this from the next message. See it with .services`,
        };
      } catch (err) {
        return { handled: true, reply: `Couldn't add that: ${err.message}` };
      }
    }

    case 'addfaq': {
      if (!featureOn('ownerEditing')) {
        return { handled: true, reply: 'Owner editing is off. Turn it on with:\n.set features.ownerEditing true' };
      }
      const [q, ...rest] = arg.split('|');
      const a = rest.join('|').trim();
      try {
        const added = addFaq(q, a);
        return { handled: true, reply: `✔ Saved FAQ (${added.count} total)\n\nQ: ${added.q}\nA: ${added.a}` };
      } catch (err) {
        return { handled: true, reply: `Couldn't save that: ${err.message}\n\nUsage: .addfaq Do you deliver? | Yes, all over Islamabad` };
      }
    }

    case 'set': {
      const match = arg.match(/^(\S+)\s+([\s\S]+)$/);
      // Turning editing on must be possible while editing is still off,
      // so feature flags can always be set by the owner.
      if (!featureOn('ownerEditing') && !(match && match[1].startsWith('features.'))) {
        return { handled: true, reply: 'Owner editing is off. Turn it on with:\n.set features.ownerEditing true' };
      }
      if (!match) {
        return {
          handled: true,
          reply:
            'Usage: .set <path> <value>\n\n' +
            'Examples:\n.set business.hours Daily 12:00–23:00\n.set business.city Islamabad\n' +
            '.set tone.style warm and quick\n.set goals.primary take the booking\n.set features.catalog true',
        };
      }
      const [, pathArg, rawValue] = match;
      const value = coerceValue(rawValue);
      try {
        setPath(pathArg, value);
        return { handled: true, reply: `✔ Saved ${pathArg} = ${typeof value === 'string' ? value : JSON.stringify(value)}\nLive now — no restart needed.` };
      } catch (err) {
        return { handled: true, reply: `Couldn't set that: ${err.message}` };
      }
    }

    case 'tools': {
      const calls = recentToolCalls(10);
      const stats = toolCallStats();
      const lines = [`*Tools* ${toolCallingEnabled() ? '✅ on' : '⏸ off (.set features.toolCalling true)'}`];
      lines.push(`Available: ${toolNames().join(', ')}`);
      lines.push(`Calls logged: ${stats.total}${stats.errors ? ` · ${stats.errors} error(s)` : ''}`);
      if (!calls.length) {
        lines.push('');
        lines.push('Nothing yet — the log fills up as the bot books, checks stock or quotes.');
        return { handled: true, reply: lines.join('\n') };
      }
      lines.push('');
      for (const call of calls) {
        const when = new Date(call.created_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
        const who = call.chat ? `+${String(call.chat).split('@')[0]}` : '—';
        const args = call.args ? Object.entries(call.args).slice(0, 3).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ') : '';
        lines.push(`${call.status === 'ok' ? '✅' : call.status === 'needs_confirmation' ? '⏳' : '⚠️'} ${when} · ${who} · *${call.tool}* ${args}${call.ms !== null ? ` (${call.ms}ms)` : ''}`);
      }
      return { handled: true, reply: lines.join('\n') };
    }

    case 'growth': {
      const summary = growthSummary();
      const lines = [`*Growth today* — ${summary.sent}/${summary.cap} proactive sent`];
      lines.push(`Transport: ${summary.transport} · quiet ${summary.quiet}${summary.inQuiet ? ' (now)' : ''}`);
      lines.push('');
      const agents = Object.entries(summary.byAgent);
      if (!agents.length) {
        lines.push('Nothing sent yet today.');
      } else {
        for (const [agent, counts] of agents) {
          const bits = [];
          if (counts.sent) bits.push(`${counts.sent} sent`);
          if (counts.skipped) bits.push(`${counts.skipped} skipped`);
          if (counts.held) bits.push(`${counts.held} held (24h window)`);
          if (counts.failed) bits.push(`${counts.failed} failed`);
          lines.push(`• ${agent}: ${bits.join(' · ') || '0'}`);
        }
      }
      const drafts = pendingDrafts(5);
      if (drafts.length) {
        lines.push('');
        lines.push(`*${drafts.length} draft(s) waiting*`);
        for (const d of drafts) lines.push(`#${d.id} → +${d.number}: "${String(d.text).slice(0, 70)}…"`);
        lines.push('.approve <id> · .skip <id>');
      }
      lines.push('');
      lines.push(`${summary.optOuts} opt-out${summary.optOuts === 1 ? '' : 's'} on file (.optouts)`);
      return { handled: true, reply: lines.join('\n') };
    }

    case 'optouts': {
      const list = optOutList(30);
      if (!list.length) {
        return { handled: true, reply: 'Nobody has opted out. Good — or nobody has asked yet.' };
      }
      const lines = [`*Opted out* (${optOutList(200).length}) — no proactive messages, ever`];
      for (const row of list) {
        const when = new Date(row.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
        lines.push(`• +${row.number} — ${when}${row.reason ? ` (${String(row.reason).slice(0, 40)})` : ''}`);
      }
      lines.push('');
      lines.push('They can return with "start". You can force one back with .set — but please don\'t.');
      return { handled: true, reply: lines.join('\n') };
    }

    case 'bookings': {
      const { today, tomorrow, todayRows, tomorrowRows } = bookingsForOwner();
      const fmt = (b) => `• ${b.time} — ${b.service}${b.name ? ` · ${b.name}` : ''} · #${b.id} (${b.status})`;
      const lines = [`*Bookings*`];
      lines.push(`Today (${today}): ${todayRows.length}`);
      for (const b of todayRows) lines.push(fmt(b));
      lines.push('');
      lines.push(`Tomorrow (${tomorrow}): ${tomorrowRows.length}`);
      for (const b of tomorrowRows) lines.push(fmt(b));
      if (!todayRows.length && !tomorrowRows.length) lines.push('', 'Nothing booked. The agent offers slots when someone asks.');
      lines.push('', '.cancel <id> frees a slot instantly.');
      return { handled: true, reply: lines.join('\n') };
    }

    case 'cancel': {
      const id = Number(String(arg).match(/\d+/)?.[0]);
      if (!id) return { handled: true, reply: 'Usage: .cancel 12  (the id from .bookings)' };
      const booking = getBooking(id);
      if (!booking) return { handled: true, reply: `No booking #${id}.` };
      const res = cancelBooking(id, { by: 'owner' });
      return {
        handled: true,
        reply: res.ok
          ? `✔ Booking #${id} cancelled — ${booking.service} ${booking.date} ${booking.time} is free again.`
          : `Couldn't cancel #${id}: ${res.problem}`,
      };
    }

    case 'approve': {
      const id = Number(String(arg).match(/\d+/)?.[0]);
      if (!id) return { handled: true, reply: 'Usage: .approve 12  (see .growth for drafts)' };
      const res = await approveDraft({ id, transport: sock, now: new Date() });
      if (res.ok) return { handled: true, reply: `✔ Draft #${id} sent to +${res.draft.number}.` };
      const why = {
        not_found: `No draft #${id}.`,
        opted_out: 'That person opted out — the draft stays unsent.',
        quiet_hours: 'It is quiet hours there. Try after 09:00.',
        contact_cap: 'They already got a proactive message in the last 24h.',
        daily_cap: "Today's proactive cap is reached.",
        window_closed: 'The Cloud API 24-hour window is closed — they must write first.',
        send_failed: 'Sending failed — check .status and the log.',
      }[res.problem] || `Couldn't send: ${res.problem}`;
      return { handled: true, reply: `⏸ ${why}` };
    }

    case 'skip': {
      const id = Number(String(arg).match(/\d+/)?.[0]);
      if (!id) return { handled: true, reply: 'Usage: .skip 12' };
      const res = skipDraft(id);
      return {
        handled: true,
        reply: res.ok ? `✔ Draft #${id} dropped.` : `Couldn't skip #${id}: ${res.problem}`,
      };
    }

    case 'intents': {
      const counts = intentStatsForDay();
      const { byIntent, bySource } = intentSummary(counts);
      const total = Object.values(byIntent).reduce((a, b) => a + b, 0);
      const lines = [`*Intents today* — ${total} message${total === 1 ? '' : 's'}`];
      lines.push(managerEnabled() ? 'Routing: ✅ on (managerAgent)' : 'Routing: ⏸ off (.set features.managerAgent true)');
      if (!total) {
        lines.push('');
        lines.push('Nothing routed yet today. Counts reset at midnight UTC.');
        return { handled: true, reply: lines.join('\n') };
      }
      lines.push('');
      for (const [intent, count] of Object.entries(byIntent)) {
        if (!count) continue;
        const agent = AGENTS[intent];
        lines.push(`${agent.emoji} *${agent.label}* — ${count}`);
      }
      lines.push('');
      lines.push(`Decided by: ${bySource.rules} rules · ${bySource.cache} remembered · ${bySource.llm} model · ${bySource.fallback} default`);
      if (byIntent.complaint) lines.push(`⚠️ ${byIntent.complaint} complaint${byIntent.complaint === 1 ? '' : 's'} — check your notifications.`);
      return { handled: true, reply: lines.join('\n') };
    }

    case 'knowledge': {
      const sources = knowledgeSources();
      const totals = knowledgeStats();
      const embed = knowledgeEmbeddingStats();
      if (!totals.chunks) {
        return {
          handled: true,
          reply:
            'No documents learned yet.\nFeed it something on the server:\n' +
            '  node scripts/tenant.js learn <slug> menu.pdf\n  node scripts/tenant.js learn <slug> https://your-site.com/services',
        };
      }
      const lines = [`*Knowledge base* — ${totals.sources} documents, ${totals.chunks} chunks`];
      for (const s of sources.slice(0, 12)) {
        lines.push(`• ${String(s.source).replace(/^(file|url|text):/, '')} — ${s.chunks} chunk${s.chunks === 1 ? '' : 's'}`);
      }
      if (sources.length > 12) lines.push(`…and ${sources.length - 12} more`);
      lines.push('');
      lines.push(`Vectors: ${embed.embedded}/${embed.chunks} embedded${embed.pending ? ` (${embed.pending} pending)` : ''}`);
      lines.push(featureOn('rag') ? 'RAG is on — excerpts are used in replies.' : 'RAG is off — turn it on with .set features.rag true');
      return { handled: true, reply: lines.join('\n') };
    }

    case 'features': {
      const current = config.owner.profile?.features || {};
      const on = FEATURE_KEYS.filter((k) => current[k] === true);
      const off = FEATURE_KEYS.filter((k) => current[k] !== true);
      return {
        handled: true,
        reply:
          `*Features on (${on.length}):*\n${on.length ? on.map((k) => `• ${k}`).join('\n') : '—'}\n\n` +
          `*Off (${off.length}):* ${off.join(', ')}\n\n` +
          'Turn one on: .set features.<name> true',
      };
    }

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
        `Routing: ${managerEnabled() ? 'manager agent on' : 'single brain (managerAgent off)'}`,
        ...transportLines(),
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
      if (['week', 'weekly', '7d'].includes(String(args[0] || '').toLowerCase())) {
        const { weeklyReportText } = await import('../services/analystAgent.js');
        return { handled: true, reply: await weeklyReportText(new Date()) };
      }
      return { handled: true, reply: buildReport() };
    }

    // ── phase 3 part 2 ─────────────────────────────────────
    case 'done': {
      const id = Number(args[0]);
      if (!id) return { handled: true, reply: 'Usage: .done 12  (id from .bookings, or an order id from .orders)' };
      const { finishJob } = await import('../services/jobFlow.js');
      const res = finishJob({ id, kind: args[1] || null });
      return { handled: true, reply: res.reply };
    }

    case 'paid': {
      const id = Number(args[0]);
      if (!id) return { handled: true, reply: 'Usage: .paid 12  (only when the money is really in)' };
      const { markOrderPaid } = await import('../services/jobFlow.js');
      const res = markOrderPaid(id);
      return { handled: true, reply: res.reply };
    }

    case 'content': {
      const { contentPackText } = await import('../services/contentAgent.js');
      if (args[0] && !['now', 'week', 'pack'].includes(String(args[0]).toLowerCase())) {
        return { handled: true, reply: 'Usage: .content now  (a fresh pack; the weekly one arrives on its own)' };
      }
      return { handled: true, reply: await contentPackText({ now: new Date() }) };
    }

    case 'rules': {
      const { rulesText } = await import('../services/selfHealing.js');
      return { handled: true, reply: rulesText() };
    }

    case 'approve-rule':
    case 'approve_rule':
    case 'reject-rule':
    case 'reject_rule': {
      const S = await import('../services/selfHealing.js');
      const id = Number(args[0]);
      if (!id) return { handled: true, reply: `Usage: .${cmd} 3   (.rules shows the pending ids)` };
      const res = cmd.startsWith('approve') ? S.approveRule(id) : S.rejectRule(id);
      return { handled: true, reply: res.reply };
    }

    case 'invoice': {
      const I = await import('../services/invoice.js');
      if (!I.pdfInvoicesEnabled()) {
        return {
          handled: true,
          reply: 'PDF documents are off.\nTurn them on with: .set features.pdfInvoices true',
        };
      }
      const id = Number(args[0]);
      if (!id) return { handled: true, reply: 'Usage: .invoice 12   (add "send" to deliver it to the client: .invoice 12 send)' };

      const { getOrder } = await import('../utils/db.js');
      const order = getOrder(id);
      if (!order) return { handled: true, reply: `No order with id ${id}. Check .orders for the ids.` };

      const toClient = String(args[1] || '').toLowerCase() === 'send';
      const jidTo = toClient ? order.chat : chatJid;
      const res = await I.sendInvoice({
        transport: sock,
        jid: jidTo,
        order,
        number: String(order.chat || '').split('@')[0],
      });

      if (!res.ok) {
        // Never pretend it worked. Fall back to the numbers as text.
        const model = res.model || I.invoiceModel({ order });
        return {
          handled: true,
          reply:
            `⚠️ Could not build the PDF (${res.reason || 'unknown'}).\n\n` +
            `${model.label} ${model.invoiceNo}\nTotal: ${model.total || '—'}\n` +
            (model.payment.length ? model.payment.map((r) => `${r.label}: ${r.value}`).join('\n') : ''),
        };
      }

      const model = res.model;
      const where = toClient ? `Sent to +${String(order.chat || '').split('@')[0]}.` : 'Saved and sent here.';
      return {
        handled: true,
        reply:
          `${model.label} ${model.invoiceNo} · ${model.total}\n${where}` +
          (toClient ? '' : `\n.invoice ${id} send → deliver it to the client`),
      };
    }

    case 'campaign': {
      const R = await import('../services/reactivationAgent.js');
      const action = String(args[0] || '').toLowerCase();

      if (!action || action === 'preview' || action === 'status') {
        const state = R.campaignStatus();
        if (state && state.status === 'running' && action === 'status') {
          return {
            handled: true,
            reply: `📣 Campaign running: ${state.sent} sent, ${state.skipped} skipped of ${state.total}.\n.campaign stop to halt.`,
          };
        }
        return { handled: true, reply: R.previewText(new Date()) };
      }

      if (action === 'send' || action === 'start') {
        const res = R.startCampaign({ now: new Date() });
        if (!res.ok) {
          return {
            handled: true,
            reply:
              res.reason === 'disabled'
                ? 'Reactivation is off. Turn it on first: .set features.reactivationAgent true'
                : 'Nobody to message right now — run .campaign preview to see why.',
          };
        }
        return {
          handled: true,
          reply: `📣 Campaign started for ${res.campaign.total} people.\nSlow and jittered on purpose — the first message goes out within a few minutes.\n.campaign stop halts it immediately.`,
        };
      }

      if (action === 'stop') {
        const res = R.stopCampaign();
        return { handled: true, reply: res.ok ? '📣 Campaign stopped.' : 'No campaign is running.' };
      }

      return { handled: true, reply: 'Usage: .campaign preview | send | stop' };
    }

    case 'referrals': {
      const rows = recentReferrals(15);
      const attributed = all("SELECT number, detail FROM events WHERE type = 'referral_attributed' ORDER BY id DESC LIMIT 10");
      if (!rows.length && !attributed.length) {
        return { handled: true, reply: 'No referral codes yet — they are created after a good rating (features.reviewAgent).' };
      }
      const lines = ['*Referral codes*'];
      for (const r of rows) {
        const c = getContact(r.number);
        lines.push(`• ${r.code} — ${c?.name || c?.push_name || `+${r.number}`} · used ${r.uses || 0}x`);
      }
      if (attributed.length) {
        lines.push('');
        lines.push('*Arrived with a code*');
        for (const a of attributed) {
          let detail = a.detail;
          try { detail = JSON.parse(a.detail)?.code || detail; } catch { /* plain text */ }
          lines.push(`• +${a.number} ← ${detail}`);
        }
      }
      return { handled: true, reply: lines.join('\n') };
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
