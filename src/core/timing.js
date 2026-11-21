// src/core/timing.js
// How long a reply may take, and what the customer sees while it is written.
//
// The old behaviour was "wait a bit, then send": `humanDelay()` mixed reading
// time, typing speed and jitter into one number, capped by two generic env
// values, and the typing indicator was a single `composing` before a sleep that
// could be nine seconds long — or, when the provider was slow, a `composing`
// that had already expired by the time the text existed.
//
// This module answers two questions and nothing else:
//   1. when should the read receipt go out, and when should typing start;
//   2. how much longer should we hold a *finished* reply before sending it.
//
// The rule that matters: the wait is a *target window* (5–15 s from the
// customer's message to the reply), never an extra pause. If the model is slow
// and the answer is ready at 12 s, it goes out at 12 s, not at 15 s to look
// human. If it is ready at 20 s it goes out immediately, with the indicator
// still alive.

import { config } from '../config/env.js';
import { business, tone as toneProfile } from '../services/profile.js';
import { noteTyping } from '../services/transportAudit.js';
import { presenceChannel } from '../transport/contract.js';
import { strategy as storedStrategy } from '../services/typingTest.js';

export const DEFAULT_TIMING = {
  enabled: true,
  debounceMs: 2000,
  readMinMs: 1000,
  readMaxMs: 3000,
  typingMinMs: 3000,
  typingMaxMs: 10000,
  targetMinMs: 5000,
  targetMaxMs: 15000,
  refreshMs: 8000,
  hardCapMs: 30000,
  holdingAfterMs: 30000,
  maxSentences: 2,
  reactionToAck: true,
  voiceMatch: true,
  voiceMaxSeconds: 20,
  scale: 1,
  // Announce "available" to the chat before the first "composing": a device
  // that never said hello is one WhatsApp may not draw a bubble for.
  goOnline: true,
  // The presence call-shape fix. Off = the old (broken) calls, unchanged.
  fix: true,
};

const ENV_KEYS = {
  enabled: 'REPLY_TIMING',
  debounceMs: 'DEBOUNCE_MS',
  readMinMs: 'READ_DELAY_MIN_MS',
  readMaxMs: 'READ_DELAY_MAX_MS',
  typingMinMs: 'TYPING_MIN_MS',
  typingMaxMs: 'TYPING_MAX_MS',
  targetMinMs: 'REPLY_TARGET_MIN_MS',
  targetMaxMs: 'REPLY_TARGET_MAX_MS',
  refreshMs: 'TYPING_REFRESH_MS',
  hardCapMs: 'TYPING_HARD_CAP_MS',
  holdingAfterMs: 'HOLDING_AFTER_MS',
  maxSentences: 'REPLY_MAX_SENTENCES',
  goOnline: 'TYPING_GO_ONLINE',
  fix: 'TYPING_FIX',
};

/** Keys the profile sets on purpose (so they escape the default floors). */
function probeProfileForExplicitKeys() {
  const profile = profileTiming();
  const keys = Object.keys(profile).filter((k) => k in DEFAULT_TIMING && typeof profile[k] !== 'object');
  return keys.length ? keys : null;
}

function profileTiming() {
  const fromBusiness = business()?.tone?.replyTiming;
  const fromTone = toneProfile()?.replyTiming;
  return { ...(fromTone && typeof fromTone === 'object' ? fromTone : {}), ...(fromBusiness && typeof fromBusiness === 'object' ? fromBusiness : {}) };
}

/**
 * The effective timing config: defaults ← profile ← environment.
 * An environment variable that is not set never overrides the profile.
 * @returns {typeof DEFAULT_TIMING}
 */
