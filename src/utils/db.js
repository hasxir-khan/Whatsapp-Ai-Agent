// src/utils/db.js
// Persistent local database (SQLite compiled to WebAssembly — no build tools,
// no native modules, works on any free host). Everything the assistant learns
// about a client lives here, so memory survives restarts and redeploys.

import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { config } from '../config/env.js';

let db = null;
let dirty = false;
let saveTimer = null;
let SQL = null;

const DB_FILE = path.join(config.paths.data, 'assistant.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  number            TEXT PRIMARY KEY,
  jid               TEXT,
  name              TEXT,
  push_name         TEXT,
  category          TEXT DEFAULT 'new',     -- new | lead | client | friend | owner | spam
  language          TEXT,
  locale            TEXT,                   -- e.g. en-US
  country           TEXT,
  currency          TEXT,
  stage             TEXT DEFAULT 'new',     -- new | discovering | quoted | negotiating | won | lost
  voice_pref        TEXT DEFAULT 'unknown', -- likes voice notes? yes | no | unknown
  message_count     INTEGER DEFAULT 0,
  spam_score        INTEGER DEFAULT 0,
  is_blocked        INTEGER DEFAULT 0,
  bot_paused_until  TEXT,
  tone              TEXT,                   -- formal | casual | neutral
  assigned_to       TEXT,                   -- team member handling this chat
  assigned_at       TEXT,
  notes             TEXT,
  first_seen        TEXT,
  last_seen         TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT,
  role        TEXT,          -- user | assistant | owner | system
  kind        TEXT,          -- text | voice | image | video | document | sticker | other
  content     TEXT,
  meta        TEXT,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_number ON messages(number, id);

CREATE TABLE IF NOT EXISTS seen_messages (
  msg_id      TEXT PRIMARY KEY,
  number      TEXT,
  kind        TEXT,
  body        TEXT,
  created_at  TEXT
);

CREATE TABLE IF NOT EXISTS facts (
  number      TEXT,
  key         TEXT,
  value       TEXT,
  updated_at  TEXT,
  PRIMARY KEY (number, key)
);

CREATE TABLE IF NOT EXISTS summaries (
  number      TEXT PRIMARY KEY,
  summary     TEXT,
  msg_count   INTEGER DEFAULT 0,
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS intake (
  number      TEXT PRIMARY KEY,
  stage       TEXT DEFAULT 'open',
  fields      TEXT,          -- JSON
  asked       TEXT,          -- JSON array of field ids already asked
  quote       TEXT,          -- JSON of last quote
  quoted_at   TEXT,
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS leads (
  number          TEXT PRIMARY KEY,
  name            TEXT,
  company         TEXT,
  country         TEXT,
  currency        TEXT,
  project_type    TEXT,
  goal            TEXT,
  features        TEXT,
  design          TEXT,
  content         TEXT,
  timeline        TEXT,
  budget          TEXT,
  tech            TEXT,
  extra           TEXT,
  quote_min       INTEGER,
  quote_max       INTEGER,
  quote_currency  TEXT,
  status          TEXT DEFAULT 'new',  -- new | qualified | quoted | negotiating | won | lost
  score           INTEGER DEFAULT 0,   -- 0-100 lead intelligence score
  priority        TEXT,                -- hot | warm | cold
  next_action     TEXT,                -- what to do next, in plain words
  notes           TEXT,
  created_at      TEXT,
  updated_at      TEXT
);

CREATE TABLE IF NOT EXISTS followups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT,
  due_at      TEXT,
  attempt     INTEGER DEFAULT 1,
  message     TEXT,
  status      TEXT DEFAULT 'pending', -- pending | sent | cancelled
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_followups_due ON followups(due_at, status);

CREATE TABLE IF NOT EXISTS pending (
  number      TEXT PRIMARY KEY,
  payload     TEXT,
  due_at      TEXT,
  created_at  TEXT
);

CREATE TABLE IF NOT EXISTS usage (
  day         TEXT PRIMARY KEY,
  llm_calls   INTEGER DEFAULT 0,
  llm_tokens  INTEGER DEFAULT 0,
  stt_seconds REAL DEFAULT 0,
  vision_calls INTEGER DEFAULT 0,
  tts_chars   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT,
  number      TEXT,
  detail      TEXT,
  created_at  TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  jid         TEXT,
  payload     TEXT,          -- JSON of what we tried to send
  kind        TEXT,          -- text | audio | document | media
  tries       INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'pending',   -- pending | sent | failed
  error       TEXT,
  created_at  TEXT,
  sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, id);

CREATE TABLE IF NOT EXISTS calls (
  id          TEXT PRIMARY KEY,
  number      TEXT,
  name        TEXT,
  video       INTEGER DEFAULT 0,
  status      TEXT,          -- offer | accepted | missed | rejected | handled
  outcome     TEXT,          -- what the assistant did about it
  created_at  TEXT,
  handled_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_created ON calls(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT
);

-- Learned business documents (menus, price sheets, policies, price lists).
-- Text is stored in Phase 1; the embedding column is filled by the Phase 2 RAG layer.
CREATE TABLE IF NOT EXISTS knowledge (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,            -- file:<name> | url:<url> | text:<label>
  title       TEXT,
  chunk_no    INTEGER NOT NULL DEFAULT 0,
  text        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  rules       TEXT,                     -- JSON: what was stripped/kept
  embedding   TEXT,                     -- reserved: JSON array of floats
  created_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_chunk ON knowledge(source, chunk_no);
CREATE INDEX IF NOT EXISTS idx_knowledge_hash ON knowledge(hash);

-- Tool calling (phase 2): every call is logged, side effects are idempotent.
CREATE TABLE IF NOT EXISTS tool_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant      TEXT,
  chat        TEXT,
  tool        TEXT,
  args        TEXT,
  result      TEXT,
  status      TEXT,          -- ok | error | needs_confirmation | rejected | cancelled | duplicate
  error       TEXT,
  ms          INTEGER,
  key         TEXT,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_created ON tool_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_chat ON tool_calls(chat, id);

CREATE TABLE IF NOT EXISTS tool_confirmations (
  token       TEXT PRIMARY KEY,
  tenant      TEXT,
  chat        TEXT,
  tool        TEXT,
  args        TEXT,          -- validated arguments, frozen at ask time
  summary     TEXT,
  status      TEXT DEFAULT 'pending',   -- pending | confirmed | cancelled | expired
  created_at  TEXT,
  expires_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_confirm_chat ON tool_confirmations(chat, status);

CREATE TABLE IF NOT EXISTS bookings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat        TEXT,
  service     TEXT,
  date        TEXT,
  time        TEXT,
  name        TEXT,
  notes       TEXT,
  status      TEXT DEFAULT 'booked',
  key         TEXT,
  created_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_key ON bookings(key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(service, date, time)
  WHERE status = 'booked';

CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat        TEXT,
  items       TEXT,
  total       INTEGER,
  currency    TEXT,
  name        TEXT,
  phone       TEXT,
  address     TEXT,
  status      TEXT DEFAULT 'placed',
  key         TEXT,
  created_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_key ON orders(key);
`;

export async function initDB({ file = DB_FILE } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  SQL = await initSqlJs();

  if (fs.existsSync(file)) {
    try {
      db = new SQL.Database(fs.readFileSync(file));
      console.log('💾 Memory loaded from disk');
    } catch (err) {
      console.error(`⚠️  Corrupt database (${err.message}) — starting a fresh one`);
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
    console.log('💾 New memory created');
  }

  db.run('PRAGMA journal_mode = MEMORY;');
  db.run(SCHEMA);
  migrate();
  saveDB(true);

  // Persist regularly and on exit so a crash never loses a client conversation
  saveTimer = setInterval(() => saveDB(), 15000);
  saveTimer.unref?.();
  process.once('exit', () => saveDB(true));
  process.once('SIGINT', () => saveDB(true));
  process.once('SIGTERM', () => saveDB(true));

  return db;
}

/** Forward-only schema fixes for databases created by older versions. */
function migrate() {
  const columns = (table) => {
    try {
      return all(`PRAGMA table_info(${table})`).map((c) => c.name);
    } catch {
      return [];
    }
  };

  const add = (table, column, definition) => {
    if (columns(table).includes(column)) return;
    try {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`🔧 Migrated ${table}.${column}`);
    } catch (err) {
      console.error(`Migration ${table}.${column} failed:`, err.message);
    }
  };

  add('contacts', 'tone', 'TEXT');
  add('contacts', 'assigned_to', 'TEXT');
  add('contacts', 'assigned_at', 'TEXT');
  add('calls', 'video', 'INTEGER DEFAULT 0');
  add('calls', 'outcome', 'TEXT');
  add('leads', 'score', 'INTEGER DEFAULT 0');
  add('leads', 'priority', 'TEXT');
  add('leads', 'next_action', 'TEXT');
  add('knowledge', 'embedding_model', 'TEXT');
  add('knowledge', 'embedded_hash', 'TEXT');
}

export function getDB() {
  return db;
}

/** Write to the in-memory DB; persisted shortly after. */
export function run(sql, params = []) {
  if (!db) throw new Error('Database not initialised — call initDB() first');
  db.run(sql, params);
  dirty = true;
  if (!saveTimer) saveDB();
}

/** Rows as plain objects. */
export function all(sql, params = []) {
  if (!db) return [];
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

/** Single row or null. */
export function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

export function saveDB(force = false) {
  if (!db) return;
  if (!dirty && !force) return;
  try {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(db.export()));
    fs.renameSync(tmp, DB_FILE); // atomic — never leaves a half-written DB
    dirty = false;
  } catch (err) {
    console.error('DB save error:', err.message);
  }
}

export function startAutoSave() {
  if (saveTimer) return;
  saveTimer = setInterval(() => saveDB(), 15000);
  saveTimer.unref?.();
}

// ════════════════════════════════════════════════════════════
// Contacts
// ════════════════════════════════════════════════════════════
export function getContact(number) {
  return get('SELECT * FROM contacts WHERE number = ?', [number]);
}

export function upsertContact(number, data = {}) {
  const now = new Date().toISOString();
  const existing = getContact(number);

  if (existing) {
    const fields = [];
    const values = [];
    for (const key of [
      'jid', 'name', 'push_name', 'category', 'language', 'locale', 'country',
      'currency', 'stage', 'voice_pref', 'tone', 'assigned_to', 'assigned_at',
      'notes', 'bot_paused_until',
    ]) {
      if (data[key] !== undefined && data[key] !== null) {
        fields.push(`${key} = ?`);
        values.push(data[key]);
      }
    }
    if (data.spam_score !== undefined) { fields.push('spam_score = ?'); values.push(data.spam_score); }
    if (data.is_blocked !== undefined) { fields.push('is_blocked = ?'); values.push(data.is_blocked ? 1 : 0); }
    if (data.increment_messages) { fields.push('message_count = message_count + 1'); }
    fields.push('last_seen = ?');
    values.push(now, number);
    if (fields.length > 1) run(`UPDATE contacts SET ${fields.join(', ')} WHERE number = ?`, values);
    return getContact(number);
  }

  run(
    `INSERT INTO contacts
      (number, jid, name, push_name, category, language, locale, country, currency,
       stage, voice_pref, message_count, spam_score, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      number,
      data.jid || null,
      data.name || null,
      data.push_name || null,
      data.category || 'new',
      data.language || null,
      data.locale || null,
      data.country || null,
      data.currency || null,
      data.stage || 'new',
      data.voice_pref || 'unknown',
      1,
      data.spam_score || 0,
      now,
      now,
    ]
  );
  return getContact(number);
}

export function setContactPaused(number, untilIso) {
  // Works even for a number we have never seen before (e.g. `.pause 92300…`)
  const exists = get('SELECT number FROM contacts WHERE number = ?', [number]);
  if (!exists) upsertContact(number, { jid: `${number}@s.whatsapp.net` });
  run('UPDATE contacts SET bot_paused_until = ? WHERE number = ?', [untilIso, number]);
}

export function blockContact(number, blocked = true) {
  const exists = get('SELECT number FROM contacts WHERE number = ?', [number]);
  if (!exists) upsertContact(number, { jid: `${number}@s.whatsapp.net` });
  run('UPDATE contacts SET is_blocked = ?, category = ? WHERE number = ?', [
    blocked ? 1 : 0,
    blocked ? 'spam' : 'new',
    number,
  ]);
}

// ════════════════════════════════════════════════════════════
// Team (multi-operator)
// ════════════════════════════════════════════════════════════
export function assignContact(number, operator, minutes = null) {
  const now = new Date().toISOString();
  const exists = getContact(number);
  if (!exists) upsertContact(number, { jid: `${number}@s.whatsapp.net` });
  run('UPDATE contacts SET assigned_to = ?, assigned_at = ?, category = ? WHERE number = ?', [
    operator || null,
    operator ? now : null,
    operator ? 'client' : 'new',
    number,
  ]);
  if (minutes) setContactPaused(number, new Date(Date.now() + minutes * 60000).toISOString());
  return getContact(number);
}

export function contactsFor(operator, limit = 20) {
  return all(
    'SELECT * FROM contacts WHERE assigned_to = ? ORDER BY last_seen DESC LIMIT ?',
    [operator, limit]
  );
}

export function teamWorkload() {
  return all(
    `SELECT assigned_to AS operator, COUNT(*) AS chats,
            SUM(CASE WHEN last_seen > ? THEN 1 ELSE 0 END) AS active_today
       FROM contacts
      WHERE assigned_to IS NOT NULL AND assigned_to <> ''
      GROUP BY assigned_to
      ORDER BY chats DESC`,
    [new Date(Date.now() - 86400000).toISOString()]
  );
}

// ════════════════════════════════════════════════════════════
// Outbox — replies that could not be sent yet (offline / dropped)
// ════════════════════════════════════════════════════════════
export function enqueueOutbox(jid, payload, { kind = 'text', error = null } = {}) {
  run(
    'INSERT INTO outbox (jid, payload, kind, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [jid, JSON.stringify(payload), kind, 'pending', error, new Date().toISOString()]
  );
  const row = get("SELECT * FROM outbox WHERE status = 'pending' ORDER BY id DESC LIMIT 1");
  return row;
}

export function dueOutbox(limit = 25) {
  return all("SELECT * FROM outbox WHERE status = 'pending' ORDER BY id ASC LIMIT ?", [limit]);
}

export function updateOutbox(id, { status, error = null, bumpTries = false } = {}) {
  const sets = [];
  const values = [];
  if (status) {
    sets.push('status = ?');
    values.push(status);
  }
  if (status === 'sent') {
    sets.push('sent_at = ?');
    values.push(new Date().toISOString());
  }
  if (error !== null) {
    sets.push('error = ?');
    values.push(error);
  }
  if (bumpTries) sets.push('tries = tries + 1');
  if (!sets.length) return;
  values.push(id);
  run(`UPDATE outbox SET ${sets.join(', ')} WHERE id = ?`, values);
}

export function outboxStats() {
  const pending = get("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'")?.n || 0;
  const failed = get("SELECT COUNT(*) AS n FROM outbox WHERE status = 'failed'")?.n || 0;
  const sent = get("SELECT COUNT(*) AS n FROM outbox WHERE status = 'sent'")?.n || 0;
  return { pending, failed, sent };
}

export function pruneOutbox(days = 14) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  run("DELETE FROM outbox WHERE status != 'pending' AND created_at < ?", [cutoff]);
}

// ════════════════════════════════════════════════════════════
// Calls (whatsapp voice/video call events)
// ════════════════════════════════════════════════════════════
export function recordCall({ id, number, name = null, video = false, status = 'offer' }) {
  if (!id) return null;
  run(
    `INSERT INTO calls (id, number, name, video, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, video = excluded.video`,
    [id, number, name, video ? 1 : 0, status, new Date().toISOString()]
  );
  return getCall(id);
}

export function updateCall(id, { status, outcome } = {}) {
  if (!id) return null;
  const fields = [];
  const values = [];
  if (status) {
    fields.push('status = ?');
    values.push(status);
  }
  if (outcome) {
    fields.push('outcome = ?');
    values.push(outcome);
  }
  if (status && ['accepted', 'missed', 'rejected', 'handled'].includes(status)) {
    fields.push('handled_at = ?');
    values.push(new Date().toISOString());
  }
  if (!fields.length) return getCall(id);
  values.push(id);
  run(`UPDATE calls SET ${fields.join(', ')} WHERE id = ?`, values);
  return getCall(id);
}

export function getCall(id) {
  return get('SELECT * FROM calls WHERE id = ?', [id]);
}

export function recentCalls(limit = 10) {
  return all('SELECT * FROM calls ORDER BY created_at DESC LIMIT ?', [limit]);
}

export function callsToday() {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const row = get('SELECT COUNT(*) AS n FROM calls WHERE created_at >= ?', [since.toISOString()]);
  return row?.n || 0;
}

export function lastCallFor(number) {
  return get('SELECT * FROM calls WHERE number = ? ORDER BY created_at DESC LIMIT 1', [number]);
}

export function listContacts(limit = 100) {
  return all('SELECT * FROM contacts ORDER BY last_seen DESC LIMIT ?', [limit]);
}

export function countContacts() {
  return get('SELECT COUNT(*) AS c FROM contacts')?.c || 0;
}

// ════════════════════════════════════════════════════════════
// Messages
// ════════════════════════════════════════════════════════════
export function saveMessage(number, role, content, kind = 'text', meta = null) {
  run(
    'INSERT INTO messages (number, role, kind, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [number, role, kind, String(content ?? ''), meta ? JSON.stringify(meta) : null, new Date().toISOString()]
  );
}

export function getMessages(number, limit = 30) {
  const rows = all(
    'SELECT role, kind, content, meta, created_at FROM messages WHERE number = ? ORDER BY id DESC LIMIT ?',
    [number, limit]
  );
  return rows.reverse().map((r) => ({ ...r, meta: r.meta ? safeJson(r.meta) : null }));
}

export function countMessages(number) {
  return get('SELECT COUNT(*) AS c FROM messages WHERE number = ?', [number])?.c || 0;
}

export function recentMessages(limit = 30) {
  return all('SELECT * FROM messages ORDER BY id DESC LIMIT ?', [limit]);
}

// ════════════════════════════════════════════════════════════
// Deleted-message tracking
// ════════════════════════════════════════════════════════════
export function rememberIncoming(msgId, number, kind, body) {
  if (!msgId) return;
  run(
    'INSERT OR REPLACE INTO seen_messages (msg_id, number, kind, body, created_at) VALUES (?, ?, ?, ?, ?)',
    [msgId, number, kind, body ? String(body).slice(0, 2000) : null, new Date().toISOString()]
  );
  // keep the table small
  run(`DELETE FROM seen_messages WHERE created_at < datetime('now', '-3 days')`);
}

export function recallIncoming(msgId) {
  return get('SELECT * FROM seen_messages WHERE msg_id = ?', [msgId]);
}

// ════════════════════════════════════════════════════════════
// Long-term memory
// ════════════════════════════════════════════════════════════
export function setFact(number, key, value) {
  if (value === undefined || value === null || value === '') return;
  run(
    `INSERT INTO facts (number, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(number, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [number, key, String(value).slice(0, 1000), new Date().toISOString()]
  );
}

export function getFacts(number) {
  return all('SELECT key, value, updated_at FROM facts WHERE number = ? ORDER BY updated_at DESC', [number]);
}

export function getSummary(number) {
  return get('SELECT * FROM summaries WHERE number = ?', [number]);
}

export function setSummary(number, summary, msgCount = 0) {
  run(
    `INSERT INTO summaries (number, summary, msg_count, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(number) DO UPDATE SET summary = excluded.summary, msg_count = excluded.msg_count, updated_at = excluded.updated_at`,
    [number, String(summary).slice(0, 4000), msgCount, new Date().toISOString()]
  );
}

// ════════════════════════════════════════════════════════════
// Project intake
// ════════════════════════════════════════════════════════════
export function getIntake(number) {
  const row = get('SELECT * FROM intake WHERE number = ?', [number]);
  if (!row) return null;
  return {
    number: row.number,
    stage: row.stage,
    fields: safeJson(row.fields) || {},
    asked: safeJson(row.asked) || [],
    quote: safeJson(row.quote) || null,
    quoted_at: row.quoted_at,
    updated_at: row.updated_at,
  };
}

export function saveIntake(number, { stage, fields, asked, quote, quoted_at }) {
  run(
    `INSERT INTO intake (number, stage, fields, asked, quote, quoted_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(number) DO UPDATE SET
       stage = excluded.stage, fields = excluded.fields, asked = excluded.asked,
       quote = excluded.quote, quoted_at = excluded.quoted_at, updated_at = excluded.updated_at`,
    [
      number,
      stage || 'open',
      JSON.stringify(fields || {}),
      JSON.stringify(asked || []),
      quote ? JSON.stringify(quote) : null,
      quoted_at || null,
      new Date().toISOString(),
    ]
  );
}

export function listIntakes(limit = 50) {
  return all('SELECT * FROM intake ORDER BY updated_at DESC LIMIT ?', [limit]).map((r) => ({
    ...r,
    fields: safeJson(r.fields) || {},
  }));
}

// ════════════════════════════════════════════════════════════
// Leads (CRM)
// ════════════════════════════════════════════════════════════
const LEAD_COLUMNS = [
  'number', 'name', 'company', 'country', 'currency', 'project_type', 'goal', 'features',
  'design', 'content', 'timeline', 'budget', 'tech', 'extra', 'quote_min', 'quote_max',
  'quote_currency', 'status', 'score', 'priority', 'next_action', 'notes',
];

export function saveLead(data) {
  if (!data?.number) return;
  const now = new Date().toISOString();
  const existing = getLead(data.number);

  if (existing) {
    const sets = [];
    const values = [];
    for (const col of LEAD_COLUMNS) {
      if (col === 'number') continue;
      if (data[col] !== undefined && data[col] !== null && data[col] !== '') {
        sets.push(`${col} = ?`);
        values.push(typeof data[col] === 'object' ? JSON.stringify(data[col]) : data[col]);
      }
    }
    sets.push('updated_at = ?');
    values.push(now, data.number);
    if (sets.length > 1) run(`UPDATE leads SET ${sets.join(', ')} WHERE number = ?`, values);
    return getLead(data.number);
  }

  const cols = [];
  const placeholders = [];
  const values = [];
  for (const col of LEAD_COLUMNS) {
    const v = data[col];
    if (v === undefined) continue;
    cols.push(col);
    placeholders.push('?');
    values.push(typeof v === 'object' ? JSON.stringify(v) : v);
  }
  cols.push('created_at', 'updated_at');
  placeholders.push('?', '?');
  values.push(now, now);

  run(`INSERT INTO leads (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`, values);
  return getLead(data.number);
}

export function getLead(number) {
  return get('SELECT * FROM leads WHERE number = ?', [number]);
}

export function listLeads(status = null, limit = 100) {
  return status
    ? all('SELECT * FROM leads WHERE status = ? ORDER BY updated_at DESC LIMIT ?', [status, limit])
    : all('SELECT * FROM leads ORDER BY updated_at DESC LIMIT ?', [limit]);
}

export function countLeads() {
  return get("SELECT COUNT(*) AS c FROM leads WHERE status != 'lost'")?.c || 0;
}

// ════════════════════════════════════════════════════════════
// Follow-ups / scheduled messages
// ════════════════════════════════════════════════════════════
export function addFollowUp(number, dueAtIso, message, attempt = 1) {
  run(
    'INSERT INTO followups (number, due_at, attempt, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [number, dueAtIso, attempt, message || null, 'pending', new Date().toISOString()]
  );
}

export function dueFollowUps(nowIso = new Date().toISOString()) {
  return all("SELECT * FROM followups WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT 20", [nowIso]);
}

export function updateFollowUp(id, status) {
  run('UPDATE followups SET status = ? WHERE id = ?', [status, id]);
}

export function cancelFollowUps(number) {
  run("UPDATE followups SET status = 'cancelled' WHERE number = ? AND status = 'pending'", [number]);
}

export function pendingFollowUps(number) {
  return all("SELECT * FROM followups WHERE number = ? AND status = 'pending' ORDER BY due_at", [number]);
}

export function savePending(number, payload, dueAtIso) {
  run(
    `INSERT INTO pending (number, payload, due_at, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(number) DO UPDATE SET payload = excluded.payload, due_at = excluded.due_at`,
    [number, JSON.stringify(payload), dueAtIso, new Date().toISOString()]
  );
}

export function getPending(number) {
  const row = get('SELECT * FROM pending WHERE number = ?', [number]);
  return row ? { ...row, payload: safeJson(row.payload) } : null;
}

export function duePending(nowIso) {
  return all('SELECT * FROM pending WHERE due_at <= ?', [nowIso]).map((r) => ({ ...r, payload: safeJson(r.payload) }));
}

export function clearPending(number) {
  run('DELETE FROM pending WHERE number = ?', [number]);
}

// ════════════════════════════════════════════════════════════
// Usage / quota (keeps the free tier safe)
// ════════════════════════════════════════════════════════════
export function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function getUsage(day = todayKey()) {
  return get('SELECT * FROM usage WHERE day = ?', [day]) || {
    day, llm_calls: 0, llm_tokens: 0, stt_seconds: 0, vision_calls: 0, tts_chars: 0,
  };
}

export function bumpUsage(field, amount = 1, day = todayKey()) {
  const allowed = ['llm_calls', 'llm_tokens', 'stt_seconds', 'vision_calls', 'tts_chars'];
  if (!allowed.includes(field)) return;
  run(
    `INSERT INTO usage (day, ${field}) VALUES (?, ?)
     ON CONFLICT(day) DO UPDATE SET ${field} = ${field} + excluded.${field}`,
    [day, amount]
  );
}

export function usageHistory(limit = 14) {
  return all('SELECT * FROM usage ORDER BY day DESC LIMIT ?', [limit]);
}

// ════════════════════════════════════════════════════════════
// Events / settings
// ════════════════════════════════════════════════════════════
export function logEvent(type, number = null, detail = null) {
  run('INSERT INTO events (type, number, detail, created_at) VALUES (?, ?, ?, ?)', [
    type,
    number,
    typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : null,
    new Date().toISOString(),
  ]);
  run(`DELETE FROM events WHERE created_at < datetime('now', '-30 days')`);
}

export function recentEvents(limit = 20) {
  return all('SELECT * FROM events ORDER BY id DESC LIMIT ?', [limit]);
}

export function countEvents(type, sinceIso) {
  return get('SELECT COUNT(*) AS c FROM events WHERE type = ? AND created_at >= ?', [type, sinceIso])?.c || 0;
}

export function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', [key]);
  if (!row) return fallback;
  return safeJson(row.value) ?? row.value ?? fallback;
}

export function setSetting(key, value) {
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, typeof value === 'string' ? value : JSON.stringify(value)]
  );
}

// ════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════
function safeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function dbStats() {
  return {
    contacts: countContacts(),
    messages: get('SELECT COUNT(*) AS c FROM messages')?.c || 0,
    leads: get('SELECT COUNT(*) AS c FROM leads')?.c || 0,
    pendingFollowUps: get("SELECT COUNT(*) AS c FROM followups WHERE status = 'pending'")?.c || 0,
    file: DB_FILE,
    sizeBytes: fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0,
  };
}

/** Writes a JSON backup into data/exports and returns the path. */
export function writeExport(data = exportAll()) {
  const dir = path.join(config.paths.data, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

export function exportAll() {
  return {
    contacts: all('SELECT * FROM contacts'),
    leads: all('SELECT * FROM leads'),
    intake: listIntakes(1000),
    followups: all('SELECT * FROM followups ORDER BY id DESC LIMIT 500'),
    usage: usageHistory(60),
  };
}

// ── knowledge base (Phase 1: ingest + store; Phase 2: embeddings) ──

/** Replace every chunk of one source in a single transaction-ish pass. */
export function replaceKnowledgeSource(source, chunks = [], { title = null, rules = null } = {}) {
  run('DELETE FROM knowledge WHERE source = ?', [source]);
  const now = new Date().toISOString();
  let n = 0;
  for (const chunk of chunks) {
    const text = typeof chunk === 'string' ? chunk : chunk.text;
    if (!text || !text.trim()) continue;
    run('INSERT INTO knowledge (source, title, chunk_no, text, hash, rules, created_at) VALUES (?,?,?,?,?,?,?)', [
      source,
      title,
      n,
      text.trim(),
      typeof chunk === 'string' ? hashText(text) : chunk.hash || hashText(text),
      rules ? JSON.stringify(rules) : null,
      now,
    ]);
    n += 1;
  }
  saveDB(true);
  return n;
}

export function knowledgeSources() {
  return all(
    `SELECT source, title, COUNT(*) AS chunks,
            MAX(created_at) AS updated_at,
            SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded
       FROM knowledge GROUP BY source ORDER BY updated_at DESC`
  );
}

export function knowledgeChunks(source, limit = 500) {
  return all('SELECT * FROM knowledge WHERE source = ? ORDER BY chunk_no LIMIT ?', [source, limit]);
}

export function knowledgeStats() {
  const row = get('SELECT COUNT(*) AS chunks, COUNT(DISTINCT source) AS sources FROM knowledge') || {};
  const bytes = get('SELECT COALESCE(SUM(LENGTH(text)), 0) AS bytes FROM knowledge') || {};
  return {
    chunks: row.chunks || 0,
    sources: row.sources || 0,
    bytes: bytes.bytes || 0,
  };
}

/** Naive substring search. Phase 2 replaces this with vector retrieval. */
export function searchKnowledge(query, limit = 5) {
  const q = String(query || '').trim();
  if (!q) return [];
  const words = q
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2)
    .slice(0, 6);
  if (!words.length) return [];
  const where = words.map(() => 'LOWER(text) LIKE ?').join(' OR ');
  return all(
    `SELECT source, title, chunk_no, text FROM knowledge WHERE ${where} LIMIT ?`,
    [...words.map((w) => `%${w}%`), limit]
  );
}

export function deleteKnowledgeSource(source) {
  run('DELETE FROM knowledge WHERE source = ?', [source]);
  saveDB(true);
  return true;
}

function hashText(text) {
  let h = 5381;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Chunks that still need a vector: never embedded, or changed since. */
export function knowledgePending(limit = 500) {
  return all(
    `SELECT id, source, title, chunk_no, text, hash, embedding, embedded_hash
       FROM knowledge
      WHERE embedded_hash IS NULL OR embedded_hash <> hash OR embedding IS NULL
      ORDER BY source, chunk_no LIMIT ?`,
    [limit]
  );
}

export function knowledgeEmbedded(limit = 5000) {
  return all(
    `SELECT id, source, title, chunk_no, text, embedding, hash
       FROM knowledge WHERE embedding IS NOT NULL LIMIT ?`,
    [limit]
  );
}

export function setKnowledgeEmbedding(id, embeddingJson, { model = null, hash = null } = {}) {
  run('UPDATE knowledge SET embedding = ?, embedding_model = ?, embedded_hash = ? WHERE id = ?', [
    embeddingJson,
    model,
    hash,
    id,
  ]);
}

export function clearKnowledgeEmbeddings(source = null) {
  if (source) run('UPDATE knowledge SET embedding = NULL, embedding_model = NULL, embedded_hash = NULL WHERE source = ?', [source]);
  else run('UPDATE knowledge SET embedding = NULL, embedding_model = NULL, embedded_hash = NULL');
  saveDB(true);
  return true;
}

/** Every chunk, for the keyword (BM25) side of the hybrid search. */
export function allKnowledgeChunks(limit = 5000) {
  return all('SELECT id, source, title, chunk_no, text, hash FROM knowledge ORDER BY id LIMIT ?', [limit]);
}

export function knowledgeEmbeddingStats() {
  const row =
    get(
      `SELECT COUNT(*) AS chunks,
              SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded,
              SUM(CASE WHEN embedded_hash IS NOT NULL AND embedded_hash <> hash THEN 1 ELSE 0 END) AS stale,
              COUNT(DISTINCT source) AS sources
         FROM knowledge`
    ) || {};
  const chunks = row.chunks || 0;
  const embedded = row.embedded || 0;
  const stale = row.stale || 0;
  return {
    chunks,
    embedded,
    stale,
    pending: chunks - embedded + stale,
    sources: row.sources || 0,
  };
}

// ── tool calls: logging, confirmations, idempotent side effects ──

export function logToolCall({
  tenant = null, chat = null, tool = null, args = null, result = null,
  status = 'ok', error = null, ms = null, key = null,
} = {}) {
  run(
    `INSERT INTO tool_calls (tenant, chat, tool, args, result, status, error, ms, key, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      tenant,
      chat,
      tool,
      args === null ? null : JSON.stringify(args),
      result === null ? null : JSON.stringify(result).slice(0, 4000),
      status,
      error,
      ms,
      key,
      new Date().toISOString(),
    ]
  );
  saveDB(true);
  return true;
}

export function recentToolCalls(limit = 10) {
  return all('SELECT * FROM tool_calls ORDER BY id DESC LIMIT ?', [limit]).map((row) => ({
    ...row,
    args: safeJson(row.args),
    result: safeJson(row.result),
  }));
}

export function toolCallStats(sinceIso = null) {
  const row = sinceIso
    ? get(
        "SELECT COUNT(*) AS total, SUM(status = 'ok') AS ok, SUM(status = 'error') AS errors FROM tool_calls WHERE created_at >= ?",
        [sinceIso]
      )
    : get("SELECT COUNT(*) AS total, SUM(status = 'ok') AS ok, SUM(status = 'error') AS errors FROM tool_calls");
  return { total: row?.total || 0, ok: row?.ok || 0, errors: row?.errors || 0 };
}


export function saveConfirmation({ token, tenant = null, chat, tool, args, summary, ttlMs = 10 * 60 * 1000 }) {
  const now = new Date();
  run('DELETE FROM tool_confirmations WHERE chat = ? AND status = ?', [chat, 'pending']);
  run(
    `INSERT INTO tool_confirmations (token, tenant, chat, tool, args, summary, status, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [token, tenant, chat, tool, JSON.stringify(args || {}), summary || '', 'pending', now.toISOString(), new Date(now.getTime() + ttlMs).toISOString()]
  );
  saveDB(true);
  return token;
}

export function getPendingConfirmation(chat) {
  const row = get(
    "SELECT * FROM tool_confirmations WHERE chat = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    [chat]
  );
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    run("UPDATE tool_confirmations SET status = 'expired' WHERE token = ?", [row.token]);
    saveDB(true);
    return null;
  }
  return { ...row, args: safeJson(row.args) || {} };
}

export function resolveConfirmation(token, status = 'confirmed') {
  run('UPDATE tool_confirmations SET status = ? WHERE token = ?', [status, token]);
  saveDB(true);
  return true;
}

export function expireConfirmations() {
  const changed = run("UPDATE tool_confirmations SET status = 'expired' WHERE status = 'pending' AND expires_at < ?", [
    new Date().toISOString(),
  ]);
  if (changed) saveDB(true);
  return changed;
}

/**
 * Idempotent booking.
 * Same key twice → the existing row, nothing new.
 * Same slot from someone else → a conflict, nothing new.
 */
export function createBooking({ chat, service, date, time, name = null, notes = null, key = null }) {
  if (key) {
    const existing = get('SELECT * FROM bookings WHERE key = ?', [key]);
    if (existing) return { booking: existing, created: false, duplicate: true };
  }
  const taken = get(
    "SELECT * FROM bookings WHERE service = ? AND date = ? AND time = ? AND status = 'booked'",
    [service, date, time]
  );
  if (taken) return { booking: taken, created: false, conflict: true };

  run(
    'INSERT INTO bookings (chat, service, date, time, name, notes, status, key, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [chat, service, date, time, name, notes, 'booked', key, new Date().toISOString()]
  );
  saveDB(true);
  const booking = get('SELECT * FROM bookings WHERE key = ? OR (chat = ? AND service = ? AND date = ? AND time = ?) ORDER BY id DESC LIMIT 1', [
    key, chat, service, date, time,
  ]);
  return { booking, created: true, duplicate: false };
}

export function bookingsFor(chat, limit = 5) {
  return all('SELECT * FROM bookings WHERE chat = ? ORDER BY id DESC LIMIT ?', [chat, limit]);
}

export function upcomingBookings(limit = 10) {
  return all("SELECT * FROM bookings WHERE status = 'booked' AND date >= date('now') ORDER BY date, time LIMIT ?", [limit]);
}

export function createOrder({ chat, items, total, currency = 'PKR', name = null, phone = null, address = null, key = null }) {
  if (key) {
    const existing = get('SELECT * FROM orders WHERE key = ?', [key]);
    if (existing) return { order: existing, created: false, duplicate: true };
  }
  run(
    'INSERT INTO orders (chat, items, total, currency, name, phone, address, status, key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [chat, JSON.stringify(items || []), total, currency, name, phone, address, 'placed', key, new Date().toISOString()]
  );
  saveDB(true);
  const order = key ? get('SELECT * FROM orders WHERE key = ?', [key]) : get('SELECT * FROM orders ORDER BY id DESC LIMIT 1');
  return { order, created: true };
}

export function recentOrders(limit = 10) {
  return all('SELECT * FROM orders ORDER BY id DESC LIMIT ?', [limit]).map((o) => ({ ...o, items: safeJson(o.items) || [] }));
}
