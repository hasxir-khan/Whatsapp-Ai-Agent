// src/transport/index.js
// Which transport is this process using, and where do webhooks find it?
//
// Exactly one transport is active per process. The registry exists for the
// Cloud API case, where several tenants may share one public port and each of
// them owns a path (/webhook/<slug>).

import { config } from '../config/env.js';
import { featureOn } from '../services/profile.js';
import { TransportError } from './base.js';
import { BaileysTransport } from './baileys.js';
import { CloudTransport } from './cloud.js';

const registry = new Map(); // slug -> transport
let current = null;

export function registerTransport(transport, { makeCurrent = true } = {}) {
  if (!transport?.slug) throw new Error('transport needs a slug');
  registry.set(transport.slug, transport);
  if (makeCurrent) current = transport;
  return transport;
}

export function getTransport() {
  return current;
}

export function transportFor(slug) {
  return registry.get(slug) || null;
}

export function transports() {
  return [...registry.values()];
}

export function clearTransports() {
  registry.clear();
  current = null;
}

/** The launch switch: TRANSPORT=cloud, plus the cloudApi flag. */
export function transportKind() {
  return config.transport;
}

export function cloudReady() {
  return !!(config.cloud.phoneId && config.cloud.token && config.cloud.verifyToken && config.cloud.appSecret);
}

/**
 * Build the transport this process should use.
 * @param {{kind?:string, sock?:object}} options
 */
export function createTransport({ kind = config.transport, sock = null } = {}) {
  if (kind === 'cloud') {
    if (!featureOn('cloudApi')) {
      throw new TransportError(
        'TRANSPORT=cloud is set but features.cloudApi is off.\\n' +
          'Turn it on once: .set features.cloudApi true   (or set "cloudApi": true in config/owner.json)',
        { code: 'flag_off', permanent: true }
      );
    }
    if (!cloudReady()) {
      throw new TransportError(
        'Cloud transport needs CLOUD_PHONE_ID, CLOUD_TOKEN, CLOUD_VERIFY_TOKEN and CLOUD_APP_SECRET.\\n' +
          'Run node scripts/doctor.js to see which one is missing.',
        { code: 'cloud_not_configured', permanent: true }
      );
    }
    return registerTransport(new CloudTransport());
  }

  // Baileys: unchanged behaviour. If a socket is passed in we wrap it instead
  // of opening a second connection.
  const transport = sock ? BaileysTransport.wrap(sock) : new BaileysTransport();
  return registerTransport(transport);
}

export { BaileysTransport, CloudTransport };
export default { createTransport, getTransport, transportFor, transports, registerTransport, clearTransports, transportKind, cloudReady };
