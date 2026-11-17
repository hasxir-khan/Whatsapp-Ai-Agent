// src/transport/base.js
// The one interface every transport implements, and the one shape every
// incoming message becomes.
//
// Two rules keep this small:
//   1. A transport speaks the payload vocabulary the rest of the bot already
//      uses ({text}, {audio}, {image}, {document}). Nothing above this layer
//      has to learn a new dialect to send a picture.
//   2. Everything above this layer sees normalised messages, never a Baileys
//      proto object and never a Meta webhook blob.

/** Names a transport may declare. Anything missing is treated as unsupported. */
export const CAPABILITY_NAMES = [
  'text',            // plain messages
  'voice',           // voice notes out (and in)
  'image',
  'video',
  'document',
  'mediaDownload',   // can fetch what a customer sent us
  'markRead',
  'presence',        // "typing…" indicators
  'deleteMessage',   // delete our own command bubble
  'deliveryReceipts',
  'templates',       // approved message templates (Cloud API)
  'callEvents',      // missed-call rescue
  'deletedMessages', // "delete for everyone" recovery
  'groups',          // never used by this bot, but honest about it
  'reactions',
  'maxMediaBytes',
];

/** Everything off; a transport turns on what it really does. */
export const NO_CAPABILITIES = {
  text: false,
  voice: false,
  image: false,
  video: false,
  document: false,
  mediaDownload: false,
  markRead: false,
  presence: false,
  deleteMessage: false,
  deliveryReceipts: false,
  templates: false,
  callEvents: false,
  deletedMessages: false,
  groups: false,
  reactions: false,
  maxMediaBytes: 16 * 1024 * 1024,
};

export class TransportError extends Error {
  constructor(message, { code = 'transport_error', permanent = false, status = null } = {}) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.permanent = permanent;
    this.status = status;
  }
}

/**
 * The internal message shape.
 *
 *   { id, chat, number, fromMe, pushName, kind, text, caption, mimetype,
 *     fileName, seconds, isVoice, location, contactName, timestamp, raw }
 *
 * `chat` is a JID-like string on purpose: memory, contacts and tools are keyed
 * by `<number>@s.whatsapp.net` today, and a transport switch must not rewrite
 * a customer's history.
 */
export function normalizeIncoming(partial = {}) {
  const chat = partial.chat || '';
  const number = String(partial.number || chat.split('@')[0] || '').replace(/[^\d]/g, '');
  return {
    id: partial.id || null,
    chat,
    number,
    fromMe: !!partial.fromMe,
    pushName: partial.pushName || null,
    kind: partial.kind || 'text',
    text: partial.text || '',
    caption: partial.caption || '',
    mimetype: partial.mimetype || '',
    fileName: partial.fileName || '',
    seconds: Number(partial.seconds) || 0,
    isVoice: !!partial.isVoice,
    location: partial.location || null,
    contactName: partial.contactName || null,
    timestamp: partial.timestamp || new Date().toISOString(),
    // What the transport needs to fetch media or quote the message later.
    mediaRef: partial.mediaRef || null,
    raw: partial.raw || null,
  };
}

/** JID → phone number, without assuming @s.whatsapp.net. */
export function jidToNumber(jid = '') {
  return String(jid).replace(/@.*$/, '').replace(/:\d+$/, '').replace(/[^\d]/g, '');
}

/** Number → JID, so cloud numbers look like Baileys numbers upstream. */
export function numberToJid(number = '') {
  return `${String(number).replace(/[^\d]/g, '')}@s.whatsapp.net`;
}

/** Human-readable capability line for .status / doctor. */
export function describeCapabilities(capabilities = {}) {
  const yes = [];
  const no = [];
  for (const [key, value] of Object.entries(capabilities)) {
    if (key === 'maxMediaBytes') continue;
    if (value === true) yes.push(key);
    else if (value === false) no.push(key);
  }
  return { supported: yes, unsupported: no };
}

/**
 * Base class: implements the bookkeeping every transport needs, so each
 * concrete transport only writes the parts that are actually different.
 */
export class Transport {
  constructor({ kind, capabilities = {}, slug = null } = {}) {
    this.kind = kind;
    this.slug = slug;
    this.capabilities = { ...NO_CAPABILITIES, ...capabilities };
    this.handlers = { message: [], status: [] };
    this.status = 'new';
    this.connectedAt = null;
  }

  can(name) {
    return this.capabilities[name] === true;
  }

  onMessage(handler) {
    if (typeof handler === 'function') this.handlers.message.push(handler);
    return () => {
      this.handlers.message = this.handlers.message.filter((h) => h !== handler);
    };
  }

  onStatus(handler) {
    if (typeof handler === 'function') this.handlers.status.push(handler);
    return () => {
      this.handlers.status = this.handlers.status.filter((h) => h !== handler);
    };
  }

  /** Hand a normalised message to everyone listening. Errors never escape. */
  async emit(incoming) {
    const normalised = normalizeIncoming(incoming);
    for (const handler of this.handlers.message) {
      try {
        await handler(normalised);
      } catch (err) {
        console.error(`[${this.kind}] message handler failed:`, err.message);
      }
    }
    return normalised;
  }

  emitStatus(event) {
    for (const handler of this.handlers.status) {
      try {
        handler(event);
      } catch {
        /* status is never worth a crash */
      }
    }
  }

  /** Subclasses must implement these. */
  async connect() {
    throw new TransportError(`${this.kind}: connect() not implemented`);
  }

  async send() {
    throw new TransportError(`${this.kind}: send() not implemented`);
  }

  /** Baileys calls it sendMessage; keeping the alias means existing code and
   *  the outbox keep working without a transport-shaped branch. */
  async sendMessage(jid, payload) {
    return this.send(jid, payload);
  }
}

export default { Transport, normalizeIncoming, CAPABILITY_NAMES, NO_CAPABILITIES, describeCapabilities, jidToNumber, numberToJid };
