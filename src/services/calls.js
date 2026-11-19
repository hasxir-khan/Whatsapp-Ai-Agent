// src/services/calls.js
// Missed-call rescue.
//
// What WhatsApp's Web protocol (and therefore Baileys) actually gives us:
// incoming-call *events* — offer, accept, reject, timeout. It does not give us
// the audio stream, so a bot cannot pick up and talk. Anyone who claims
// otherwise is either on the official Cloud API or lying.
//
// So the assistant does the next best thing, 60 seconds after a call goes
// unanswered: it "picks up" in the chat — a short apology in the client's own
// language and register, as a voice note and/or text — and then keeps the
// conversation going like a human would.

import { config, normalizePhone } from '../config/env.js';
import * as db from '../utils/db.js';
import { sendHuman, sendTyping } from '../core/humanizer.js';
import { chat, hasLLM } from '../core/llm.js';
import { detectLanguage, detectTone, mirrorInstruction, toneInstruction } from './language.js';
import { buildVoiceNote, ttsEnabled } from './tts.js';
import { brevityInstruction } from '../core/brevity.js';

// callId → { timer, number, video, startedAt }
const pending = new Map();
/** The random 60–90 s window, in ms. CALL_FALLBACK_SECONDS pins it. */
export function callWindowMs() {
  const min = Math.max(0, Number(config.calls.delayMinSeconds ?? config.calls.delaySeconds) || 0);
  const max = Math.max(min, Number(config.calls.delayMaxSeconds ?? min) || min);
  return Math.round((min + Math.random() * (max - min)) * 1000);
}
// callIds we have already reacted to (events repeat across reconnects)
const seen = new Set();
// Numbers where the owner picked up while an apology was being typed.
const answeredMidApology = new Set();

export function pendingCalls() {
  return [...pending.keys()];
}

/**
 * The customer wrote to us while the rescue timer was still running — drop the
 * timer. Nobody wants "sorry I missed your call" seconds after they already
 * messaged us themselves, and it must never be a second reply.
 * @returns {number} how many pending rescues were cancelled
 */
export function cancelCallRescue(number, reason = 'customer wrote first') {
  let cancelled = 0;
  for (const [id, entry] of pending) {
    if (entry.number !== number) continue;
    clearTimeout(entry.timer);
    pending.delete(id);
    answeredMidApology.add(number);
    try {
      db.updateCall(id, { status: 'cancelled', outcome: `rescue cancelled — ${reason}` });
      db.logEvent('call_rescue_cancelled', number, { call: id, reason });
    } catch {
      /* ignore */
    }
    cancelled += 1;
  }
  return cancelled;
}

export function __resetCalls() {
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
  seen.clear();
}

// ── message writing ────────────────────────────────────────
// Short on purpose: two sentences, the second one an invitation. A missed call
// gets an apology, not a brochure.
const TEMPLATES = {
  en: () => "Sorry — I couldn't take your call just now. Write here and I'll reply right away.",
  'roman-ur': () => 'Sorry, abhi call attend nahi kar sakay. Yahin likh dein, foran jawab dete hain.',
  ur: () => 'معذرت، ابھی کال نہیں اٹھا سکے۔ یہیں لکھ دیں، فوراً جواب دیتے ہیں۔',
  hi: () => 'माफ़ कीजिए, अभी कॉल नहीं उठा सका। यहीं लिखिए, तुरंत जवाब देता हूँ।',
  ar: () => 'آسف، لم أتمكن من الرد على اتصالك الآن. اكتب هنا وسأجيب فوراً.',
  es: () => 'Perdón, no pude contestar tu llamada. Escribe por aquí y te respondo enseguida.',
  fr: () => "Désolé, je n'ai pas pu prendre votre appel. Écrivez ici, je réponds tout de suite.",
  de: () => 'Entschuldigen Sie, ich konnte Ihren Anruf nicht annehmen. Schreiben Sie hier, ich antworte sofort.',
  pt: () => 'Desculpe, não consegui atender sua ligação. Escreva aqui que eu respondo na hora.',
  tr: () => 'Kusura bakmayın, aramanızı şu an açamadım. Buraya yazın, hemen cevap veririm.',
  id: () => 'Maaf, panggilan Anda belum bisa saya angkat. Tulis di sini, saya balas segera.',
  ru: () => 'Извините, не смог ответить на ваш звонок. Напишите здесь — отвечу сразу.',
  zh: () => '抱歉，刚才没能接您的电话。请在这里留言，我会马上回复。',
  ja: () => 'すみません、お電話に出られませんでした。こちらにメッセージをいただければすぐ返信します。',
};

