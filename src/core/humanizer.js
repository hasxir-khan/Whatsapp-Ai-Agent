// src/core/humanizer.js
// Makes the typing feel human: realistic "typing…" pauses, answers split into
// 2–3 WhatsApp bubbles instead of one wall of text, read receipts, and an
// optional quiet-hours window so it never replies like a machine at 3 a.m.

import { config } from '../config/env.js';
import { sendReliable } from '../services/outbox.js';
import { replyTiming, planReplyDelay, createTypingSession, typingCapabilities, readDelayMs, scaled, holdingLine } from './timing.js';
import * as timeline from '../services/timeline.js';
import * as providerTrace from '../services/providerTrace.js';
import { isNumberHeavy } from './brevity.js';
import { presenceChannel } from '../transport/contract.js';
import { noteTyping } from '../services/transportAudit.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rand = (min, max) => min + Math.random() * (max - min);

/** Copy model output into something that looks typed on a phone. */
export function polish(text = '') {
  let out = String(text).trim();

  out = out
    .replace(/^```[\w]*\n?/gm, '')
    .replace(/```/g, '')
    .replace(/\*\*(.+?)\*\*/g, '*$1*') // markdown bold → WhatsApp bold
    .replace(/^#{1,6}\s+/gm, '') // headers
    .replace(/^\s*[-–]\s+/gm, '• ') // dashes → bullets
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u00a0/g, ' ');

  // Strip the tells that instantly break the illusion
  out = out
    .replace(/^(as an ai( language model)?|i am an ai|i'm an ai)[^\n]*/gim, '')
    .replace(/^(sure|certainly|absolutely|of course)[,!]\s*/i, (m) => (Math.random() < 0.7 ? '' : m))
    .replace(/^(here('|’)s|here is) (the|a|your) [^:\n]*:\s*/i, '')
    .trim();

  return out;
}

/**
 * Split a reply into WhatsApp-sized bubbles.
 * People send 1 line, then 2 lines, then a list — not a 900 character block.
 */
export function splitIntoBubbles(text, maxBubbles = config.bot.maxBubbles) {
  const clean = polish(text);
  if (!clean) return [];
  if (clean.length <= 320) return [clean];

  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];

  for (const para of paragraphs) {
    if (para.length <= 320) {
      chunks.push(para);
      continue;
    }
    // Long paragraph → sentence packing
    const sentences = para.match(/[^.!?…\n]+[.!?…]+["')\]]*|\S[^.!?…\n]*$/g) || [para];
    let buf = '';
    for (const sentence of sentences) {
      const s = sentence.trim();
      if (!s) continue;
      if ((buf + ' ' + s).trim().length > 320 && buf) {
        chunks.push(buf.trim());
        buf = s;
      } else {
        buf = (buf + ' ' + s).trim();
      }
    }
    if (buf) chunks.push(buf.trim());
  }

  // Merge tiny tail chunks so we don't send five one-word bubbles
  const merged = [];
  for (const chunk of chunks) {
    const last = merged[merged.length - 1];
    if (last && (last.length < 45 || chunk.length < 30) && last.length + chunk.length < 380) {
      merged[merged.length - 1] = `${last}\n${chunk}`;
    } else {
      merged.push(chunk);
    }
  }

  if (merged.length <= maxBubbles) return merged;

  // Too many bubbles → keep the first (maxBubbles-1) and merge the rest
  const head = merged.slice(0, maxBubbles - 1);
  const tail = merged.slice(maxBubbles - 1).join('\n\n');
  return [...head, tail];
}

/** How long a human would take to read + type this. */
export function humanDelay({ replyText = '', incomingText = '', isVoice = false } = {}) {
  const cps = Math.max(4, config.behavior.typingSpeedCharsPerSec);
  const typingMs = (replyText.length / cps) * 1000;
  const readingMs = Math.min(4, incomingText.length / 18) * 1000;
  const jitter = rand(0.7, 1.5);

  let total = (typingMs * 0.7 + readingMs + 700) * jitter;
  if (isVoice) total += rand(1200, 2600); // "recording" takes longer

  return Math.round(
    Math.min(config.behavior.maxDelayMs, Math.max(config.behavior.minDelayMs, total))
  );
}

export async function setPresence(sock, jid, state) {
  try {
    // One place knows the argument order (see src/transport/contract.js): the
    // transport's method is (jid, state), a raw socket's is (state, jid).
    const channel = presenceChannel(sock);
    if (!channel) return;
    await channel.send(state, jid);
    noteTyping({ jid, state, via: channel.via, order: channel.order, sock, ok: true });
  } catch (err) {
    noteTyping({ jid, state, via: 'unknown', order: 'broken', sock, ok: false, error: err?.message });
    /* presence is cosmetic — never fail a message because of it */
  }
}

/**
 * A reaction instead of a whole reply — for "ok", "thanks", "👍".
 * @returns {Promise<boolean>} false when the transport cannot do it
 */
export async function sendReaction(sock, jid, key, emoji = '👍') {
  if (!key) return false;
  // The transport wrapper and a raw Baileys socket answer to different names;
  // ask the capability matrix rather than guessing.
  const cap = typingCapabilities(sock);
  if (!cap.reactions) return false;
  const messageKey = typeof key === 'string' ? { remoteJid: jid, id: key, fromMe: false } : key;
  try {
    if (typeof sock?.sendReaction === 'function') {
      await sock.sendReaction(jid, messageKey, emoji);
      return true;
    }
    // Baileys spells it as a message payload.
    await sendReliable(sock, jid, { react: { text: emoji, key: messageKey } });
    return true;
  } catch {
    return false;
  }
}

export async function markRead(sock, keys = []) {
  if (!config.behavior.readReceipts || !keys.length) return;
  try {
    await sock.readMessages(keys);
  } catch {
    /* ignore */
  }
}

/**
 * Read receipt after 1–3 s, like someone glancing at the phone — not the
 * instant the message lands. Returns a handle so a test (or shutdown) can flush
 * it; nothing waits for it, because the customer should not wait for a tick.
 *
 * @returns {{at:number, done:Promise<void>, cancel:()=>void}}
 */
export function scheduleRead(sock, keys = [], { chat = null } = {}) {
  const timing = replyTiming();
  if (timing.enabled === false) {
    return { at: 0, done: markRead(sock, keys), cancel: () => {} };
  }
  const at = readDelayMs(timing);
  let timer = null;
  let cancelled = false;
  const done = new Promise((resolve) => {
    timer = setTimeout(async () => {
      if (cancelled) return resolve();
      timeline.mark(chat, 'read');
      await markRead(sock, keys);
      resolve();
    }, at);
    timer.unref?.();
  });
  // In tests (and in a burst) the env scale makes this a few milliseconds.
  return {
    at,
    done,
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Send a reply like a person would.
 *
 * With `replyTiming` on (the default) the wait is planned from the *target
 * window* — see timing.js — and an indicator that is already running (the one
 * the batch opened while the model worked) is reused instead of a second
 * `composing` that would look like a restart. With it off, this is the old
 * behaviour, byte for byte.
 *
 * @param {{incomingText?:string, voice?:object|null, session?:object, receivedAt?:number, chat?:string}} opts
 */
export async function sendHuman(
  sock,
  jid,
  text,
  { incomingText = '', voice = null, session = null, receivedAt = null, chat = null, lang = 'en', shouldSend = null, companionText = false, holdingManaged = false } = {}
) {
  const bubbles = companionText ? [String(text || '').trim()].filter(Boolean) : splitIntoBubbles(text);
  if (!bubbles.length) return [];

  const timing = replyTiming();
  if (timing.enabled === false) return legacySendHuman(sock, jid, text, { incomingText, voice, companionText, shouldSend });

  const key = chat || String(jid || '').split('@')[0];
  const ownSession = session || createTypingSession(sock, jid, { voice: !!voice, timing });
  const sent = [];
  const readyAt = Date.now();
  // The reply exists: whatever happens next, `.debug last` should know when the
  // text was ready and which model produced it.
  markProviderDone(key, chat || key);

  try {
    // A reply that took longer than 30 s has already cost the customer a wait;
    // one short line says "still here" without pretending nothing happened.
    if (!holdingManaged && receivedAt && readyAt - receivedAt > timing.holdingAfterMs && !voice) {
      await ownSession.stop({ paused: true });
      await sendTyping(sock, jid, holdingLine(lang), { delay: scaled(400, timing) });
      timeline.markHold(key);
    }

    const plan = planReplyDelay({
      text: bubbles.join('\n'),
      voice: !!voice,
      receivedAt: receivedAt || ownSession.startedAt,
      readyAt: Date.now(),
      timing,
    });

    if (plan.waitMs > 0) await sleep(plan.waitMs);
    // Last look before the first word: the owner may have taken over while we
    // were composing, or the call may have been answered after all.
    if (typeof shouldSend === 'function' && !shouldSend()) {
      await ownSession.stop({ paused: true });
      return [];
    }
    if (!ownSession.alive) await setPresence(sock, jid, voice ? 'recording' : 'composing');

    // Number-heavy replies (a quote, a price band) are never voice-only: a
    // price the customer cannot see is a price they will ask for again.
    const keepTextWithVoice = !!voice?.payload?.audio && (companionText || looksNumberHeavy(text));

    for (let i = 0; i < bubbles.length; i += 1) {
      const bubble = bubbles[i];
      if (i > 0) {
        // A short pause between bubbles, with the indicator back on: two
        // messages with nothing in between read like a script.
        await setPresence(sock, jid, 'composing');
        await sleep(scaled(rand(400, 900), timing));
      }
      await ownSession.stop({ paused: true });

      const voiceBubble = !!voice?.payload?.audio && i === bubbles.length - 1 && !keepTextWithVoice;
      if (voiceBubble) {
        await setPresence(sock, jid, 'recording');
        await sleep(scaled(rand(500, 1100), timing));
        try {
          const msg = await sendReliable(sock, jid, voice.payload);
          sent.push(msg);
        } catch {
          // Voice note refused (permanent) — fall back to the same text
          await sendReliable(sock, jid, { text: bubble }).catch(() => {});
          sent.push(null);
        } finally {
          // "recording…" must not survive the note, whether it was sent or not.
          ownSession.pause();
        }
      } else {
        const msg = await sendReliable(sock, jid, { text: bubble });
        sent.push(msg);
      }
    }

    // Voice *and* text for a quote: the audio is a courtesy, the text is the
    // record the customer can scroll back to.
    if (keepTextWithVoice) {
      await setPresence(sock, jid, 'recording');
      await sleep(scaled(rand(500, 1100), timing));
      try {
        if (!shouldSend || shouldSend()) sent.push(await sendReliable(sock, jid, voice.payload));
      } catch {
        /* the text already went out; the voice note was a courtesy */
      }
    }

    timeline.mark(key, 'sent', { bubbles: sent.length });
    timeline.commit(key);
    return sent;
  } catch (err) {
    // No stuck "typing…": whatever happened, clear it.
    await ownSession.stop({ paused: true });
    throw err;
  } finally {
    await ownSession.stop({ paused: true });
  }
}

/** A quote, a price band or a table of numbers (see brevity.js). */
function looksNumberHeavy(text) {
  try {
    return isNumberHeavy(text);
  } catch {
    return false;
  }
}

/** Note the moment the text existed, plus who wrote it. */
function markProviderDone(key, chat) {
  try {
    const rows = providerTrace.lastFor(chat || key, 1);
    const row = rows[0];
    const fresh = row && Date.now() - new Date(row.created_at || 0).getTime() < 120_000;
    timeline.mark(key, 'provider_done', {
      at: Date.now(),
      provider: fresh ? row.provider : null,
      model: fresh ? row.model : null,
      ms: fresh ? row.ms : undefined,
    });
  } catch {
    timeline.mark(key, 'provider_done', { at: Date.now() });
  }
}

/** The pre-timing behaviour, kept for `REPLY_TIMING=false`. */
async function legacySendHuman(sock, jid, text, { incomingText = '', voice = null, companionText = false, shouldSend = null } = {}) {
  const bubbles = companionText ? [String(text || '').trim()].filter(Boolean) : splitIntoBubbles(text);
  if (!bubbles.length) return [];

  const sent = [];
  const keepTextWithVoice = !!voice?.payload?.audio && (companionText || looksNumberHeavy(text));
  for (let i = 0; i < bubbles.length; i++) {
    const bubble = bubbles[i];
    await setPresence(sock, jid, 'composing');
    const delay = humanDelay({
      replyText: bubble,
      incomingText: i === 0 ? incomingText : '',
      isVoice: !!voice,
    });
    await sleep(delay);
    if (companionText && shouldSend && !shouldSend()) { await setPresence(sock, jid, 'paused'); return sent; }

    if (!keepTextWithVoice && voice?.payload?.audio && i === bubbles.length - 1) {
      await setPresence(sock, jid, 'recording');
      await sleep(rand(900, 1800));
      try {
        const msg = await sendReliable(sock, jid, voice.payload);
        sent.push(msg);
      } catch {
        await sendReliable(sock, jid, { text: bubble }).catch(() => {});
      }
    } else {
      await setPresence(sock, jid, 'paused');
      const msg = await sendReliable(sock, jid, { text: bubble });
      sent.push(msg);
    }

    if (i < bubbles.length - 1) await sleep(rand(600, 1500));
  }

  if (keepTextWithVoice && (!shouldSend || shouldSend())) {
    try { sent.push(await sendReliable(sock, jid, voice.payload)); } catch { /* text already delivered */ }
  }
  await setPresence(sock, jid, 'paused');
  return sent;
}

/** Plain send with a typing indicator — used for owner notifications. */
export async function sendTyping(sock, jid, text, { delay = 600 } = {}) {
  let session = null;
  try {
    if (replyTiming().enabled) {
      // Short, fixed pause: these are notifications, not conversations.
      session = createTypingSession(sock, jid, { timing: replyTiming() });
      await sleep(delay);
      await session.stop({ paused: true });
    } else {
      await setPresence(sock, jid, 'composing');
      await sleep(delay);
      await setPresence(sock, jid, 'paused');
    }
    return await sendReliable(sock, jid, { text });
  } catch {
    try {
      return await sendReliable(sock, jid, { text });
    } catch {
      return null;
    }
  } finally {
    if (session) await session.stop({ paused: true });
  }
}

// ── quiet hours (owner's timezone) ──────────────────────────
function parseWindow(spec) {
  const m = /^(\d{1,2}):?(\d{2})?\s*-\s*(\d{1,2}):?(\d{2})?$/.exec(String(spec || '').trim());
  if (!m) return null;
  return {
    from: parseInt(m[1], 10) * 60 + (parseInt(m[2] || '0', 10)),
    to: parseInt(m[3], 10) * 60 + (parseInt(m[4] || '0', 10)),
  };
}

export function ownerClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10) % 24;
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  return { hour, minute, minutes: hour * 60 + minute };
}

export function isQuietNow(date = new Date()) {
  const window = parseWindow(config.behavior.quietHours);
  if (!window) return false;
  const now = ownerClock(date).minutes;
  if (window.from <= window.to) return now >= window.from && now < window.to;
  return now >= window.from || now < window.to;
}

/** When the quiet window ends (ISO), or now if we're not in it. */
export function quietEndsAt(date = new Date()) {
  const window = parseWindow(config.behavior.quietHours);
  if (!window || !isQuietNow(date)) return date.toISOString();
  const now = ownerClock(date).minutes;
  const minutesLeft = window.to > now ? window.to - now : 24 * 60 - now + window.to;
  return new Date(date.getTime() + minutesLeft * 60000).toISOString();
}

/** Avoid sending the same sentence twice in a row. */
export function isRepetitive(reply, recentReplies = []) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const candidate = norm(reply).slice(0, 160);
  if (!candidate) return false;
  return recentReplies.some((prev) => {
    const p = norm(prev);
    if (!p) return false;
    if (p === candidate) return true;
    // near-duplicate: same opening (a repeated "Sure! I can do that…" reads robotic)
    const window = 32;
    return candidate.length > window && p.slice(0, window) === candidate.slice(0, window);
  });
}

/** Speech-friendly text for TTS: no emoji, no markdown, no URLs. */
export function forSpeech(text = '') {
  return polish(text)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/•/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/\n+/g, '. ')
    .trim();
}

export default {
  sleep, polish, splitIntoBubbles, humanDelay, sendHuman, sendTyping, sendReaction,
  markRead, scheduleRead, isQuietNow, quietEndsAt, isRepetitive, forSpeech, ownerClock, setPresence,
};
