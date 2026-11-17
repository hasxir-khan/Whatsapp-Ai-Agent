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

// callId → { timer, number, video }
const pending = new Map();
// callIds we have already reacted to (events repeat across reconnects)
const seen = new Set();

export function pendingCalls() {
  return [...pending.keys()];
}

export function __resetCalls() {
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
  seen.clear();
}

// ── message writing ────────────────────────────────────────
const TEMPLATES = {
  en: ({ brand, name }) =>
    `Hey — I saw your call just now, sorry I couldn't pick up. This is ${brand}'s assistant. Tell me here what you need and ${name} can call you back.`,
  'roman-ur': ({ brand, name }) =>
    `Assalam o alaikum! Aap ka call dekha, sorry pick nahi kar saka. Main ${brand} ka assistant hoon — yahan bata dein kya chahiye, ${name} ko bata kar call back karwa deta hoon.`,
  ur: ({ brand, name }) =>
    `السلام علیکم! آپ کی کال دیکھی، معذرت کہ اٹھا نہیں سکا۔ میں ${brand} کا اسسٹنٹ ہوں — یہاں بتا دیں کیا چاہیے، ${name} کو بتا کر کال بیک کروا دوں گا۔`,
  hi: ({ brand, name }) =>
    `नमस्ते! आपका कॉल देखा, माफ़ कीजिए उठा नहीं सका। मैं ${brand} का असिस्टेंट हूँ — यहाँ बता दीजिए क्या चाहिए, ${name} को बोलकर कॉल बैक करा दूँगा।`,
  ar: ({ brand, name }) =>
    `مرحباً، رأيت اتصالك ولم أتمكن من الرد، آسف. أنا مساعد ${brand} — أخبرني هنا بما تحتاجه وسيتواصل معك ${name}.`,
  es: ({ brand, name }) =>
    `Hola, vi tu llamada pero no pude contestar, perdón. Soy el asistente de ${brand}. Cuéntame aquí qué necesitas y ${name} te devuelve la llamada.`,
  fr: ({ brand, name }) =>
    `Bonjour, j'ai vu votre appel mais je n'ai pas pu décrocher, désolé. Je suis l'assistant de ${brand}. Dites-moi ici ce qu'il vous faut et ${name} vous rappellera.`,
  de: ({ brand, name }) =>
    `Hallo, ich habe Ihren Anruf gesehen, konnte aber nicht rangehen — entschuldigen Sie. Ich bin ${brand}s Assistent. Schreiben Sie hier, worum es geht, dann ruft ${name} zurück.`,
  pt: ({ brand, name }) =>
    `Olá, vi sua ligação mas não consegui atender, desculpe. Sou o assistente da ${brand}. Me conte aqui o que precisa e o ${name} retorna a ligação.`,
  tr: ({ brand, name }) =>
    `Merhaba, aramanızı gördüm ama açamadım, kusura bakmayın. Ben ${brand} asistanıyım. Buradan neye ihtiyacınız olduğunu yazın, ${name} sizi arayacak.`,
  id: ({ brand, name }) =>
    `Halo, saya melihat panggilan Anda tapi belum bisa angkat, maaf. Saya asisten ${brand}. Ceritakan di sini kebutuhannya, nanti ${name} menelepon balik.`,
  ru: ({ brand, name }) =>
    `Здравствуйте! Видел ваш звонок, но не смог ответить — извините. Я ассистент ${brand}. Напишите здесь, что нужно, и ${name} перезвонит.`,
  zh: ({ brand, name }) =>
    `你好，刚看到你的来电，抱歉没接到。我是 ${brand} 的助理，在这里告诉我你的需求，${name} 会回电给你。`,
  ja: ({ brand, name }) =>
    `こんにちは。お電話に気づきましたが取れませんでした、すみません。${brand} のアシスタントです。ご用件をこちらに送っていただければ、${name} から折り返します。`,
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
        `Write ONE short WhatsApp message (max 2 sentences, no lists, no signatures) that: ` +
        `1) apologises briefly for missing the call, 2) says you are the assistant, ` +
        `3) invites them to say what they need right here, 4) says ${ownerName} can call them back. ` +
        `${mirrorInstruction(langInfo)} ${toneInstruction({ tone })} ` +
        'Do not invent a time, price or promise. Do not use the word "unfortunately" twice.',
      messages: [
        {
          role: 'user',
          content: last
            ? `Their last message before calling: "${last.slice(0, 300)}"`
            : 'There is no previous chat history with this number.',
        },
      ],
      temperature: 0.6,
      maxTokens: 160,
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
          `If you don't pick up in ${config.calls.delaySeconds}s, the assistant will reply in chat.`,
        { delay: 150 }
      ).catch(() => {});
    }

    if (!config.calls.enabled || config.calls.delaySeconds < 0) return;

    const timer = setTimeout(() => {
      pending.delete(id);
      handleMissedCall(sock, number, { id, video, reason: 'no_answer' }).catch(() => {});
    }, Math.max(0, config.calls.delaySeconds * 1000));
    timer.unref?.();

    pending.set(id, { timer, number, video });
    seen.add(id);
    return;
  }

  if (status === 'accept') {
    const entry = pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(id);
    }
    db.updateCall(id, { status: 'accepted', outcome: 'owner answered' });
    db.logEvent('call_answered', number, { video });
    return;
  }

  if (status === 'reject' || status === 'timeout') {
    const entry = pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(id);
    }
    db.updateCall(id, { status: status === 'reject' ? 'rejected' : 'missed' });
    await handleMissedCall(sock, number, { id, video, reason: status });
  }
}

/**
 * The client's call went unanswered — start the conversation in chat.
 * @returns {Promise<{sent:boolean, mode?:string, text?:string}>}
 */
export async function handleMissedCall(sock, number, { id = null, video = false, reason = 'no_answer' } = {}) {
  if (db.getSetting('bot_enabled', true) !== true) return { sent: false };
  if (db.getContact(number)?.is_blocked) return { sent: false };

  // Make sure the attempt exists as a row, so the daily cap counts it even
  // when the fallback was triggered without a prior 'offer' event.
  if (id && !db.getCall(id)) db.recordCall({ id, number, video, status: 'missed' });

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

  const wantsVoice =
    config.calls.mode === 'voice_note' ||
    (config.calls.mode === 'auto' && ttsEnabled() && tone !== 'formal');

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
    await sendHuman(sock, `${number}@s.whatsapp.net`, text, { incomingText: '', voice });
  } catch (err) {
    db.logEvent('call_fallback_failed', number, err.message);
    return { sent: false };
  }

  const mode = voice?.buffer ? 'voice_note' : 'text';
  if (id) db.updateCall(id, { status: 'handled', outcome: `${reason} → ${mode}` });
  db.logEvent('call_fallback', number, { mode, video, reason, tone });

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

export default { registerCalls, handleCallEvents, handleMissedCall, pendingCalls };
