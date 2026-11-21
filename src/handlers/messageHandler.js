// src/handlers/messageHandler.js
// The router. One incoming WhatsApp message enters here; everything the
// assistant can do (listen, see, read, remember, quote, speak) is stitched
// together below.
//
// Ground rules enforced here, before any AI is called:
//   • groups, channels, broadcasts and status updates are ignored outright
//   • the bot never talks over the owner (handoff) and never answers a paused chat
//   • scam patterns are filtered, but normal clients (links, caps, short
//     messages) are never punished

import { handleMediaTurn, mediaIngressGuard, resumeDeferredMedia, protectedVideo, protectedTurn } from './mediaTurn.js';
import { config, isFriend, friendName, isTeam, teamMember, teamMembers } from '../config/env.js';
import { normalizeBaileys } from '../transport/baileys.js';
import { normalizeIncoming } from '../transport/base.js';
import * as db from '../utils/db.js';
import * as media from '../services/media.js';
import { detectLanguage, detectTone, fromWhisperLanguage } from '../services/language.js';
import { generateReply, detectMood, needsOwner } from '../core/brain.js';
import { routeMessage, managerEnabled } from '../core/manager.js';
import * as reasoningModule from '../services/reasoning.js';
import * as keyChain from '../services/keyChain.js';
import { agentsEnabled, routeToAgent, logAgentEvent, noteAgentSuccess, noteAgentFailure, noteAgentTokens } from '../services/agents.js';
import { emergencyGuardEnabled, detectEmergency, emergencyReply, emergencyContact } from '../services/agentPacks.js';
import { workerAccess } from '../services/billingLease.js';
import { admit, handover } from '../services/billingMeter.js';
import { detectOptOut, detectOptIn, recordOptOut, recordOptIn, optOutConfirmation } from '../services/growth.js';
import {
  privacyEnabled as privacyToolsEnabled,
  isDeletionRequest,
  requestDeletion,
  deletionAcknowledgement,
} from '../services/privacy.js';
import { isOrderQuestion, orderStatusAnswer, orderTrackingEnabled } from '../services/orders.js';
import { bookingAgentEnabled, handleBookingTurn } from '../services/bookingAgent.js';
import { jidForms } from '../services/transportAudit.js';
import { featureOn } from '../services/profile.js';
import { alternateJid } from '../services/typingTest.js';
import { cancelFor as cancelFollowUpDrafts } from '../services/followUpAgent.js';
import { closerAgentEnabled, handleCloserTurn, readyToBuy, startOrder, handleReceipt } from '../services/closerAgent.js';
import { reviewAgentEnabled, handleRating, attributeReferral } from '../services/reviewAgent.js';
import { recordSourceTag } from '../services/growthDashboard.js';
import { sourceLinksEnabled, stripSourceMarker, attributeSource } from '../services/sourceLinks.js';
import {
  toolCallingEnabled, hasPendingConfirmation, confirmPending, cancelPending,
  isAffirmative, isNegative,
} from '../core/tools.js';
import { ingest, markAsked, markQuoted, getState, mergeExternalFields } from '../core/projectIntake.js';
import { buildQuote, formatQuote } from '../core/pricing.js';
import { createReplyChannel, beginBatch, batchIdOf } from '../core/replyChannel.js';
import { guardReply, safeLine, rememberClaims, voiceOf } from '../core/replyGuard.js';
import { scopeGuard } from '../core/scope.js';
import { controlEnabled, conversationSettings } from '../services/conversation.js';
import { decide, recordDecision } from '../services/decision.js';
import * as briefs from '../services/brief.js';
import { collectorTurn, conflictTurn } from '../services/collector.js';
import { asksPrice, asksPriceQuestion, hasPublishedPrices, noGuessLine, ownerTaskText, unansweredPolicy } from '../services/noGuess.js';
import { replyLanguage } from '../services/languageStick.js';
import * as memory from '../services/memory.js';
import { sendHuman, sendTyping, sendReaction, markRead, scheduleRead, isQuietNow, quietEndsAt } from '../core/humanizer.js';
import {
  asksIfBot,
  honestBotAnswer,
  shouldReactOnly,
  ackReaction,
  humanTouchEnabled,
  ownerIsActive,
} from '../core/humanTouch.js';
import { replyTiming, createTypingSession } from '../core/timing.js';
import * as timeline from '../services/timeline.js';
import { transcribe, sttEnabled, looksMeaningful } from '../services/transcription.js';
import { visionEnabled, analyzeImage } from '../services/vision.js';
import { understandVideo, videoCapabilities } from '../services/video.js';
import { ttsEnabled, buildVoiceNote, shouldSpeak, speechTextFor } from '../services/tts.js';
import { extractText, summarizeDocument, extractProjectBrief, looksLikeBrief, understoodReply } from '../services/documents.js';
import { scheduleFollowUp, cancelFor } from '../services/followUps.js';
import { analyze as spamAnalyze, applyAction, WARN_MESSAGE } from '../services/spamGuard.js';
import { rememberMessage } from '../services/deletedMessages.js';
import { handleOwnerCommand, isCommand } from './ownerCommands.js';
import { saveLeadToSheet } from '../services/sheets.js';
import { refreshLead } from '../services/leads.js';
import { lookupNumber } from '../services/geo.js';

// ── per-chat message buffering (humans don't reply to every single line) ──
const buffers = new Map();
const processedIds = new Set();
const ownSentIds = new Set();

function track(set, id) {
  if (!id) return;
  set.add(id);
  if (set.size > 800) {
    const first = set.values().next().value;
    set.delete(first);
  }
}

export function noteSent(ids = []) {
  for (const id of ids) if (id) track(ownSentIds, id);
}

const isPaused = (contact) =>
  !!(contact?.bot_paused_until && new Date(contact.bot_paused_until) > new Date());

// ════════════════════════════════════════════════════════════
// The clock
// ════════════════════════════════════════════════════════════
/**
 * The time a turn happens at. Production never passes anything, so this is the
 * real clock and nothing changes. Tests and the eval harness pass a fixed
 * instant so a conversation that says "tomorrow at 11" means the same thing
 * every day the suite runs.
 *
 * @param {Date|number|string|null} now  a fixed instant, or null for the real clock
 * @returns {() => Date} a clock; a fixed one returns the same instant every call
 */
export function makeClock(now = null) {
  if (now === null || now === undefined) return () => new Date();
  const fixed = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return () => new Date(fixed);
}

const realClock = makeClock(null);