export function replyTiming() {
  const out = { ...DEFAULT_TIMING };
  const profile = profileTiming();

  for (const [key, value] of Object.entries(profile)) {
    if (key in DEFAULT_TIMING && value !== undefined && value !== null && typeof value !== 'object') {
      out[key] = typeof DEFAULT_TIMING[key] === 'boolean' ? Boolean(value) : Number(value);
    }
  }

  const env = config.timing || {};
  for (const [key, envName] of Object.entries(ENV_KEYS)) {
    if (process.env[envName] !== undefined && process.env[envName] !== '') {
      out[key] = typeof DEFAULT_TIMING[key] === 'boolean' ? Boolean(env[key]) : Number(env[key]);
    }
  }
  // Booleans that the profile may also set (a config file is not an env var, so
  // the loop above leaves them alone).
  for (const key of ['goOnline', 'fix']) {
    if (env[key] !== undefined) out[key] = Boolean(env[key]);
  }

  // A pre-existing install (and every test harness) tunes the old single delay
  // with MIN_DELAY_MS / MAX_DELAY_MS. Honour it: when MAX_DELAY_MS is set below
  // the new window, the whole timing model is scaled into that envelope, so a
  // suite that asks for 40 ms replies gets 40 ms replies instead of 15 s.
  const legacyMax = Number(process.env.MAX_DELAY_MS);
  const explicitTarget =
    process.env.REPLY_TARGET_MIN_MS !== undefined || process.env.REPLY_TARGET_MAX_MS !== undefined;
  if (!explicitTarget && Number.isFinite(legacyMax) && legacyMax > 0 && legacyMax < DEFAULT_TIMING.targetMaxMs) {
    const scale = legacyMax / DEFAULT_TIMING.targetMaxMs;
    out.scale = scale;
    out.readMinMs = Math.round(out.readMinMs * scale);
    out.readMaxMs = Math.round(out.readMaxMs * scale);
    out.typingMinMs = Math.round(out.typingMinMs * scale);
    out.typingMaxMs = Math.round(out.typingMaxMs * scale);
    out.targetMinMs = Math.round(out.targetMinMs * scale);
    out.targetMaxMs = Math.round(out.targetMaxMs * scale);
    out.refreshMs = Math.max(2, Math.round(out.refreshMs * scale));
    out.hardCapMs = Math.max(4, Math.round(out.hardCapMs * scale));
    out.holdingAfterMs = Math.max(4, Math.round(out.holdingAfterMs * scale));
  }

  // Hard bounds: a burst debounce longer than 3 s makes the bot feel asleep, and
  // typing that never ends is worse than no typing indicator at all. A value
  // someone set on purpose (env or profile) is never clamped away — only the
  // defaults get the sanity floor.
  const explicit = new Set(
    Object.entries(ENV_KEYS)
      .filter(([, env]) => process.env[env] !== undefined && process.env[env] !== '')
      .map(([key]) => key)
  );
  if (probeProfileForExplicitKeys()) {
    for (const key of probeProfileForExplicitKeys()) explicit.add(key);
  }
  const floor = (ms, min, key = null) => {
    const value = Math.round(Number(ms) || 0);
    if (key && explicit.has(key)) return Math.max(0, value);
    return Math.max(out.scale < 1 ? 1 : min, value);
  };
  out.debounceMs = Math.max(0, Math.min(3000, Number(out.debounceMs) || 0));
  out.readMinMs = floor(Math.min(Number(out.readMaxMs) || 0, Number(out.readMinMs) || 0), 0, 'readMinMs');
  out.readMaxMs = floor(Math.max(Number(out.readMaxMs) || 0, out.readMinMs), 0, 'readMaxMs');
  out.typingMinMs = floor(Math.min(Number(out.typingMinMs) || 0, 10000), 500, 'typingMinMs');
  out.typingMaxMs = floor(Math.min(10000, Math.max(Number(out.typingMaxMs) || 0, out.typingMinMs)), 600, 'typingMaxMs');
  out.targetMinMs = floor(Math.max(out.typingMinMs, Number(out.targetMinMs) || 0), 1000, 'targetMinMs');
  out.targetMaxMs = floor(Math.max(out.targetMinMs, Number(out.targetMaxMs) || 0), 1500, 'targetMaxMs');
  out.refreshMs = floor(Number(out.refreshMs) || 8000, 1000, 'refreshMs');
  out.hardCapMs = floor(Math.max(out.refreshMs, Number(out.hardCapMs) || 30000), 2000, 'hardCapMs');
  out.holdingAfterMs = floor(Math.max(0, Number(out.holdingAfterMs) || 30000), 1000, 'holdingAfterMs');
  // A compressed envelope (tests, a 40 ms install) has no "long wait" to
  // apologise for; a holding line there would be pure noise.
  if (out.scale < 1) out.holdingAfterMs = Number.MAX_SAFE_INTEGER;
  out.maxSentences = Math.max(1, Math.min(6, Number(out.maxSentences) || 2));
  return out;
}

