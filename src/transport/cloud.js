// src/transport/cloud.js
// WhatsApp Cloud API (Meta's official endpoint), behind the same interface.
//
// The parts that are genuinely different from Baileys — and therefore the
// parts that need care rather than translation:
//
//   • there is no socket: messages arrive as webhooks, so the transport owns
//     signature verification and the tenant's webhook path
//   • media is not in the payload: it is fetched from the Graph API by id
//   • Meta only allows free-form messages inside a 24-hour window that the
//     *customer* opens. Outside it, only an approved template goes through.
//     Anything else is held and the owner is told — never dropped silently.

import crypto from 'node:crypto';
import { config } from '../config/env.js';
import * as db from '../utils/db.js';
import { TransportError, Transport, normalizeIncoming, jidToNumber, numberToJid } from './base.js';

export const GRAPH_VERSION = 'v21.0';
export const GRAPH_BASE = 'https://graph.facebook.com';

const WINDOW_MS = 24 * 60 * 60 * 1000;

export const CLOUD_CAPABILITIES = {
  text: true,
  voice: true, // audio messages; the cloud API drops the "ptt" flag
  image: true,
  video: true,
  document: true,
  mediaDownload: true,
  markRead: true,
  // No presence protocol on the Cloud API. Typing still exists — it rides on
  // the read receipt (POST /messages with status=read + typing_indicator) — so
  // it has its own capability flag rather than pretending to be presence.
  presence: false,
  typingIndicator: true,
  typingMaxSeconds: 25, // Meta drops the label after 25 s; the call must repeat
  typingKinds: ['text'], // 'recording' has no Cloud equivalent
  deleteMessage: false, // you cannot unsend on the Cloud API
  deliveryReceipts: true,
  templates: true,
  callEvents: false, // calls never reach the Cloud API
  deletedMessages: false, // no "delete for everyone" event
  groups: false, // the Cloud API does not deliver group messages at all
  reactions: false,
  maxMediaBytes: 100 * 1024 * 1024,
};

