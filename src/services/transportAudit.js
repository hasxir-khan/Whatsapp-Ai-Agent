// src/services/transportAudit.js
// The evidence layer for the WhatsApp transport: what was sent, what came back,
// and what the socket complained about.
//
// This module exists because "the typing indicator never shows" and "the message
// says *Waiting for this message*" are both invisible from the inside: the bot
// thinks it sent a presence update and a message, WhatsApp disagrees, and
// nothing in a fake-socket test can tell the difference. So every relevant
// event is counted here, in memory, with no message content:
//
//   • presence — the exact JID, which state, which call shape, and whether the
//     call shape even matches the object we handed it;
//   • delivery — the status transitions WhatsApp reports for each outgoing
//     message (sent → server ack → delivered → read) with timestamps;
//   • decryption — Bad MAC, session resets, "message absent from node", failed
//     retries, counted from the Baileys logger and from upsert/update stubs.
//
// Nothing here stores text. A JID is an address, not content; the counters are
// integers; log lines are matched by category and the matched line is dropped.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';
import { logEvent } from '../utils/db.js';

const require_ = createRequire(import.meta.url);

/** How many outgoing ids and presence events to remember. */
const OUTBOUND_LIMIT = 200;
const TYPING_LIMIT = 60;

/** WhatsApp's status enum, named. */
export const STATUS_NAMES = {
  0: 'error',
  1: 'pending',
  2: 'server_ack',
  3: 'delivered',
  4: 'read',
  5: 'played',
};

const DECRYPT_KINDS = {
  badMac: /bad MAC|failed to decrypt message|no matching session/i,
  sessionReset: /closing open session in favor of incoming prekey bundle/i,
  absentMessage: /message absent from node/i,
  retryFailed: /failed to (send|process) retry|retry receipt|session error/i,
};

function freshState() {
  return {
    counters: {
      badMac: 0,
      sessionReset: 0,
      absentMessage: 0,
      retryFailed: 0,
      presenceSent: 0,
      presenceFailed: 0,
      presenceMismatch: 0,
      outboundSent: 0,
      outboundDelivered: 0,
    },
    typing: [],
    outbound: new Map(),
    inbound: new Map(),
    lastPresence: null,
    startedAt: Date.now(),
  };
}

let state = freshState();

/** Forget everything. Tests call this; a restart does it for free. */
export function resetAudit() {
  state = freshState();
  return state;
}

function noteNumberKind(kind, detail = null) {
  if (state.counters[kind] === undefined) return;
  state.counters[kind] += 1;
  try {
    logEvent(`transport_${kind}`, null, detail);
  } catch {
    /* bookkeeping never breaks the socket */
  }
}

// ── inbound JIDs (phone form vs LID form) ────────────────────
const LID_SUFFIX = '@lid';

function phoneForm(jid = '') {
  const value = String(jid || '');
  if (!value.endsWith('@s.whatsapp.net')) return null;
  return value.replace(/:\d+@/, '@');
}

/**
 * Remember the JID shapes this contact's last message arrived on.
 * Baileys sends a message to `remoteJid`; for a LID chat that is not the phone
 * number, which is exactly why a presence update can be addressed to a chat the
 * customer's phone is not showing.
 */
export function noteInbound(msg = {}) {
  const key = msg?.key || msg || {};
  const remoteJid = key.remoteJid || msg?.chat || '';
  if (!remoteJid) return null;
  const alt = key.remoteJidAlt || key.senderLid || msg?.remoteJidAlt || null;
  const phone = phoneForm(remoteJid) || phoneForm(alt) || null;
  const lid = String(remoteJid).endsWith(LID_SUFFIX) ? remoteJid : String(alt || '').endsWith(LID_SUFFIX) ? alt : null;
  const number = String(phone || remoteJid).replace(/@.*$/, '').replace(/[^\d]/g, '');

  const entry = {
    jid: remoteJid,
    alt: alt || null,
    phone,
    lid,
    number,
    id: key.id || null,
    at: Date.now(),
  };
  if (number) {
    state.inbound.set(number, entry);
    // Keep the map from growing without bound: drop the oldest when it does.
    if (state.inbound.size > 500) {
      const oldest = [...state.inbound.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) state.inbound.delete(oldest[0]);
    }
  }
  return entry;
}

