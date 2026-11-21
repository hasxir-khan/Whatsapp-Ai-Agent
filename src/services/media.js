// src/services/media.js
// Everything about turning a raw Baileys message into something usable:
// chats we must ignore, media type detection, safe downloads with size caps,
// and temp files.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// Baileys is optional (a Cloud-only install omits it), so the one function we
// need from it is loaded on demand. `downloadMediaMessage` is only reached for
// Baileys messages, which cannot exist without the package.
async function baileys() {
  try {
    return await import('@whiskeysockets/baileys');
  } catch (err) {
    const e = new Error(
      'This message needs @whiskeysockets/baileys, which is not installed.\n' +
        '  Install it:  npm install     (optional deps included)\n' +
        '  Cloud-only:  TRANSPORT=cloud does not download Baileys media this way\n' +
        `  Underlying error: ${err.message}`
    );
    e.code = 'baileys_missing';
    throw e;
  }
}
import { config } from '../config/env.js';

// ── chat type guards ────────────────────────────────────────
export function chatKind(jid = '') {
  if (jid === 'status@broadcast') return 'status';
  if (jid.endsWith('@g.us')) return 'group';
  if (jid.endsWith('@newsletter')) return 'newsletter';
  if (jid.endsWith('@broadcast')) return '#broadcast';
  if (jid.endsWith('@s.whatsapp.net')) return 'private';
  if (jid.endsWith('@lid')) return 'private';
  return 'other';
}

/** Hard rule: this bot only ever works in 1-to-1 chats. */
export function isAllowedChat(jid = '') {
  return chatKind(jid) === 'private';
}

export function jidToNumber(jid = '') {
  return String(jid)
    .replace(/@.*$/, '')
    .replace(/:\d+$/, '');
}

/** Some accounts arrive as @lid; prefer the phone-number JID when offered. */
export function resolveNumber(msg) {
  const key = msg?.key || {};
  const raw = key.remoteJidAlt || key.senderPn || key.remoteJid || '';
  if (String(raw).includes('@s.whatsapp.net')) return jidToNumber(raw);
  if (String(key.remoteJid || '').endsWith('@s.whatsapp.net')) return jidToNumber(key.remoteJid);
  return jidToNumber(raw || key.remoteJid || '');
}

export function resolveJid(msg) {
  const key = msg?.key || {};
  const alt = key.remoteJidAlt || key.senderPn;
  if (alt && String(alt).includes('@s.whatsapp.net')) return alt;
  return key.remoteJid || '';
}

// ── message unpacking ───────────────────────────────────────
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
  'deviceSentMessage',
];

/** Peels off ephemeral / view-once / edited wrappers. */
export function unwrapContent(message = {}) {
  let content = message;
  for (let i = 0; i < 6; i++) {
    const wrapper = WRAPPERS.find((w) => content?.[w]?.message);
    if (!wrapper) break;
    content = content[wrapper].message;
  }
  return content || {};
}

export function extractText(content = {}) {
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.pollCreationMessage?.name ||
    ''
  );
}

/**
 * @returns {{kind:string, mimetype:string, fileName:string, seconds:number, caption:string, text:string, isVoice:boolean, isViewOnce:boolean}}
 */
export function describeMessage(msg) {
  const raw = msg?.message || {};
  const content = unwrapContent(raw);
  const caption = extractText(content);
  const isViewOnce = !!(raw.viewOnceMessage || raw.viewOnceMessageV2 || raw.viewOnceMessageV2Extension) ||
    !!(content.imageMessage?.viewOnce || content.videoMessage?.viewOnce || content.audioMessage?.viewOnce);

  let kind = 'other';
  let mimetype = '';
  let fileName = '';
  let seconds = 0;
  let isVoice = false;

  if (content.imageMessage) {
    kind = 'image';
    mimetype = content.imageMessage.mimetype || 'image/jpeg';
  } else if (content.videoMessage) {
    kind = 'video';
    mimetype = content.videoMessage.mimetype || 'video/mp4';
    seconds = Number(content.videoMessage.seconds) || 0;
  } else if (content.audioMessage) {
    isVoice = !!content.audioMessage.ptt;
    kind = isVoice ? 'voice' : 'audio';
    mimetype = content.audioMessage.mimetype || 'audio/ogg';
    seconds = Number(content.audioMessage.seconds) || 0;
  } else if (content.documentMessage) {
    kind = 'document';
    mimetype = content.documentMessage.mimetype || 'application/octet-stream';
    fileName = content.documentMessage.fileName || 'file';
  } else if (content.stickerMessage) {
    kind = 'sticker';
    mimetype = content.stickerMessage.mimetype || 'image/webp';
  } else if (content.locationMessage || content.liveLocationMessage) {
    kind = 'location';
  } else if (content.contactMessage || content.contactsArrayMessage) {
    kind = 'contact';
  } else if (content.reactionMessage) {
    kind = 'reaction';
  } else if (content.protocolMessage) {
    kind = 'protocol';
  } else if (caption || content.conversation) {
    kind = 'text';
  }

  // Baileys/WhatsApp sometimes lie about ptt on forwarded voice notes
  if ((kind === 'audio') && /ogg|opus/.test(mimetype) && seconds > 0 && seconds < 300) {
    // leave as audio; callers can still transcribe it
  }

  return {
    kind,
    mimetype,
    fileName,
    seconds,
    caption,
    text: caption,
    isVoice,
    isViewOnce,
    content,
    message: raw,
  };
}