/** A duration scaled into the configured envelope (used for bubble gaps). */
export function scaled(ms, timing = replyTiming()) {
  if (!timing || timing.scale === undefined || timing.scale >= 1) return ms;
  return Math.max(1, Math.round(ms * timing.scale));
}

const jitter = (min, max) => min + Math.random() * (max - min);

/** Read receipt delay: 1–3 s by default, never longer than the typing start. */
export function readDelayMs(timing = replyTiming()) {
  return Math.round(jitter(timing.readMinMs, timing.readMaxMs));
}

/**
 * How long the indicator should stay up for this reply.
 * ~11 characters per second (a phone), clamped to the configured band, plus a
 * little jitter so two consecutive replies never look metronomic.
 */
export function typingMsFor(text = '', { voice = false, timing = replyTiming() } = {}) {
  const chars = String(text || '').length;
  const cps = Math.max(4, Number(config.behavior.typingSpeedCharsPerSec) || 11);
  const raw = (chars / cps) * 1000 * jitter(0.85, 1.15);
  const withVoice = voice ? raw + jitter(600, 1400) : raw;
  return Math.round(Math.max(timing.typingMinMs, Math.min(timing.typingMaxMs, withVoice)));
}

/**
 * The wait before a *finished* reply is sent.
 *
 * @param {{text?:string, voice?:boolean, receivedAt:number, readyAt:number,
 *          timing?:object, target?:number}} opts
 * @returns {{waitMs:number, typingMs:number, totalMs:number, late:boolean, targetMs:number}}
 */
export function planReplyDelay({ text = '', voice = false, receivedAt, readyAt, timing = replyTiming(), target = null }) {
  const typingMs = typingMsFor(text, { voice, timing });
  const targetMs = target ?? Math.round(jitter(timing.targetMinMs, timing.targetMaxMs));
  const elapsed = Math.max(0, Number(readyAt) - Number(receivedAt || readyAt));

  // Ready after the window: no extra pause at all. Being late is not a reason
  // to be later.
  if (elapsed >= timing.targetMaxMs) {
    return { waitMs: 0, typingMs, totalMs: elapsed, late: true, targetMs };
  }

  // Inside the window, hold for as long as this reply needs to be "typed", but
  // never past the window, and never less than the window's floor (a three-word
  // answer that arrives instantly should still read like someone read it).
  const minWait = Math.max(0, timing.targetMinMs - elapsed);
  const maxWait = Math.max(0, timing.targetMaxMs - elapsed);
  const waitMs = Math.round(Math.min(Math.max(typingMs, minWait), maxWait));
  return { waitMs, typingMs, totalMs: elapsed + waitMs, late: false, targetMs };
}

/**
 * A live typing indicator: `composing` (or `recording`) now, refreshed every
 * `refreshMs` so WhatsApp never drops it, and stopped after `hardCapMs` so a
 * dead provider cannot leave "typing…" on the customer's screen all evening.
 */