/** What we know about the JID(s) a contact writes from. */
export function jidForms(number = '') {
  const digits = String(number || '').replace(/[^\d]/g, '');
  const known = state.inbound.get(digits) || null;
  const phone = known?.phone || (digits ? `${digits}@s.whatsapp.net` : null);
  return {
    number: digits,
    phone,
    lid: known?.lid || null,
    lastInboundJid: known?.jid || null,
    lastInboundAlt: known?.alt || null,
    lastInboundId: known?.id || null,
    at: known?.at || null,
    // The exact JID a reply must be addressed to: the inbound one when we have
    // it, the phone form otherwise.
    replyJid: known?.jid || phone,
  };
}

// ── presence / typing ───────────────────────────────────────
/**
 * Record one presence call. `via` says which call shape was used, because the
 * two shapes have opposite argument orders and only one of them can be right:
 *   sendPresenceUpdate(state, jid)   ← the socket's own method
 *   setPresence(jid, state)          ← the transport's method
 * A mismatch counter above zero means someone called the second one with the
 * first one's arguments — presence goes out addressed to "composing".
 */
export function noteTyping({ jid = null, state: presenceState = null, via = 'unknown', sock = null, ok = true, error = null, order = null, at = Date.now() } = {}) {
  const setPresenceArity = typeof sock?.setPresence === 'function' ? Number(sock.setPresence.length) || 0 : 0;
  // `order` is the authoritative answer when the caller supplies it. Without it
  // (older call sites, the transport's own method) fall back to the signature:
  // a two-argument setPresence called with one argument is the swapped call.
  const mismatch = order === 'broken' || (order === null && via === 'setPresence' && setPresenceArity >= 2);
  if (ok) state.counters.presenceSent += 1;
  else state.counters.presenceFailed += 1;
  if (mismatch) state.counters.presenceMismatch += 1;

  const entry = {
    at,
    jid: jid || null,
    state: presenceState || null,
    via,
    order,
    ok: !!ok,
    error: error ? String(error).slice(0, 120) : null,
    mismatch,
  };
  state.typing.push(entry);
  if (state.typing.length > TYPING_LIMIT) state.typing.shift();
  state.lastPresence = entry;

  if (String(process.env.TYPING_AUDIT || '').toLowerCase() === '1') {
    const stamp = new Date(at).toISOString().slice(11, 23);
    console.log(
      `[typing] ${stamp} ${presenceState || '?'} → ${jid || '?'} via=${via}${ok ? '' : ' FAILED'}${mismatch ? ' ⚠️ ARGUMENT ORDER' : ''}`,
    );
  }
  return entry;
}

export function lastTyping() {
  return state.lastPresence;
}

export function recentTyping(limit = 10) {
  return state.typing.slice(-Math.max(1, Number(limit) || 10));
}

// ── outbound delivery ───────────────────────────────────────
export function noteOutbound({ id, jid, at = Date.now(), kind = 'message' } = {}) {
  if (!id) return null;
  const entry = {
    id: String(id),
    jid: jid ? String(jid) : null,
    kind,
    sentAt: Number(at) || Date.now(),
    history: [{ status: 'sent', at: Number(at) || Date.now() }],
    status: 'sent',
    deliveredAt: null,
    readAt: null,
    errorAt: null,
  };
  state.outbound.set(entry.id, entry);
  state.counters.outboundSent += 1;
  if (state.outbound.size > OUTBOUND_LIMIT) {
    const oldest = [...state.outbound.entries()].sort((a, b) => a[1].sentAt - b[1].sentAt)[0];
    if (oldest) state.outbound.delete(oldest[0]);
  }
  return entry;
}

function canonicalStatus(raw) {
  if (typeof raw === 'number') return STATUS_NAMES[raw] || `status_${raw}`;
  const value = String(raw ?? '').toLowerCase();
  if (['sent', 'pending', 'server_ack', 'delivered', 'read', 'played', 'error'].includes(value)) return value;
  return value || 'unknown';
}

/** One transition for one message. Later states never overwrite earlier times. */
export function noteStatus({ id, status, at = Date.now() } = {}) {
  if (!id) return null;
  const entry = state.outbound.get(String(id));
  if (!entry) return null;
  const name = canonicalStatus(status);
  const when = Number(at) || Date.now();
  const seen = entry.history.some((h) => h.status === name);
  if (!seen) entry.history.push({ status: name, at: when });
  entry.status = name;
  if (name === 'delivered' && !entry.deliveredAt) {
    entry.deliveredAt = when;
    state.counters.outboundDelivered += 1;
  }
  if (name === 'read') {
    if (!entry.readAt) entry.readAt = when;
    // A read receipt is proof of delivery that arrived without its own event.
    if (!entry.deliveredAt) {
      entry.deliveredAt = when;
      state.counters.outboundDelivered += 1;
    }
  }
  if (name === 'error' && !entry.errorAt) entry.errorAt = when;
  return entry;
}