function nameOf(number) {
  const contact = db.getContact(number);
  return contact?.name || contact?.push_name || null;
}

function lastClientText(number) {
  const rows = db.getMessages(number, 6) || [];
  const row = [...rows].reverse().find((r) => r.role === 'user' && r.content);
  return row?.content || '';
}

/** When the customer last wrote to us (ms), or 0. */
function lastClientMessageAt(number) {
  const rows = db.getMessages(number, 8) || [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].role !== 'user') continue;
    const at = new Date(rows[i].created_at || 0).getTime();
    if (Number.isFinite(at) && at > 0) return at;
  }
  return 0;
}

function templateFor(langInfo, ctx) {
  const code = langInfo?.code && TEMPLATES[langInfo.code] ? langInfo.code : 'en';
  return TEMPLATES[code](ctx);
}

async function composeMessage(number, { langInfo, tone }) {
  const brand = config.owner.profile?.owner?.brand || config.bot.name || 'us';
  const ownerName = config.owner.name || 'the owner';
  const ctx = { brand, name: ownerName };

  if (!hasLLM()) return templateFor(langInfo, ctx);

  try {
    const last = lastClientText(number);
    const result = await chat({
      system:
        `You are the WhatsApp assistant of ${brand} (${ownerName}). A client just called and nobody could pick up. ` +
        'Write ONE short WhatsApp message: max 2 sentences, no lists, no signatures, no brochure. ' +
        '1) apologise briefly for missing the call, 2) invite them to write here and promise a quick reply. ' +
        `${mirrorInstruction(langInfo)} ${toneInstruction({ tone })} ` +
        'Do not invent a time, price or promise. ' +
        brevityInstruction({ maxSentences: 2, lang: langInfo?.code }),
      messages: [
        {
          role: 'user',
          content: last
            ? `Their last message before calling: "${last.slice(0, 300)}"`
            : 'There is no previous chat history with this number.',
        },
      ],
      temperature: 0.6,
      maxTokens: 120,
    });
    const text = (result?.text || '').trim();
    return text || templateFor(langInfo, ctx);
  } catch {
    return templateFor(langInfo, ctx);
  }
}

// ── main logic ─────────────────────────────────────────────
export function registerCalls(sock) {
  try {
    sock.ev.on('call', (calls) => {
      handleCallEvents(sock, calls).catch((err) => console.error('Call handler:', err.message));
    });
  } catch (err) {
    console.error('Could not subscribe to call events:', err.message);
  }
}

/**
 * Exported for tests: feed call events straight in.
 * @param {object} sock
 * @param {Array<{id:string, chatId:string, from:string, status:string, isVideo:boolean}>} calls
 */
export async function handleCallEvents(sock, calls = []) {
  for (const call of calls) {
    try {
      await handleOne(sock, call);
    } catch (err) {
      console.error('Call event failed:', err.message);
    }
  }
}

