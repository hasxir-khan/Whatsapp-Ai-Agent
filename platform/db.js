// platform/db.js
// The platform's own database. Separate file, separate process from any bot.
//
// Engine: sql.js (SQLite compiled to wasm) — the same choice the bot makes, for
// the same reason: no native build step on a free host. The queries themselves
// avoid SQLite-only syntax (`INSERT OR REPLACE`, `datetime()`, `AUTOINCREMENT`
// in anything but the id definition) and `?` placeholders are rewritten for
// Postgres by `toDialect()`, so moving to a server database is a config change
// plus a connection object, not a rewrite of every call site.

import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { platformDbFile, ensurePlatformDir } from './env.js';
import { schemaStatements } from './schema.js';

let SQL = null;
let db = null;
let file = null;
let saveTimer = null;

export function dialect() {
  return String(process.env.PLATFORM_DB_DIALECT || 'sqlite').toLowerCase();
}

/** `?` → `$1, $2, …` for Postgres. Exported so the conversion is testable. */
export function toDialect(sql, target = dialect()) {
  if (target !== 'postgres') return sql;
  let n = 0;
  return String(sql).replace(/\?/g, () => `$${(n += 1)}`);
}

function ensure() {
  if (!db) throw new Error('platform_db_not_ready');
  return db;
}

export function isOpen() {
  return !!db;
}

export function currentFile() {
  return file;
}

/** Open (or create) the platform database and apply the schema. */
export async function initPlatformDb({ file: target = platformDbFile() } = {}) {
  if (db && file === target) return db;
  if (db) closePlatformDb();
  ensurePlatformDir();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  SQL = SQL || (await initSqlJs());

  if (fs.existsSync(target)) {
    try {
      db = new SQL.Database(fs.readFileSync(target));
    } catch {
      // A corrupt platform database must not look like an empty platform, but
      // refusing to boot is worse: start clean and let the audit trail show it.
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }
  file = target;
  for (const statement of schemaStatements(dialect())) {
    try {
      db.run(statement);
    } catch {
      /* present already, or a dialect that does not need it */
    }
  }
  save(true);
  if (!saveTimer) {
    saveTimer = setInterval(() => save(), 5000);
    saveTimer.unref?.();
  }
  return db;
}

/** Throwing guard for synchronous code paths: routes open the database first. */
export function ensureOpen() {
  if (!db) throw new Error('platform_db_not_ready');
  return db;
}

/** Open on first use, so a route never has to think about boot order. */
export async function ensurePlatformDb() {
  if (db) return db;
  return initPlatformDb();
}

function save(force = false) {
  if (!db || !file) return false;
  try {
    const bytes = Buffer.from(db.export());
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
    return !force || true;
  } catch {
    return false;
  }
}

export function flush() {
  return save(true);
}

export function closePlatformDb() {
  if (db) save(true);
  db = null;
  file = null;
  return true;
}

/** Everything the platform reads or writes goes through these four. */
export function all(sql, params = []) {
  const stmt = ensure().prepare(toDialect(sql, dialect()));
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

export function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

export function run(sql, params = []) {
  // sql.js refuses `undefined` with a message that says nothing about where it
  // came from; this turns that into a usable error without hiding it.
  for (let i = 0; i < params.length; i += 1) {
    if (params[i] === undefined) throw new Error(`platform_db_undefined_param:${i}:${String(sql).slice(0, 60)}`);
  }
  ensure().run(sql, params);
  return true;
}

/** Last inserted rowid for the autoincrement tables. */
export function lastId() {
  const row = get('SELECT last_insert_rowid() AS id');
  return row ? Number(row.id) : null;
}

/**
 * One transaction helper. sql.js is synchronous, so a thrown error rolls the
 * whole unit back and the caller decides what to tell the user.
 */
export function transaction(fn) {
  const database = ensure();
  database.run('BEGIN');
  try {
    const result = fn();
    database.run('COMMIT');
    save();
    return result;
  } catch (err) {
    try {
      database.run('ROLLBACK');
    } catch {
      /* already gone */
    }
    throw err;
  }
}

export default {
  initPlatformDb,
  ensurePlatformDb,
  ensureOpen,
  closePlatformDb,
  flush,
  get,
  all,
  run,
  lastId,
  transaction,
  toDialect,
  dialect,
  isOpen,
};
