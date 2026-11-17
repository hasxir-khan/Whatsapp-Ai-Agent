// src/utils/sessionBackup.js
// Free hosts often wipe the disk on redeploy, which would log the bot out and
// force a new QR scan. This packs the whole WhatsApp session into one
// base64 blob you can paste into an environment variable (WA_SESSION) and
// restore automatically on the next boot.
//
//   node scripts/session-backup.js          → prints the blob
//   WA_SESSION=<blob> npm start             → restores it before connecting

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from '../config/env.js';

export function backupSession() {
  const dir = config.paths.sessions;
  if (!fs.existsSync(dir)) return null;

  const files = {};
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    files[name] = fs.readFileSync(full).toString('base64');
  }
  if (!Object.keys(files).length) return null;

  const json = JSON.stringify(files);
  return zlib.gzipSync(Buffer.from(json, 'utf8')).toString('base64');
}

export function restoreSession(blob = config.session.backupEnv) {
  if (!blob) return false;
  const dir = config.paths.sessions;
  try {
    const json = zlib.gunzipSync(Buffer.from(blob, 'base64')).toString('utf8');
    const files = JSON.parse(json);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, b64] of Object.entries(files)) {
      if (name.includes('/') || name.includes('..')) continue; // path safety
      fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
    }
    console.log(`🔐 Session restored from WA_SESSION (${Object.keys(files).length} files)`);
    return true;
  } catch (err) {
    console.error('⚠️  Could not restore WA_SESSION:', err.message);
    return false;
  }
}

export function sessionFiles() {
  const dir = config.paths.sessions;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
}

export default { backupSession, restoreSession, sessionFiles };