export function createTypingSession(
  sock,
  jid,
  { voice = false, timing = replyTiming(), setPresence = null, messageId = null, altJid = null, strategy = null, processing = false } = {}
) {
  // (strategy = null means "use the owner's stored choice".)
  // Which of the four shapes the owner saw working in `.typing-test`. The default
  // is "a" — composing only — so nobody gets a different behaviour by accident.
  const shape = strategy || storedStrategy();
  const target = shape === 'd' && altJid ? altJid : jid;
  const presence = setPresence || defaultPresence(sock, target, { messageId });
  const state = voice ? 'recording' : 'composing';
  const startedAt = Date.now();
  let timer = null;
  let cap = null;
  let stopped = false;
  let refreshes = 0;
  let announced = false;

  /**
   * Before the first `composing`: subscribe (shape b) and/or say `available`
   * (shape c, or the goOnline default). Sent to this chat only — the bot does
   * not announce itself to every contact on the account.
   */
  const announce = () => {
    if (announced) return;
    announced = true;
    if (!typingFixOn(timing)) return;
    const channel = presenceChannel(sock);
    if (shape === 'b') {
      const subscribe = typeof sock?.presenceSubscribe === 'function' ? sock.presenceSubscribe.bind(sock) : null;
      if (subscribe) {
        try {
          const out = subscribe(target);
          if (out && typeof out.catch === 'function') out.catch(() => {});
        } catch {
          /* subscription is best-effort */
        }
      }
    }
    // A partial timing object (tests, older callers) that says nothing about
    // going online gets the default, not "off".
    const goOnline = timing.goOnline === undefined ? Boolean(config.timing?.goOnline ?? true) : Boolean(timing.goOnline);
    if ((shape === 'c' || goOnline) && channel && !voice) {
      try {
        const out = channel.send('available', target);
        if (out && typeof out.catch === 'function') out.catch(() => {});
        noteTyping({ jid: target, state: 'available', via: channel.via, order: channel.order, sock, ok: true });
      } catch (err) {
        noteTyping({ jid: target, state: 'available', via: channel.via, order: channel.order, sock, ok: false, error: err?.message });
      }
    }
  };

  const ping = () => {
    if (stopped) return;
    try {
      announce();
      presence(state);
    } catch {
      /* presence is cosmetic */
    }
  };

  ping();
  timer = setInterval(() => {
    refreshes += 1;
    ping();
  }, timing.refreshMs);
  timer.unref?.();
  if (!processing)
    cap = setTimeout(() => {
      // Out of patience: stop claiming to type. The reply, when it comes, is sent
      // immediately and the caller decides whether an apology line is warranted.
      clearInterval(timer);
      timer = null;
    }, timing.hardCapMs);
  cap?.unref?.();

  return {
    startedAt,
    state,
    get alive() {
      return !stopped && timer !== null;
    },
    get refreshes() {
      return refreshes;
    },
    elapsed() {
      return Date.now() - startedAt;
    },
    pause() {
      // Deliberate: `paused` is always emitted, even after stop(). A caller that
      // put "recording…" up by hand still needs it taken down.
      try {
        presence('paused');
      } catch {
        /* ignore */
      }
    },
    async stop({ paused = true } = {}) {
      if (stopped) {
        if (paused) this.pause();
        return;
      }
      stopped = true;
      if (timer) clearInterval(timer);
      if (cap) clearTimeout(cap);
      timer = null;
      if (paused) {
        try {
          presence('paused');
        } catch {
          /* ignore */
        }
      }
    },
  };
}

function defaultPresence(sock, jid = null, { messageId = null } = {}) {
  return (state) => {
    try {
      let out = null;
      let via = null;
      let order = null;

      if (typeof sock?.sendTypingIndicator === 'function' && messageId) {
        // Cloud API: typing *is* the read receipt, and it needs the wamid.
        via = 'typingIndicator';
        order = 'message-id';
        out = sock.sendTypingIndicator(messageId, { state });
      } else if (typingFixOn()) {
        // One place knows the argument order. `presenceChannel` calls
        // setPresence(jid, state) on a transport and sendPresenceUpdate(state,
        // jid) on a raw socket — never the other way round.
        const channel = presenceChannel(sock);
        if (channel) {
          via = channel.via;
          order = channel.order;
          out = channel.send(state, jid);
        }
      } else if (typeof sock?.sendPresenceUpdate === 'function') {
        // Rollback path (TYPING_FIX=0): unchanged, bug and all.
        via = 'sendPresenceUpdate';
        order = 'state-first';
        out = sock.sendPresenceUpdate(state, jid);
      } else if (typeof sock?.setPresence === 'function') {
        via = 'setPresence';
        order = 'broken';
        out = sock.setPresence(state);
      }

      noteTyping({ jid, state, via: via || 'none', order, sock, ok: true });
      // Some transports return a promise; nobody waits for a typing indicator,
      // but an unhandled rejection would crash the process.
      if (out && typeof out.catch === 'function') {
        out.catch((err) => noteTyping({ jid, state, via: via || 'none', order, sock, ok: false, error: err?.message }));
      }
    } catch (err) {
      noteTyping({ jid, state, via: 'unknown', order: 'broken', sock, ok: false, error: err?.message });
      /* presence is cosmetic */
    }
  };
}

