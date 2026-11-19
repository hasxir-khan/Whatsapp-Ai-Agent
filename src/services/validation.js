// src/services/validation.js
// One definition of "a tenant", shared by the admin panel, the CLI and backups.
//
// Before this file the admin panel had `SLUG_RE`, scripts/tenant.js had its own
// slightly different regex, and the backup writer trusted whatever it was
// given. Three answers to the same question is how a path escape gets in, so
// the rules live here once and every surface imports them.

import fs from 'node:fs';
import path from 'node:path';

export const SLUG_RE = /^[a-z0-9-]{2,40}$/;
export const PORT_MIN = 1024;
export const PORT_MAX = 65535;

export function validSlug(slug) {
  const s = String(slug || '');
  return SLUG_RE.test(s) && !s.startsWith('-') && !s.endsWith('-') && !s.includes('--');
}

/** A port a tenant may listen on: a number, unprivileged, and inside range. */
export function validPort(port, { min = PORT_MIN, max = PORT_MAX } = {}) {
  const n = Number(port);
  if (!Number.isInteger(n)) return false;
  return n >= min && n <= max;
}

/**
 * Resolve `...parts` inside `root` and refuse anything that lands outside it.
 * Throws instead of returning a path that "looks fine" — a caller that ignores
 * a boolean here would be the bug.
 */
export function resolveInside(root, ...parts) {
  const base = path.resolve(String(root));
  const target = path.resolve(base, ...parts.map(String));
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`refusing to touch ${target}: outside ${base}`);
  }
  return target;
}

/** mkdir -p with 0700 where the platform honours it. */
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows and some mounts: best effort, never fatal.
  }
  return dir;
}

/** Write a file that only the owner can read (0600 where supported). */
export function writePrivateFile(file, data) {
  ensurePrivateDir(path.dirname(file));
  fs.writeFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
  }
  return file;
}

/** Tighten a file that already exists (e.g. .env written by a wizard). */
export function tightenFile(file, mode = 0o600) {
  try {
    fs.chmodSync(file, mode);
  } catch {
    // best effort
  }
  return file;
}

export default { SLUG_RE, validSlug, validPort, resolveInside, ensurePrivateDir, writePrivateFile, tightenFile };
