// src/core/humanTouch.js
// The small things that make a chat feel like a person, not a form.
//
// Four of them, and the boundaries between them matter:
//   1. "ok" / "thanks" / "shukriya" on its own is not a question. Answering it
//      with two sentences is what a bot does. A 👍 reaction (or silence) is
//      what a person does — and silence is only chosen when the transport
//      cannot react.
//   2. Never describe yourself. A receptionist does not announce that they are
//      a receptionist.
//   3. If someone sincerely asks whether they are talking to a bot, tell them
//      the truth, briefly. This one is not a setting: `honestBotAnswer` has no
//      off switch, and nothing in the pipeline can suppress it.
//   4. Do not talk over the owner. If the owner is handling the chat, the bot
//      stays out of it (the takeover pause is checked again right before send).

import { config } from '../config/env.js';
import * as db from '../utils/db.js';
import { business } from '../services/profile.js';

// ── 1. acknowledgements ────────────────────────────────────
const ACK_RE =
  /^(?:ok|okay|okey|k|kk|cool|great|nice|good|perfect|alright|all right|sure|thanks|thank you|thnx|thx|ty|shukriya|shukria|shukriyaa|jazakallah|jazak allah|meharbani|theek|theek hai|thik hai|thik|haan theek|acha|achha|samajh gaya|got it|noted|👍|🙏|✅|👌|🥰|❤️|❤|شکریہ|ٹھیک|ٹھیک ہے|جی شکریہ|بہت شکریہ|اچھا)[\s.!،,~👍🙏✅👌😊❤️]*$/iu;

const ACK_EMOJI = /👍|🙏|✅|👌|❤️|❤|🙂|😊/u;

/** Is this message *only* an acknowledgement? */
export function isAckOnly(text = '') {
  const body = String(text || '').trim();
  if (!body) return false;
  if (body.length > 40) return false;
  if (ACK_RE.test(body)) return true;
  // Two acknowledgements and nothing else ("ok thanks", "theek hai shukriya").
  const words = body.split(/\s+/).filter(Boolean);
  if (words.length <= 3 && words.every((w) => ACK_RE.test(w.replace(/[.!،,~]/g, '')) || /^[👍🙏✅👌❤️❤😊]+$/u.test(w))) {
    return true;
  }
  return false;
}

/** Which emoji answers this acknowledgement, if any. */
export function ackReaction(text = '') {
  const body = String(text || '');
  if (/🙏|شکریہ|shukriya|shukria|thanks|thank you|jazak|meharbani|thx|ty/i.test(body)) return '🙏';
  if (ACK_EMOJI.test(body)) return (body.match(ACK_EMOJI) || ['👍'])[0];
  return '👍';
}

/**
 * An acknowledgement deserves a reaction only when there is nothing left to
 * say: if the assistant's own last message asked something, "ok" is an answer
 * and must be handled by the normal pipeline.
 */
export function shouldReactOnly(number, text = '') {
  if (!isAckOnly(text)) return false;
  try {
    const rows = db.getMessages(number, 6) || [];
    const lastAssistant = [...rows].reverse().find((r) => r.role !== 'user');
    if (lastAssistant?.content && /[?؟]/.test(lastAssistant.content)) return false;
  } catch {
    return false;
  }
  return true;
}

// ── 2/3. the bot question ──────────────────────────────────
const BOT_QUESTION_RE = new RegExp(
  [
    '\\b(?:are|r)\\s+(?:you|u)\\s+(?:a\\s+)?(?:real\\s+)?(?:bot|robot|ai|machine|human|person|insan|insaan)\\b',
    '\\b(?:is\\s+this|is\\s+it)\\s+(?:a\\s+)?(?:bot|robot|ai|machine)\\b',
    '\\byou\\s+are\\s+(?:a\\s+)?(?:bot|robot|ai|machine)\\b',
    '\\bare\\s+you\\s+(?:chatting|talking)\\s+(?:to\\s+me\\s+)?from\\s+(?:a\\s+)?(?:bot|ai)\\b',
    '\\b(?:kya|kia)\\s+(?:aap|ap|tum)\\s+(?:koi\\s+)?(?:bot|robot|ai|insan|insaan|machine)\\b',
    '\\b(?:aap|ap|tum)\\s+(?:bot|robot|ai|machine)\\s+(?:hain|hain\\?|ho)\\b',
    '\\b(?:insan|insaan)\\s+(?:hain|ho)\\s*(?:\\?|؟)',
    'کیا\\s+آپ\\s+(?:بوٹ|روبٹ|اے\\s*آئی|انسان|مشین)',
    'آپ\\s+(?:بوٹ|انسان)\\s+(?:ہیں|ہو)',
  ].join('|'),
  'iu'
);

/** Is the customer sincerely asking whether this is a bot? */
export function asksIfBot(text = '') {
  const body = String(text || '');
  if (!body || body.length > 160) return false;
  return BOT_QUESTION_RE.test(body);
}