/** Is the presence call-shape fix on? `TYPING_FIX=0` restores the old calls. */
export function typingFixOn(timing = null) {
  if (timing && typeof timing.fix === 'boolean') return timing.fix;
  // Env wins over the config snapshot, so a running process (and a test) can
  // roll the fix back without a restart.
  const raw = process.env.TYPING_FIX;
  if (raw !== undefined && raw !== '') return !['0', 'false', 'off', 'no'].includes(String(raw).toLowerCase());
  return Boolean(config.timing?.fix);
}

/**
 * The one-line "sorry, still here" that goes out when a reply takes longer than
 * a person would wait silently. One per reply, short, in the chat's language.
 */
export const HOLDING_LINES = {
  'roman-ur': 'Ek second… likh raha hoon.',
  ur: 'ایک لمحہ… لکھ رہا ہوں۔',
  en: 'One sec — writing it up.',
};

export function holdingLine(lang = 'en') {
  const code = String(lang || 'en').toLowerCase();
  if (HOLDING_LINES[code]) return HOLDING_LINES[code];
  if (code.startsWith('roman')) return HOLDING_LINES['roman-ur'];
  if (code.startsWith('ur')) return HOLDING_LINES.ur;
  return HOLDING_LINES.en;
}

/** "available" on the owner's own account while the bot is working. */
export function markAvailable(sock, jid = null) {
  try {
    const channel = presenceChannel(sock);
    if (!channel) return;
    const out = channel.send('available', jid || undefined);
    if (out && typeof out.catch === 'function') out.catch(() => {});
    noteTyping({ jid: jid || null, state: 'available', via: channel.via, order: channel.order, sock, ok: true });
  } catch {
    /* ignore */
  }
}

/** Can this transport show typing at all? Cloud API cannot; say so once. */
export function typingCapabilities(transport) {
  const can = typeof transport?.can === 'function' ? transport.can.bind(transport) : () => true;
  const typingIndicator = can('typingIndicator') === true;
  // Typing is "presence" on Baileys and the read-receipt indicator on Cloud.
  const presence = can('presence') !== false || typingIndicator;
  const reactions = can('reactions') !== false;
  return {
    presence,
    reactions,
    typingIndicator,
    // Cloud: the label is raised by the read-receipt call and dies after 25 s.
    maxSeconds: typingIndicator ? Number(transport?.capabilities?.typingMaxSeconds) || 25 : null,
    note: presence
      ? typingIndicator
        ? 'Cloud API: typing rides on the read receipt and lasts 25 s; it is refreshed while the reply is written'
        : null
      : 'this transport has no typing indicator; replies arrive without one',
  };
}

export default {
  DEFAULT_TIMING,
  replyTiming,
  readDelayMs,
  typingMsFor,
  planReplyDelay,
  createTypingSession,
  markAvailable,
  typingCapabilities,
  holdingLine,
  HOLDING_LINES,
  scaled,
};

// Exactly one in-flight holding line. The caller cancels (and joins) it
// before delivery, so a slow send cannot overtake the final answer.
export function startMediaHolding({ receivedAt, timing, send }) {
  let promise, timer;
  if (timing.enabled && timing.holdingAfterMs < 2147483647) {
    timer = setTimeout(() => { promise = Promise.resolve().then(send).catch(() => {}); },
      Math.max(0, receivedAt + timing.holdingAfterMs - Date.now()));
    timer.unref?.();
  }
  return async () => { clearTimeout(timer); await promise; };
}