// ── downloads ───────────────────────────────────────────────
export class MediaTooBigError extends Error {}

// Callers can tighten these bounds, never remove the transport's own limit.
export function mediaByteLimit(kind, requested) {
  let limit = 25 * 1024 * 1024;
  if (kind === 'video') limit = config.vision.maxVideoBytes;
  if (kind === 'image' || kind === 'sticker') limit = config.vision.maxImageBytes;
  const cap = Math.min(64 * 1024 * 1024, limit, requested ?? Infinity);
  return Number.isFinite(cap) ? Math.max(0, cap) : 0;
}
export const mediaTimeout = ms => Math.max(1, Math.min(ms ?? Infinity, config.media.timeoutMs, 30000));
export async function downloadMedia(msg, info = describeMessage(msg), { maxBytes, timeoutMs } = {}) {
  const limit = mediaByteLimit(info.kind, maxBytes);
  const content = info.content || {};
  const node =
    content.videoMessage ||
    content.audioMessage ||
    content.imageMessage ||
    content.documentMessage ||
    content.stickerMessage;
  const length = node?.fileLength ?? content.fileLength;
  // A protobuf Long can arrive hydrated or as its JSON {low, high} limbs.
  const declared =
    Number.isInteger(length?.high) && Number.isInteger(length?.low)
      ? (length.high >>> 0) * 2 ** 32 + (length.low >>> 0)
      : Number(length);
  if (declared > limit || (['audio', 'voice'].includes(info.kind) && info.seconds > config.stt.maxSeconds))
    throw new MediaTooBigError('media_limit');
  const { downloadMediaMessage } = await baileys();
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(mediaTimeout(timeoutMs))]);
  let stream;
  const abort = () => stream?.destroy(new Error('download_timeout'));
  try {
    stream = await downloadMediaMessage(msg, 'stream', { options: { signal } });
    signal.throwIfAborted();
    signal.addEventListener('abort', abort, { once: true });
    return { buffer: await boundedMedia(stream, limit), mimetype: info.mimetype };
  } finally {
    signal.removeEventListener('abort', abort);
    stream?.destroy();
    controller.abort();
  }
}

// ── temp files ──────────────────────────────────────────────
function ensureTmp() {
  fs.mkdirSync(config.paths.tmp, { recursive: true, mode: 0o700 });
  return config.paths.tmp;
}

export function tempFile(ext = 'bin', prefix = 'wa') {
  const dir = ensureTmp();
  const name = `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  return path.join(dir, name);
}

export function writeTemp(buffer, ext = 'bin', prefix = 'wa') {
  const file = tempFile(ext, prefix);
  fs.writeFileSync(file, buffer, { mode: 0o600 });
  return file;
}

export function tempDir(prefix = 'job') {
  const dir = path.join(ensureTmp(), `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function cleanupPath(target) {
  try {
    if (target && fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function extFromMime(mimetype = '') {
  const map = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
    'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/opus': 'opus',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/msword': 'doc', 'text/plain': 'txt', 'text/markdown': 'md',
  };
  return map[String(mimetype).split(';')[0].trim()] || 'bin';
}

/** Removes files older than an hour from the temp dir (runs opportunistically). */
export function sweepTemp(maxAgeMs = 60 * 60 * 1000) {
  try {
    const dir = config.paths.tmp;
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > maxAgeMs) fs.rmSync(full, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

export default {
  chatKind, isAllowedChat, jidToNumber, resolveNumber, resolveJid,
  unwrapContent, extractText, describeMessage, downloadMedia,
  tempFile, writeTemp, tempDir, cleanupPath, extFromMime, sweepTemp, MediaTooBigError,
};

// Stop reading untrusted downloads
// as soon as the limit is crossed, even if Content-Length was absent or false.
export async function boundedMedia(stream, limit) {
  if (!stream?.[Symbol.asyncIterator]) throw Error('no_media_stream');
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new MediaTooBigError('too_large');
    chunks.push(chunk);
  }
  if (!size) throw Error('empty_media');
  return Buffer.concat(chunks, size);
}
