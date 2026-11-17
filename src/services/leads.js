// src/services/leads.js
// Lead intelligence: a score you can argue with, and a next action you can act on.
//
// Every lead is graded from the conversation itself — how complete the scope is,
// whether there is a real budget, how engaged they are, whether a quote went out
// and how fresh it all is. Nothing is invented: if a signal is missing, the lead
// simply scores lower and the next action says what to ask for.

import { config } from '../config/env.js';
import {
  listLeads, getLead, getContact, getIntake, saveLead,
} from '../utils/db.js';
import { parseBudget } from '../core/pricing.js';
import { toPkr } from './geo.js';

const DAY = 86400000;

const PRIORITIES = {
  hot: { label: 'HOT', emoji: '🔥' },
  warm: { label: 'WARM', emoji: '🌤️' },
  cold: { label: 'COLD', emoji: '❄️' },
};

function servicesList() {
  return config.owner.profile?.owner?.services || [];
}

/** Find the service this lead is about, by name or keyword. */
export function serviceFor(projectType = '') {
  const needle = String(projectType || '').toLowerCase().trim();
  if (!needle) return null;
  const services = servicesList();
  return (
    services.find((s) => String(s.name || '').toLowerCase() === needle) ||
    services.find((s) => String(s.id || '').toLowerCase() === needle) ||
    services.find((s) =>
      [...(s.keywords || []), s.name, s.id].filter(Boolean).some((k) => needle.includes(String(k).toLowerCase()))
    ) ||
    null
  );
}

const has = (v) => v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim() !== '{}' && String(v).trim() !== '[]';

/**
 * @param {{lead?:object, contact?:object, intakeFields?:object, facts?:Array, now?:number}} input
 * @returns {{score:number, priority:'hot'|'warm'|'cold', reasons:string[], risks:string[], nextAction:string, staleDays:number|null}}
 */
export function scoreLead({ lead = {}, contact = {}, intakeFields = {}, now = Date.now() } = {}) {
  const fields = { ...(intakeFields || {}) };
  for (const key of ['project_type', 'goal', 'features', 'timeline', 'budget', 'design', 'content', 'tech']) {
    if (!has(fields[key]) && has(lead[key])) fields[key] = lead[key];
  }

  const reasons = [];
  const risks = [];
  let score = 0;

  // 1. Scope completeness — max 30
  const parts = [
    ['project_type', 8, 'what they want built'],
    ['goal', 6, 'why they want it'],
    ['features', 8, 'features'],
    ['timeline', 5, 'timeline'],
    ['design', 2, 'design direction'],
    ['content', 1, 'content readiness'],
  ];
  let scope = 0;
  const missing = [];
  for (const [key, points, label] of parts) {
    if (has(fields[key])) scope += points;
    else missing.push(label);
  }
  score += Math.min(30, scope);
  if (scope >= 22) reasons.push('scope is clear');
  if (missing.length && missing.length <= 2) risks.push(`missing ${missing.join(' + ')}`);

  // 2. Budget — max 25
  const budget = parseBudget(fields.budget);
  if (budget?.amount) {
    score += 10;
    reasons.push(`budget stated (${budget.currency})`);

    const service = serviceFor(fields.project_type);
    const targetMin = service?.min || null;
    if (targetMin) {
      if (budget.amount >= targetMin) {
        score += 15;
        reasons.push('budget fits the range');
      } else if (budget.amount >= targetMin * 0.5) {
        score += 8;
        risks.push('budget is below the usual range');
      } else {
        risks.push('budget is far below the range — qualify before quoting');
      }
    }
  } else {
    risks.push('no budget mentioned');
  }

  // 3. Engagement — max 10
  const msgs = Number(contact.message_count || 0);
  if (msgs >= 15) score += 10;
  else if (msgs >= 8) score += 8;
  else if (msgs >= 3) score += 5;
  else if (msgs >= 1) score += 2;
  if (msgs >= 8) reasons.push('actively chatting');

  // 4. Commitment — max 14
  const status = String(lead.status || 'new').toLowerCase();
  if (has(lead.quote_min)) {
    score += 8;
    reasons.push('quote sent');
  }
  if (status === 'negotiating') {
    score += 6;
    reasons.push('negotiating');
  }
  if (status === 'won') {
    score += 5;
    reasons.push('closed');
  }
  if (status === 'lost') {
    score -= 25;
    risks.push('marked lost');
  }

  // 5. Recency — up to +7, down to −12
  const lastSeen = contact.last_seen || lead.updated_at || lead.created_at || null;
  let staleDays = null;
  if (lastSeen) {
    const age = Math.max(0, now - new Date(lastSeen).getTime());
    staleDays = Math.floor(age / DAY);
    if (age <= DAY) {
      score += 7;
      reasons.push('active in the last 24h');
    } else if (age <= 3 * DAY) score += 5;
    else if (age <= 7 * DAY) score += 2;
    else if (age > 14 * DAY) {
      score -= 12;
      risks.push(`silent for ${staleDays} days`);
    }
  } else {
    risks.push('never replied');
  }

  // 6. Context — max 3
  if (has(lead.country) || has(contact.country)) score += 2;
  if (has(lead.company)) score += 1;

  score = Math.max(0, Math.min(100, Math.round(score)));

  const priority = score >= 65 ? 'hot' : score >= 35 ? 'warm' : 'cold';
  const nextAction = nextActionFor({ lead, contact, fields, budget, status, staleDays, priority });

  return { score, priority, reasons, risks, nextAction, staleDays };
}

