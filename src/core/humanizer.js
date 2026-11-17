// src/core/humanizer.js
// Makes the typing feel human: realistic "typing…" pauses, answers split into
// 2–3 WhatsApp bubbles instead of one wall of text, read receipts, and an
// optional quiet-hours window so it never replies like a machine at 3 a.m.

import { config } from '../config/env.js';

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

async function setPresence(sock, jid, state) {
  try {
    await sock.sendPresenceUpdate(state, jid);
  } catch {
    /* presence is cosmetic — never fail a message because of it */
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
 * Send a reply like a person would: pause, show typing, send in 1–3 bubbles
 * with short gaps, then go back to "offline".
 */
export async function sendHuman(sock, jid, text, { incomingText = '', voice = null } = {}) {
  const bubbles = splitIntoBubbles(text);
  if (!bubbles.length) return [];

  const sent = [];
  for (let i = 0; i < bubbles.length; i++) {
    const bubble = bubbles[i];
    await setPresence(sock, jid, 'composing');
    const delay = humanDelay({
      replyText: bubble,
      incomingText: i === 0 ? incomingText : '',
      isVoice: !!voice,
    });
    await sleep(delay);

    if (voice && i === bubbles.length - 1 && voice.buffer) {
      await setPresence(sock, jid, 'recording');
      await sleep(rand(900, 1800));
      try {
        const msg = await sock.sendMessage(jid, voice.payload);
        sent.push(msg);
      } catch {
        await sock.sendMessage(jid, { text: bubble });
      }
    } else {
      await setPresence(sock, jid, 'paused');
      const msg = await sock.sendMessage(jid, { text: bubble });
      sent.push(msg);
    }

    if (i < bubbles.length - 1) await sleep(rand(600, 1500));
  }

  await setPresence(sock, jid, 'paused');
  return sent;
}

/** Plain send with a typing indicator — used for owner notifications. */
export async function sendTyping(sock, jid, text, { delay = 600 } = {}) {
  try {
    await setPresence(sock, jid, 'composing');
    await sleep(delay);
    await setPresence(sock, jid, 'paused');
    return await sock.sendMessage(jid, { text });
  } catch {
    try {
      return await sock.sendMessage(jid, { text });
    } catch {
      return null;
    }
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
  sleep, polish, splitIntoBubbles, humanDelay, sendHuman, sendTyping,
  markRead, isQuietNow, quietEndsAt, isRepetitive, forSpeech, ownerClock,
};