const HONEST_ANSWERS = {
  'roman-ur': () =>
    `Main ${brandName()} ka AI assistant hoon — seedhi baat. Insan se baat karni ho to bata dein, ${ownerName()} ko bula deta hoon.`,
  ur: () => `میں ${brandName()} کا اے آئی اسسٹنٹ ہوں — سیدھی بات۔ انسان سے بات کرنی ہو تو بتا دیں، ${ownerName()} کو بلا دیتا ہوں۔`,
  en: () => `I'm ${brandName()}'s AI assistant — straight answer. If you'd rather talk to a person, say so and I'll get ${ownerName()}.`,
};

function brandName() {
  return config.owner.profile?.owner?.brand || config.bot.name || 'this business';
}
function ownerName() {
  return config.owner.name || 'the owner';
}

/**
 * The honest answer. Deliberately has no feature flag and no config check:
 * someone asking "is this a bot?" gets an honest reply, always.
 */
export function honestBotAnswer(lang = 'en') {
  const code = HONEST_ANSWERS[lang] ? lang : String(lang || '').startsWith('roman') ? 'roman-ur' : String(lang || '').startsWith('ur') ? 'ur' : 'en';
  return HONEST_ANSWERS[code]();
}

const BOT_QUESTION_FOLLOWUP = {
  'roman-ur': 'Koi baat nahi — yahan likh dein, main foran handle karta hoon.',
  ur: 'کوئی بات نہیں — یہیں لکھ دیں، میں فوراً دیکھتا ہوں۔',
  en: 'No problem — write here and I’ll sort it out right away.',
};

/** A second, warmer line for the same question (used instead of looping). */
export function honestBotFollowup(lang = 'en') {
  const code = BOT_QUESTION_FOLLOWUP[lang] ? lang : 'en';
  return BOT_QUESTION_FOLLOWUP[code];
}

// ── 2. no self-description ─────────────────────────────────
const SELF_DESCRIPTION_RE =
  /\b(?:as an ai|as a language model|i am an ai|i'm an ai|i am a bot|i'm a bot|i am an assistant|i'm just an assistant|i am a virtual assistant|i do not have feelings|main ek ai|main ek bot)\b|ایک\s+اے\s*آئی\s+ہوں/iu;

/** Does this reply announce what it is? Only allowed when asked. */
export function describesItself(text = '') {
  return SELF_DESCRIPTION_RE.test(String(text || ''));
}

/** The rules every reply must respect, for the prompt. */
export function touchInstruction({ askBot = false } = {}) {
  const lines = [
    'Never describe yourself as an AI, bot, assistant, model or program unless the customer directly asks — then answer honestly and briefly, once.',
    'Never repeat their question back to them and never end with "Is there anything else I can help with?".',
  ];
  if (askBot) lines.push('They just asked whether you are a bot: say plainly that you are the business’s AI assistant, briefly, and offer a human.');
  return lines.join(' ');
}

// ── 4. don't talk over the owner ───────────────────────────
/**
 * The owner sent something in this chat in the last `minutes` — or is paused
 * into a takeover. Either way the bot must not send.
 */
export function ownerIsActive(number, { minutes = 3, since: sinceAt = null, includePause = false } = {}) {
  try {
    const contact = db.getContact(number);
    // The pause is checked when a batch starts; asking about it again here would
    // also catch the pause a handoff tool sets *inside* this batch, which must
    // still send its "the owner will reply" line.
    if (includePause && contact?.bot_paused_until && new Date(contact.bot_paused_until) > new Date()) return true;
    const rows = db.getMessages(number, 8) || [];
    // "Active" means the owner wrote *after* the message we are answering (or,
    // without one, in the last few minutes). An owner who replied, handed the
    // chat back and then received a new message is not in the way.
    const since = Number(sinceAt) || Date.now() - minutes * 60_000;
    return rows.some((r) => {
      // Only a real owner turn counts. `meta.handoff` marks a *customer*
      // message that arrived while the owner had the chat, and is not the owner
      // writing.
      const isOwnerTurn = r.role === 'owner' || (r.role !== 'user' && r.meta?.source === 'owner');
      if (!isOwnerTurn) return false;
      const at = new Date(r.created_at || 0).getTime();
      // `>=`: a message written in the same millisecond as ours still counts as
      // the owner being in the chat.
      return Number.isFinite(at) && at >= since;
    });
  } catch {
    return false;
  }
}

/** Is the human-touch layer on? Defaults to on; `HUMAN_TOUCH=off` restores old behaviour. */
export function humanTouchEnabled() {
  const fromProfile = business()?.tone?.humanTouch;
  if (fromProfile === false) return false;
  if (String(process.env.HUMAN_TOUCH || '').toLowerCase() === 'off') return false;
  return true;
}

export default {
  isAckOnly,
  ackReaction,
  shouldReactOnly,
  asksIfBot,
  honestBotAnswer,
  honestBotFollowup,
  describesItself,
  touchInstruction,
  ownerIsActive,
  humanTouchEnabled,
};