/**
 * `messages.update` (status on our own messages) and `message-receipt.update`
 * (delivered/read receipts) both land here. Stub type 2 is "message absent from
 * node" — WhatsApp's way of saying it cannot find the message it was told about.
 */
export function noteStatusUpdate(updates = []) {
  for (const item of [].concat(updates || [])) {
    if (!item) continue;
    const id = item.key?.id || item.id || null;
    if (item.receipt) {
      const read = item.receipt.readTimestamp;
      const when = Number(read || item.receipt.receiptTimestamp || 0) * 1000 || Date.now();
      noteStatus({ id, status: read ? 'read' : 'delivered', at: when });
      continue;
    }
    if (item.update && item.update.status !== undefined) {
      noteStatus({ id, status: item.update.status });
    }
    const stub = item.update?.messageStubType ?? item.messageStubType;
    const params = item.update?.messageStubParameters || item.messageStubParameters || [];
    if (Number(stub) === 2 || params.some((p) => /absent from node/i.test(String(p)))) {
      noteNumberKind('absentMessage', { id: id || null });
    }
  }
  return state.counters.absentMessage;
}

/** send → delivered latency, and anything still unacknowledged. */
export function deliveryLines({ limit = 5, now = Date.now(), staleMs = 60000, jid = null } = {}) {
  const rows = [...state.outbound.values()]
    .filter((row) => (jid ? row.jid === jid : true))
    .sort((a, b) => b.sentAt - a.sentAt)
    .slice(0, Math.max(1, Number(limit) || 5));
  if (!rows.length) return [];
  const lines = ['*Delivery*'];
  for (const row of rows) {
    const short = row.jid ? `+${String(row.jid).split('@')[0].replace(/\D/g, '')}` : 'unknown';
    if (row.deliveredAt) {
      const ms = row.deliveredAt - row.sentAt;
      const extra = row.readAt ? ` · read in ${((row.readAt - row.sentAt) / 1000).toFixed(1)}s` : '';
      lines.push(`✅ ${short}: sent → delivered in ${(ms / 1000).toFixed(1)}s${extra}`);
    } else if (now - row.sentAt >= staleMs) {
      const waited = Math.round((now - row.sentAt) / 1000);
      lines.push(`⚠️ ${short}: no delivery ack after ${waited}s (${row.status})`);
    } else {
      lines.push(`⏳ ${short}: ${row.status} · ${Math.round((now - row.sentAt) / 1000)}s ago`);
    }
  }
  return lines;
}

export function unackedCount({ now = Date.now(), staleMs = 60000 } = {}) {
  return [...state.outbound.values()].filter((row) => !row.deliveredAt && now - row.sentAt >= staleMs).length;
}

// ── decryption ──────────────────────────────────────────────
/** Count a decryption problem by category. Text is never stored. */
export function noteDecrypt(kind, { id = null, at = Date.now() } = {}) {
  if (!DECRYPT_KINDS[kind]) return null;
  state.counters[kind] += 1;
  try {
    logEvent(`decrypt_${kind}`, null, { id: id || null, at: new Date(at).toISOString() });
  } catch {
    /* ignore */
  }
  return state.counters[kind];
}

/**
 * Match a log line against the categories without keeping it. Baileys reports
 * Bad MAC and prekey-bundle session resets through its logger, so the logger is
 * where they are counted.
 */
export function noteLogText(text) {
  const line = typeof text === 'string' ? text : '';
  if (!line) return null;
  for (const [kind, pattern] of Object.entries(DECRYPT_KINDS)) {
    if (pattern.test(line)) {
      state.counters[kind] += 1;
      return kind;
    }
  }
  return null;
}

function logTextFrom(args) {
  // pino accepts (obj, msg), (msg), or (obj) with an `err` inside. The object is
  // inspected before the second argument, because `logger.error({ err }, 'x')`
  // carries the message in `err`, not in the trailing label.
  const [first, second] = args;
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    const fromObject = String(first.err?.message || first.message || first.msg || '');
    if (fromObject) return fromObject;
  }
  if (typeof second === 'string') return second;
  return '';
}

/**
 * Wrap a pino logger so every line is inspected for the categories above and
 * then passed through untouched. Behaviour is unchanged; only the counting is
 * new.
 */