async function handleOne(sock, call) {
  const chatId = String(call.chatId || call.from || '');
  if (!chatId) return;

  // Never in groups, channels or broadcasts — the same rule as messages.
  if (chatId.endsWith('@g.us') || chatId.endsWith('@newsletter') || chatId.endsWith('@broadcast')) return;

  const number = normalizePhone(chatId.split('@')[0]);
  if (!number) return;
  if (number === config.owner.number) return; // your own calls from another device
  if (db.getContact(number)?.is_blocked) return;

  const status = String(call.status || '').toLowerCase();
  const video = !!(call.isVideo || call.video);
  const id = call.id || `${number}-${Date.now()}`;

  if (status === 'offer' || status === 'ringing') {
    if (seen.has(id)) return;

    const contact = db.getContact(number);
    if (!contact) {
      db.upsertContact(number, {
        jid: `${number}@s.whatsapp.net`,
        name: nameOf(number),
        category: 'lead',
      });
    }
    db.recordCall({ id, number, video, status: 'offer' });
    db.logEvent('call_incoming', number, { video });
    console.log(`📞 Incoming ${video ? 'video ' : ''}call from +${number}`);

    if (config.calls.notifyOwner && config.calls.enabled) {
      const who = db.getContact(number)?.name || `+${number}`;
      sendTyping(
        sock,
        config.owner.jid,
        `📞 Incoming call from ${who}${video ? ' (video)' : ''}.\n` +
          `If you don't pick up, the assistant will reply in chat a minute or so later.`,
        { delay: 150 }
      ).catch(() => {});
    }

    if (!config.calls.enabled) return;
    if (Number(config.calls.delayMaxSeconds ?? config.calls.delaySeconds) < 0) return;

    // A human does not answer a missed call on a stopwatch: 60–90 s, random.
    // The window is a *fallback* for a call whose end event never arrives; a
    // reject/timeout schedules the apology from the moment it actually ended.
    const timer = setTimeout(() => {
      pending.delete(id);
      handleMissedCall(sock, number, { id, video, reason: 'no_answer' }).catch(() => {});
    }, callWindowMs());
    timer.unref?.();

    pending.set(id, { timer, number, video, startedAt: Date.now() });
    seen.add(id);
    return;
  }

  if (status === 'accept') {
    // The owner picked up: nothing is sent, ever. Cancel the window *and* any
    // apology that was already scheduled.
    const entry = pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(id);
    }
    cancelCallRescue(number, 'owner answered the call');
    db.updateCall(id, { status: 'accepted', outcome: 'owner answered', endedAt: new Date() });
    db.logEvent('call_answered', number, { video });
    return;
  }

  if (status === 'reject' || status === 'timeout') {
    // The caller hung up (reject) or the phone stopped ringing (timeout). From
    // this moment it is a missed call: the apology follows 5–15 s later, like
    // someone noticing and typing.
    const entry = pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(id);
    }
    db.updateCall(id, { status: status === 'reject' ? 'rejected' : 'missed', endedAt: new Date() });
    await handleMissedCall(sock, number, { id, video, reason: status, missAt: Date.now() });
  }
}

/**
 * The client's call went unanswered — start the conversation in chat.
 * @returns {Promise<{sent:boolean, mode?:string, text?:string}>}
 */
