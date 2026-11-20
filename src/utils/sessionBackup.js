// src/utils/sessionBackup.js
// The WhatsApp login, in a portable blob — and the guards that stop that blob
// from making things worse.
//
// Free hosts often wipe the disk on redeploy, which would log the bot out and
// force a new QR scan. This packs the whole session into one base64 blob you can
// paste into WA_SESSION and restore on the next boot.
//
// Two rules, both learned the hard way:
//
//   1. NEVER restore over a working session. The old code wrote every file from
//      WA_SESSION on every boot, unconditionally. A blob captured a week ago
//      would replace a session that had been re-linked and rotated since — the
//      phone keeps the new keys, the bot keeps the old ones, incoming messages
//      still decrypt and outgoing ones do not. That is precisely the "Waiting
//      for this message" symptom. Now the blob is applied only when the local
//      session is missing or corrupt; otherwise it is ignored and the log says
//      so.
//
//   2. A backup is only worth taking from a session that has actually
//      connected. `markSessionConnected()` writes a marker on every successful
//      open; `backupSession()` refuses to produce a blob for files that changed
//      since the last good connection, because those are unproven keys and a
//      backup of them is a trap.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from '../config/env.js';

const CREDS = 'creds.json';
const MARKER = 'connected.marker';

/** Is the restore guard on? `SESSION_RESTORE_GUARD=0` restores the old always-on behaviour. */
export function restoreGuardEnabled() {
  const raw = process.env.SESSION_RESTORE_GUARD;
  if (raw === undefined || raw === '') return true;
  return !['0', 'false', 'off', 'no'].includes(String(raw).toLowerCase());
}

/**
 * What is actually on disk?
 * @returns {{state:'missing'|'corrupt'|'healthy', reason:string, files:string[]}}
 */
export function sessionHealth(dir = config.paths.sessions) {
  let files = [];
  try {
    if (!fs.existsSync(dir)) return { state: 'missing', reason: 'no session folder', files };
    files = fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile());
  } catch (err) {
    return { state: 'missing', reason: `unreadable: ${err.message}`, files };
  }

  const credsFile = path.join(dir, CREDS);
  if (!files.includes(CREDS)) return { state: 'missing', reason: 'no creds.json', files };

  let creds;
  try {
    const raw = fs.readFileSync(credsFile, 'utf8');
    if (!raw.trim()) return { state: 'corrupt', reason: 'creds.json is empty', files };
    creds = JSON.parse(raw);
  } catch {
    return { state: 'corrupt', reason: 'creds.json is not valid JSON', files };
  }
  if (!creds || typeof creds !== 'object') return { state: 'corrupt', reason: 'creds.json is not an object', files };
  // A linked session always carries the account it is linked to and a noise key.
  const linked = Boolean(creds.me?.id || creds.registrationId || creds.noiseKey);
  if (!linked) return { state: 'corrupt', reason: 'creds.json has no account in it', files };
  return { state: 'healthy', reason: 'creds.json reads', files };
}

function markerPath(dir) {
  return path.join(dir, MARKER);
}

/** Called by the transport on every successful connection. */
export function markSessionConnected(dir = config.paths.sessions, { at = new Date(), user = null } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(markerPath(dir), JSON.stringify({ at: new Date(at).toISOString(), user: user || null }));
    return true;
  } catch {
    return false;
  }
}

export function sessionConnectedAt(dir = config.paths.sessions) {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath(dir), 'utf8'));
    const at = new Date(parsed.at);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}

/**
 * Has this session been proven? True when the marker exists and no auth file has
 * been written since — i.e. the keys we would be backing up are the keys that
 * last connected successfully.
 */
export function sessionVerified(dir = config.paths.sessions) {
  const connectedAt = sessionConnectedAt(dir);
  if (!connectedAt) return { verified: false, reason: 'no successful connection recorded' };
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name === MARKER) continue;
      const full = path.join(dir, name);
      if (!fs.statSync(full).isFile()) continue;
      if (fs.statSync(full).mtimeMs > connectedAt.getTime() + 1000) {
        return { verified: false, reason: `${name} changed after the last connection` };
      }
    }
  } catch {
    return { verified: false, reason: 'session folder unreadable' };
  }
  return { verified: true, connectedAt };
}

