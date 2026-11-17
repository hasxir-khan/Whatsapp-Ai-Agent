// src/services/report.js
// Daily digest for the owner: who messaged, what they want, which quotes went
// out, what needs his attention, and how much of the free quota got used.

import { config } from '../config/env.js';
import {
  all, get, getSetting, setSetting, getUsage, usageHistory, dbStats,
} from '../utils/db.js';
import { formatMoney } from './geo.js';
import { ownerClock } from '../core/humanizer.js';

const startOfToday = () => {
  const now = new Date();
  // Use the owner's local day, not UTC
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  return `${parts}T00:00:00.000Z`;
};

function count(sql, params = []) {
  return get(sql, params)?.c || 0;
}

export function buildReport() {
  const since = startOfToday();
  const messages = count('SELECT COUNT(*) AS c FROM messages WHERE role = ? AND created_at >= ?', ['user', since]);
  const chats = count('SELECT COUNT(DISTINCT number) AS c FROM messages WHERE role = ? AND created_at >= ?', ['user', since]);
  const newContacts = count('SELECT COUNT(*) AS c FROM contacts WHERE first_seen >= ?', [since]);
  const quotes = count("SELECT COUNT(*) AS c FROM events WHERE type = 'quote_sent' AND created_at >= ?", [since]);
  const followups = count("SELECT COUNT(*) AS c FROM events WHERE type = 'followup_sent' AND created_at >= ?", [since]);
  const escalated = count("SELECT COUNT(*) AS c FROM events WHERE type = 'escalation' AND created_at >= ?", [since]);
  const blocked = count("SELECT COUNT(*) AS c FROM events WHERE type = 'contact_blocked' AND created_at >= ?", [since]);

  const leads = all(
    "SELECT number, name, project_type, quote_min, quote_max, quote_currency, status FROM leads WHERE created_at >= ? OR updated_at >= ? ORDER BY updated_at DESC LIMIT 8",
    [since, since]
  );

  const escalations = all(
    "SELECT number, detail FROM events WHERE type = 'escalation' AND created_at >= ? ORDER BY id DESC LIMIT 5",
    [since]
  );

  const usage = getUsage();
  const stats = dbStats();

  const lines = [];
  const now = ownerClock();
  lines.push(`📊 *Daily brief* — ${new Date().toDateString()}`);
  lines.push('');
  lines.push(`💬 ${messages} client messages · ${chats} chats`);
  lines.push(`🆕 ${newContacts} new contacts · 💼 ${leads.length} active leads`);
  lines.push(`💰 ${quotes} quotes sent · ⏰ ${followups} follow-ups sent`);

  if (leads.length) {
    lines.push('');
    lines.push('*Leads:*');
    for (const lead of leads) {
      const who = lead.name || `+${lead.number}`;
      const price = lead.quote_min
        ? ` · ${formatMoney(lead.quote_min, lead.quote_currency || 'PKR')}–${formatMoney(lead.quote_max, lead.quote_currency || 'PKR')}`
        : '';
      lines.push(`• ${who} — ${lead.project_type || 'project'}${price} (${lead.status})`);
    }
  }

  if (escalated) {
    lines.push('');
    lines.push(`⚠️ ${escalated} chat(s) need you:`);
    for (const row of escalations) {
      const detail = safeParse(row.detail);
      lines.push(`• +${row.number}${detail?.reason ? ` — ${detail.reason}` : ''}`);
    }
  }

  if (blocked) lines.push(`\n🚫 ${blocked} scam number(s) blocked`);

  lines.push('');
  lines.push(`🧠 Memory: ${stats.contacts} contacts · ${stats.messages} messages · ${stats.leads} leads`);
  lines.push(
    `📈 Quota today: ${usage.llm_calls}/${config.limits.dailyLlmCalls} AI calls · ${usage.vision_calls}/${config.limits.dailyVisionCalls} images · ${Math.round(usage.stt_seconds)}s audio`
  );
  lines.push(`🕐 ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')} ${config.timezone}`);

  return lines.join('\n');
}

function safeParse(v) {
  try {
    return JSON.parse(v);
  } catch {
    return { reason: v };
  }
}

export function startDailyReport(sock) {
  if (!config.report.enabled) return null;

  const tick = async () => {
    const now = ownerClock();
    const today = new Date().toISOString().slice(0, 10);
    if (now.hour !== config.report.hour) return;
    if (getSetting('last_daily_report') === today) return;

    try {
      const text = buildReport();
      await sock.sendMessage(config.owner.jid, { text });
      setSetting('last_daily_report', today);
      console.log('📊 Daily report sent');
    } catch (err) {
      console.error('Daily report error:', err.message);
    }
  };

  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  console.log(`📊 Daily report scheduled for ${String(config.report.hour).padStart(2, '0')}:00 ${config.timezone}`);
  return timer;
}

export function usageTable(days = 7) {
  return usageHistory(days);
}

export default { buildReport, startDailyReport, usageTable };
