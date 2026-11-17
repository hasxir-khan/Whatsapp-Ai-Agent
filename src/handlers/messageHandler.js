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

import { config, isFriend, friendName, isTeam, teamMember, teamMembers } from '../config/env.js';
import { normalizeBaileys } from '../transport/baileys.js';
import { normalizeIncoming } from '../transport/base.js';
import * as db from '../utils/db.js';
import * as media from '../services/media.js';
import { detectLanguage, detectTone, fromWhisperLanguage } from '../services/language.js';
import { generateReply, detectMood, needsOwner } from '../core/brain.js';
import { routeMessage, managerEnabled } from '../core/manager.js';
import { detectOptOut, detectOptIn, recordOptOut, recordOptIn, optOutConfirmation } from '../services/growth.js';
import { bookingAgentEnabled, handleBookingTurn } from '../services/bookingAgent.js';
import { cancelFor as cancelFollowUpDrafts } from '../services/followUpAgent.js';
import { closerAgentEnabled, handleCloserTurn, readyToBuy, startOrder, handleReceipt } from '../services/closerAgent.js';
import { reviewAgentEnabled, handleRating, attributeReferral } from '../services/reviewAgent.js';
import { recordSourceTag } from '../services/growthDashboard.js';
import {
  toolCallingEnabled, hasPendingConfirmation, confirmPending, cancelPending,
  isAffirmative, isNegative,
} from '../core/tools.js';
import { ingest, markAsked, markQuoted, getState, mergeExternalFields } from '../core/projectIntake.js';
import { buildQuote, formatQuote } from '../core/pricing.js';
import * as memory from '../services/memory.js';
import { sendHuman, sendTyping, markRead, isQuietNow, quietEndsAt } from '../core/humanizer.js';
import { transcribe, sttEnabled, looksMeaningful } from '../services/transcription.js';
import { visionEnabled, analyzeImage } from '../services/vision.js';
import { understandVideo, videoCapabilities } from '../services/video.js';
import { ttsEnabled, buildVoiceNote, shouldSpeak } from '../services/tts.js';
import { extractText, summarizeDocument, extractProjectBrief, looksLikeBrief } from '../services/documents.js';
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
// Entry point — called for every upserted message
// ════════════════════════════════════════════════════════════
export async function handleIncoming(transport, rawIncoming) {
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

    const info = incoming;
    const number = incoming.number;

    // ── the owner's own messages ───────────────────────────
    if (incoming.fromMe) {
      if (ownSentIds.has(msgId)) return; // our own send echoed back
      return await handleOwnerSide(transport, { jid, number, info, incoming });
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

    // ── bookkeeping ────────────────────────────────────────
    // Only transports that can report a deletion are worth remembering.
    if (transport.can?.('deletedMessages') !== false && incoming.raw) rememberMessage(incoming.raw);

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

    // ── "stop" means stop ──────────────────────────────────
    // Checked before the AI, before intake, before anything can decide to be
    // clever. It is honoured instantly: pending drafts die here.
    const said = (info.text || info.caption || '').trim();
    if (said && detectOptOut(said)) {
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

    // ── a rating for a job we just finished ────────────────
    // Only when a review ask is actually waiting: "5" in an unrelated chat is
    // a quantity, not a score.
    if (reviewAgentEnabled() && said) {
      try {
        const rated = await handleRating({ number, text: said, transport, now: new Date() });
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
    if (spam.isScam) {
      await sendTyping(transport, jid, WARN_MESSAGE, { delay: 900 });
      await notifyOwner(transport, `🚫 Possible scam from +${number}\n${(info.text || '').slice(0, 200)}\nBlocked: ${spam.action === 'block' ? 'yes' : 'no'}`);
      return;
    }

    await markRead(transport, [{ id: incoming.id }]);

    // ── quiet hours: hold the reply for the morning ────────
    if (config.behavior.deferQuietHours && isQuietNow()) {
      db.savePending(
        number,
        {
          jid,
          reason: 'quiet_hours',
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

    enqueue(transport, jid, number, { incoming });
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

async function handleOwnerSide(sock, { jid, number, info, incoming }) {
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
      return runCommand(sock, jid, `${text} ${number}`);
    }
    return runCommand(sock, jid, text);
  }

  if (isSelfChat) {
    // Chatting with your own bot is allowed and handy for testing
    if (!text) return;
    return answerOwnerQuestion(sock, jid, text);
  }

  // Owner replied manually to a client → step back for a while
  const minutes = config.behavior.handoffMinutes;
  const until = new Date(Date.now() + minutes * 60000).toISOString();
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
      const seen = observeOwnerReply({ number, text, transport: sock, now: new Date() });
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

async function runCommand(sock, jid, text, from = config.owner.number) {
  if (!config.behavior.ownerCommands) return;
  try {
    const result = await handleOwnerCommand(sock, jid, text, from);
    if (result?.reply) await sendTyping(sock, jid, result.reply, { delay: 250 });
  } catch (err) {
    console.error('Command error:', err.message);
    await sendTyping(sock, jid, `Command failed: ${err.message}`, { delay: 200 });
  }
}

// ════════════════════════════════════════════════════════════
// Debounce: wait for the client to finish typing their burst
// ════════════════════════════════════════════════════════════
function enqueue(sock, jid, number, item) {
  const key = number;
  const entry = buffers.get(key) || { jid, number, items: [], timer: null };
  entry.items.push(item);
  entry.jid = jid;
  if (entry.timer) clearTimeout(entry.timer);

  entry.timer = setTimeout(() => {
    buffers.delete(key);
    const items = entry.items;
    processBatch(sock, entry.jid, number, items).catch((err) => {
      console.error('Batch error:', err.message);
      db.logEvent('batch_error', number, err.message);
    });
  }, config.behavior.debounceMs);

  buffers.set(key, entry);
}

/** Send any quiet-hour messages that are now due. */
export function startPendingFlusher(sock) {
  const timer = setInterval(async () => {
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
  }, 60_000);
  timer.unref?.();
  return timer;
}

// ════════════════════════════════════════════════════════════
// The batch pipeline
// ════════════════════════════════════════════════════════════
async function processBatch(sock, jid, number, items) {
  const contact = db.getContact(number);
  if (!contact || contact.is_blocked) return;
  if (isPaused(contact) || db.getSetting('bot_enabled', true) !== true) return;

  // The client replied → stop any scheduled nudge, and drop any draft the
  // growth agent was waiting to send. Silence means silence.
  cancelFor(number);
  cancelFollowUpDrafts(number, 'replied');

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
  const detected = detectLanguage(humanText || 'voice');
  let langInfo = detected;
  if (detected.code === 'unknown') {
    // A voice note carries its own language tag from Whisper — trust it
    const voicePart = parts.find((p) => p.kind === 'voice' && p.lang);
    const fromVoice = voicePart ? fromWhisperLanguage(voicePart.lang) : null;
    if (fromVoice) langInfo = fromVoice;
    else if (contact.language) langInfo = detectLanguage(contact.language);
  }
  const mood = detectMood(humanText);
  const toneInfo = detectTone(humanText, langInfo.code);
  const tone = toneInfo.tone !== 'neutral' ? toneInfo.tone : 'neutral';

  // Long-term context BEFORE this turn is stored, so it isn't duplicated
  const dossier = { ...memory.getDossier(number), mood };

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
          now: new Date(),
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
          noteSent([(await sendTyping(sock, jid, ack, { delay: 500 }))?.key?.id]);
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
      const turn = await handleBookingTurn({ number, text: humanText, lang: langInfo.code, now: new Date() });
      if (turn.handled) {
        memory.saveUserTurn(number, humanText, parts.length > 1 ? 'mixed' : parts[0].kind, { lang: langInfo.code, booking: true });
        const sentB = await sendTyping(sock, jid, turn.reply, { delay: 500 });
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
      const turn = ready ? null : handleCloserTurn({ number, text: humanText, lang: langInfo.code, now: new Date() });
      const out = turn?.handled ? turn : ready ? startOrder({ number, text: humanText, lang: langInfo.code, now: new Date() }) : null;
      if (out) {
        memory.saveUserTurn(number, humanText, parts.length > 1 ? 'mixed' : parts[0].kind, { lang: langInfo.code, closer: true });
        memory.saveAssistantTurn(number, out.reply, 'text');
        noteSent([(await sendTyping(sock, jid, out.reply, { delay: 500 }))?.key?.id]);
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
  let intake;
  try {
    intake = await ingest(number, modelText, { explicitPriceQuestion });
  } catch (err) {
    db.logEvent('intake_error', number, err.message);
    intake = { state: getState(number), readyToQuote: false, nextField: null };
  }

  const features = {
    visionEnabled: visionEnabled(),
    videoEnabled: videoCapabilities().ready,
    ttsEnabled: ttsEnabled(),
    sttEnabled: sttEnabled(),
  };

  const quote = intake.readyToQuote ? intake.quote || buildQuote(intake.state.fields, number) : null;

  let extraNote = quote
    ? 'A price estimate is being sent automatically as the next message based on the collected scope. Write only a 1–2 line lead-in (do not restate the numbers).'
    : '';

  const unreadable = parts.filter((p) => p.unreadable).map((p) => p.kind);
  if (unreadable.length) {
    extraNote += ` The ${[...new Set(unreadable)].join(' and ')} could not be processed on our side. Say that briefly and honestly in one line, and ask them to resend it or describe it in text — do not pretend you saw it.`;
  }

  // ── the customer answering "shall I confirm?" ────────────
  // Arguments were frozen when we asked, so this cannot be re-pointed by the
  // new message — only confirmed or cancelled.
  const confirmationReply = await handleToolConfirmation(sock, jid, number, humanText, langInfo);
  if (confirmationReply) {
    await sendHuman(sock, jid, confirmationReply, { incomingText: humanText });
    memory.saveUserTurn(number, humanText, 'text', { lang: langInfo.code, mood });
    memory.saveAssistantTurn(number, confirmationReply, 'text');
    return;
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

  const reply = await generateReply({
    number,
    text: modelText,
    agent: route?.agent || null,
    kind: parts[0]?.kind || 'text',
    langInfo,
    dossier,
    intakeState: intake.state,
    features,
    extraNote,
    tone: toneInfo.tone !== 'neutral' ? toneInfo.tone : contact.tone || 'neutral',
    chatId: jid,
    send: (t) => sendHuman(sock, jid, t, { incomingText: humanText }),
    notifyOwner: (t) => notifyOwner(sock, t),
  });

  const replyText = (reply?.text || '').trim();
  if (!replyText) {
    memory.saveUserTurn(number, humanText, parts.length > 1 ? 'mixed' : parts[0].kind, {
      lang: langInfo.code,
      mood,
      note: 'no_reply_generated',
    });
    memory.saveAssistantTurn(number, "[no reply generated]", 'system');
    await sendTyping(sock, jid, "Sorry — that one didn't come through. Can you say it again?", { delay: 700 });
    return;
  }

  // ── voice reply decision ────────────────────────────────
  const voiceMode = db.getSetting('tts_mode', config.tts.mode);
  let voice = null;
  if (shouldSpeak({ mode: voiceMode, clientSentVoice, text: humanText })) {
    try {
      voice = await buildVoiceNote(replyText, { langInfo });
    } catch (err) {
      db.logEvent('tts_failed', number, err.message);
    }
  }

  const sent = await sendHuman(sock, jid, replyText, { incomingText: humanText, voice });
  noteSent((sent || []).map((m) => m?.key?.id));

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

  db.logEvent('message_in', number, { lang: langInfo.code, mood, kinds: parts.map((p) => p.kind), voiceOut: !!voice });

  // ── quote, lead and follow-up ───────────────────────────
  if (quote) {
    await deliverQuote(sock, jid, number, intake, quote);
  }

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
      if (!visionEnabled()) {
        return {
          kind: 'image',
          text: caption || '[Image sent — I cannot see images right now]',
          unreadable: !caption,
        };
      }
      const { buffer, mimetype } = await download();
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

      const summary = (await summarizeDocument(text, {
        context: describeContext(memory.getDossier(number)),
      })) || text.slice(0, 700);

      return {
        kind: 'document',
        text: summary,
        fileName: info.fileName,
        isBrief: brief,
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
async function deliverQuote(sock, jid, number, intake, quote) {
  try {
    const quoteText = formatQuote(quote, intake.state.fields);
    const sent = await sendHuman(sock, jid, quoteText, { incomingText: 'quote' });
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
