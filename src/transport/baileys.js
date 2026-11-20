// src/transport/baileys.js
// Baileys, wrapped — not rewritten.
//
// Every line of socket setup below is the code that used to live in index.js,
// moved behind the transport interface unchanged: same options, same reconnect
// backoff, same pairing code, same QR rendering. That is deliberate. Existing
// installations must not be able to tell that a transport layer appeared.

// Baileys is an *optional* dependency: a Cloud-API-only box should be able to
// `npm ci --omit=optional` and never download libsignal-node, sharp or axios.
// So it is loaded on first use, with an error that says what to do about it.
let baileysModule = null;

/**
 * Is the package installed at all? Synchronous, so the CLI can refuse to start
 * with one clear sentence instead of failing halfway through a connection.
 */
export function baileysAvailable() {
  try {
    createRequire(import.meta.url).resolve('@whiskeysockets/baileys');
    return true;
  } catch {
    return false;
  }
}

export const BAILEYS_MISSING_HINT =
  'Baileys is not installed, so TRANSPORT=baileys cannot start.\n' +
  '  Install it:    npm install                  (optional dependencies included)\n' +
  '  Or go Cloud:   TRANSPORT=cloud  with features.cloudApi and the Meta keys';

export async function loadBaileys() {
  if (baileysModule) return baileysModule;
  try {
    baileysModule = await import('@whiskeysockets/baileys');
    return baileysModule;
  } catch (err) {
    const e = new Error(
      [
        'Baileys is not installed, so TRANSPORT=baileys cannot start.',
        '  Install it:    npm install                 (optional deps included)',
        '  Or go Cloud:   TRANSPORT=cloud  with features.cloudApi and the Meta keys',
        `  Underlying error: ${err.message}`,
      ].join('\n')
    );
    e.code = 'baileys_missing';
    e.permanent = true;
    throw e;
  }
}
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import { config } from '../config/env.js';
import { logEvent } from '../utils/db.js';
import { botState, setQr, clearQr, setStatus } from '../state.js';
import { registerCalls } from '../services/calls.js';
import {
  createAuditLogger,
  noteInbound,
  noteOutbound,
  noteStatusUpdate,
  noteTyping,
  noteDecrypt,
} from '../services/transportAudit.js';
import { handleDeletedMessage } from '../services/deletedMessages.js';
import * as media from '../services/media.js';
import { describeMessage, downloadMedia, chatKind, resolveNumber, resolveJid } from '../services/media.js';
import { createRequire } from 'node:module';
import { Transport, normalizeIncoming, jidToNumber } from './base.js';

// Wrapped, not replaced: Baileys reports Bad MAC and prekey-bundle session
// resets through this logger, so it is where decryption failures are counted.
// The wrapper passes every line through untouched and stores no text.
const logger = createAuditLogger(pino({ level: process.env.BAILEYS_LOG === 'debug' ? 'debug' : 'silent' }));

export const BAILEYS_CAPABILITIES = {
  text: true,
  voice: true,
  image: true,
  video: true,
  document: true,
  mediaDownload: true,
  markRead: true,
  presence: true,
  deleteMessage: true,
  deliveryReceipts: true,
  templates: false, // not a Baileys concept
  callEvents: true,
  deletedMessages: true,
  groups: false, // the bot refuses them by design — capability or not
  reactions: true,
  maxMediaBytes: config.vision.maxVideoBytes,
};

/** Baileys message → the internal shape. */
export function normalizeBaileys(msg) {
  const info = describeMessage(msg);
  const content = info.content || {};
  const loc = content.locationMessage || content.liveLocationMessage || null;
  const contact = content.contactMessage || content.contactsArrayMessage || null;

  return normalizeIncoming({
    id: msg?.key?.id || null,
    chat: resolveJid(msg) || msg?.key?.remoteJid || '',
    number: resolveNumber(msg),
    fromMe: !!msg?.key?.fromMe,
    pushName: msg?.pushName || null,
    kind: info.kind,
    text: info.text || '',
    caption: info.caption || '',
    mimetype: info.mimetype || '',
    fileName: info.fileName || '',
    seconds: info.seconds || 0,
    isVoice: !!info.isVoice,
    location: loc
      ? { lat: loc.degreesLatitude, lng: loc.degreesLongitude, name: loc.name || '' }
      : null,
    contactName: contact ? contact.displayName || 'contact' : null,
    timestamp: msg?.messageTimestamp
      ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
      : new Date().toISOString(),
    mediaRef: null,
    raw: msg,
  });
}

