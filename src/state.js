// src/state.js
// Live runtime state, shared by the dashboard and the WhatsApp connection.

export const botState = {
  status: 'starting', // starting | waiting_for_qr | pairing | connecting | online | reconnecting | stopped
  qr: null, // raw QR string from Baileys
  qrDataUrl: null, // PNG data URL for the dashboard
  pairingCode: null,
  connectedAt: null,
  startedAt: new Date(),
  lastError: null,
  me: null, // { id, name }
  stats: { received: 0, replied: 0, ignored: 0 },
  lastEvent: null,
};

export function setStatus(status, extra = {}) {
  botState.status = status;
  Object.assign(botState, extra);
}

export function bumpStat(key, by = 1) {
  if (botState.stats[key] === undefined) botState.stats[key] = 0;
  botState.stats[key] += by;
}

export function setQr(qr) {
  botState.qr = qr;
  botState.qrDataUrl = null; // server re-renders on demand
  botState.pairingCode = null;
  botState.status = 'waiting_for_qr';
}

export function clearQr() {
  botState.qr = null;
  botState.qrDataUrl = null;
  botState.pairingCode = null;
}

export function uptimeMinutes() {
  return Math.floor((Date.now() - new Date(botState.startedAt).getTime()) / 60000);
}

export default botState;
