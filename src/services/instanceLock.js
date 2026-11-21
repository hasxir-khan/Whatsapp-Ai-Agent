// src/services/instanceLock.js
// One process per session folder.
//
// Two bot processes on the same WhatsApp login fight over the same keys: both
// write `creds.json`, both send, and WhatsApp sees a session that keeps changing
// underneath it. The symptom is exactly the one in the bug report — incoming
// works, outgoing does not, and the other phone says *Waiting for this message*.
//
// So: a small lock file next to the session, holding the PID that owns it. A
// second process refuses to start. A lock left by a crashed process is detected
// (the PID is gone) and taken over.
//
// **What this cannot do**, and why the README says the same thing: a lock file on
// a disk sees processes on that disk. Two containers with two copies of the
// session folder — or a rolling deploy where old and new overlap — will not see
// each other. The lock is a safety net, not a substitute for running one
// replica, stopping the old one before starting the new one, and keeping the
// sessions folder on a persistent volume.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config/env.js';

const LOCK = 'session.lock';

/** Is the lock on? `SESSION_LOCK=0` disables it (not recommended). */
export function lockEnabled() {
  const raw = process.env.SESSION_LOCK;
  if (raw === undefined || raw === '') return true;
  return !['0', 'false', 'off', 'no'].includes(String(raw).toLowerCase());
}

export function lockPath(dir = config.paths.sessions) {
  return path.join(dir, LOCK);
}

/** Is this PID running on this machine right now? */
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return err?.code === 'EPERM';
  }
}

export function readLock(dir = config.paths.sessions) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Take the lock for this session folder.
 *
 * @returns {{ok:true, path:string, recovered?:boolean} | {ok:false, reason:string, holder:object|null, path:string}}
 */
export function acquireSessionLock({
  dir = config.paths.sessions,
  pid = process.pid,
  now = new Date(),
  staleMs = null,
} = {}) {
  const file = lockPath(dir);
  if (!lockEnabled()) return { ok: true, path: file, skipped: true };

  const stale = staleMs === null ? Number(process.env.SESSION_LOCK_STALE_MINUTES || 15) * 60_000 : staleMs;
  const existing = readLock(dir);

  if (existing && Number(existing.pid) !== Number(pid)) {
    const alive = existing.host && existing.host !== os.hostname() ? true : pidAlive(existing.pid);
    const age = existing.startedAt ? new Date(now).getTime() - new Date(existing.startedAt).getTime() : 0;
    const staleLock = !alive || (Number.isFinite(stale) && stale > 0 && age > stale && !alive);
    if (alive && !staleLock) {
      return { ok: false, reason: 'in_use', holder: existing, path: file };
    }
  }

  const record = {
    pid: Number(pid),
    host: os.hostname(),
    startedAt: new Date(now).toISOString(),
    transport: config.transport,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record));
    return { ok: true, path: file, recovered: Boolean(existing && Number(existing.pid) !== Number(pid)) };
  } catch (err) {
    // A folder we cannot write to is not a folder we can hold a lock in; the
    // session itself would fail a moment later anyway.
    return { ok: false, reason: `unwritable: ${err.message}`, holder: existing, path: file };
  }
}

/** Release only if we hold it: a crashed process releasing someone else's lock is worse than a stale file. */
export function releaseSessionLock({ dir = config.paths.sessions, pid = process.pid } = {}) {
  const existing = readLock(dir);
  if (!existing) return false;
  if (Number(existing.pid) !== Number(pid)) return false;
  try {
    fs.rmSync(lockPath(dir), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** A refusal a human can act on, printed once before we exit. */
export function lockRefusalMessage(holder = {}, file = lockPath()) {
  const since = holder.startedAt ? new Date(holder.startedAt).toLocaleString('en-GB') : 'unknown time';
  return [
    '🔒 Another process is already using this WhatsApp session.',
    `   pid ${holder.pid || '?'} on ${holder.host || 'this host'}, started ${since}`,
    `   Lock file: ${file}`,
    '',
    '   Two processes on one login fight over the same encryption keys, which is',
    '   what makes outgoing messages unreadable ("Waiting for this message").',
    '',
    '   • Is the bot already running?  pm2 list · systemctl status <service>',
    '   • Stop the other one, then start this one.',
    '   • If it crashed and left the lock behind, delete the file above.',
    '   • Deliberately running two? You need two numbers, not one session.',
  ].join('\n');
}

export default {
  lockEnabled,
  lockPath,
  readLock,
  pidAlive,
  acquireSessionLock,
  releaseSessionLock,
  lockRefusalMessage,
};