// ════════════════════════════════════════════════════════════
// Entry point — called for every upserted message
// ════════════════════════════════════════════════════════════
export async function handleIncoming(transport, rawIncoming, { now = null } = {}) {
  const clock = makeClock(now);
  try {
    // The handler only ever sees the internal shape. A Baileys message handed
    // in directly (tests, older callers) is normalised at the door, exactly
    // like the Baileys transport would have done it.
    const incoming = rawIncoming?.key ? normalizeBaileys(rawIncoming) : normalizeIncoming(rawIncoming || {});
    if (!incoming.chat || !incoming.number) return;

    const msgId = incoming.id;
    if (msgId && processedIds.has(msgId)) return;
    track(processedIds, msgId);

    const jid = incoming.chat;
    const kind = media.chatKind(jid);

    // ── only 1-to-1 chats are allowed, ever ────────────────
    if (kind !== 'private') {
      if (kind === 'group' || kind === 'newsletter') {
        db.logEvent('ignored_chat', null, { kind, jid });
      }
      return;
    }

    // A protected clip caption is transient too. Do not put it in deleted
    // message recovery, quiet-hours payloads, source attribution or previews.
    const privateInput = protectedTurn(incoming);
    const info = privateInput ? { ...incoming, text: '', caption: '' } : incoming;
    const number = incoming.number;

    const lease = workerAccess(clock());
    if (lease) {
      const customer = !incoming.fromMe && number !== config.owner.number && !isTeam(number);
      const stop = customer && detectOptOut(info.text || info.caption || '');
      if (!lease.canRun || (customer && !stop && (!admit('chat', 1, number, clock()) || (info.kind === 'video' && !admit('video', 1, '', clock()))))) {
        if (stop) recordOptOut(number);
        else if (customer) await handover(transport, jid, number, clock());
        return;
      }
    }
    // ── the owner's own messages ───────────────────────────
    if (incoming.fromMe) {
      if (ownSentIds.has(msgId)) return; // our own send echoed back
      return await handleOwnerSide(transport, { jid, number, info, incoming, clock });
    }

    if (number === config.owner.number) {
      // Message to yourself from another device
      if (isCommand(info.text)) return await runCommand(transport, jid, info.text, number);
      return;
    }

    // ── team members (multi-user) ──────────────────────────
    // A teammate messaging the bot is an operator, never a client.
    if (isTeam(number)) {
      return await handleTeammate(transport, jid, number, info);
    }

    // ── a tracked link or QR left its mark in the message ──
    // The marker is data for us and noise for everyone else, so it comes out
    // before memory, the guards, intake or the model see the text. A malformed
    // marker is removed too: a customer should never be shown the machinery.
    let sourceCode = null;
    let sourceMarkerSeen = false;
    if (sourceLinksEnabled() && (info.text || info.caption)) {
      const stripped = stripSourceMarker(info.text || info.caption);
      if (stripped.found) {
        sourceMarkerSeen = true;
        sourceCode = stripped.code;
        if (info.text) info.text = stripped.text;
        if (info.caption) info.caption = stripped.text;
      }
    }

    // ── bookkeeping ────────────────────────────────────────
    // Only transports that can report a deletion are worth remembering.
    if (!privateInput && transport.can?.('deletedMessages') !== false && incoming.raw) rememberMessage(incoming.raw);

    const existing = db.getContact(number);
    const friend = isFriend(number);
    const contact = db.upsertContact(number, {
      jid,
      push_name: incoming.pushName || existing?.push_name || null,
      name: existing?.name || friendName(number) || incoming.pushName || null,
      category: friend ? 'friend' : existing?.category || 'new',
      increment_messages: true,
    });

    if (contact?.is_blocked) return;
    if (db.getSetting('bot_enabled', true) !== true) return;

    if (privateInput && await mediaIngressGuard({ sock: transport, jid, number, contact, incoming, noteSent })) return;

    // ── "stop" means stop ──────────────────────────────────
    // Checked before the AI, before intake, before anything can decide to be
    // clever. It is honoured instantly: pending drafts die here.
    const said = (info.text || info.caption || '').trim();
    if (said && detectOptOut(said)) {
      // Conversation Control: an opt-out is a decision too, and it is never an
      // ignore. Logged here because this path returns before the batch.
      if (controlEnabled()) {
        recordDecision(number, await decide({ number, text: said, lang: detectLanguage(said).code }), {
          lang: detectLanguage(said).code,
        });
      }
      recordOptOut(number, { reason: said.slice(0, 80) });
      cancelFollowUpDrafts(number, 'opted_out');
      const lang = detectLanguage(said).code;
      const reply = optOutConfirmation(lang);
      memory.saveUserTurn(number, said, info.kind, { lang, optOut: true });
      memory.saveAssistantTurn(number, reply, 'text');
      await sendTyping(transport, jid, reply, { delay: 400 });
      return;
    }

    if (said && detectOptIn(said) && db.isOptedOut(number)) {
      recordOptIn(number);
      const reply = 'Welcome back — reminders are on again.';
      memory.saveUserTurn(number, said, info.kind, { optIn: true });
      memory.saveAssistantTurn(number, reply, 'text');
      await sendTyping(transport, jid, reply, { delay: 300 });
      return;
    }

    // ── "delete my data" ───────────────────────────────────
    // Before the model, before intake, before anything can decide to be clever.
    // A deletion request is a legal-ish act, not a conversation: acknowledge it
    // in the customer's language and put it in front of the owner, who is the
    // only one who can run .forget.
    if (said && privacyToolsEnabled() && isDeletionRequest(said)) {
      const lang = detectLanguage(said).code;
      const ackLang = lang === 'ur' ? 'ur' : lang === 'roman-ur' ? 'roman' : 'en';
      const ack = deletionAcknowledgement(ackLang);
      try {
        requestDeletion(number, { language: lang });
      } catch (err) {
        db.logEvent('privacy_request_error', number, err.message);
      }
      if (controlEnabled()) {
        recordDecision(number, await decide({ number, text: said, lang }), { lang });
      }
      memory.saveUserTurn(number, said, info.kind, { lang, privacy: 'delete_request' });
      memory.saveAssistantTurn(number, ack, 'text');
      await sendTyping(transport, jid, ack, { delay: 500 });
      noteSent([]);
      await notifyOwner(
        transport,
        `🔐 +${number} asked to have their data deleted.\nWhen you are sure, type: .forget ${number} ${number}`
      );
      return;
    }

    // ── "where is my order?" ───────────────────────────────
    // Answered from the orders table, never by the model: a status is a fact,
    // and a plausible-sounding guess about a delivery is worse than no answer.
    if (said && orderTrackingEnabled() && isOrderQuestion(said)) {
      const lang = detectLanguage(said).code;
      const found = orderStatusAnswer(number, { lang });
      const reply = found
        ? found
        : "I can't see an order on this number. If you ordered with a different number, send me the order id (for example #12) and I'll check — or I can pass you to the owner.";
      memory.saveUserTurn(number, said, info.kind, { lang, orderQuestion: true });
      memory.saveAssistantTurn(number, reply, 'text');
      await sendTyping(transport, jid, reply, { delay: 400 });
      noteSent([]);
      db.logEvent(found ? 'order_question_answered' : 'order_question_no_match', number, { lang });
      return;
    }

    // ── a rating for a job we just finished ────────────────
    // Only when a review ask is actually waiting: "5" in an unrelated chat is
    // a quantity, not a score.
    if (reviewAgentEnabled() && said) {
      try {
        const rated = await handleRating({ number, text: said, transport, now: clock() });
        if (rated.handled) {
          memory.saveUserTurn(number, said, info.kind, { lang: detectLanguage(said).code, rating: rated.rating });
          memory.saveAssistantTurn(number, rated.reply, 'text');
          noteSent([(await sendTyping(transport, jid, rated.reply, { delay: 400 }))?.key?.id]);
          return;
        }
      } catch (err) {
        db.logEvent('review_handle_error', number, err.message);
      }
    }

    // ── did a stranger arrive quoting someone's code? ───────
    // First message only, so a later mention of a code in conversation cannot
    // retroactively "refer" an existing customer.
    // A QR sticker or an ad link can carry a tag in the first message.
    if (said && (existing?.message_count || 0) === 0) {
      try {
        recordSourceTag(number, said);
      } catch (err) {
        db.logEvent('source_tag_error', number, err.message);
      }
    }

    if (reviewAgentEnabled() && said && (existing?.message_count || 0) === 0) {
      try {
        const ref = attributeReferral({ number, text: said, transport, context: said.slice(0, 160) });
        if (ref) db.logEvent('referral_captured', number, ref.code);
      } catch (err) {
        db.logEvent('referral_error', number, err.message);
      }
    }

    // ── and where they came from, if we printed something ──
    // Runs after the referral check on purpose: a code from a friend outranks
    // a QR on a wall, and attributeSource refuses when a referral is on file.
    if (sourceLinksEnabled() && (sourceMarkerSeen || incoming.referral)) {
      try {
        attributeSource({
          number,
          code: sourceCode,
          referral: incoming.referral || null,
          firstTouch: (existing?.message_count || 0) === 0,
        });
      } catch (err) {
        db.logEvent('source_link_error', number, err.message);
      }
    }

    if (isPaused(contact)) {
      // The owner is handling this chat. Stay out of it, but keep listening so
      // the memory is complete when the bot takes over again.
      db.logEvent('skipped_handoff', number, contact.bot_paused_until);
      const said = (info.text || info.caption || '').trim();
      if (said) {
        memory.saveUserTurn(number, said, info.kind, { lang: detectLanguage(said).code, handoff: true });
        memory.summarizeIfNeeded(number).catch(() => {});
      }
      return;
    }

    // ── scam filter (never blocks normal clients) ──────────
    const spam = spamAnalyze(number, info.text || info.caption || '');
    if (spam.action === 'block') {
      applyAction(number, 'block');
      return;
    }
    if (spam.isScam && !controlEnabled()) {
      await sendTyping(transport, jid, WARN_MESSAGE, { delay: 900 });
      await notifyOwner(transport, `🚫 Possible scam from +${number}\n${(info.text || '').slice(0, 200)}\nBlocked: ${spam.action === 'block' ? 'yes' : 'no'}`);
      return;
    }
    // Conversation Control decides about spam in the batch, so the decision is
    // logged and the "clear spam" case is one silent ignore instead of a second
    // warning. The hard block above still happens either way.

    // Read receipt after a beat (1–3 s), not on arrival: the customer sees a
    // person pick the phone up, not a webhook firing.
    const receipt = scheduleRead(transport, [{ id: incoming.id }], { chat: number });
    if (receipt?.done?.catch) receipt.done.catch(() => {});

    // ── quiet hours: hold the reply for the morning ────────
    if (config.behavior.deferQuietHours && isQuietNow()) {
      db.savePending(
        number,
        {
          jid,
          reason: 'quiet_hours',
          ...(privateInput ? { mediaDeferred: true } : {}),
          text: info.text || '',
          kind: info.kind,
          caption: info.caption || '',
        },
        quietEndsAt()
      );
      db.logEvent('deferred_quiet_hours', number, quietEndsAt());
      return;
    }

    // ── first contact heads-up for the owner ───────────────
    if ((contact?.message_count || 0) <= 1 && config.behavior.notifyNewChats && !friend) {
      const geo = lookupNumber(number);
      const preview = (info.text || info.caption || `[${info.kind}]`).slice(0, 180);
      await notifyOwner(
        transport,
        `🆕 New chat: ${incoming.pushName || 'unknown'}\n+${number} · ${geo.country} · ${geo.currency}\n“${preview}”`
      );
      db.logEvent('new_contact', number, { country: geo.country });
    }

    enqueue(transport, jid, number, { incoming, receivedAt: timeline.received(number).receivedAt }, clock);
  } catch (err) {
    console.error('❌ handleIncoming:', err.message);
    db.logEvent('handler_error', null, err.message);
  }
}

// ════════════════════════════════════════════════════════════
// Owner side: commands, manual takeover, or asking the bot itself
// ════════════════════════════════════════════════════════════
const SAFE_IN_CLIENT_CHAT = new Set(['pause', 'resume', 'block', 'unblock', 'reset', 'quote', 'ping']);
const TARGET_COMMANDS = new Set(['pause', 'resume', 'block', 'unblock', 'reset', 'quote']);

async function handleOwnerSide(sock, { jid, number, info, incoming, clock = realClock }) {
  const text = (info.text || '').trim();
  const isSelfChat = number === config.owner.number;

  if (isCommand(text)) {
    const cmd = text.slice(1).split(/\s+/)[0].toLowerCase();

    if (!isSelfChat && !SAFE_IN_CLIENT_CHAT.has(cmd)) {
      await sendTyping(sock, jid, 'Use "Message yourself" for full bot commands (.help).', { delay: 300 });
      return;
    }

    // A command typed inside a client's chat should not be read by the client:
    // delete our own command bubble right after running it.
    // Deleting our own command bubble needs a transport that can unsend.
    if (!isSelfChat && (sock.can?.('deleteMessage') ?? false) && incoming.raw?.key) {
      try {
        await sock.sendMessage(jid, { delete: incoming.raw.key });
      } catch {
        /* older than 2 days or no permission — ignore */
      }
    }

    // Shorthand: `.pause` inside a chat applies to that chat
    if (!isSelfChat && TARGET_COMMANDS.has(cmd) && !/\+?\d{8,}/.test(text)) {
      return runCommand(sock, jid, `${text} ${number}`, undefined, clock);
    }
    return runCommand(sock, jid, text, undefined, clock);
  }

  if (isSelfChat) {
    // Chatting with your own bot is allowed and handy for testing
    if (!text) return;
    return answerOwnerQuestion(sock, jid, text);
  }

  // Owner replied manually to a client → step back for a while
  const minutes = config.behavior.handoffMinutes;
  const until = new Date(clock().getTime() + minutes * 60000).toISOString();
  db.setContactPaused(number, until);
  memory.saveOwnerTurn(number, text);
  db.logEvent('handoff', number, { minutes });
  memory.summarizeIfNeeded(number).catch(() => {});

  // Phase 4: the owner just answered something himself. If his answer differs
  // from the bot's, that difference is a candidate FAQ rule — for his approval,
  // never applied on its own.
  try {
    const { selfHealingEnabled, observeOwnerReply } = await import('../services/selfHealing.js');
    if (selfHealingEnabled()) {
      const seen = observeOwnerReply({ number, text, transport: sock, now: clock() });
      if (seen?.handled) console.log(`🧠 Rule #${seen.rule?.id} proposed from the owner's own reply`);
    }
  } catch (err) {
    db.logEvent('self_healing_error', number, err.message);
  }

  console.log(`🤝 Handoff: owner is handling +${number} for ${minutes} min`);
}

async function answerOwnerQuestion(sock, jid, text) {
  const dossier = {
    number: config.owner.number,
    name: config.owner.name,
    country: 'Pakistan',
    currency: 'PKR',
    localTime: { label: config.timezone },
    stage: 'owner',
    messageCount: 0,
    facts: [],
    summary: 'This is the owner himself, testing or asking you something. Be concise and practical.',
    recent: [],
  };
  const result = await generateReply({
    number: config.owner.number,
    text,
    langInfo: detectLanguage(text),
    dossier,
    intakeState: null,
    features: {
      visionEnabled: visionEnabled(),
      videoEnabled: videoCapabilities().ready,
      ttsEnabled: ttsEnabled(),
      sttEnabled: sttEnabled(),
    },
    chatType: 'owner',
  });
  await sendTyping(sock, jid, result.text || 'Hmm, nothing came back.', { delay: 500 });
}

