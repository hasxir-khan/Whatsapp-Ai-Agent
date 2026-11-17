// src/services/followUpAgent.js
// The follow-up agent (Phase 3, behind features.followUpAgent).
//
// A lead goes quiet after a quote or a question. This agent writes *one short
// message* that proves a human was listening — their name, what they asked
// about, one clear question — and then gets out of the way.
//
// It supersedes the older generic nudge loop when its flag is on:
//   • triggers at 24h and 72h of silence, never more than twice
//   • only for leads above a configurable score
//   • personalised from what they actually said, in their language
//   • never quotes a price that is not in the catalogue
//   • stops dead on a reply, an opt-out, or an owner takeover
//   • drafts wait for the owner (.approve / .skip) unless they opt out of that

import { config } from '../config/env.js';
import { business, featureOn, effectiveCatalog } from './profile.js';
import { sendProactively, nextAllowedMoment } from './growth.js';
import { formatMoney } from './geo.js';
import { logEvent } from '../utils/db.js';
import {
  all, getContact, getLead, getIntake, getMessages, saveLead, isOptedOut,
  addDraft, getDraft, pendingDrafts, pendingDraftFor, setDraftStatus, cancelDraftsFor,
} from '../utils/db.js';

const HOUR = 3600 * 1000;

export function followUpAgentEnabled() {
  return featureOn('followUpAgent');
}

/** Approval mode: on by default, off only when the owner says so. */
export function approvalRequired() {
  return featureOn('growthApproval');
}

// ── who is quiet ───────────────────────────────────────────
/**
 * Leads worth a nudge right now.
 * @returns {Array<{number, contact, lead, stage, attempt, silentHours}>}
 */
export function candidates(now = new Date()) {
  const minScore = config.growth.followUpMinScore;
  const stages = [...config.growth.followUpAfterHours].sort((a, b) => a - b); // [24, 72]
  const out = [];

  const leads = all("SELECT * FROM leads WHERE status IN ('quoted','contacted','new','negotiating') ORDER BY score DESC LIMIT 200");

  for (const lead of leads) {
    const number = lead.number;
    if (!number) continue;

    const contact = getContact(number);
    if (!contact) continue;
    if (contact.is_blocked) continue;
    if (isOptedOut(number)) continue; // "stop" is forever, not until the next stage
    if (contact.bot_paused_until && new Date(contact.bot_paused_until) > now) continue; // owner has it
    if (contact.assigned_to) continue; // a teammate owns this chat

    if ((lead.score || 0) < minScore) continue;

    const lastSeen = new Date(contact.last_seen || contact.last_message_at || lead.updated_at || 0).getTime();
    if (!lastSeen) continue;
    const silentHours = (now.getTime() - lastSeen) / HOUR;

    // Which trigger does this silence fall into? 24h fires between 24h and 72h;
    // 72h fires after that. Nothing fires twice for the same stage.
    let stage = null;
    if (silentHours >= stages[1]) stage = stages[1];
    else if (silentHours >= stages[0]) stage = stages[0];
    if (!stage) continue;

    const sent = followUpCount(number);
    if (sent >= config.growth.followUpMax) {
      markCold(lead);
      continue;
    }

    // Do not draft a second time while one is waiting, or for a stage already done.
    if (pendingDraftFor(number, 'followup')) continue;
    if (stageAlreadyDone(number, stage)) continue;

    out.push({ number, contact, lead, stage, attempt: sent + 1, silentHours });
  }

  return out;
}

function followUpCount(number) {
  const row = all(
    "SELECT COUNT(*) AS n FROM growth_sends WHERE number = ? AND agent = 'followup' AND result = 'sent'",
    [number]
  )[0];
  return row?.n || 0;
}

function stageAlreadyDone(number, stage) {
  // The reason string carries the stage ("quiet 24h"), so a restart never repeats one.
  return all("SELECT reason FROM growth_sends WHERE number = ? AND agent = 'followup'", [number]).some((r) =>
    String(r.reason || '').includes(`${stage}h`)
  );
}

