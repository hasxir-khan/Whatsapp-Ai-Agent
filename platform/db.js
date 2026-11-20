// platform/db.js
// The platform's own database. Separate file, separate process from any bot.
//
// Engine: sql.js (SQLite compiled to wasm) — the same choice the bot makes, for
// the same reason: no native build step on a free host. The queries themselves
// avoid SQLite-only syntax (`INSERT OR REPLACE`, `datetime()`, `AUTOINCREMENT`
// in anything but the id definition) and `?` placeholders are rewritten for
// Postgres by `toDialect()`, so moving to a server database is a config change
// plus a connection object, not a rewrite of every call site.

import { draftMetadata } from './draftMetadata.js';
import { writeTenantUndo } from '../src/services/adminPanel.js';
import { migrateNumbers } from './numberIdentity.js';
import { migrateReports } from './reportSchema.js';
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { platformDbFile, ensurePlatformDir } from './env.js';
import { schemaStatements, MIGRATIONS, PLAN_SEEDS, SCHEMA_VERSION } from './schema.js';

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

/** Operator tools inspect a snapshot without creating, migrating or periodically
 * flushing the live writer's file. The callback must complete synchronously. */
export async function readSnapshot(fn, target = platformDbFile()) {
  const engine = SQL || await initSqlJs();
  const copy = new engine.Database(fs.readFileSync(target));
  try {
    return fn((query, params = []) => {
      const stmt = copy.prepare(query), rows = [];
      try { stmt.bind(params); while (stmt.step()) rows.push(stmt.getAsObject()); return rows; }
      finally { stmt.free(); }
    });
  } finally { copy.close(); }
}

/** Open (or create) the platform database and apply the schema. */
export async function initPlatformDb({ file: target = platformDbFile() } = {}) {
  if (db && file === target) return db;
  if (db) closePlatformDb();
  ensurePlatformDir();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  SQL = SQL || (await initSqlJs());
  if (db && file === target) return db; // concurrent first request during WASM load

  if (fs.existsSync(target)) {
    db = new SQL.Database(fs.readFileSync(target));
  } else {
    db = new SQL.Database();
  }
  file = target;
  const version = Number(db.exec('PRAGMA user_version')[0]?.values[0][0]) || 0;
  db.run('PRAGMA secure_delete=ON');
  let compact = false;
  db.run('BEGIN');
  try {
    for (const statement of schemaStatements(dialect())) db.run(statement);
    if (version < 2) {
      for (const statement of MIGRATIONS) {
        try {
          db.run(statement);
        } catch (err) {
          if (!/duplicate column name/i.test(err.message)) throw err;
        }
      }
      // Upgrade the bundled Growth seed, not an operator's customised plan.
      const growth = PLAN_SEEDS.find((p) => p.id === 'growth').features;
      db.run("UPDATE plans SET features = ? WHERE id = 'growth' AND features = ?", [
        JSON.stringify(growth),
        JSON.stringify(growth.filter((f) => f !== 'conversationControl')),
      ]);
      // Pre-BYOK active rows cannot attest a key, compatibility run or sandbox turn.
      db.run("UPDATE tenants SET status = 'provisioned' WHERE status = 'active' AND test_chat_at IS NULL");
      db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    compact = migrateReports(db);
    migrateNumbers(db);
    for (const r of all(
      "SELECT slug,token,before FROM settings_undo WHERE before!='tenant-backup' ORDER BY created_at"
    )) {
      try {
        writeTenantUndo(r.slug, r.token, r.before);
      } catch (err) {
        if (err.message !== 'missing_profile') throw err;
        // An absent mount is not evidence that the customer was deleted.
        // Roll the upgrade back until their durable volume is available.
        if (get('SELECT 1 FROM tenants WHERE slug=?', [r.slug]))
          throw new Error('restore_tenant_volume_before_undo_migration');
        run('DELETE FROM settings_undo WHERE slug=? AND token=?', [r.slug, r.token]);
        compact = true;
        continue;
      }
      compact = true;
      run("UPDATE settings_undo SET before='tenant-backup' WHERE slug=? AND token=?", [r.slug, r.token]);
    }
    // Wizard values are already in the atomically written business profile.
    for (const r of all('SELECT slug,data FROM wizard_drafts')) {
      let old;
      try {
        old = JSON.parse(r.data);
      } catch {
        old = {};
      }
      const data = JSON.stringify(draftMetadata(old));
      if (r.data !== data) {
        run('UPDATE wizard_drafts SET data=? WHERE slug=?', [data, r.slug]);
        compact = true;
      }
    }
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    db.close();
    db = file = null;
    throw err;
  }
  // Rebuild legacy pages once; removed values must not persist on the freelist.
  if (compact) db.run('VACUUM');
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
    // sql.js reopens its connection on export, resetting connection pragmas.
    db.run('PRAGMA secure_delete=ON');
    fs.writeFileSync(file + '.tmp', bytes, { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
    return true;
  } catch {
    return false;
  }
}

export function flush() {
  return save(true);
}

export function closePlatformDb() {
  if (db) { save(true); db.close(); }
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