// ════════════════════════════════════════════════════════════
// Team member DMing the bot (multi-user)
// ════════════════════════════════════════════════════════════
async function handleTeammate(sock, jid, number, info) {
  const member = teamMember(number);
  const text = (info.text || '').trim();
  if (!text) return;

  if (isCommand(text)) return runCommand(sock, jid, text, number);

  const mine = db.contactsFor(member.name, 5);
  const extraNote =
    `You are talking to ${member.name}, a ${member.role} on the team (not a client). ` +
    'Answer briefly and practically, in their language. They can take over a chat with .takeover <number>, ' +
    'see their queue with .mine, and see the roster with .team.' +
    (mine.length
      ? ` Their chats right now: ${mine.map((c) => `+${c.number} (${c.stage})`).join(', ')}.`
      : ' They have no chats assigned yet.');

  const result = await generateReply({
    number,
    text,
    langInfo: detectLanguage(text),
    dossier: {
      number,
      name: member.name,
      country: 'Pakistan',
      currency: 'PKR',
      localTime: { label: config.timezone },
      stage: 'team',
      messageCount: 0,
      facts: [],
      summary: `Team member: ${member.name} (${member.role}).`,
      recent: [],
      category: 'team',
    },
    intakeState: null,
    features: {
      visionEnabled: visionEnabled(),
      videoEnabled: videoCapabilities().ready,
      ttsEnabled: ttsEnabled(),
      sttEnabled: sttEnabled(),
    },
    chatType: 'owner',
    extraNote,
  });

  const reply = (result?.text || '').trim();
  if (reply) return sendTyping(sock, jid, reply, { delay: 350 });

  // No model available — fall back to their little dashboard
  const lines = [`👋 ${member.name} — ${member.role}`];
  if (mine.length) {
    lines.push('', '*Your chats*');
    for (const c of mine) lines.push(`• ${c.name || `+${c.number}`} — ${c.stage} · ${c.message_count} msgs`);
  } else {
    lines.push('', 'No chats assigned to you yet.');
  }
  lines.push('', '.mine .leads .calls .takeover 92… .release 92… .quote 92…');
  return sendTyping(sock, jid, lines.join('\n'), { delay: 350 });
}

/** Ping whoever owns this chat, if it isn't the owner himself. */
async function notifyOperator(sock, number, text) {
  const contact = db.getContact(number);
  if (!contact?.assigned_to) return;
  const member = teamMembers().find((m) => m.name === contact.assigned_to);
  if (!member) return;
  try {
    await sendTyping(sock, `${member.number}@s.whatsapp.net`, text, { delay: 150 });
  } catch {
    /* ignore */
  }
}

async function runCommand(sock, jid, text, from = config.owner.number, clock = realClock) {
  if (!config.behavior.ownerCommands) return;
  try {
    const result = await handleOwnerCommand(sock, jid, text, from, { now: clock() });
    if (result?.reply) await sendTyping(sock, jid, result.reply, { delay: 250 });
  } catch (err) {
    console.error('Command error:', err.message);
    await sendTyping(sock, jid, `Command failed: ${err.message}`, { delay: 200 });
  }
}

// ════════════════════════════════════════════════════════════
// Debounce: wait for the client to finish typing their burst
// ════════════════════════════════════════════════════════════
function enqueue(sock, jid, number, item, clock = realClock) {
  const key = number;
  const entry = buffers.get(key) || { jid, number, items: [], timer: null, clock };
  entry.items.push(item);
  entry.jid = jid;
  if (entry.timer) clearTimeout(entry.timer);

  entry.timer = setTimeout(() => {
    buffers.delete(key);
    const items = entry.items;
    const task = processBatch(sock, entry.jid, number, items, entry.clock || realClock)
      .catch((err) => {
        console.error('Batch error:', err.message);
        db.logEvent('batch_error', number, err.message);
      })
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
  }, config.behavior.debounceMs);

  buffers.set(key, entry);
}

// Batches that are running right now. `enqueue` is deliberately fire-and-forget
// for the live bot, so anything that wants to see the reply (tests, the eval
// harness) needs a way to wait for the queue to empty.
const inFlight = new Set();

/**
 * Wait until every debounced batch has finished and produced its reply.
 * @returns {Promise<boolean>} false when it gave up waiting
 */
