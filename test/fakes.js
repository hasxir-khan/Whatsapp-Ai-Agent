// test/fakes.js
// Fakes with the REAL shapes.
//
// The typing bug survived because a fake exposed `sendPresenceUpdate` on the
// object the pipeline passed to it, while the real pipeline passes a
// *transport* — whose presence method is `setPresence(jid, state)`. The fake
// was easier to satisfy than reality, so it proved nothing.
//
// These two fakes mirror the two real shapes:
//   createFakeSocket()     — what Baileys' socket looks like: state first
//   createFakeTransport()  — what our transports look like: JID first, and it
//                            forwards to a socket in the state-first order
//
// `assertContract` in test/65-typing-fix.test.js checks both against the real
// classes, so a fake that drifts away from reality fails the suite.

/** A Baileys-shaped socket: `sendPresenceUpdate(state, jid)`, nothing else. */
export function createFakeSocket({ throwOnPresence = false } = {}) {
  const calls = [];
  const socket = {
    calls,
    user: { id: '923001234567:1@s.whatsapp.net', name: 'Test' },
    async sendMessage(jid, payload) {
      calls.push({ kind: 'message', jid, payload });
      return { key: { id: `wamid-${calls.length}`, remoteJid: jid } };
    },
    /** The real signature. `state` first. */
    async sendPresenceUpdate(state, jid) {
      if (throwOnPresence) throw new Error('presence refused');
      calls.push({ kind: 'presence', state, jid: jid ?? null });
      return { ok: true };
    },
    async presenceSubscribe(jid) {
      calls.push({ kind: 'subscribe', jid });
      return { ok: true };
    },
    async readMessages(keys) {
      calls.push({ kind: 'read', keys });
    },
    ev: { on() {}, off() {} },
    end() {},
    presence(kind, jid) {
      calls.push({ kind: 'presence-update', state: kind, jid });
    },
  };
  return socket;
}

/**
 * A transport-shaped fake: `setPresence(jid, state)`, forwarding to a socket as
 * `sendPresenceUpdate(state, jid)` — which is what the real BaileysTransport
 * does, and what makes the argument order observable at both layers.
 */
export function createFakeTransport({ sock = null, throwOnPresence = false } = {}) {
  const socket = sock || createFakeSocket({ throwOnPresence });
  const calls = [];
  const transport = {
    kind: 'fake',
    slug: 'fake',
    capabilities: { presence: true, typingIndicator: false, text: true },
    calls,
    sock: socket,
    can(name) {
      return Boolean(this.capabilities[name]);
    },
    async send(jid, payload) {
      calls.push({ kind: 'send', jid, payload });
      return socket.sendMessage(jid, payload);
    },
    async sendMessage(jid, payload) {
      return this.send(jid, payload);
    },
    /** The real signature. `jid` first — the whole point. */
    async setPresence(jid, state = 'paused') {
      calls.push({ kind: 'setPresence', jid, state });
      if (throwOnPresence) throw new Error('presence refused');
      return socket.sendPresenceUpdate(state, jid);
    },
    async presenceSubscribe(jid) {
      calls.push({ kind: 'subscribe', jid });
      return socket.presenceSubscribe(jid);
    },
    async markRead(keys) {
      calls.push({ kind: 'read', keys });
      return socket.readMessages(keys);
    },
    onMessage() {
      return () => {};
    },
    onStatus() {
      return () => {};
    },
  };
  return transport;
}

/** Presence calls recorded on either fake, in order. */
export function presenceCalls(target) {
  return (target?.calls || []).filter((c) => c.kind === 'presence' || c.kind === 'setPresence');
}
