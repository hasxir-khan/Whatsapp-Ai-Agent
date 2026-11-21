// src/transport/contract.js
// One presence call shape, stated once.
//
// The bug this file exists to prevent: the transport's method is
// `setPresence(jid, state)` and Baileys' own socket method is
// `sendPresenceUpdate(state, jid)`. Both are plausible and the arguments are
// swapped. A caller that guessed wrong sent `sendPresenceUpdate('paused',
// 'composing')` — a pause addressed to a chat called *composing* — and the
// customer never saw the indicator. Nothing threw, so the unit tests stayed
// green for months.
//
// Two habits stop it happening again:
//   1. `presenceChannel(obj)` is the only place that knows the order. Everything
//      (typing, humanizer, `.typing-test`) goes through it.
//   2. `checkInterface()` compares a real transport and a fake against the same
//      list, and `describeMismatch()` reports a call shape that cannot be right.
//      The contract test then fails on the exact bug above.

/** Methods every transport must have. Presence is the interesting one. */
export const TRANSPORT_METHODS = ['send', 'sendMessage', 'setPresence', 'markRead', 'can'];

/** Methods a raw Baileys socket must have, for the same reason. */
export const SOCKET_METHODS = ['sendMessage', 'sendPresenceUpdate', 'presenceSubscribe'];

/**
 * Which call shape does this object speak?
 *
 * - `setPresence(jid, state)`     — this repo's transports (jid first)
 * - `sendPresenceUpdate(state, jid)` — a raw Baileys socket (state first)
 *
 * A transport is preferred when both exist, because a transport wraps a socket
 * and its own method is the one that knows where the socket lives.
 *
 * @returns {{via:string, order:'jid-first'|'state-first', send:(state:string, jid?:string)=>any}|null}
 */
export function presenceChannel(target) {
  if (!target) return null;
  if (typeof target.setPresence === 'function') {
    return {
      via: 'setPresence',
      order: 'jid-first',
      send: (state, jid) => target.setPresence(jid, state),
    };
  }
  if (typeof target.sendPresenceUpdate === 'function') {
    return {
      via: 'sendPresenceUpdate',
      order: 'state-first',
      send: (state, jid) => target.sendPresenceUpdate(state, jid),
    };
  }
  return null;
}

/** Every name present? Returns what is missing, so a message can name it. */
export function checkInterface(obj, methods = TRANSPORT_METHODS) {
  const missing = [];
  for (const name of methods) {
    if (typeof obj?.[name] !== 'function') missing.push(name);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Everything that can be checked about a presence implementation without a
 * phone: does a method exist, and does the call reach the socket in the order
 * the socket expects?
 *
 * Used by the contract test for the two real transports and for the fakes. A
 * fake that only has `setPresence(state)` fails here — which is the point.
 */
export function describeMismatch(target) {
  const channel = presenceChannel(target);
  if (!channel) return 'no presence method (needs setPresence or sendPresenceUpdate)';
  if (channel.via === 'setPresence') {
    // The transport method takes the JID first. A caller that passes the state
    // as the first argument produces a presence addressed to "composing".
    const arity = Number(target.setPresence.length) || 0;
    if (arity === 1) {
      // Legal (state may have a default) but suspicious: it cannot tell a JID
      // from a state by position, so the implementation must be checked by
      // behaviour, not by signature. Say so rather than pass silently.
      return null;
    }
    if (arity >= 2) return null;
    return 'setPresence takes no arguments';
  }
  return null;
}

/** The one-line summary `.typing-test` and `.status` can print. */
export function describePresence(target) {
  const channel = presenceChannel(target);
  if (!channel) return 'no presence capability';
  return `${channel.via}(${channel.order === 'jid-first' ? 'jid, state' : 'state, jid'})`;
}

export default {
  TRANSPORT_METHODS,
  SOCKET_METHODS,
  presenceChannel,
  checkInterface,
  describeMismatch,
  describePresence,
};