function markCold(lead) {
  if (lead.status === 'cold') return;
  saveLead({ number: lead.number, status: 'cold' });
  logEvent('lead_cold', lead.number, { reason: 'follow-ups exhausted' });
}

// ── the message ────────────────────────────────────────────
/** The last question this person asked, shortened — the hook for the nudge. */
export function lastQuestion(number) {
  const rows = getMessages(number, 30).filter((m) => m.role === 'user' && m.content);
  const question = [...rows].reverse().find((m) => /\?/.test(m.content));
  const source = question || rows[rows.length - 1];
  if (!source) return null;
  const text = String(source.content).replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function firstName(contact = {}) {
  const raw = contact.name || contact.push_name || '';
  return String(raw).split(' ')[0] || '';
}

/** A price is only ever mentioned when the catalogue actually has the item. */
export function catalogPrice(itemName) {
  if (!itemName) return null;
  const items = effectiveCatalog();
  const needle = String(itemName).toLowerCase();
  const item = items.find((i) => String(i.name || '').toLowerCase().includes(needle) || needle.includes(String(i.name || '').toLowerCase()));
  if (!item) return null;
  const price = item.price ?? item.min;
  if (!price) return null;
  return formatMoney(Number(price), business().currency || 'PKR');
}

/**
 * Build the nudge. Deterministic: no tokens, no invention, same input → same
 * message.
 */
export function buildFollowUp({ contact = {}, lead = {}, stage = 24, attempt = 1 } = {}) {
  const lang = contact.language || 'en';
  const name = firstName(contact);
  const item = lead.project_type || lead.quote_item || null;
  const asked = lastQuestion(lead.number || contact.number);
  const price = item ? catalogPrice(item) : null;

  const hi = name ? `Hi ${name}` : 'Hi';

  // What we are nudging about: the thing they asked, else the thing we quoted.
  const topic = asked && asked.length > 12 ? `"${asked}"` : item ? item : null;

  if (attempt >= 2) {
    // Second and final nudge: give them an easy way out.
    if (lang === 'ur') {
      return topic
        ? `${name ? name + ' صاحب، ' : ''}آپ نے ${topic} کے بارے میں پوچھا تھا۔ کیا یہ ابھی زیرِ غور ہے یا میں فائل بند کر دوں؟`
        : `${name ? name + ' صاحب، ' : ''}کیا یہ ابھی زیرِ غور ہے یا میں فائل بند کر دوں؟`;
    }
    if (lang === 'roman-ur') {
      return topic
        ? `${hi} — aap ne ${topic} poocha tha. Abhi bhi consider kar rahe hain ya file band kar dun?`
        : `${hi} — abhi bhi consider kar rahe hain ya file band kar dun?`;
    }
    return topic
      ? `${hi} — you asked me about ${topic}. Still worth pursuing, or should I close the file?`
      : `${hi} — still worth pursuing, or should I close the file?`;
  }

  if (lang === 'ur') {
    return topic
      ? `${name ? name + ' صاحب، ' : ''}آپ نے ${topic} کے بارے میں پوچھا تھا${price ? ` (${price})` : ''}۔ کیا آگے بڑھیں؟`
      : `${name ? name + ' صاحب، ' : ''}کیا آگے بڑھیں؟`;
  }
  if (lang === 'roman-ur') {
    return topic
      ? `${hi} — aap ne ${topic} poocha tha${price ? ` (${price})` : ''}. Aage barhein?`
      : `${hi} — aage barhein?`;
  }
  return topic
    ? `${hi} — you asked about ${topic}${price ? ` (${price})` : ''}. Shall we go ahead?`
    : `${hi} — shall we go ahead?`;
}

// ── drafting and sending ───────────────────────────────────
/**
 * Work out the drafts for this moment. With approval on they wait for the
 * owner; with it off they go out immediately.
 */
export async function runFollowUpAgent({ transport, now = new Date(), dryRun = false } = {}) {
  if (!followUpAgentEnabled()) return { drafted: 0, sent: 0, skipped: 0 };

  if (inApprovalLimbo(now)) return { drafted: 0, sent: 0, skipped: 0 };

  const list = candidates(now);
  const results = { drafted: 0, sent: 0, skipped: 0, drafts: [] };

  for (const candidate of list) {
    const text = buildFollowUp({
      contact: candidate.contact,
      lead: { ...candidate.lead, number: candidate.number },
      stage: candidate.stage,
      attempt: candidate.attempt,
    });
    const reason = `quiet ${candidate.stage}h · score ${candidate.lead.score}`;

    if (dryRun) {
      results.drafts.push({ number: candidate.number, text, reason });
      continue;
    }

    if (approvalRequired()) {
      const draft = addDraft({ number: candidate.number, agent: 'followup', kind: 'followup', text, reason });
      results.drafted += 1;
      results.drafts.push(draft);
      logEvent('followup_drafted', candidate.number, { draft: draft.id, stage: candidate.stage });
      await notifyOwnerOfDraft(transport, draft);
      continue;
    }

    const outcome = await sendProactively({
      transport,
      number: candidate.number,
      text,
      agent: 'followup',
      reason,
      now,
    });

    if (outcome.sent) results.sent += 1;
    else results.skipped += 1;
  }

  return results;
}

/**
 * Drafting itself is work we should not do in the middle of the night: the
 * owner would wake up to a pile of stale drafts. One quiet-hours check.
 */
function inApprovalLimbo(now) {
  const later = nextAllowedMoment(now);
  return later.getTime() > now.getTime();
}

async function notifyOwnerOfDraft(transport, draft) {
  if (!transport || !draft) return;
  const contact = getContact(draft.number);
  const who = contact?.name || contact?.push_name || `+${draft.number}`;
  const text =
    `📝 Follow-up draft #${draft.id} for ${who} (+${draft.number})\n\n"${draft.text}"\n\n` +
    `.approve ${draft.id} to send · .skip ${draft.id} to drop`;
  try {
    await transport.sendMessage(config.owner.jid, { text });
  } catch (err) {
    logEvent('followup_notify_failed', draft.number, err.message);
  }
}

/** .approve <id> */
export async function approveDraft({ id, transport, now = new Date() }) {
  const draft = getDraft(id);
  if (!draft) return { ok: false, problem: 'not_found' };
  if (draft.status !== 'pending') return { ok: false, problem: `already_${draft.status}`, draft };

  const outcome = await sendProactively({
    transport,
    number: draft.number,
    text: draft.text,
    agent: draft.agent || 'followup',
    reason: draft.reason || 'owner approved',
    now,
  });

  if (!outcome.sent) {
    return { ok: false, problem: outcome.reason, detail: outcome.detail, draft };
  }

  setDraftStatus(id, 'sent', { sentAt: new Date().toISOString() });
  logEvent('followup_approved', draft.number, { draft: id });
  return { ok: true, draft: getDraft(id) };
}

export function skipDraft(id) {
  const draft = getDraft(id);
  if (!draft) return { ok: false, problem: 'not_found' };
  if (draft.status !== 'pending') return { ok: false, problem: `already_${draft.status}`, draft };
  setDraftStatus(id, 'skipped');
  logEvent('followup_skipped', draft.number, { draft: id });
  return { ok: true, draft: getDraft(id) };
}

/** The customer replied / asked to stop / the owner took over → drop it. */
export function cancelFor(number, reason = 'cancelled') {
  const count = cancelDraftsFor(number, reason);
  if (count) logEvent('followup_cancelled', number, { reason, count });
  return count;
}

export function startFollowUpAgentLoop(transport, { intervalMs = 15 * 60_000 } = {}) {
  if (!followUpAgentEnabled()) return null;

  const tick = async () => {
    try {
      await runFollowUpAgent({ transport });
    } catch (err) {
      logEvent('followup_agent_error', null, err.message);
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 20_000).unref?.();
  console.log('✍️  Follow-up agent loop started');
  return timer;
}

export { pendingDrafts };

export default {
  followUpAgentEnabled, approvalRequired, candidates, buildFollowUp, catalogPrice,
  runFollowUpAgent, approveDraft, skipDraft, cancelFor, startFollowUpAgentLoop,
};