function nextActionFor({ lead, fields, budget, status, staleDays, priority }) {
  if (status === 'won') return 'Ask for a testimonial, then a referral';
  if (status === 'lost') return 'Move to nurture — retry in a month';

  if (staleDays !== null && staleDays >= 7 && status !== 'quoted') {
    return 'Nudge with one useful idea (no pitch)';
  }
  if (status === 'negotiating') return 'You should call or close the deal yourself';

  if (!has(lead.quote_min)) {
    if (!budget?.amount) return 'Ask for a budget range';
    if (!has(fields.timeline)) return 'Ask when they want it live';
    return 'Scope is ready — send the quote (.quote 92…)';
  }

  if (staleDays !== null && staleDays >= 1) return 'Follow up on the quote today';
  if (priority === 'hot') return 'Lock the start date and take the advance';
  return 'Answer their questions and keep it warm';
}

/** Score every lead and return them best-first. */
export function rankLeads({ status = null, limit = 100 } = {}) {
  return listLeads(status, limit)
    .map((lead) => {
      const contact = getContact(lead.number) || {};
      const intake = getIntake(lead.number) || {};
      const scored = scoreLead({ lead, contact, intakeFields: intake.fields || {} });
      return {
        ...lead,
        ...scored,
        contact,
        // keep the persisted status, not the computed one
        status: lead.status || 'new',
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** Recompute and persist a lead's score (call after quotes, replies, stage changes). */
export function refreshLead(number) {
  const lead = getLead(number);
  if (!lead) return null;
  const contact = getContact(number) || {};
  const intake = getIntake(number) || {};
  const scored = scoreLead({ lead, contact, intakeFields: intake.fields || {} });
  saveLead({
    number,
    score: scored.score,
    priority: scored.priority,
    next_action: scored.nextAction,
  });
  return { ...lead, ...scored };
}

export function priorityMeta(priority = 'cold') {
  return PRIORITIES[priority] || PRIORITIES.cold;
}

/** One line for .leads */
export function leadLine(lead) {
  const who = lead.name || `+${lead.number}`;
  const money = lead.quote_min
    ? ` · ${lead.quote_min}–${lead.quote_max} ${lead.quote_currency || 'PKR'}`
    : '';
  const meta = priorityMeta(lead.priority);
  const stale = lead.staleDays !== null && lead.staleDays >= 7 ? ` · ${lead.staleDays}d quiet` : '';
  return `${meta.emoji} ${lead.score} ${who} — ${lead.project_type || 'unknown'}${money} · ${lead.status}${stale}\n    → ${lead.nextAction}`;
}

/** Top-of-funnel numbers for the daily brief and the dashboard. */
export function pipelineSummary() {
  const leads = rankLeads({ limit: 500 });
  const byPriority = { hot: 0, warm: 0, cold: 0 };
  const byStatus = {};
  for (const lead of leads) {
    byPriority[lead.priority] = (byPriority[lead.priority] || 0) + 1;
    byStatus[lead.status] = (byStatus[lead.status] || 0) + 1;
  }
  // Quotes are stored in the client's currency — bring them back to PKR
  const valuePkr = leads
    .filter((l) => l.quote_min && l.status !== 'lost')
    .reduce(
      (sum, l) => sum + (toPkr(l.quote_min, l.quote_currency || 'PKR') + toPkr(l.quote_max, l.quote_currency || 'PKR')) / 2,
      0
    );
  return {
    total: leads.length,
    byPriority,
    byStatus,
    top: leads.slice(0, 3),
    valuePkr: Math.round(valuePkr),
    needsAction: leads.filter((l) => l.status !== 'won' && l.status !== 'lost').slice(0, 5),
  };
}

export default { scoreLead, rankLeads, refreshLead, leadLine, pipelineSummary, serviceFor, priorityMeta };
