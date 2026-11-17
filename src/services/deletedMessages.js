// src/services/deletedMessages.js
// "Delete for everyone" watchdog: if a client says something and then deletes
// it, the owner still gets to see it (with the original timestamp).

import { config } from '../config/env.js';
import { rememberIncoming, recallIncoming, logEvent } from '../utils/db.js';
import { jidToNumber, describeMessage, chatKind } from './media.js';

/** Remember incoming content so it can be recovered if deleted. */
export function rememberMessage(msg) {
  try {
    const msgId = msg?.key?.id;
    if (!msgId) return;
    const info = describeMessage(msg);
    const body = (info.text || '').slice(0, 1500);
    rememberIncoming(msgId, jidToNumber(msg.key.remoteJid || ''), info.kind, body || null);
  } catch {
    /* never break the main flow */
  }
}

const formatTime = (date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    day: '2-digit',
    month: 'short',
  }).format(date);

export async function handleDeletedMessage(sock, updates = []) {
  for (const update of updates) {
    const isDelete =
      update.update?.message === null ||
      update.update?.messageStubType === 1 ||
      update.update?.messageStubType === 'REVOKE';

    if (!isDelete || update.key?.fromMe) continue;
    if (!chatKind(update.key?.remoteJid || '') || chatKind(update.key?.remoteJid || '') !== 'private') continue;

    const stored = recallIncoming(update.key?.id);
    if (!stored) continue;

    const number = stored.number;
    const lines = [
      '🗑️ *Deleted message*',
      '',
      `👤 ${number}`,
      stored.body ? `💬 "${stored.body}"` : stored.kind && stored.kind !== 'other' ? `📎 ${stored.kind} (deleted)` : '❓ unknown content',
      `🕐 ${formatTime(new Date(stored.created_at))}`,
    ];

    try {
      await sock.sendMessage(config.owner.jid, { text: lines.join('\n') });
      logEvent('deleted_message', number, stored.body || stored.kind);
    } catch (err) {
      console.error('Deleted-message notify failed:', err.message);
    }
  }
}

export default { rememberMessage, handleDeletedMessage };