export async function drainBatches({ timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (buffers.size === 0 && inFlight.size === 0) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

/** Send any quiet-hour messages that are now due. */
export async function flushDuePending(sock) {
  if (isQuietNow()) return;
  const due = db.duePending(new Date().toISOString());
  for (const row of due) {
    db.clearPending(row.number);
    db.logEvent('pending_flushed', row.number, row.reason || 'due');

    const payload = row.payload || {};
    const text = payload.text || (payload.kind && payload.kind !== 'text' ? `[${payload.kind} sent after hours]` : '');
    if (!text) continue;

    const jid = payload.jid || `${row.number}@s.whatsapp.net`;
    try {
      if (payload.mediaDeferred) {
        await resumeDeferredMedia({ sock, jid, number: row.number, contact: db.getContact(row.number), noteSent });
        continue;
      }
      await sendTyping(sock, jid, 'Morning! Sorry for the late reply — saw this after hours.', { delay: 700 });
      enqueue(sock, jid, row.number, {
        incoming: normalizeIncoming({
          chat: jid,
          number: row.number,
          kind: 'text',
          text,
          caption: payload.caption || '',
        }),
      });
    } catch (err) {
      db.logEvent('pending_flush_error', row.number, err.message);
    }
  }
}

export function startPendingFlusher(sock) {
  const timer = setInterval(() => flushDuePending(sock), 60_000);
  timer.unref?.();
  return timer;
}

/**
 * The other JID form this contact has written from, for `typing.strategy = d`.
 * Unknown contacts simply have none.
 */
function alternateJidFor(number, jid) {
  try {
    return alternateJid(jidForms(number), jid);
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// The batch pipeline
// ════════════════════════════════════════════════════════════
async function processBatch(sock, jid, number, items, clock = realClock) {
  // The indicator is owned here, so it is cleared on every exit path: a reply,
  // a guard refusal, an error, a handoff. Nothing can leave "typing…" behind.
  const receivedAt = items[0]?.receivedAt || timeline.received(number).receivedAt || Date.now();
  const timing = replyTiming();
  const ctx = {
    receivedAt,
    lang: 'en',
    // The clock this turn runs on: the real one in production, the harness's
    // pinned instant in the eval.
    clock,
    // The newest inbound id: on the Cloud API the typing indicator *is* the
    // read receipt for that message.
    session: timing.enabled
      ? createTypingSession(sock, jid, {
          timing,
          processing: items.slice(0, 5).some((i) => protectedVideo(i.incoming)),
          messageId: items[items.length - 1]?.incoming?.id || null,
          // If this contact has written from a LID as well, that is the other
          // address a presence update can be tried on (`typing.strategy = d`).
          altJid: alternateJidFor(number, jid),
        })
      : null,
    // The pause that existed when the batch started is the pipeline's own
    // business; a pause that appears *during* the batch is the owner taking
    // over, and the reply must not go out.
    pauseAtStart: db.getContact(number)?.bot_paused_until || null,
  };
  if (ctx.session) timeline.mark(number, 'typing', { at: ctx.session.startedAt });
  try {
    return await runBatch(sock, jid, number, items, ctx);
  } finally {
    await ctx.session?.stop({ paused: true });
    // The brief is checked on the way out, so it covers every return path in
    // runBatch (a reply, a redirect, a handover, a silent ignore). With the flag
    // off this is one boolean and nothing else happens.
    maybeSendBrief(sock, number).catch(() => {});
  }
}

/**
 * Conversation Control: send the owner the brief when the requirements are done
 * or the conversation has stalled. One per contact: `brief_sent` is the record.
 */
async function maybeSendBrief(sock, number) {
  if (!controlEnabled()) return false;
  try {
    const due = briefs.briefDue(number);
    if (!due.due) return false;
    if (briefs.briefAlreadySent(number)) return false;
    // Nothing collected is not a brief, it is an empty form.
    if (!due.brief.fields.some((f) => f.value !== null)) return false;
    const body = `${briefs.briefSummaryLine(number)}\n\n${briefs.briefMarkdown(number)}`;
    await notifyOwner(sock, body.slice(0, 3500));
    db.logEvent('brief_sent', number, { because: due.because, percent: due.brief.percent });
    return true;
  } catch (err) {
    db.logEvent('brief_error', number, err.message);
    return false;
  }
}

async function runBatch(sock, jid, number, items, ctx) {
  const contact = db.getContact(number);
  if (!contact || contact.is_blocked) return;
  if (isPaused(contact) || db.getSetting('bot_enabled', true) !== true) return;

  // The client replied → stop any scheduled nudge, and drop any draft the
  // growth agent was waiting to send. Silence means silence.
  cancelFor(number);
  cancelFollowUpDrafts(number, 'replied');
  // A missed-call rescue must not land on top of a customer who has just
  // written to us themselves.
  try {
    const { cancelCallRescue } = await import('../services/calls.js');
    cancelCallRescue(number, 'customer wrote first');
  } catch {
    /* the calls service is optional */
  }

  // ── one message in, one reply out ──────────────────────
  // A batch that was already answered (a redelivery, a double-enqueue, two
  // pipelines racing) stops here rather than sending a second message.
  const batchId = batchIdOf(items);
  if (beginBatch(number, batchId).skip) {
    db.logEvent('batch_skipped_duplicate', number, { batch: batchId });
    return;
  }
  // One indicator for the whole batch: the customer sees "typing…" while the
  // model works, however long that takes (refreshed, capped), and the send path
  // reuses it instead of blinking a fresh one on.
  timeline.mark(number, 'batch', { at: Date.now() });
  const receivedAt = ctx.receivedAt;

  // Every send from this batch is stamped with when the batch arrived and the
  // chat's language, so the send path can plan the wait and the holding line.
  const pacedSend = (transport, to, text, opts = {}) =>
    sendHuman(transport, to, text, {
      chat: number,
      receivedAt: ctx.receivedAt,
      session: ctx.session,
      lang: ctx.lang,
      // Never talk over the owner: if they took the chat over (or sent
      // something) while we were composing, this reply is dropped.
      // The owner replied in this chat while we were composing: stay out.
      // (A pause set during the batch is usually our own handoff tool, whose
      // "the owner will reply" line must still go out — so the pause itself is
      // checked when the batch starts, not here.)
      shouldSend: () => !ownerIsActive(number, { since: ctx.receivedAt }),
      ...opts,
    });

  const channel = createReplyChannel({ chat: number, batch: batchId, transport: sock, jid, sendTyping, sendHuman: pacedSend });

  if (items.slice(0, 5).some((i) => protectedTurn(i.incoming))) {
    return handleMediaTurn({ sock, jid, number, items, contact, ctx, channel, noteSent });
  }

  const parts = [];
  const problems = [];
  let clientSentVoice = false;

  for (const { incoming } of items.slice(0, 5)) {
    try {
      const part = await interpretItem({ transport: sock, incoming, number });
      if (part) {
        parts.push(part);
        if (part.kind === 'voice') clientSentVoice = true;
      }
    } catch (err) {
      console.error(`Media (${incoming.kind}) error:`, err.message);
      db.logEvent('media_error', number, { kind: incoming.kind, error: err.message });
      problems.push(incoming.kind === 'voice' ? 'voice' : 'media');
    }
  }

  if (!parts.length) {
    if (problems.length) await handleUnreadable(sock, jid, problems);
    return;
  }

  const humanText = parts
    .map((p) => p.text || '')
    .filter(Boolean)
    .join('\n')
    .trim();

  const modelText = renderForModel(parts);
  // The conversation's language, not this message's: a short "Yes" or a
  // forwarded PDF must not move the chat into another language.
  const primaryKind = parts[0]?.kind || 'text';
  let langInfo = replyLanguage(number, humanText || '', { kind: primaryKind, contact });
  if (!langInfo || langInfo.code === 'unknown') {
    // A voice note carries its own language tag from Whisper — trust it
    const voicePart = parts.find((p) => p.kind === 'voice' && p.lang);
    const fromVoice = voicePart ? fromWhisperLanguage(voicePart.lang) : null;
    if (fromVoice) langInfo = fromVoice;
    else if (contact.language) langInfo = detectLanguage(contact.language);
    else langInfo = detectLanguage(humanText || 'voice');
  }
  db.logEvent('language_choice', number, { code: langInfo.code, source: langInfo.source || 'detected', sticky: !!langInfo.sticky });
  ctx.lang = langInfo.code;
  const mood = detectMood(humanText);
  const toneInfo = detectTone(humanText, langInfo.code);
  const tone = toneInfo.tone !== 'neutral' ? toneInfo.tone : 'neutral';

  // Long-term context BEFORE this turn is stored, so it isn't duplicated
  const dossier = { ...memory.getDossier(number), mood };

  // ── "is this a bot?" — answered honestly, always ────────
  // No flag disables this. Someone who asks deserves a straight answer, and the
  // answer is written here rather than by a model that might deny it.
  if (asksIfBot(humanText)) {
    const answer = honestBotAnswer(langInfo.code);
    try {
      memory.saveUserTurn(number, humanText, 'text', { lang: langInfo.code, askedBot: true });
      const sentHonest = await channel.say(answer, { incomingText: humanText });
      memory.saveAssistantTurn(number, answer, 'text');
      noteSent(Array.isArray(sentHonest) ? sentHonest.map((m) => m?.key?.id) : [sentHonest?.key?.id]);
      db.logEvent('bot_disclosure', number, { lang: langInfo.code });
      await notifyOwner(sock, `🤖 +${number} asked whether they are talking to a bot. I answered honestly.`);
    } catch (err) {
      db.logEvent('bot_disclosure_error', number, err.message);
    }
    return;
  }

  // ════════════════════════════════════════════════════════
  // Conversation Control V1 (features.conversationControl)
  // ════════════════════════════════════════════════════════
  // One decision per inbound batch, logged whether or not it changes anything.
  // With the flag off this whole block is skipped and every path below behaves
  // exactly as it did before.
  if (controlEnabled()) {
    const settings = conversationSettings();
    const decision = await decide({ number, text: humanText, contact, lang: langInfo.code });
    recordDecision(number, decision, { lang: langInfo.code, batch: batchId });
    ctx.decision = decision;

    if (decision.confusion && decision.action === 'reply') db.logEvent('confusion_noted', number, { lang: langInfo.code });

    // The owner hears about anything the bot did not answer itself, and about
    // an insult that repeated past the limit — once, with a reason code.
    if (decision.notifyOwner) {
      const why = {
        human_request: 'asked for a human',
        handover_keyword: 'matched your handover keywords',
        sensitive_keyword: 'used emergency or sensitive words',
        self_harm: 'used self-harm words',
        threat: 'made a threat',
        insult: 'insulted the bot again — cool-down started',
        confusion: 'seems stuck after repeated confusion',
        angry: 'sounds angry — a decision needs a person',
        ignore_limit: 'had to be answered after two ignores in a row',
      }[decision.reason];
      if (why) {
        const urgent = decision.urgent ? '🚨 URGENT — ' : '';
        await notifyOwner(
          sock,
          `${urgent}🙋 +${number} ${why}.\n${decision.urgent ? 'Please look at this chat now.' : 'The chat is paused for you; .resume to hand it back.'}`
        );
      }
    }

    if (decision.action === 'ignore') {
      // A pending payment decision is an active order context: that customer is
      // never silently ignored, whatever the conversation rules think.
      let pendingDecision = null;
      try {
        const review = await import('../services/paymentReview.js');
        if (review.ownerDecisionsOn()) pendingDecision = review.pendingDecisionFor(number);
      } catch {
        /* the review module must never break the conversation path */
      }
      if (!pendingDecision) {
        // Silence, but not accidental silence: the reason is in `.decisions`, and
        // the two-in-a-row limit means nobody is ghosted for long.
        memory.saveUserTurn(number, humanText, parts.length > 1 ? 'mixed' : parts[0].kind, { lang: langInfo.code, decision: decision.reason });
        channel.claim();
        db.logEvent('decision_ignore', number, { reason: decision.reason });
        return;
      }
      db.logEvent('decision_ignore_overridden', number, { reason: decision.reason, decision: pendingDecision.id });
    }

    if (decision.action === 'react') {
      const emoji = ackReaction(humanText);
      const incomingKey = items[0]?.incoming?.id || null;
      const reacted = incomingKey ? await sendReaction(sock, jid, { remoteJid: jid, id: incomingKey, fromMe: false }, emoji) : false;
      memory.saveUserTurn(number, humanText, 'text', { lang: langInfo.code, decision: 'react' });
      channel.claim();
      if (reacted) {
        noteSent([incomingKey]);
        db.logEvent('ack_reaction', number, { emoji, decision: true });
        memory.saveAssistantTurn(number, `[reaction ${emoji}]`, 'reaction');
      } else {
        db.logEvent('ack_silent', number, { decision: true });
      }
      return;
    }

    if (decision.action === 'handover') {
      // A person takes over: the customer is told once, the chat pauses, and the
      // reason (never the words) is in the log.
      try {
        if (decision.text) {
          const sentH = await channel.say(decision.text, { incomingText: humanText });
          memory.saveAssistantTurn(number, decision.text, 'text');
          noteSent([sentH?.key?.id]);
        }
        memory.saveUserTurn(number, humanText, parts.length > 1 ? 'mixed' : parts[0].kind, { lang: langInfo.code, decision: decision.reason });
      } catch (err) {
        db.logEvent('decision_handover_error', number, err.message);
      }
      try {
        db.setContactPaused(number, new Date(Date.now() + (decision.urgent ? 6 * 60 : config.behavior.handoffMinutes) * 60_000).toISOString());
        db.logEvent(decision.urgent ? 'urgent_handoff' : 'handoff', number, { reason: decision.reason, minutes: decision.urgent ? 360 : config.behavior.handoffMinutes });
      } catch {
        /* pausing is best effort; the owner has already been told */
      }
      return;
    }

    // clarify / redirect, or a reply that is a fixed line (boundary, cool-down,
    // ignore limit): the text is written, so no model is spent on it.
    if (decision.text) {
      try {
        memory.saveUserTurn(number, humanText, parts.length > 1 ? 'mixed' : parts[0].kind, { lang: langInfo.code, decision: decision.reason });
        const sentLine = await channel.say(decision.text, { incomingText: humanText });
        memory.saveAssistantTurn(number, decision.text, 'text');
        noteSent([sentLine?.key?.id]);
        if (decision.action === 'redirect') db.logEvent('scope_refused', number, { kind: 'conversation_control', lang: langInfo.code });
        db.logEvent('decision_fixed_line', number, { action: decision.action, reason: decision.reason });
      } catch (err) {
        db.logEvent('decision_line_error', number, err.message);
      }
      return;
    }
  }

  // ── acknowledgements: a reaction, not a paragraph ───────
  if (humanTouchEnabled() && shouldReactOnly(number, humanText)) {
    const emoji = ackReaction(humanText);
    const incomingKey = items[0]?.incoming?.id || null;
    const reacted = incomingKey ? await sendReaction(sock, jid, { remoteJid: jid, id: incomingKey, fromMe: false }, emoji) : false;
    memory.saveUserTurn(number, humanText, 'text', { lang: langInfo.code, ack: true });
    if (reacted) {
      channel.claim();
      // A reaction is not a reply: nothing else goes out for this batch.
      noteSent([incomingKey]);
      db.logEvent('ack_reaction', number, { emoji });
      memory.saveAssistantTurn(number, `[reaction ${emoji}]`, 'reaction');
    } else {
      // No reactions on this transport (Cloud API): silence is better than
      // "You're welcome! 😊". Claim the batch so no other pipeline answers it.
      channel.claim();
      db.logEvent('ack_silent', number, null);
    }
    return;
  }

  // ── off-topic guard ────────────────────────────────────
  // "Say 1 to 100", a joke, homework, code: a short friendly refusal and a
  // redirect, in the conversation's language, from a fixed line — no model
  // call, so the reply can never drift into doing it anyway.
  const textOnly = parts.every((p) => !p.visual && !['image', 'document', 'voice', 'video'].includes(p.kind));
  if (textOnly && contact.category !== 'friend') {
    const scope = scopeGuard(humanText, langInfo);
    if (scope.handled) {
      try {
        memory.saveUserTurn(number, humanText, 'text', { lang: langInfo.code, mood, offTopic: scope.kind });
        const sentScope = await channel.say(scope.reply, { incomingText: humanText });
        memory.saveAssistantTurn(number, scope.reply, 'text');
        noteSent([sentScope?.key?.id]);
        db.logEvent('scope_refused', number, { kind: scope.kind, lang: langInfo.code });
      } catch (err) {
        db.logEvent('scope_refusal_error', number, err.message);
      }
      return;
    }
  }

  // ── visual catalogue match ─────────────────────────────
  // The model found a matching product photo, so the answer is written from the
  // catalogue (name, price, stock). No tokens, no invention, and no second
  // opinion from an LLM that has never seen the shop.
  const visualPart = parts.find((p) => p.visual?.handled);
  if (visualPart) {
    const { composeReply } = await import('../services/visualSearch.js');
    const visual = visualPart.visual;
    const reply = composeReply({ decision: visual.decision, score: visual.score }, visual.matches, {
      lang: langInfo.code,
    });
    try {
      memory.saveUserTurn(number, humanText || '[photo]', 'image', { lang: langInfo.code, visual: visual.decision });
      const sentV = await channel.say(reply, { delay: 600 });
      memory.saveAssistantTurn(number, reply, 'text');
      noteSent([sentV?.key?.id]);
      db.logEvent('visual_reply', number, { decision: visual.decision, score: Number(visual.score.toFixed(3)) });
    } catch (err) {
      db.logEvent('visual_reply_error', number, err.message);
    }
    return;
  }

  // ── payment proof (Owner Decisions + Payment Review) ───
  // With features.paymentReview on, a proof becomes a decision request: read,
  // checked, carded to the owner, and answered by a person. This block returns
  // before the older receipt path below, which is left exactly as it was for
  // when the flag is off.
  if (featureOn('paymentReview')) {
    try {
      const review = await import('../services/paymentReview.js');
      // A screenshot or a PDF of a receipt: both are evidence to look at.
      const picture = parts.find((p) => (p.kind === 'image' || p.kind === 'document') && (p.text || p.caption)) || null;
      const order = db.orderFor(`${number}@s.whatsapp.net`);
      const waiting = order && ['awaiting_payment', 'placed'].includes(order.status);

      // A customer asking "did my payment go through?" gets one short, honest,
      // rate-limited line — never a second demand for money.
      if (waiting && (review.asksAboutPayment(humanText) || picture)) {
        const line = review.waitingLine({ number, lang: langInfo.code, now: ctx.clock() });
        if (line) {
          try {
            const sentWait = await channel.say(line, { incomingText: humanText });
            memory.saveUserTurn(number, humanText || '[photo]', picture ? 'image' : 'text', { lang: langInfo.code, waitingLine: true });
            memory.saveAssistantTurn(number, line, 'text');
            noteSent([sentWait?.key?.id]);
            db.logEvent('payment_waiting_line', number, { lang: langInfo.code });
          } catch (err) {
            db.logEvent('payment_waiting_error', number, err.message);
          }
          return;
        }
      }

      const proofText = textOnly && waiting && review.looksLikeProofText(humanText);
      if ((picture && waiting) || proofText) {
        const proof = await review.handlePaymentProof({
          number,
          text: picture ? picture.text : humanText,
          kind: picture ? (picture.kind === 'document' ? 'document' : 'image') : 'text',
          mimetype: picture?.mimetype || 'image/jpeg',
          transport: sock,
          now: ctx.clock(),
          lang: langInfo.code,
          // The customer's own file, fetched once, so the proof we keep is the
          // proof they sent. A failed download still leaves the reading.
          download: picture ? () => sock.getMedia(items[0]?.incoming) : null,
        });
        if (proof.handled) {
          memory.saveUserTurn(number, humanText || '[photo]', picture ? 'image' : 'text', {
            lang: langInfo.code,
            paymentProof: proof.decision?.id || null,
          });
          channel.claim();
          noteSent([]);
          db.logEvent('payment_proof_handled', number, {
            decision: proof.decision?.id || null,
            reason: proof.reason || 'opened',
          });
          return;
        }
      }
    } catch (err) {
      // Never lose the conversation because of a review failure: fall through to
      // the normal pipeline, and leave the reason in the log.
      db.logEvent('payment_review_error', number, String(err.message).slice(0, 200));
    }
  }

  // ── payment proof ──────────────────────────────────────
  // A screenshot from a customer who has an order awaiting payment goes to the
  // owner with whatever we could read from it. It never marks anything paid:
  // the owner is the only one who can see money arrive.
  if (closerAgentEnabled()) {
    const picture = parts.find((p) => p.kind === 'image' && p.text);
    const order = db.orderFor(`${number}@s.whatsapp.net`);
    // Not every photo is a receipt: either we can actually see it, or the
    // caption says what it is.
    const looksLikeReceipt =
      visionEnabled() || /receipt|payment|paid|transfer|screenshot|رسید|ادائیگی|transfer\s+kiya/i.test(humanText);
    if (picture && order && looksLikeReceipt && ['awaiting_payment', 'placed'].includes(order.status)) {
      try {
        const receipt = await handleReceipt({
          number,
          transport: sock,
          now: ctx.clock(),
          // No second vision call: the description already exists.
          reader: async () => ({ description: picture.text }),
        });
        if (receipt.handled) {
          const ack =
            langInfo.code === 'ur'
              ? 'شکریہ — رسید میں نے مالک کو بھیج دی ہے، وہ تصدیق کریں گے۔'
              : langInfo.code === 'roman-ur'
                ? 'Shukriya — receipt main owner ko bhej di hai, wo confirm karenge.'
                : "Thanks — I've passed that to the owner, they'll confirm it.";
          memory.saveUserTurn(number, humanText, 'image', { lang: langInfo.code, receipt: true });
          memory.saveAssistantTurn(number, ack, 'text');
          noteSent([(await channel.say(ack, { delay: 500 }))?.key?.id]);
          return;
        }
      } catch (err) {
        db.logEvent('receipt_error', number, err.message);
      }
    }
  }

  // ── the booking agent's turn ───────────────────────────
  // Deterministic: real free slots, a confirmation, a written booking. No
  // tokens are spent and no slot can be invented.
  if (bookingAgentEnabled()) {
    try {
      const turn = await handleBookingTurn({ number, text: humanText, lang: langInfo.code, now: ctx.clock() });
      if (turn.handled) {
        memory.saveUserTurn(number, humanText, parts.length > 1 ? 'mixed' : parts[0].kind, { lang: langInfo.code, booking: true });
        const sentB = await channel.say(turn.reply, { delay: 500 });
        memory.saveAssistantTurn(number, turn.reply, 'text');
        noteSent([sentB?.key?.id]);
        db.logEvent('booking_turn', number, { booked: !!turn.booking, id: turn.booking?.id || null });
        return;
      }
    } catch (err) {
      db.logEvent('booking_turn_error', number, err.message);
      // fall through to the normal brain — a booking bug must not silence the bot
    }
  }

  // ── the closer's turn ──────────────────────────────────
  // Objections are answered with facts from the profile, and "yes, I'll take
  // it" produces a quote plus the real payment details. Still no tokens.
  if (closerAgentEnabled() && humanText) {
    try {
      const ready = readyToBuy(humanText);
      const turn = ready ? null : handleCloserTurn({ number, text: humanText, lang: langInfo.code, now: ctx.clock() });
      const out = turn?.handled ? turn : ready ? startOrder({ number, text: humanText, lang: langInfo.code, now: ctx.clock() }) : null;
      if (out) {
        memory.saveUserTurn(number, humanText, parts.length > 1 ? 'mixed' : parts[0].kind, { lang: langInfo.code, closer: true });
        memory.saveAssistantTurn(number, out.reply, 'text');
        noteSent([(await channel.say(out.reply, { delay: 500 }))?.key?.id]);
        db.logEvent('closer_turn', number, { kind: out.kind || (ready ? 'ready' : null), order: out.order?.id || null });
        // The text quote has already gone out. This is the same quote as a PDF,
        // and if it fails the customer still has the message above.
        if (out.order) await maybeSendInvoice(sock, jid, { order: out.order, number });
        return;
      }
    } catch (err) {
      db.logEvent('closer_error', number, err.message);
      // fall through to the normal brain
    }
  }

  const explicitPriceQuestion = /\b(price|pricing|cost|charge|rate|quote|estimate|how much|kitna|kitne|budget)\b/i.test(humanText);
  // What we knew before this message, so a correction can name what changed.
  const fieldsBefore = { ...(getState(number).fields || {}) };
  let intake;
  try {
    intake = await ingest(number, modelText, { explicitPriceQuestion });
  } catch (err) {
    db.logEvent('intake_error', number, err.message);
    intake = { state: getState(number), readyToQuote: false, nextField: null };
  }

  // ── Conversation Control: no guessing ────────────────────
  // A price the owner never published, or a policy they never wrote, becomes a
  // question to the owner — with the customer told the truth — instead of a
  // confident number from a model. This is the existing handoff: the chat is
  // paused for the owner, who answers the customer directly.
  if (controlEnabled() && humanText) {
    const missingPolicy = unansweredPolicy(humanText);
    const noPrice = asksPriceQuestion(humanText) && !hasPublishedPrices() && !intake?.readyToQuote;
    if (noPrice || missingPolicy) {
      const kind = noPrice ? 'price' : missingPolicy;
      try {
        memory.saveUserTurn(number, humanText, parts.length > 1 ? 'mixed' : parts[0].kind, { lang: langInfo.code, ownerTask: kind });
        const line = noGuessLine(kind, langInfo.code);
        const sentN = await channel.say(line, { incomingText: humanText });
        memory.saveAssistantTurn(number, line, 'text');
        noteSent([sentN?.key?.id]);
      } catch (err) {
        db.logEvent('no_guess_reply_error', number, err.message);
      }
      try {
        db.logEvent('owner_task_created', number, { kind });
        await notifyOwner(sock, ownerTaskText({ number, kind, question: humanText }));
        db.setContactPaused(number, new Date(Date.now() + config.behavior.handoffMinutes * 60_000).toISOString());
        await notifyOperator(sock, number, `❓ A question only you can answer (+${number}). The bot did not guess.`);
      } catch (err) {
        db.logEvent('owner_task_error', number, err.message);
      }
      return;
    }
  }

  // ── Conversation Control: read the answers back ──────────
  // Several fields in one message, or a correction to an earlier answer, get a
  // short "here is what I understood … right?" instead of a model reply. The
  // fields are the client's own words, so nothing can be invented — and one
  // question per turn is kept, because the confirmation *is* the question.
  if (controlEnabled() && intake?.updates && Object.keys(intake.updates).length && !asksPriceQuestion(humanText)) {
    const collected = collectorTurn({ updates: intake.updates, previous: fieldsBefore, lang: langInfo.code, text: humanText });
    const conflicted = collected ? null : conflictTurn({ updates: intake.updates, previous: fieldsBefore, lang: langInfo.code });
    const turn = collected || conflicted;
    if (turn) {
      try {
        memory.saveUserTurn(number, humanText, parts.length > 1 ? 'mixed' : parts[0].kind, { lang: langInfo.code, collector: turn.kind });
        const sentC = await channel.say(turn.reply, { incomingText: humanText });
        memory.saveAssistantTurn(number, turn.reply, 'text');
        noteSent([sentC?.key?.id]);
        db.logEvent(turn.kind === 'conflict' ? 'intake_conflict' : 'intake_confirmed', number, {
          fields: turn.fields || [turn.field].filter(Boolean),
        });
      } catch (err) {
        db.logEvent('collector_error', number, err.message);
      }
      return;
    }
  }

  const features = {
    visionEnabled: visionEnabled(),
    videoEnabled: videoCapabilities().ready,
    ttsEnabled: ttsEnabled(),
    sttEnabled: sttEnabled(),
  };

  const quote = intake.readyToQuote ? intake.quote || buildQuote(intake.state.fields, number) : null;

  // A document, a photo or a long brief is not a price request. The estimate is
  // only sent when the customer asks for a price or confirms the scope.
  const PRICE_ASK =
    /\b(price|prices|pricing|cost|costs|charge|charges|rate|rates|quote|quotation|estimate|budget|how much|total)\b|kitn[ae]|kya rate|qemat|قیمت|کتنا|ریٹ/i;
  const priceAsk = PRICE_ASK.test(humanText);

  let extraNote = '';
  if (quote && !priceAsk) {
    // Held back on purpose: quoting here is how an unrequested price range ended
    // up in a chat that never asked for one.
    extraNote =
      'A price estimate is ready but has NOT been sent — the customer has not asked for a price. Do not state any numbers. Ask one short question about their goal or the next step so the scope is right.';
    db.logEvent('quote_held', number, { reason: 'no price ask' });
  }

  // A document is answered with what we understood, verbatim, then one
  // question: the summary is the model's own words about the file, so it is
  // never re-worded a second time (and never replaced by a price).
  const understoodPart = parts.find((p) => p.understoodText);

  if (parts.some((p) => p.kind === 'document')) {
    // The customer gets what we understood, then one question. A document is
    // not a request for a price.
    extraNote +=
      (extraNote ? ' ' : '') +
      'They sent a document and have been shown what we understood from it. Ask ONE short question about what they want done next. Do not quote a price until they ask for one.';
  }

  const unreadable = parts.filter((p) => p.unreadable).map((p) => p.kind);
  if (unreadable.length) {
    extraNote += ` The ${[...new Set(unreadable)].join(' and ')} could not be processed on our side. Say that briefly and honestly in one line, and ask them to resend it or describe it in text — do not pretend you saw it.`;
  }

  // ── the customer answering "shall I confirm?" ────────────
  // Arguments were frozen when we asked, so this cannot be re-pointed by the
  // new message — only confirmed or cancelled.
  const confirmationReply = await handleToolConfirmation(sock, jid, number, humanText, langInfo);
  if (confirmationReply) {
    await channel.say(confirmationReply, { incomingText: humanText });
    memory.saveUserTurn(number, humanText, 'text', { lang: langInfo.code, mood });
    memory.saveAssistantTurn(number, confirmationReply, 'text');
    return;
  }

  // ── clinic emergencies (phase 6, opt-in) ────────────────
  // A clinic's assistants are forbidden from giving medical advice, so the one
  // case that must never be answered by a model is checked first, answered with
  // the configured emergency number, and handed to a human immediately.
  if (emergencyGuardEnabled()) {
    const hit = detectEmergency(humanText);
    if (hit) {
      const lang = langInfo?.code === 'ur' ? 'ur' : langInfo?.code === 'roman-ur' ? 'roman-ur' : 'en';
      try {
        await channel.say(emergencyReply(lang), { incomingText: humanText });
        memory.saveUserTurn(number, humanText, 'text', { lang: langInfo?.code, mood });
        memory.saveAssistantTurn(number, emergencyReply(lang), 'text');
      } catch (err) {
        db.logEvent('agent_emergency_error', number, err.message);
      }
      const contact = emergencyContact();
      logAgentEvent(jid, 'clinic', 'emergency', { keyword: hit, contact: contact.configured ? 'configured' : 'missing' });
      try {
        await notifyOwner(
          sock,
          `🚨 Emergency words from +${number}: "${hit}"\n` +
            `They were told to call ${contact.number || 'their local emergency number'}. Please check on them.`
        );
      } catch {
        /* the customer's reply already went out */
      }
      return;
    }
  }

  // ── a price was asked for, and the scope is ready ──────
  // One deterministic reply, straight from the pricing code: no model, no
  // second bubble, no chance of a range that differs from the last one.
  if (quote && priceAsk) {
    // Stored before it is sent, like every other path: the turn is part of the
    // conversation even if the send itself fails.
    memory.saveUserTurn(number, humanText, parts.length > 1 ? 'mixed' : parts[0].kind, { lang: langInfo.code, mood, quote: true });
    const sentQuote = await deliverQuote(sock, jid, number, intake, quote, { channel });
    if (sentQuote) {
      memory.saveAssistantTurn(number, sentQuote, 'text');
      db.upsertContact(number, {
        language: langInfo.code,
        locale: langInfo.locale,
        category: 'lead',
        stage: 'quoted',
      });
      db.logEvent('message_in', number, { lang: langInfo.code, mood, kinds: parts.map((p) => p.kind), quote: true });
      rememberClaims(number, sentQuote);
      return;
    }
  }

  // ── who should answer this one? ─────────────────────────
  // Cheap rules first; the model only when they are unsure. A failure here
  // must never cost the customer a reply, so routeMessage never throws.
  let route = null;
  if (managerEnabled()) {
    try {
      route = await routeMessage({ text: humanText, mood, langInfo, chatId: jid });
      db.logIntent({
        tenant: config.tenant.slug,
        chat: jid,
        intent: route.intent,
        agent: route.agent,
        source: route.source,
        confidence: route.confidence,
      });
      db.logEvent('route', number, { intent: route.intent, source: route.source });
    } catch (err) {
      db.logEvent('route_error', number, err.message);
      route = null;
    }
  }

  // ── which custom agent answers? (phase 6, opt-in) ───────
  // With features.multiAgent off this block does nothing and nothing below
  // changes: the built-in manager and specialists behave exactly as before.
  const agentStartedAt = Date.now();
  let agentRoute = null;
  if (agentsEnabled()) {
    try {
      agentRoute = await routeToAgent({ text: humanText, chatId: jid, number, langInfo });
      db.logEvent('agent_route', number, { agent: agentRoute.agent?.id || null, source: agentRoute.source });
    } catch (err) {
      db.logEvent('agent_route_error', number, err.message);
      noteAgentFailure("unknown");
      agentRoute = null;
    }
  }

  // ── the reasoning path (phase 6 part 3, opt-in) ─────────
  // Off by default. When on, a complex turn gets a short plan before the reply
  // is written, and the reply is checked before it is sent. The plan is never
  // stored or shown; only a ≤300-character rationale reaches the audit table.
  let reasoning = null;
  let reasoningNote = '';
  if (reasoningModule.reasoningEnabled()) {
    try {
      const R = reasoningModule;
      const { reasonAboutTurn, planAddendum, reasoningConfig, holdingReply } = R;
      const cfgR = reasoningConfig();
      const history = (dossier?.recent || []).map((m) => ({ role: m.role, content: m.content }));
      const pass = reasonAboutTurn({ text: humanText, langInfo, history, now: ctx.clock(), chat: number });
      const raced = await Promise.race([
        pass.then((v) => ({ done: true, value: v })).catch(() => ({ done: true, value: null })),
        new Promise((resolve) => setTimeout(() => resolve({ done: false }), cfgR.turnLatencyMs)),
      ]);
      if (raced.done) {
        reasoning = raced.value;
        if (reasoning?.plan) {
          reasoningNote = planAddendum(reasoning.plan);
          // The decision record was written by reasonAboutTurn itself.
        }
      } else {
        // Out of time. The plan is skipped and the reply is written without it:
        // a holding message followed by the real answer would be two replies
        // for one message, which is exactly what must not happen.
        pass.catch(() => {});
        reasoning = { used: false, timedOut: true };
        db.logEvent('reasoning_timeout_no_holding_reply', number, { limit: cfgR.turnLatencyMs });
      }
    } catch (err) {
      db.logEvent('reasoning_error', number, err.message);
      reasoning = null;
    }
  }
  const replyNote = [extraNote, reasoningNote].filter(Boolean).join('\n\n');

  const replyArgs = {
    number,
    text: modelText,
    agent: route?.agent || null,
    agentConfig: agentRoute?.agent || null,
    kind: parts[0]?.kind || 'text',
    langInfo,
    dossier,
    intakeState: intake.state,
    features,
    extraNote: replyNote,
    tone: toneInfo.tone !== 'neutral' ? toneInfo.tone : contact.tone || 'neutral',
    chatId: jid,
    chatKey: number,
    send: (t) => channel.say(t, { incomingText: humanText }),
    notifyOwner: (t) => notifyOwner(sock, t),
  };

  const reply = await generateReply(replyArgs);

  // Every provider failed. The customer gets the short "we will reply soon"
  // line that the brain produces, and the owner is told why — a silent chain
  // failure is how a chat goes quiet for hours.
  if (reply?.provider === 'error') {
    db.logEvent('brain_no_provider', number, null);
    // One alert per problem, not one per message: a chain outage during a busy
    // hour must not turn into forty WhatsApp messages to the owner.
    const ALERT_WINDOW_MS = 30 * 60000;
    const lastAlert = Date.parse(db.getSetting('ai_down_alerted_at', '') || '') || 0;
    if (Date.now() - lastAlert > ALERT_WINDOW_MS) {
      db.setSetting('ai_down_alerted_at', new Date().toISOString());
      try {
        const health = keyChain.healthSnapshot();
        const broken = Object.entries(health)
          .flatMap(([provider, rows]) => rows.filter((r) => r.state !== 'active').map((r) => `${provider} key …${r.last4}: ${r.state}`))
          .slice(0, 4);
        await notifyOwner(
          sock,
          `⚠️ +${number}: none of the AI keys answered (${reply.model || 'unknown'}). The customer got the holding line.\n` +
            (broken.length ? `${broken.join('\n')}\n` : '') +
            'Reply in this chat if they need a human answer — I will stay quiet until a key works.'
        );
      } catch {
        /* the owner notification must not cost the reply */
      }
    }
  }

  let replyText = (reply?.text || '').trim();

  // ── the gate (phase 6 part 3) ───────────────────────────
  // A reasoned reply is checked for invented numbers, the wrong language and
  // leaked internals. One quiet retry, then the owner takes over — a wrong
  // price is worse than a slow answer.
  if (reasoning?.used && replyText) {
    try {
      const R = reasoningModule;
      const { verifyAnswer, allowedDigits, verifyHandoff, recordDecision } = R;
      const digits = allowedDigits();
      let verdict = verifyAnswer({ reply: replyText, langInfo, digits });
      if (!verdict.ok) {
        recordDecision({
          chat: number,
          kind: 'verify',
          action: 'rejected',
          rationale: `Rejected a draft: ${verdict.problems.join('; ')}`,
          outcome: 'retry',
        });
        const retry = await generateReply({
          ...replyArgs,
          extraNote: `${replyNote}\n\nYour previous draft was rejected because: ${verdict.problems.join('; ')}. Rewrite it. Use only numbers that appear in the business facts, catalogue or the customer's own orders. Keep the customer's language.`,
        });
        const retryText = (retry?.text || '').trim();
        if (retryText) {
          verdict = verifyAnswer({ reply: retryText, langInfo, digits });
          if (verdict.ok) {
            replyText = retryText;
            recordDecision({ chat: number, kind: 'verify', action: 'repaired', rationale: 'The retry passed every check', outcome: 'sent' });
          }
        }
        if (!verdict.ok) {
          recordDecision({
            chat: number,
            kind: 'verify',
            action: 'handoff',
            rationale: `Handed to the owner after two failed checks: ${verdict.problems.join('; ')}`,
            outcome: 'handoff',
          });
          await notifyOwner(sock, `⚠️ +${number}: I could not answer safely (${verdict.problems.join('; ')}). Your turn.`);
          replyText = verifyHandoff(langInfo.code);
        }
      }
    } catch (err) {
      db.logEvent('verify_error', number, err.message);
    }
  }

  // ── the last gate before a customer sees a word ─────────
  // Independent of the reasoning path, of the pipeline that produced the text
  // and of the provider that wrote it: numbers must exist in the business
  // facts, the language must be the conversation's, the voice must be one
  // voice, and the reply must be a finished sentence. One repair attempt, then
  // a safe line and the owner.
  if (replyText) {
    const guardCtx = {
      chat: number,
      extra: quote ? [quote.local?.min, quote.local?.max, quote.pkrMin, quote.pkrMax] : [],
      voice: voiceOf(),
    };
    let verdictG = guardReply({ text: replyText, langInfo, ...guardCtx });
    if (!verdictG.ok) {
      // The draft is kept in the event so the eval harness can report what the
      // model actually wrote, even when the customer only saw the repair.
      db.logEvent('reply_guard_rejected', number, {
        problems: verdictG.problems,
        draft: replyText.slice(0, 400),
        provider: reply?.provider || null,
        model: reply?.model || null,
      });
      let repaired = false;
      try {
        const retry = await generateReply({
          ...replyArgs,
          extraNote: `${replyNote}\n\nYour previous draft was rejected because: ${verdictG.problems.join('; ')}. Rewrite it so it breaks none of those rules, and finish the last sentence.`,
        });
        const retryText = (retry?.text || '').trim();
        if (retryText) {
          const second = guardReply({ text: retryText, langInfo, ...guardCtx });
          if (second.ok) {
            replyText = retryText;
            verdictG = second;
            repaired = true;
            if (retry?.provider) reply.provider = retry.provider;
            if (retry?.model) reply.model = retry.model;
            db.logEvent('reply_guard_repaired', number, null);
          }
        }
      } catch (err) {
        db.logEvent('reply_guard_retry_failed', number, err.message);
      }
      if (!repaired) {
        replyText = safeLine(langInfo.code);
        db.logEvent('reply_guard_safe_line', number, { problems: verdictG.problems });
        try {
          await notifyOwner(
            sock,
            `⚠️ +${number}: I could not send a safe reply (${verdictG.problems.join('; ')}). They got a holding line — please answer them yourself.`
          );
        } catch {
          /* the customer already has an answer */
        }
      }
    }
  }

  // ── "Here is what I understood" ─────────────────────────
  if (replyText && understoodPart) {
    const opening = understoodPart.understoodText;
    if (opening && !replyText.includes(opening.slice(0, 40))) {
      replyText = `${opening}\n\n${replyText}`;
      db.logEvent('document_understanding_sent', number, { file: understoodPart.fileName || null });
    }
  }

  if (!replyText && understoodPart?.understoodText) {
    replyText = understoodPart.understoodText;
  }

  if (!replyText) {
    memory.saveUserTurn(number, humanText, parts.length > 1 ? 'mixed' : parts[0].kind, {
      lang: langInfo.code,
      mood,
      note: 'no_reply_generated',
    });
    memory.saveAssistantTurn(number, "[no reply generated]", 'system');
    await channel.say("Sorry — that one didn't come through. Can you say it again?", { delay: 700 });
    return;
  }

  // ── agent bookkeeping (phase 6) ─────────────────────────
  if (agentRoute?.agent) {
    logAgentEvent(jid, agentRoute.agent.id, 'first_reply', { ms: Date.now() - agentStartedAt });
    noteAgentSuccess(agentRoute.agent.id);
    noteAgentTokens(agentRoute.agent.id, Math.ceil((replyText.length + humanText.length) / 4));
  }

  // ── brevity: the fewest sentences that work ─────────────
  // A local trim, not another model call: the reply is already written, and
  // asking again costs seconds the customer can count. Numbers, links and a
  // closing question survive; lists and quoted prices are exempt.
  if (replyText && !understoodPart) {
    try {
      const { trimReply } = await import('../core/brevity.js');
      const trimmed = trimReply(replyText, { userText: humanText, lang: langInfo.code });
      if (trimmed.changed) {
        db.logEvent('reply_trimmed', number, { dropped: trimmed.dropped.length, from: replyText.length, to: trimmed.text.length });
        replyText = trimmed.text;
      }
    } catch (err) {
      db.logEvent('trim_error', number, err.message);
    }
  }

  // ── voice reply decision ────────────────────────────────
  const voiceMode = db.getSetting('tts_mode', config.tts.mode);
  const firstMessage = (contact?.message_count || 0) <= 1;
  let voice = null;
  if (shouldSpeak({ mode: voiceMode, clientSentVoice, text: humanText, firstMessage })) {
    try {
      // Only the part that fits in ~20 s is spoken; the text is sent either way,
      // and a quote is never voice-only (see sendHuman).
      const spoken = speechTextFor(replyText, { langInfo });
      voice = await buildVoiceNote(spoken, { langInfo });
      if (voice && spoken.trim() !== replyText.trim()) {
        db.logEvent('tts_shortened', number, { from: replyText.length, to: spoken.length });
      }
    } catch (err) {
      // A failed voice note is not a failed reply: the text goes out alone.
      db.logEvent('tts_failed', number, err.message);
      voice = null;
    }
  }

  const sent = await channel.say(replyText, { incomingText: humanText, voice });
  noteSent(Array.isArray(sent) ? sent.map((m) => m?.key?.id) : sent?.key?.id ? [sent.key.id] : []);
  rememberClaims(number, replyText);

  // ── persist the turn ────────────────────────────────────
  memory.saveUserTurn(number, humanText, parts.length > 1 ? 'mixed' : parts[0].kind, {
    lang: langInfo.code,
    mood,
    parts: parts.map((p) => p.kind),
  });
  memory.saveAssistantTurn(number, replyText, voice ? 'voice' : 'text');

  db.upsertContact(number, {
    language: langInfo.code,
    locale: langInfo.locale,
    tone: toneInfo.tone !== 'neutral' ? toneInfo.tone : contact.tone || 'neutral',
    category: intake.state.stage === 'quoted' ? 'lead' : contact.category || 'lead',
    stage: intake.state.stage === 'quoted' ? 'quoted' : contact.stage === 'new' ? 'discovering' : contact.stage,
    voice_pref: voice ? 'yes' : clientSentVoice ? (contact.voice_pref || 'unknown') : contact.voice_pref,
  });

  db.logEvent('message_in', number, {
    lang: langInfo.code,
    mood,
    kinds: parts.map((p) => p.kind),
    voiceOut: !!voice,
    provider: reply?.provider || null,
    model: reply?.model || null,
    langSource: langInfo.source || null,
  });

  // Phase 6 Part 3 — a reply is the only honest signal a proactive message
  // worked. Off unless the brain is on; it never sends anything.
  try {
    const { learningEnabled, noteReplyOutcome } = await import('../services/learning.js');
    if (learningEnabled()) noteReplyOutcome(number);
  } catch {
    /* the weights are not worth a failed turn */
  }

  // ── quote, lead and follow-up ───────────────────────────
  // (A quote is never sent as a second message here: it either was the reply
  // above, or it is held until the customer asks for a price.)

  // ── the "ask one question" bookkeeping ──────────────────
  if (intake.nextField && /\?/.test(replyText)) {
    try {
      markAsked(intake.state, intake.nextField);
    } catch {
      /* ignore */
    }
  }

  // ── escalation / owner notifications ────────────────────
  // A complaint is handed to the owner with a summary, whether or not it also
  // trips the keyword escalator — one notification, not two.
  if (route?.intent === 'complaint' && config.behavior.escalateToOwner) {
    db.logEvent('complaint_handoff', number, { source: route.source });
    await notifyOwner(
      sock,
      `😟 Complaint — +${number}\nThey said: "${humanText.slice(0, 240)}"\n\n${memory.buildOwnerBrief(number)}`
    );
    await notifyOperator(sock, number, `😟 A customer complained (+${number}). It is in your chat.`);
  } else {
    const esc = needsOwner(humanText);
    if (esc.required && config.behavior.escalateToOwner) {
      db.logEvent('escalation', number, { reason: esc.reason });
      await notifyOwner(sock, `⚠️ Needs you — +${number} (${esc.reason})\n\n${memory.buildOwnerBrief(number)}`);
      await notifyOperator(sock, number, `⚠️ Your chat +${number} needs a human (${esc.reason}).`);
    }
  }

  // ── memory roll-up every N messages ─────────────────────
  memory.summarizeIfNeeded(number).catch(() => {});
}

// ── turning one incoming item into a text part ─────────────
async function interpretItem({ transport, incoming, number }) {
  const info = incoming;
  const caption = incoming.caption || '';
  // One call, whatever the transport: Baileys downloads the proto it kept,
  // the Cloud API fetches by media id. The handler does not care which.
  const download = () => transport.getMedia(incoming);

  switch (incoming.kind) {
    case 'text': {
      const text = info.text.trim();
      return text ? { kind: 'text', text } : null;
    }

    case 'voice':
    case 'audio': {
      if (!sttEnabled()) return { kind: 'voice', text: '[Voice note — could not be transcribed]', unreadable: true };
      const { buffer, mimetype } = await download();
      const result = await transcribe(buffer, { mimetype });
      if (!result?.text || !looksMeaningful(result.text)) {
        return { kind: 'voice', text: '[Voice note — could not be transcribed]', unreadable: true };
      }
      return {
        kind: 'voice',
        text: result.text,
        seconds: Math.round(result.duration || info.seconds || 0),
        lang: result.language,
      };
    }

    case 'image':
    case 'sticker': {
      // Local visual search first: it is free, it needs no key, and when it is
      // sure it answers from the catalogue instead of guessing. Everything
      // below (Gemini) stays exactly as it was for when the model is missing.
      let media = null;
      const readMedia = async () => {
        if (!media) media = await download();
        return media;
      };
      {
        const { visualSearchEnabled } = await import('../services/visualSearch.js');
        if (visualSearchEnabled()) {
          const { buffer, mimetype } = await readMedia();
          const { visualLookup } = await import('../services/visualSearch.js');
          const visual = await visualLookup({ buffer, mimetype, number });
          if (visual.handled) {
            return { kind: 'image', text: caption || '', caption, visual };
          }
        }
      }
      if (!visionEnabled()) {
        return {
          kind: 'image',
          text: caption || '[Image sent — I cannot see images right now]',
          unreadable: !caption,
        };
      }
      const { buffer, mimetype } = await readMedia();
      const dossier = memory.getDossier(number);
      const context = describeContext(dossier);
      const vision = await analyzeImage({ buffer, mimetype, caption, context });
      if (!vision) {
        return { kind: 'image', text: caption || '[Image sent — I could not open it]', unreadable: !caption };
      }
      return {
        kind: 'image',
        text: vision.description,
        caption,
        provider: vision.provider,
      };
    }

    case 'video': {
      const caps = videoCapabilities();
      if (!caps.ready) {
        return { kind: 'video', text: caption || '[Video sent — I cannot watch videos right now]', unreadable: !caption };
      }
      const { buffer, mimetype } = await download();
      const dossier = memory.getDossier(number);
      const vision = await understandVideo({
        buffer,
        mimetype,
        caption,
        context: describeContext(dossier),
        declaredSeconds: info.seconds,
      });
      if (!vision?.description) {
        return { kind: 'video', text: caption || '[Video sent — I could not watch it]', unreadable: !caption };
      }
      return {
        kind: 'video',
        text: vision.description,
        caption,
        seconds: info.seconds,
        provider: vision.provider,
      };
    }

    case 'document': {
      const { buffer, mimetype } = await download();
      const text = await extractText(buffer, { mimetype, fileName: info.fileName });
      if (!text) {
        return {
          kind: 'document',
          text: `[Document: ${info.fileName}] (could not read this format)`,
          fileName: info.fileName,
        };
      }

      const brief = looksLikeBrief(text);
      if (brief) {
        const extracted = await extractProjectBrief(text, {
          context: JSON.stringify(getState(number).fields || {}),
        });
        if (extracted) {
          mergeExternalFields(number, extracted);
          db.logEvent('brief_extracted', number, { file: info.fileName });
        }
      }

      // The whole file is read (in chunks when it is long), and the customer
      // is shown what we understood — then asked what they want done, before
      // any price is mentioned.
      const summary = await summarizeDocument(text, {
        context: describeContext(memory.getDossier(number)),
      });
      const understanding = summary ? understoodReply(summary, detectLanguage(text).code) : null;
      db.logEvent('document_read', number, { file: info.fileName, chars: text.length, understood: !!summary });

      return {
        kind: 'document',
        text: understanding || text.slice(0, 700),
        fileName: info.fileName,
        isBrief: brief,
        understood: !!summary,
        // Shown to the customer verbatim, ahead of the model's question.
        understoodText: understanding || null,
      };
    }

    case 'location': {
      const loc = incoming.location || {};
      const lat = loc.lat;
      const lng = loc.lng;
      return {
        kind: 'location',
        text: `[Location shared${loc.name ? `: ${loc.name}` : ''}${lat ? ` — https://maps.google.com/?q=${lat},${lng}` : ''}]`,
      };
    }

    case 'contact': {
      return { kind: 'contact', text: `[Contact card: ${incoming.contactName || 'contact'}]` };
    }

    case 'reaction':
    case 'protocol':
      return null;

    default:
      return caption ? { kind: 'other', text: caption } : null;
  }
}

function describeContext(dossier) {
  const bits = [];
  if (dossier.summary) bits.push(dossier.summary.slice(0, 400));
  const fields = dossier.intake?.fields || {};
  if (Object.keys(fields).length) bits.push(`Project so far: ${JSON.stringify(fields).slice(0, 500)}`);
  if (dossier.lead?.project_type) bits.push(`Saved lead: ${dossier.lead.project_type}`);
  return bits.join(' | ');
}

function renderForModel(parts) {
  return parts
    .map((p) => {
      if (p.kind === 'text') return p.text;
      if (p.kind === 'voice') {
        return `[Voice note${p.seconds ? ` · ${p.seconds}s` : ''}] ${p.text}`;
      }
      if (p.kind === 'image') {
        return `[Image] ${p.text}${p.caption ? `\n(Caption they wrote: "${p.caption}")` : ''}`;
      }
      if (p.kind === 'video') {
        return `[Video${p.seconds ? ` · ${p.seconds}s` : ''}] ${p.text}${p.caption ? `\n(Caption: "${p.caption}")` : ''}`;
      }
      if (p.kind === 'document') {
        return `[Document: ${p.fileName}] ${p.text}`;
      }
      return p.text;
    })
    .join('\n\n');
}

// ── quote and invoice documents ─────────────────────────────
/**
 * Attach the PDF, if the owner turned features.pdfInvoices on.
 *
 * Deliberately quiet: the text version is always sent first, so a missing font,
 * a bad logo or a transport without document support costs nothing. Every
 * failure is logged with its reason instead of vanishing.
 */
async function maybeSendInvoice(sock, jid, { order = null, quote = null, number = null } = {}) {
  try {
    const { pdfInvoicesEnabled, sendInvoice } = await import('../services/invoice.js');
    if (!pdfInvoicesEnabled()) return;
    if (typeof sock.can === 'function' && !sock.can('document')) {
      db.logEvent('invoice_skipped', number, 'transport has no document support');
      return;
    }
    const res = await sendInvoice({ transport: sock, jid, order, quote, number });
    if (!res.ok) db.logEvent('invoice_fallback', number, res.reason || 'unknown');
  } catch (err) {
    db.logEvent('invoice_error', number, err.message);
  }
}

// ── quote delivery ──────────────────────────────────────────
async function deliverQuote(sock, jid, number, intake, quote, { channel = null } = {}) {
  try {
    const quoteText = formatQuote(quote, intake.state.fields);
    // Through the batch channel when there is one: the quote is the reply, not
    // an extra bubble after it.
    const sent = channel
      ? await channel.say(quoteText, { incomingText: 'quote' })
      : await sendHuman(sock, jid, quoteText, { incomingText: 'quote' });
    if (channel && !sent) {
      db.logEvent('quote_not_sent_duplicate', number, null);
      return null;
    }
    noteSent((sent || []).map((m) => m?.key?.id));
    await maybeSendInvoice(sock, jid, { quote, number });

    markQuoted(intake.state, quote);

    const contact = db.getContact(number) || {};
    const lead = {
      number,
      name: contact.name || contact.push_name || null,
      country: quote.country,
      currency: quote.local.currency,
      project_type: quote.serviceName,
      goal: intake.state.fields.goal || null,
      features: intake.state.fields.features || null,
      design: intake.state.fields.design || null,
      content: intake.state.fields.content || null,
      timeline: intake.state.fields.timeline || quote.timeline,
      budget: intake.state.fields.budget || null,
      tech: intake.state.fields.tech || (quote.stack || []).join(', '),
      extra: intake.state.fields.extra || null,
      quote_min: quote.local.min,
      quote_max: quote.local.max,
      quote_currency: quote.local.currency,
      status: 'quoted',
    };
    db.saveLead(lead);
    const scored = refreshLead(number);
    db.logEvent('quote_sent', number, { min: quote.pkrMin, max: quote.pkrMax, score: scored?.score });

    scheduleFollowUp(number, { attempt: 1 });
    saveLeadToSheet(lead).catch(() => {});

    await notifyOperator(sock, number, `💰 A quote went out to your client +${number} (${quote.local.minText} – ${quote.local.maxText}).`);
    await notifyOwner(
      sock,
      `💰 Quote sent to ${contact.name || `+${number}`}${scored ? ` · ${scored.score}/100 ${scored.priority.toUpperCase()}` : ''}\n` +
        `${quote.serviceName} — ${quote.local.minText} – ${quote.local.maxText}\n` +
        `${intake.state.fields.goal ? `Goal: ${String(intake.state.fields.goal).slice(0, 160)}\n` : ''}` +
        `Follow-up scheduled in ${config.behavior.followUpHours}h.`
    );
    return quoteText;
  } catch (err) {
    db.logEvent('quote_error', number, err.message);
    console.error('Quote delivery failed:', err.message);
  }
}

// ── unreadable media ───────────────────────────────────────
async function handleUnreadable(sock, jid, problems) {
  if (problems.includes('voice')) {
    await sendTyping(
      sock,
      jid,
      "Your voice note didn't come through on my side — mind typing it? (Or send it again, sometimes the network eats them.)",
      { delay: 900 }
    );
    return;
  }
  await sendTyping(sock, jid, "That file didn't come through — can you send it again, or just tell me in text?", { delay: 900 });
}

// ── owner notifications ────────────────────────────────────
export async function notifyOwner(sock, text) {
  try {
    await sendTyping(sock, config.owner.jid, text, { delay: 200 });
  } catch (err) {
    console.error('Owner notify failed:', err.message);
  }
}

export default { handleIncoming, notifyOwner, noteSent, startPendingFlusher };

// ════════════════════════════════════════════════════════════
// Tool confirmations (phase 2, opt-in)
// ════════════════════════════════════════════════════════════

/**
 * If this chat has a pending booking/order and the customer just said yes or
 * no, finish it here and return the reply text. Null means "carry on normally".
 */
async function handleToolConfirmation(sock, jid, number, text, langInfo) {
  if (!toolCallingEnabled() || !hasPendingConfirmation(jid)) return null;

  if (isNegative(text)) {
    const cancelled = cancelPending(jid, { tenant: config.tenant.slug });
    if (cancelled.status !== 'cancelled') return null;
    db.logEvent('tool_cancelled', number, { tool: cancelled.tool });
    return 'No problem — cancelled that. Anything you want to change?';
  }

  if (!isAffirmative(text)) return null;

  const outcome = await confirmPending(jid, {
    tenant: config.tenant.slug,
    number,
    notifyOwner: (t) => notifyOwner(sock, t),
    who: number,
  });

  if (outcome.status !== 'ok') {
    db.logEvent('tool_confirm_failed', number, { tool: outcome.tool, status: outcome.status });
    // Never surface the reason; keep the conversation moving.
    return 'That one didn\'t go through on my side — let me get the owner to sort it out. Anything else I can help with meanwhile?';
  }

  const result = outcome.result || {};
  db.logEvent('tool_confirmed', number, { tool: outcome.tool });

  if (outcome.tool === 'book_slot' && result.booking) {
    const b = result.booking;
    const already = result.alreadyBooked ? ' (this was already booked, so nothing changed)' : '';
    return `✅ Booked — ${b.service} on ${b.date} at ${b.time}${b.name ? ` for ${b.name}` : ''}.${already}\n\nYou'll get a reminder a day before.`;
  }

  if (outcome.tool === 'create_order' && result.total !== undefined) {
    const lines = (result.items || []).map((i) => `• ${i.qty}× ${i.name} — ${i.unit?.toLocaleString?.() ?? i.unit}`);
    return [
      `✅ Order confirmed — #${result.orderId}`,
      '',
      ...lines,
      '',
      `*Total: ${result.total.toLocaleString()} ${result.currency}*`,
      '',
      'The owner has it. Pay on delivery unless you already paid online.',
    ].join('\n');
  }

  return '✅ Done — the owner has it.';
}

export { handleToolConfirmation };