export class BaileysTransport extends Transport {
  constructor({ sock = null, slug = config.tenant.slug } = {}) {
    super({ kind: 'baileys', capabilities: BAILEYS_CAPABILITIES, slug });
    this.sock = sock;
    this.reconnectAttempts = 0;
    this.closed = false;
    this.reconnectTimer = null;
  }

  /** Wrap an existing socket (tests, or a host that made its own). */
  static wrap(sock) {
    const transport = new BaileysTransport({ sock });
    transport.status = 'online';
    return transport;
  }

  can(name) {
    // Groups are a WhatsApp feature Baileys can see, but this bot refuses
    // them everywhere; saying "yes" would only invite a code path we ban.
    if (name === 'groups') return false;
    return super.can(name);
  }

  get user() {
    return this.sock?.user || null;
  }

  /** Build the socket exactly as index.js always did. */
  async connect() {
    setStatus(botState.connectedAt ? 'reconnecting' : 'connecting');

    const baileys = await loadBaileys();
    const { state, saveCreds } = await baileys.useMultiFileAuthState(config.paths.sessions);

    let version;
    try {
      ({ version } = await baileys.fetchLatestBaileysVersion());
    } catch {
      version = [2, 3000, 1017531287];
    }

    const sock = baileys.default({
      version,
      logger,
      printQRInTerminal: false,
      browser: baileys.Browsers.ubuntu('Chrome'),
      auth: { creds: state.creds, keys: baileys.makeCacheableSignalKeyStore(state.keys, logger) },
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      emitOwnEvents: false,
      defaultQueryTimeoutMs: 60000,
      getMessage: async () => undefined,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    // Missed-call rescue: when nobody picks up within CALL_FALLBACK_SECONDS,
    // the assistant starts the conversation in chat instead.
    if (config.calls.enabled) registerCalls(sock);

    // ── pairing code (nicer than a QR on a headless host) ────
    if (!state.creds.registered && config.session.pairingNumber) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(config.session.pairingNumber);
          botState.pairingCode = code;
          setStatus('pairing');
          console.log(`\n📞 Pairing code for +${config.session.pairingNumber}: ${code}`);
          console.log('   WhatsApp → Linked devices → Link with phone number → enter the code\n');
        } catch (err) {
          console.error('Pairing code failed:', err.message);
        }
      }, 3500);
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        setQr(qr);
        try {
          const ascii = await QRCode.toString(qr, { type: 'terminal', small: true });
          console.log(ascii);
          await QRCode.toFile(config.paths.qr, qr, { width: 420, margin: 1 });
          console.log(`\n📸 QR ready — scan it, or open the dashboard: http://localhost:${config.server.port}`);
          console.log('   WhatsApp → Linked devices → Link a device\n');
        } catch (err) {
          console.error('QR render error:', err.message);
        }
      }

      if (connection === 'open') {
        this.reconnectAttempts = 0;
        clearQr();
        botState.connectedAt = new Date();
        botState.me = sock.user ? { id: sock.user.id, name: sock.user.name || sock.user.verifiedName } : null;
        this.status = 'online';
        this.connectedAt = new Date();
        setStatus('online');
        console.log(`\n✅ Connected as ${botState.me?.name || config.owner.name} (${botState.me?.id || 'unknown'})\n`);

        logEvent('connected', null, botState.me?.id || null);
        this.emitStatus({ type: 'open', me: botState.me });
      }

      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        clearQr();
        botState.lastError = lastDisconnect?.error?.message || String(reason);
        console.log(`🔴 Connection closed (${reason || 'unknown'})`);

        if (reason === baileys.DisconnectReason.loggedOut) {
          setStatus('stopped');
          this.status = 'stopped';
          console.log('❌ Logged out. Delete ./sessions and restart to scan again.');
          process.exit(0);
        }
        if (reason === baileys.DisconnectReason.connectionReplaced) {
          setStatus('stopped');
          this.status = 'stopped';
          console.log('❌ Session replaced by another WhatsApp Web session. Exiting to avoid a loop.');
          process.exit(0);
        }

        this.reconnectAttempts += 1;
        const delay = Math.min(30000, 1500 * 2 ** Math.min(5, this.reconnectAttempts));
        setStatus('reconnecting');
        this.status = 'reconnecting';
        console.log(`🔄 Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})…`);
        this.emitStatus({ type: 'close', reason });
        this.reconnectTimer = setTimeout(
          () => this.connect().catch((err) => console.error('Reconnect failed:', err.message)),
          delay
        );
        this.reconnectTimer.unref?.();
      }
    });

    // ── incoming messages ────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // Recorded before the filter on purpose: the JID shapes a contact writes
      // from are what a presence update must be addressed to, and they arrive on
      // every upsert, not only the ones we answer.
      for (const msg of messages || []) {
        noteInbound(msg);
        const stub = Number(msg?.messageStubType || 0);
        const params = msg?.messageStubParameters || [];
        if (stub === 2 || params.some((param) => /absent from node/i.test(String(param)))) {
          noteDecrypt('absentMessage', { id: msg?.key?.id || null });
        }
      }
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg?.message) {
          this.emitStatus({ type: 'ignored' });
          continue;
        }
        await this.emit(normalizeBaileys(msg));
      }
    });

    sock.ev.on('messages.update', async (updates) => {
      noteStatusUpdate(updates);
      try {
        await handleDeletedMessage(sock, updates);
      } catch (err) {
        console.error('Delete handler failed:', err.message);
      }
    });

    // Delivery/read receipts for our own messages. Observational: the handler
    // only records the timestamp, it does not answer anything.
    sock.ev.on('message-receipt.update', (receipts) => {
      noteStatusUpdate(receipts);
    });

    // Contacts/groups/receipts: nothing to do, but don't let them bubble up
    sock.ev.on('groups.upsert', () => {});
    sock.ev.on('messages.reaction', () => {});

    return sock;
  }

  async disconnect() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.sock?.end?.();
    } catch {
      /* already gone */
    }
    this.status = 'stopped';
  }

  // ── sending ───────────────────────────────────────────────
  async send(jid, payload = {}) {
    if (!this.sock) throw new Error('baileys: not connected');
    const sent = await this.sock.sendMessage(jid, payload);
    // Remember the id so `messages.update` can be matched to a recipient and a
    // send time later. The payload itself is not kept.
    noteOutbound({ id: sent?.key?.id, jid, at: Date.now() });
    return sent;
  }

  async sendVoice(jid, { buffer, mimetype = 'audio/ogg; codecs=opus', seconds = 0 } = {}) {
    return this.send(jid, { audio: buffer, mimetype, ptt: true, seconds });
  }

  async sendMedia(jid, { kind = 'image', buffer, mimetype, caption = '', fileName, ptt = false } = {}) {
    if (kind === 'document') return this.send(jid, { document: buffer, mimetype, fileName, caption });
    if (kind === 'audio') return this.send(jid, { audio: buffer, mimetype, ptt, caption });
    if (kind === 'video') return this.send(jid, { video: buffer, mimetype, caption });
    return this.send(jid, { image: buffer, mimetype, caption });
  }

  async markRead(keys = []) {
    if (!this.sock || !keys.length) return;
    await this.sock.readMessages(keys);
  }

  /**
   * Some accounts only honour presence for a chat the device is subscribed to.
   * `.typing-test` variant b exists because of that; this is the method it (and
   * `typing.strategy = b`) calls.
   */
  async presenceSubscribe(jid) {
    if (typeof this.sock?.presenceSubscribe !== 'function') return null;
    return this.sock.presenceSubscribe(jid);
  }

  async setPresence(jid, state = 'paused') {
    try {
      await this.sock?.sendPresenceUpdate(state, jid);
      noteTyping({ jid, state, via: 'setPresence', sock: this, ok: true });
    } catch (err) {
      noteTyping({ jid, state, via: 'setPresence', sock: this, ok: false, error: err?.message });
      /* presence is cosmetic */
    }
  }

  async deleteMessage(jid, key) {
    return this.send(jid, { delete: key });
  }

  /** Download whatever a customer sent. */
  async getMedia(incoming) {
    const raw = incoming?.raw;
    if (!raw) throw new Error('baileys: nothing to download');
    const info = describeMessage(raw);
    return downloadMedia(raw, info);
  }

  /** Chat kind from a JID — used only to refuse groups early. */
  chatKind(jid) {
    return chatKind(jid);
  }
}

export { media as baileysMedia, jidToNumber };
export default BaileysTransport;
