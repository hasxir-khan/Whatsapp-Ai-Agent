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
import * as db from '../utils/db.js';
import * as media from '../services/media.js';
import { detectLanguage, detectTone, fromWhisperLanguage } from '../services/language.js';
import { generateReply, detectMood, needsOwner } from '../core/brain.js';
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
export async function handleIncoming(sock, msg) {
  try {
    if (!msg?.message || !msg.key?.remoteJid) return;

    const msgId = msg.key.id;
    if (msgId && processedIds.has(msgId)) return;
    track(processedIds, msgId);

    const jid = msg.key.remoteJid;
    const kind = media.chatKind(jid);

    // ── only 1-to-1 chats are allowed, ever ────────────────
    if (kind !== 'private') {
      if (kind === 'group' || kind === 'newsletter') {
        db.logEvent('ignored_chat', null, { kind, jid });
      }
      return;
    }

    const info = media.describeMessage(msg);
    const number = media.resolveNumber(msg);
    if (!number) return;

    // ── the owner's own messages ───────────────────────────
    if (msg.key.fromMe) {
      if (ownSentIds.has(msgId)) return; // our own send echoed back
      return await handleOwnerSide(sock, { jid, number, info, msg });
    }

    if (number === config.owner.number) {
      // Message to yourself from another device
      if (isCommand(info.text)) return await runCommand(sock, jid, info.text, number);
      return;
    }

    // ── team members (multi-user) ──────────────────────────
    // A teammate messaging the bot is an operator, never a client.
    if (isTeam(number)) {
      return await handleTeammate(sock, jid, number, info);
    }

    // ── bookkeeping ────────────────────────────────────────
    rememberMessage(msg); // so "delete for everyone" can be recovered

    const existing = db.getContact(number);
    const friend = isFriend(number);
    const contact = db.upsertContact(number, {
      jid,
      push_name: msg.pushName || existing?.push_name || null,
      name: existing?.name || friendName(number) || msg.pushName || null,
      category: friend ? 'friend' : existing?.category || 'new',
      increment_messages: true,
    });

    if (contact?.is_blocked) return;
    if (db.getSetting('bot_enabled', true) !== true) return;

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
      await sendTyping(sock, jid, WARN_MESSAGE, { delay: 900 });
      await notifyOwner(sock, `🚫 Possible scam from +${number}\n${(info.text || '').slice(0, 200)}\nBlocked: ${spam.action === 'block' ? 'yes' : 'no'}`);
      return;
    }

    await markRead(sock, [msg.key]);

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
        sock,
        `🆕 New chat: ${msg.pushName || 'unknown'}\n+${number} · ${geo.country} · ${geo.currency}\n“${preview}”`
      );
      db.logEvent('new_contact', number, { country: geo.country });
    }

    enqueue(sock, jid, number, { msg, info });
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

async function handleOwnerSide(sock, { jid, number, info, msg }) {
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
    if (!isSelfChat) {
      try {
        await sock.sendMessage(jid, { delete: msg.key });
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
          msg: { key: { remoteJid: jid }, message: {} },
          info: {
            kind: 'text',
            text,
            caption: payload.caption || '',
            mimetype: '',
            fileName: '',
            seconds: 0,
          },
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

  // The client replied → stop any scheduled nudge
  cancelFor(number);

  const parts = [];
  const problems = [];
  let clientSentVoice = false;

  for (const { msg, info } of items.slice(0, 5)) {
    try {
      const part = await interpretItem({ msg, info, number });
      if (part) {
        parts.push(part);
        if (part.kind === 'voice') clientSentVoice = true;
      }
    } catch (err) {
      console.error(`Media (${info.kind}) error:`, err.message);
      db.logEvent('media_error', number, { kind: info.kind, error: err.message });
      problems.push(info.kind === 'voice' ? 'voice' : 'media');
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

  const reply = await generateReply({
    number,
    text: modelText,
    kind: parts[0]?.kind || 'text',
    langInfo,
    dossier,
    intakeState: intake.state,
    features,
    extraNote,
    tone: toneInfo.tone !== 'neutral' ? toneInfo.tone : contact.tone || 'neutral',
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
  const esc = needsOwner(humanText);
  if (esc.required && config.behavior.escalateToOwner) {
    db.logEvent('escalation', number, { reason: esc.reason });
    await notifyOwner(sock, `⚠️ Needs you — +${number} (${esc.reason})\n\n${memory.buildOwnerBrief(number)}`);
    await notifyOperator(sock, number, `⚠️ Your chat +${number} needs a human (${esc.reason}).`);
  }

  // ── memory roll-up every N messages ─────────────────────
  memory.summarizeIfNeeded(number).catch(() => {});
}

// ── turning one incoming item into a text part ─────────────
async function interpretItem({ msg, info, number }) {
  const caption = info.caption || '';

  switch (info.kind) {
    case 'text': {
      const text = info.text.trim();
      return text ? { kind: 'text', text } : null;
    }

    case 'voice':
    case 'audio': {
      if (!sttEnabled()) return { kind: 'voice', text: '[Voice note — could not be transcribed]', unreadable: true };
      const { buffer, mimetype } = await media.downloadMedia(msg, info);
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
      const { buffer, mimetype } = await media.downloadMedia(msg, info);
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
      const { buffer, mimetype } = await media.downloadMedia(msg, info);
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
      const { buffer, mimetype } = await media.downloadMedia(msg, info);
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
      const loc = info.content.locationMessage || info.content.liveLocationMessage || {};
      const lat = loc.degreesLatitude;
      const lng = loc.degreesLongitude;
      return {
        kind: 'location',
        text: `[Location shared${loc.name ? `: ${loc.name}` : ''}${lat ? ` — https://maps.google.com/?q=${lat},${lng}` : ''}]`,
      };
    }

    case 'contact': {
      const c = info.content.contactMessage;
      const arr = info.content.contactsArrayMessage;
      const name = c?.displayName || arr?.displayName || 'contact';
      return { kind: 'contact', text: `[Contact card: ${name}]` };
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

// ── quote delivery ──────────────────────────────────────────
async function deliverQuote(sock, jid, number, intake, quote) {
  try {
    const quoteText = formatQuote(quote, intake.state.fields);
    const sent = await sendHuman(sock, jid, quoteText, { incomingText: 'quote' });
    noteSent((sent || []).map((m) => m?.key?.id));

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