/**
 * Pack the session.
 * @param {{requireConnected?:boolean}} [options] when true (the safe default for
 *   anything automatic), an unverified session produces no blob at all.
 */
export function backupSession({ requireConnected = false, dir = config.paths.sessions } = {}) {
  if (!fs.existsSync(dir)) return null;
  if (requireConnected) {
    const check = sessionVerified(dir);
    if (!check.verified) return null;
  }

  const files = {};
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    if (name === MARKER) continue; // a local fact, not part of the login
    files[name] = fs.readFileSync(full).toString('base64');
  }
  if (!Object.keys(files).length) return null;

  const json = JSON.stringify(files);
  return zlib.gzipSync(Buffer.from(json, 'utf8')).toString('base64');
}

/**
 * Put a backup back — but only where it belongs.
 *
 * @returns {{restored:boolean, reason:string, source:'local'|'backup', state:string, forced?:true}}
 */
export function restoreSession(blob = config.session.backupEnv, { force = false, dir = config.paths.sessions } = {}) {
  const health = sessionHealth(dir);
  if (!blob) {
    return { restored: false, reason: 'no_blob', source: 'local', state: health.state };
  }

  if (!force && restoreGuardEnabled() && health.state === 'healthy') {
    // The loudest line in the log, because this is the case that used to
    // silently roll a working session back to an old one.
    console.log('🔐 Session: local login is healthy — WA_SESSION ignored (SESSION_RESTORE_GUARD=0 to force a restore)');
    return { restored: false, reason: 'local_healthy', source: 'local', state: health.state };
  }

  try {
    const json = zlib.gunzipSync(Buffer.from(blob, 'base64')).toString('utf8');
    const files = JSON.parse(json);
    if (!files || typeof files !== 'object' || !Object.keys(files).length) {
      return { restored: false, reason: 'blob_empty', source: 'local', state: health.state };
    }
    fs.mkdirSync(dir, { recursive: true });
    // Keep what we are about to overwrite, so a mistaken restore is one `mv`
    // away from being undone.
    if (health.state !== 'missing') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      for (const name of health.files) {
        if (name.startsWith('before-restore-')) continue;
        try {
          fs.copyFileSync(path.join(dir, name), path.join(dir, `before-restore-${stamp}-${name}`));
        } catch {
          /* a copy we cannot make does not block the restore */
        }
      }
    }
    for (const [name, b64] of Object.entries(files)) {
      if (name.includes('/') || name.includes('..')) continue; // path safety
      fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
    }
    // The restored files are unproven until the next successful connection.
    try {
      fs.rmSync(markerPath(dir), { force: true });
    } catch {
      /* ignore */
    }
    console.log(
      `🔐 Session restored from WA_SESSION (${Object.keys(files).length} files) — local state was ${health.state}: ${health.reason}`
    );
    return { restored: true, reason: 'restored', source: 'backup', state: health.state };
  } catch (err) {
    console.error('⚠️  Could not restore WA_SESSION:', err.message);
    return { restored: false, reason: `bad_blob: ${err.message}`, source: 'local', state: health.state };
  }
}

export function sessionFiles(dir = config.paths.sessions) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('before-restore-'));
  } catch {
    return [];
  }
}

/** One line for `.health` / doctor: which session is in use, and is it proven. */
export function sessionSummary(dir = config.paths.sessions) {
  const health = sessionHealth(dir);
  const verified = sessionVerified(dir);
  const connected = sessionConnectedAt(dir);
  return {
    ...health,
    verified: verified.verified,
    verifiedReason: verified.reason || null,
    connectedAt: connected ? connected.toISOString() : null,
    line:
      health.state === 'healthy'
        ? `Session: healthy${verified.verified ? ' · verified by a successful connection' : ` · UNVERIFIED (${verified.reason})`}`
        : `Session: ${health.state} (${health.reason}) — link with .qr`,
  };
}

export default {
  backupSession,
  restoreSession,
  sessionFiles,
  sessionHealth,
  sessionSummary,
  sessionVerified,
  sessionConnectedAt,
  markSessionConnected,
  restoreGuardEnabled,
};