export function createAuditLogger(base) {
  if (!base) return base;
  const wrap = (level) =>
    function audited(...args) {
      noteLogText(logTextFrom(args));
      const fn = base[level];
      return typeof fn === 'function' ? fn.apply(base, args) : undefined;
    };
  return {
    level: base.level,
    child: (bindings) => createAuditLogger(base.child ? base.child(bindings) : base),
    trace: wrap('trace'),
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
    fatal: wrap('fatal'),
  };
}

// ── versions and settings ───────────────────────────────────
function packageVersion(name) {
  try {
    const file = require_.resolve(`${name}/package.json`, { paths: [config.root, process.cwd()] });
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: parsed.version || null, file };
  } catch {
    return null;
  }
}

function declaredRange() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8'));
    return (
      pkg.optionalDependencies?.['@whiskeysockets/baileys'] ||
      pkg.dependencies?.['@whiskeysockets/baileys'] ||
      null
    );
  } catch {
    return null;
  }
}

/**
 * What is actually running: package versions, Node, and the reply-timing model.
 * `strategy` is the `.typing-test` choice (see services/typingTest.js); it is
 * read from the profile without importing that module, to keep this one leaf.
 */
export function environment() {
  const baileys = packageVersion('@whiskeysockets/baileys');
  const libsignal = packageVersion('libsignal') || packageVersion('@whiskeysockets/libsignal-node');
  let timing = { enabled: null, strategy: null };
  try {
    const profile = JSON.parse(fs.readFileSync(path.join(config.paths.config, 'owner.json'), 'utf8'));
    const explicit = profile?.typing?.strategy || process.env.TYPING_STRATEGY || null;
    timing = {
      enabled: process.env.REPLY_TIMING === undefined ? null : !['0', 'false', 'off'].includes(String(process.env.REPLY_TIMING).toLowerCase()),
      strategy: explicit ? String(explicit) : 'a (default: composing only)',
    };
  } catch {
    timing = { enabled: process.env.REPLY_TIMING ?? null, strategy: process.env.TYPING_STRATEGY || 'a (default: composing only)' };
  }
  return {
    node: process.version,
    baileys: { installed: baileys?.version || null, declared: declaredRange() },
    libsignal: libsignal ? { name: libsignal.file.includes('libsignal-node') ? '@whiskeysockets/libsignal-node' : 'libsignal', version: libsignal.version } : null,
    timing,
    transport: config.transport,
    sessionDir: config.paths.sessions,
  };
}

export function environmentLines() {
  const env = environment();
  return [
    `Node ${env.node} · transport ${env.transport}`,
    `Baileys: ${env.baileys.installed ? `installed ${env.baileys.installed}` : 'NOT installed'} (declared ${env.baileys.declared || 'no'})`,
    `libsignal: ${env.libsignal ? `${env.libsignal.name} ${env.libsignal.version}` : 'not installed'}`,
    `Reply timing: ${env.timing.enabled === null ? 'default (on)' : env.timing.enabled ? 'on' : 'off'} · strategy ${env.timing.strategy}`,
  ];
}

// ── the one-line summaries commands use ─────────────────────
export function counters() {
  return { ...state.counters, unacked: unackedCount() };
}

export function summaryLines({ now = Date.now() } = {}) {
  const c = state.counters;
  const unacked = unackedCount({ now });
  const last = state.lastPresence;
  const typingBits = [
    `${c.presenceSent} presence sent`,
    ...(c.presenceFailed ? [`${c.presenceFailed} failed`] : []),
    ...(c.presenceMismatch ? [`⚠️ ${c.presenceMismatch} wrong argument order`] : []),
  ];
  const lines = [
    `Typing: ${last ? `${last.state} → ${last.jid || '?'}` : 'nothing sent yet'} · ${typingBits.join(' · ')}`,
    `Delivery: ${c.outboundSent} sent · ${c.outboundDelivered} delivered${unacked ? ` · ⚠️ ${unacked} unacked >60s` : ''}`,
    `Decrypt: ${c.badMac} bad MAC · ${c.sessionReset} session reset · ${c.absentMessage} absent · ${c.retryFailed} retry failed`,
  ];
  return lines;
}

export default {
  resetAudit,
  noteInbound,
  jidForms,
  noteTyping,
  lastTyping,
  recentTyping,
  noteOutbound,
  noteStatus,
  noteStatusUpdate,
  deliveryLines,
  unackedCount,
  noteDecrypt,
  noteLogText,
  createAuditLogger,
  environment,
  environmentLines,
  counters,
  summaryLines,
  STATUS_NAMES,
};