// ── signature verification ─────────────────────────────────
export function signBody(rawBody, appSecret) {
  return `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

export function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return false;
  if (!header) return false;
  const expected = signBody(rawBody, appSecret);
  const a = Buffer.from(String(header));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── webhook payload → internal messages ────────────────────
const TYPE_MAP = {
  text: 'text',
  image: 'image',
  video: 'video',
  audio: 'voice',
  document: 'document',
  sticker: 'sticker',
  location: 'location',
  contacts: 'contact',
  reaction: 'reaction',
  button: 'text',
  interactive: 'text',
  order: 'text',
  system: 'protocol',
  unsupported: 'other',
};

/**
 * Click-to-WhatsApp: the first message from someone who tapped an ad carries a
 * `referral` object. We keep the headline and the source url — enough to say
 * "the Eid ad brought 12 people" — and deliberately drop `ctwa_clid`, which is
 * a per-click identifier with no use outside Meta's own reporting.
 */
export function normalizeReferral(referral) {
  if (!referral || typeof referral !== 'object') return null;
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const out = {
    sourceUrl: clean(referral.source_url),
    sourceType: clean(referral.source_type),
    headline: clean(referral.headline),
    body: clean(referral.body),
    // Only whether it was there, never the value.
    hasClickId: Boolean(referral.ctwa_clid),
  };
  if (!out.sourceUrl && !out.headline && !out.sourceType) return null;
  return out;
}

/** One Cloud API `message` object → our normalised shape. */
export function normalizeCloudMessage(message = {}, { pushName = null } = {}) {
  const kind = TYPE_MAP[message.type] || 'other';
  const text =
    message.text?.body ||
    message.button?.text ||
    message.interactive?.button_reply?.title ||
    message.interactive?.list_reply?.title ||
    message.order?.catalog_id ||
    '';

  const mediaNode = message.image || message.video || message.document || message.audio || message.sticker || null;
  const caption = mediaNode?.caption || '';

  return normalizeIncoming({
    id: message.id || null,
    chat: numberToJid(message.from || ''),
    number: message.from || '',
    fromMe: false,
    pushName,
    kind,
    text: caption || text,
    caption,
    mimetype: mediaNode?.mime_type || '',
    fileName: message.document?.filename || '',
    seconds: 0,
    isVoice: !!message.audio?.voice,
    location: message.location
      ? { lat: message.location.latitude, lng: message.location.longitude, name: message.location.name || '' }
      : null,
    contactName: message.contacts?.[0]?.name?.formatted_name || null,
    timestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString(),
    mediaRef: mediaNode ? { mediaId: mediaNode.id, kind, mimetype: mediaNode.mime_type } : null,
    referral: normalizeReferral(message.referral),
    raw: message,
  });
}

export class CloudTransport extends Transport {
  constructor({
    slug = config.tenant.slug,
    phoneId = config.cloud.phoneId,
    token = config.cloud.token,
    verifyToken = config.cloud.verifyToken,
    appSecret = config.cloud.appSecret,
    apiVersion = config.cloud.apiVersion || GRAPH_VERSION,
    template = config.cloud.template,
    fetchImpl = null,
    now = () => Date.now(),
  } = {}) {
    super({ kind: 'cloud', capabilities: CLOUD_CAPABILITIES, slug });
    this.phoneId = phoneId;
    this.token = token;
    this.verifyToken = verifyToken;
    this.appSecret = appSecret;
    this.apiVersion = apiVersion;
    this.template = template || null;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.webhookPath = `/webhook/${slug}`;
    this.lastError = null;
    this.notified = [];
  }

  // ── lifecycle ────────────────────────────────────────────
  async connect() {
    if (!this.phoneId || !this.token) {
      throw new TransportError(
        'cloud: CLOUD_PHONE_ID and CLOUD_TOKEN are required (see README → Switching to the official Cloud API)',
        { code: 'cloud_not_configured', permanent: true }
      );
    }
    if (!this.appSecret) {
      throw new TransportError('cloud: CLOUD_APP_SECRET is required to verify webhooks — refusing to run unsigned', {
        code: 'cloud_no_secret',
        permanent: true,
      });
    }
    this.status = 'online';
    this.connectedAt = new Date();
    // The token never goes into a log line. Not even a fragment of it.
    console.log(`☁️  Cloud API ready · tenant ${this.slug} · phone id ${this.phoneId} · ${this.webhookPath}`);
    this.emitStatus({ type: 'open', mode: 'webhook', path: this.webhookPath });
    return this;
  }

  async disconnect() {
    this.status = 'stopped';
  }

  get user() {
    return { id: this.phoneId || null, name: config.bot.name };
  }

  // ── the 24-hour customer service window ──────────────────
  windowOpenedAt(number) {
    const row = db.cloudWindowGet(number);
    if (!row?.last_inbound) return null;
    const at = new Date(row.last_inbound).getTime();
    return Number.isFinite(at) ? at : null;
  }

  windowOpen(number) {
    const opened = this.windowOpenedAt(number);
    return !!opened && this.now() - opened < WINDOW_MS;
  }

  /** Hours left in the window, or 0. Shown in .status when it matters. */
  windowRemainingHours(number) {
    const opened = this.windowOpenedAt(number);
    if (!opened) return 0;
    return Math.max(0, (WINDOW_MS - (this.now() - opened)) / 3600000);
  }

  // ── webhook ──────────────────────────────────────────────
  /** GET /webhook/<slug>?hub.mode=subscribe&hub.verify_token=…&hub.challenge=… */
  verifyWebhook(query = {}) {
    const mode = query['hub.mode'] || query.hub_mode;
    const token = query['hub.verify_token'] || query.hub_verify_token;
    const challenge = query['hub.challenge'] || query.hub_challenge;

    if (mode !== 'subscribe') return { status: 400, body: 'unknown mode' };
    if (!this.verifyToken || token !== this.verifyToken) {
      db.logEvent('cloud_webhook_rejected', null, { reason: 'bad verify token', slug: this.slug });
      return { status: 403, body: 'verification failed' };
    }
    return { status: 200, body: String(challenge ?? '') };
  }

  /**
   * POST /webhook/<slug>
   * @param {{rawBody:string, signature?:string, query?:object}} request
   */
  async handleWebhook({ rawBody = '', signature = '', headers = {} } = {}) {
    const sig = signature || headers['x-hub-signature-256'] || headers['X-Hub-Signature-256'];
    if (!verifySignature(rawBody, sig, this.appSecret)) {
      db.logEvent('cloud_webhook_rejected', null, { reason: 'bad signature', slug: this.slug });
      return { status: 401, body: 'invalid signature' };
    }

    let body;
    try {
      body = JSON.parse(rawBody || '{}');
    } catch {
      return { status: 400, body: 'invalid JSON' };
    }

    const { messages, statuses } = this.parseWebhook(body);

    for (const status of statuses) this.applyStatus(status);

    // Meta retries a webhook until it gets a 2xx, and a restart between "handled"
    // and "answered" used to mean the same customer got two replies. The id is
    // written to cloud_messages *before* the message is acted on, so the ledger
    // survives a restart and a retry is a no-op.
    let duplicates = 0;
    for (const message of messages) {
      if (message.id && db.cloudInboundSeen(message.id)) {
        duplicates += 1;
        db.logEvent('cloud_webhook_duplicate', message.number, { wa_id: message.id, slug: this.slug });
        continue;
      }
      if (message.id) db.cloudInboundMark(message.id, { tenant: this.slug, number: message.number });
      await this.emit(message);
    }

    if (!messages.length && !statuses.length) {
      db.logEvent('cloud_webhook_empty', null, { slug: this.slug });
    }
    return {
      status: 200,
      body: 'ok',
      messages: messages.length - duplicates,
      duplicates,
      statuses: statuses.length,
    };
  }

  /** Pull messages and statuses out of a Meta webhook body. */
  parseWebhook(body = {}) {
    const messages = [];
    const statuses = [];

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const pushName = value.contacts?.[0]?.profile?.name || null;

        for (const raw of value.messages || []) {
          const incoming = normalizeCloudMessage(raw, { pushName });
          if (!incoming.number) continue;

          // The customer wrote to us: the 24-hour window is open again, so
          // anything we had to hold for them can go out.
          db.cloudWindowTouch(incoming.number, incoming.timestamp);
          const released = db.releaseHeld(incoming.chat);
          if (released) {
            db.logEvent('cloud_held_released', incoming.number, { pending: released });
            console.log(`📤 Window reopened for +${incoming.number} — ${released} held message(s) queued`);
          }

          messages.push(incoming);
        }

        for (const raw of value.statuses || []) statuses.push(raw);
      }
    }

    return { messages, statuses };
  }

  /** delivered / read / failed → our records and the outbox. */
  applyStatus(status = {}) {
    const map = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed', deleted: 'failed' };
    const state = map[status.status] || status.status || 'unknown';
    const error = status.errors?.[0]
      ? `${status.errors[0].code}: ${status.errors[0].title || status.errors[0].message || 'error'}`
      : null;

    db.cloudMarkStatus(status.id, state, { error });
    db.logEvent('cloud_status', status.recipient_id || null, { status: state, error });
    this.emitStatus({ type: 'delivery', id: status.id, status: state, error });
    return state;
  }

  // ── sending ──────────────────────────────────────────────
  /** Turn a Baileys-style payload into a Cloud API message object. */
  async toCloudMessage(number, payload = {}) {
    if (payload.text) return { type: 'text', text: { preview_url: false, body: String(payload.text) } };

    if (payload.audio) {
      const media = await this.upload(payload.audio, payload.mimetype || 'audio/ogg; codecs=opus', 'voice.ogg');
      return { type: 'audio', audio: { id: media.id } };
    }
    if (payload.image) {
      const media = await this.upload(payload.image, payload.mimetype || 'image/jpeg', 'image.jpg');
      const image = { id: media.id };
      if (payload.caption) image.caption = String(payload.caption);
      return { type: 'image', image };
    }
    if (payload.video) {
      const media = await this.upload(payload.video, payload.mimetype || 'video/mp4', 'video.mp4');
      const video = { id: media.id };
      if (payload.caption) video.caption = String(payload.caption);
      return { type: 'video', video };
    }
    if (payload.document) {
      const media = await this.upload(
        payload.document,
        payload.mimetype || 'application/octet-stream',
        payload.fileName || 'file'
      );
      const document = { id: media.id, filename: payload.fileName || 'file' };
      if (payload.caption) document.caption = String(payload.caption);
      return { type: 'document', document };
    }
    if (payload.delete) {
      throw new TransportError('cloud: deleting messages is not supported by the Cloud API', {
        code: 'not_supported',
        permanent: true,
      });
    }
    if (payload.react) {
      throw new TransportError('cloud: reactions are not supported by this transport yet', {
        code: 'not_supported',
        permanent: true,
      });
    }

    throw new TransportError('cloud: empty or unsupported payload', { code: 'bad_payload', permanent: true });
  }

  async send(jid, payload = {}) {
    const number = jidToNumber(jid);
    if (!number) throw new TransportError(`cloud: no phone number in "${jid}"`, { code: 'bad_jid', permanent: true });

    const message = await this.toCloudMessage(number, payload);

    if (this.windowOpen(number)) {
      return this.postMessage(number, message, { kind: payloadKind(payload) });
    }
    return this.outsideWindow(number, jid, payload, message);
  }

  async sendVoice(jid, { buffer, mimetype = 'audio/ogg; codecs=opus' } = {}) {
    return this.send(jid, { audio: buffer, mimetype, ptt: true });
  }

  async sendMedia(jid, { kind = 'image', buffer, mimetype, caption = '', fileName } = {}) {
    if (kind === 'document') return this.send(jid, { document: buffer, mimetype, caption, fileName });
    if (kind === 'video') return this.send(jid, { video: buffer, mimetype, caption });
    if (kind === 'audio') return this.send(jid, { audio: buffer, mimetype });
    return this.send(jid, { image: buffer, mimetype, caption });
  }

  /**
   * Outside the 24-hour window: an approved template, or hold it and tell the
   * owner. Nothing is ever silently dropped.
   */
  async outsideWindow(number, jid, payload, message) {
    const template = this.templateMessage(payload);
    if (template) {
      const sent = await this.postMessage(number, template, { kind: 'template' });
      db.logEvent('cloud_template_sent', number, { template: this.template?.name });
      return sent;
    }

    const kind = payloadKind(payload);
    const row = db.holdOutbox(jid, payload, {
      kind,
      error: 'outside the 24-hour window — waiting for the customer to write',
    });
    db.logEvent('cloud_held', number, { kind, outbox: row?.id });

    await this.warn(
      `⏸ Couldn't message +${number} yet — the 24-hour window is closed.\n` +
        `Meta only allows an approved template until they write again.\n` +
        `It is queued and goes out automatically when they do.`
    );

    return { queued: true, held: true, window: 'closed', id: null, rowId: row?.id };
  }

  /** An approved template, if this tenant configured one. */
  templateMessage(payload = {}) {
    const t = this.template;
    if (!t?.name) return null;
    const body =
      payload.text ||
      payload.caption ||
      (payload.audio ? '[voice message]' : payload.document ? `[${payload.fileName || 'file'}]` : '');

    const components = body
      ? [
          {
            type: 'body',
            parameters: [{ type: 'text', text: String(body).slice(0, 1000) }],
          },
        ]
      : undefined;

    return {
      type: 'template',
      template: {
        name: t.name,
        language: { code: t.language || 'en' },
        ...(components ? { components } : {}),
      },
    };
  }

  /** Best-effort owner warning that cannot itself loop forever. */
  async warn(text) {
    this.notified.push({ text, at: new Date().toISOString() });
    console.warn(`⚠️  ${text.replace(/\n/g, ' ')}`);
    const ownerNumber = config.owner.number;
    if (!ownerNumber) return;
    try {
      const note = { type: 'text', text: { preview_url: false, body: text } };
      if (!this.windowOpen(ownerNumber)) return; // do not fight Meta, log instead
      await this.postMessage(ownerNumber, note, { kind: 'notice' });
    } catch (err) {
      db.logEvent('cloud_notice_failed', null, err.message);
    }
  }

  /** The actual Graph API call, with the token kept out of every log line. */
  async graph(path, { method = 'GET', body = null, raw = null, contentType = 'application/json' } = {}) {
    if (!this.token) throw new TransportError('cloud: CLOUD_TOKEN missing', { code: 'no_token', permanent: true });
    const doFetch = this.fetchImpl || globalThis.fetch;
    const url = `${GRAPH_BASE}/${this.apiVersion}/${String(path).replace(/^\//, '')}`;

    const headers = { Authorization: `Bearer ${this.token}` };
    if (contentType) headers['Content-Type'] = contentType;

    let res;
    try {
      res = await doFetch(url, { method, headers, body: raw || (body ? JSON.stringify(body) : undefined) });
    } catch (err) {
      // Network trouble is retryable — the outbox will pick it up.
      throw new TransportError(`cloud: network error (${err.message})`, { code: 'network', status: 503 });
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!res.ok) {
      const apiError = data?.error || {};
      const err = new TransportError(
        `cloud ${res.status}: ${apiError.message || text.slice(0, 200) || 'request failed'}`,
        {
          code: apiError.code || 'graph_error',
          // 401/403 = wrong token or permissions: retrying cannot help.
          permanent: res.status === 401 || res.status === 403 || res.status === 400,
          status: res.status,
        }
      );
      err.apiError = apiError;
      if (res.status === 401 || res.status === 403) {
        this.lastError = 'Cloud API rejected the token — check CLOUD_TOKEN and its permissions';
      }
      throw err;
    }

    this.lastError = null;
    return data || {};
  }

  async postMessage(number, message, { kind = 'text' } = {}) {
    const data = await this.graph(`${this.phoneId}/messages`, {
      method: 'POST',
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: number, ...message },
    });

    const id = data?.messages?.[0]?.id || null;
    if (id) db.cloudTrack({ waId: id, tenant: this.slug, number, kind });
    return { key: { id }, id, to: number, transport: 'cloud', kind };
  }

  /** Media upload: POST /{phone-id}/media (multipart), returns {id}. */
  async upload(buffer, mimetype, filename = 'file') {
    if (!buffer?.length) throw new TransportError('cloud: empty media buffer', { code: 'empty_media', permanent: true });
    const bound = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimetype);
    form.append('file', new Blob([bound], { type: mimetype }), filename);

    const data = await this.graph(`${this.phoneId}/media`, { method: 'POST', raw: form, contentType: null });
    if (!data?.id) throw new TransportError('cloud: media upload returned no id', { code: 'upload_failed', status: 502 });
    return { id: data.id };
  }

  /** Two-step Graph download: metadata → file URL → bytes. */
  async getMedia(incoming) {
    const ref = incoming?.mediaRef;
    if (!ref?.mediaId) throw new TransportError('cloud: nothing to download', { code: 'no_media', permanent: true });

    const meta = await this.graph(ref.mediaId, { method: 'GET' });
    if (!meta?.url) throw new TransportError('cloud: media url missing', { code: 'no_media_url' });

    const doFetch = this.fetchImpl || globalThis.fetch;
    const res = await doFetch(meta.url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new TransportError(`cloud: media download failed (${res.status})`, { status: res.status });

    const arrayBuffer = await res.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimetype: meta.mime_type || ref.mimetype || 'application/octet-stream',
    };
  }

  async markRead(keys = []) {
    const ids = keys
      .map((k) => (typeof k === 'string' ? k : k?.id))
      .filter(Boolean);
    for (const id of ids) {
      await this.graph(`${this.phoneId}/messages`, {
        method: 'POST',
        body: { messaging_product: 'whatsapp', status: 'read', message_id: id },
      });
    }
  }

  /** No presence protocol on the Cloud API: this stays a no-op. */
  async setPresence() {
    return null;
  }

  /**
   * Typing, the Cloud API way: mark the customer's message read *and* raise the
   * typing label in one call. Meta's documented shape is
   *   { messaging_product: 'whatsapp', status: 'read', message_id,
   *     typing_indicator: { type: 'text' } }
   * The label is dropped when the next message is sent, or after 25 s — so it
   * is refreshed while a slow reply is being written. There is no `paused`,
   * `available` or `recording`: those are accepted and ignored.
   *
   * @param {string} messageId the inbound wamid to acknowledge
   * @param {{state?:string}} [opts]
   * @returns {Promise<{sent:boolean, reason?:string}>}
   */
  async sendTypingIndicator(messageId = null, { state = 'composing' } = {}) {
    if (state !== 'composing') return { sent: false, reason: `cloud: no ${state} state` };
    if (!messageId) return { sent: false, reason: 'cloud: typing needs the inbound message id' };
    try {
      await this.graph(`${this.phoneId}/messages`, {
        method: 'POST',
        body: {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
          typing_indicator: { type: 'text' },
        },
      });
      return { sent: true };
    } catch (err) {
      // A cosmetic indicator must never fail a reply: record it, carry on.
      this.lastError = err.message;
      this.typingError = err.message;
      return { sent: false, reason: err.message };
    }
  }

  // ── Baileys-compatible spellings ─────────────────────────
  // humanizer.js and older call sites speak Baileys. These two lines mean the
  // rest of the bot does not need to know which transport is underneath.
  async sendPresenceUpdate() {
    // Presence is not part of the Cloud API; typing comes from the read receipt
    // above, which needs the message id that this call does not carry.
    return null;
  }

  async readMessages(keys = []) {
    return this.markRead(keys);
  }

  async deleteMessage() {
    throw new TransportError('cloud: deleting messages is not supported by the Cloud API', {
      code: 'not_supported',
      permanent: true,
    });
  }
}

function payloadKind(payload = {}) {
  if (payload.text) return 'text';
  if (payload.audio) return 'audio';
  if (payload.image) return 'image';
  if (payload.video) return 'video';
  if (payload.document) return 'document';
  return 'other';
}

export default CloudTransport;