export async function handleMissedCall(sock, number, { id = null, video = false, reason = 'no_answer', missAt = null } = {}) {
  if (db.getSetting('bot_enabled', true) !== true) return { sent: false };
  const contactNow = db.getContact(number);
  if (contactNow?.is_blocked) return { sent: false };
  // The owner is handling this chat, or the customer opted out: the apology is
  // exactly the kind of message that must not arrive then.
  if (contactNow?.bot_paused_until && new Date(contactNow.bot_paused_until) > new Date()) {
    db.logEvent('call_rescue_skipped', number, { call: id, reason: 'owner handling' });
    return { sent: false, reason: 'owner handling' };
  }
  if (contactNow?.opted_out || contactNow?.opt_out) {
    db.logEvent('call_rescue_skipped', number, { call: id, reason: 'opted out' });
    return { sent: false, reason: 'opted out' };
  }

  // Make sure the attempt exists as a row, so the daily cap counts it even
  // when the fallback was triggered without a prior 'offer' event.
  if (id && !db.getCall(id)) db.recordCall({ id, number, video, status: 'missed' });

  // One rescue per call, ever.
  if (id) {
    const row = db.getCall(id);
    if (row?.status === 'handled') {
      db.logEvent('call_rescue_skipped', number, { call: id, reason: 'already rescued' });
      return { sent: false, reason: 'already rescued' };
    }
  }

  // If the customer wrote to us after the call started, the chat is already
  // open — a rescue message would be a duplicate reply.
  const callAt = id ? new Date(db.getCall(id)?.created_at || 0).getTime() : Date.now();
  const wroteAt = lastClientMessageAt(number);
  if (wroteAt && wroteAt > callAt) {
    if (id) db.updateCall(id, { status: 'cancelled', outcome: 'customer wrote first' });
    db.logEvent('call_rescue_skipped', number, { call: id, reason: 'customer wrote first' });
    return { sent: false, reason: 'customer wrote first' };
  }

  // One apology per contact per 30 minutes. Someone ringing three times in a row
  // does not get three apologies — that is a bot, not a person.
  const windowMs = Math.max(1, Number(config.calls.apologyWindowMinutes) || 30) * 60 * 1000;
  const since = Date.now() - windowMs;
  // Only a call we actually saw ring and end counts as a missed call for this
  // rule; a programmatic rescue (an owner script, the eval harness) still obeys
  // the daily cap below.
  const sawRing = id ? !!db.getCall(id)?.ended_at : false;
  const apologizedRecently =
    sawRing &&
    (db.recentCalls(30) || []).some(
      (c) => c.number === number && c.apologized_at && new Date(c.apologized_at).getTime() > since
    );
  if (apologizedRecently) {
    db.logEvent('call_rescue_skipped', number, { call: id, reason: 'apology within 30 min' });
    return { sent: false, reason: 'apology cap' };
  }

  // Don't spam: a client ringing three times in a row gets one reply
  const recent = db.recentCalls(20).filter((c) => c.number === number && c.outcome);
  const today = recent.filter((c) => c.created_at >= new Date(new Date().setHours(0, 0, 0, 0)).toISOString());
  if (today.length >= config.calls.maxPerNumberPerDay) {
    db.logEvent('call_fallback_skipped', number, 'daily cap');
    return { sent: false };
  }

  const last = lastClientText(number);
  const langInfo = detectLanguage(last || '');
  const priorTone = db.getContact(number)?.tone;
  const detected = last ? detectTone(last, langInfo.code) : { tone: 'neutral' };
  const tone =
    config.calls.tone === 'auto'
      ? detected.tone !== 'neutral'
        ? detected.tone
        : priorTone || 'neutral'
      : config.calls.tone;

  const text = await composeMessage(number, { langInfo, tone });

  // Voice is optional for the apology (`calls.apologyVoice`); text always goes
  // too, so a client who cannot play audio still reads the apology.
  const wantsVoice =
    config.calls.apologyVoice ||
    config.calls.mode === 'voice_note' ||
    (config.calls.mode === 'auto' && ttsEnabled() && tone !== 'formal' && config.calls.apologyVoice !== false);

  let voice = null;
  if (wantsVoice) {
    try {
      voice = await buildVoiceNote(text, { langInfo });
    } catch (err) {
      db.logEvent('call_tts_failed', number, err.message);
      voice = null;
    }
  }

  try {
    // The 5–15 s "notice and type" window is planned by the send path itself,
    // measured from the moment the call ended.
    const sent = await sendHuman(sock, `${number}@s.whatsapp.net`, text, {
      incomingText: '',
      voice,
      chat: number,
      receivedAt: missAt || callAt,
      lang: langInfo.code,
      // Answered in the meantime? Then there is nothing to apologise for.
      shouldSend: () => !answeredMidApology.has(number),
    });
    if (!sent || (Array.isArray(sent) && sent.length === 0)) {
      db.logEvent('call_rescue_cancelled', number, { call: id, reason: 'owner answered mid-apology' });
      return { sent: false, reason: 'owner answered' };
    }
  } catch (err) {
    db.logEvent('call_fallback_failed', number, err.message);
    return { sent: false };
  }

  const mode = voice?.buffer ? 'voice_note' : 'text';
  answeredMidApology.delete(number);
  if (id) db.updateCall(id, { status: 'handled', outcome: `${reason} → ${mode}`, apologizedAt: new Date() });
  else {
    const lastRow = db.lastCallFor?.(number);
    if (lastRow?.id) db.updateCall(lastRow.id, { apologizedAt: new Date() });
  }
  db.logEvent('call_fallback', number, {
    mode,
    video,
    reason,
    tone,
    delaySec: Math.max(0, Math.round((Date.now() - callAt) / 1000)),
  });

  if (config.calls.notifyOwner) {
    const who = db.getContact(number)?.name || `+${number}`;
    sendTyping(
      sock,
      config.owner.jid,
      `☎️ Missed call from ${who}${video ? ' (video)' : ''} — the assistant replied by ${mode === 'voice_note' ? 'voice note' : 'text'} in ${langInfo.label}.\nCall back when you can.`,
      { delay: 150 }
    ).catch(() => {});
  }

  console.log(`☎️  Missed call from +${number} → ${mode} reply (${langInfo.label}, ${tone})`);
  return { sent: true, mode, text };
}

export default { registerCalls, handleCallEvents, handleMissedCall, pendingCalls, cancelCallRescue };
