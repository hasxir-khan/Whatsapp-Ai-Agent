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

-- Cloud API: what we sent, and what Meta said happened to it.
CREATE TABLE IF NOT EXISTS cloud_messages (
  wa_id       TEXT PRIMARY KEY,
  tenant      TEXT,
  number      TEXT,
  kind        TEXT,
  status      TEXT DEFAULT 'sent',   -- sent | delivered | read | failed
  outbox_id   INTEGER,
  error       TEXT,
  created_at  TEXT,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_cloud_status ON cloud_messages(status, updated_at);

-- Cloud API: when each customer last wrote to us. That single timestamp decides
-- whether Meta lets us send a free-form message (24-hour service window).
CREATE TABLE IF NOT EXISTS cloud_windows (
  number       TEXT PRIMARY KEY,
  last_inbound TEXT,
  updated_at   TEXT
);

-- ── Phase 3: proactive growth ──────────────────────────────
-- One row per person who asked us to stop. Permanent until they say "start".
CREATE TABLE IF NOT EXISTS growth_optouts (
  number      TEXT PRIMARY KEY,
  reason      TEXT,
  source      TEXT,          -- message | owner | command
  created_at  TEXT
);

-- Every proactive message we tried, whether it went out or was refused.
CREATE TABLE IF NOT EXISTS growth_sends (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT,          -- booking | followup | reminder | rebook
  number      TEXT,
  reason      TEXT,
  result      TEXT,          -- sent | skipped | held | blocked | failed
  detail      TEXT,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_growth_sends_at ON growth_sends(created_at, agent);

-- Drafts waiting for the owner (.approve / .skip) — or sent immediately when
-- approval mode is off.
CREATE TABLE IF NOT EXISTS growth_drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT,
  agent       TEXT,
  kind        TEXT,          -- followup | reminder | rebook
  text        TEXT,
  reason      TEXT,
  status      TEXT DEFAULT 'pending',   -- pending | sent | skipped | cancelled | expired
  due_at      TEXT,
  created_at  TEXT,
  sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_growth_drafts_status ON growth_drafts(status, id);

-- Reminders for a booking, so a restart does not forget them.
CREATE TABLE IF NOT EXISTS booking_reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id  INTEGER,
  number      TEXT,
  kind        TEXT,          -- 24h | 2h | noshow
  due_at      TEXT,
  status      TEXT DEFAULT 'pending',   -- pending | sent | cancelled
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_booking_reminders_due ON booking_reminders(status, due_at);

CREATE TABLE IF NOT EXISTS calls (
  id          TEXT PRIMARY KEY,
  number      TEXT,
  name        TEXT,
  video       INTEGER DEFAULT 0,
  status      TEXT,          -- offer | accepted | missed | rejected | handled
  outcome     TEXT,          -- what the assistant did about it
  created_at  TEXT,          -- when it started ringing
  ended_at    TEXT,          -- when the phone stopped ringing (answered, hung up, timed out)
  apologized_at TEXT,        -- when the chat apology went out
  handled_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_created ON calls(created_at);

CREATE TABLE IF NOT EXISTS image_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT,
  image_path TEXT UNIQUE,
  hash TEXT,
  model TEXT,
  dim INTEGER,
  vector TEXT,
  updated_at TEXT
);

-- Every call that leaves this machine for an external tool server.
-- The arguments themselves are never stored, only a hash: a tool argument can
-- be a customer's address or an order's contents.
CREATE TABLE IF NOT EXISTS mcp_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant      TEXT,
  server      TEXT,
  tool        TEXT,
  arg_hash    TEXT,
  ok          INTEGER,
  status      TEXT,          -- ok | error | timeout | rejected | breaker | budget
  ms          INTEGER,
  error       TEXT,
  truncated   INTEGER,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_calls_created ON mcp_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_calls_tenant ON mcp_calls(tenant, created_at);

-- A write tool must not run twice for one confirmation, however often the
-- customer's "yes" is replayed.
CREATE TABLE IF NOT EXISTS mcp_idempotency (
  key         TEXT PRIMARY KEY,
  tenant      TEXT,
  server      TEXT,
  tool        TEXT,
  result      TEXT,
  created_at  TEXT
);

-- Reliability incidents: one row per thing that went wrong, when it opened,
-- when the owner was told, and when it recovered. "detail" never holds a
-- customer's words — it holds numbers and states.
CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT,
  kind        TEXT,
  severity    TEXT,          -- warn | bad
  detail      TEXT,
  status      TEXT,          -- open | resolved
  opened_at   TEXT,
  resolved_at TEXT,
  notified_at TEXT,
  notify_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_incidents_key ON incidents(key, status);
CREATE INDEX IF NOT EXISTS idx_incidents_opened ON incidents(opened_at);

-- A customer asked to be forgotten; the owner decides.
CREATE TABLE IF NOT EXISTS privacy_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT,
  status      TEXT,          -- pending | done | declined
  language    TEXT,
  created_at  TEXT,
  decided_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_privacy_requests_status ON privacy_requests(status, created_at);

-- The audit line for a deletion: what happened, how much, never who or what.
CREATE TABLE IF NOT EXISTS privacy_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT,          -- forget | retention
  subject_hash TEXT,         -- sha256(number)[0..16] — irreversible, and enough
  detail      TEXT,          -- row counts, never content
  created_at  TEXT
);

-- Mini-CRM: free-text tags and notes on a person, per tenant.
-- Tags are normalised before they get here; the UNIQUE key is what makes a
-- double ".tag vip" harmless.
CREATE TABLE IF NOT EXISTS contact_tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant      TEXT,
  number      TEXT,
  tag         TEXT,
  source      TEXT,          -- owner | auto
  created_at  TEXT,
  UNIQUE(tenant, number, tag)
);
CREATE INDEX IF NOT EXISTS idx_contact_tags_tag ON contact_tags(tenant, tag);

-- Tracked entry points: a QR, a poster or a link the owner printed somewhere.
-- One row per source name per tenant, with the short code that travels inside
-- the prefilled message. First touch wins in contact_sources, so a customer can
-- only ever be counted once.
CREATE TABLE IF NOT EXISTS tracked_sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant      TEXT,
  source      TEXT NOT NULL,
  code        TEXT NOT NULL,
  label       TEXT,
  message     TEXT,
  created_at  TEXT,
  UNIQUE(tenant, source),
  UNIQUE(tenant, code)
);

CREATE TABLE IF NOT EXISTS contact_sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant      TEXT,
  number      TEXT NOT NULL,
  source      TEXT NOT NULL,
  code        TEXT,
  detail      TEXT,          -- the ad headline, when the arrival came from a click-to-WhatsApp ad
  created_at  TEXT,
  UNIQUE(tenant, number)
);
CREATE INDEX IF NOT EXISTS idx_contact_sources_source ON contact_sources(tenant, source);

CREATE TABLE IF NOT EXISTS contact_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant      TEXT,
  number      TEXT,
  note        TEXT,
  author      TEXT,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_contact_notes_number ON contact_notes(tenant, number, id);

-- Every order transition, with who did it and when. The order row keeps "where",
-- this table keeps "how it got there".
CREATE TABLE IF NOT EXISTS order_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER,
  from_status TEXT,
  to_status   TEXT,
  actor       TEXT,          -- owner | bot | customer
  detail      TEXT,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id, id);

CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT,
  action TEXT,
  slug TEXT,
  detail TEXT,
  ip TEXT,
  ok INTEGER DEFAULT 1
);

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

-- Which specialist answered, and how we decided (phase 2 step 3).
CREATE TABLE IF NOT EXISTS message_intents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant      TEXT,
  chat        TEXT,
  intent      TEXT,
  agent       TEXT,
  source      TEXT,          -- rules | cache | llm | fallback
  confidence  REAL,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_intents_created ON message_intents(created_at);

-- Phase 3 part 2 ────────────────────────────────────────────
-- One feedback ask per completed job, never twice.
CREATE TABLE IF NOT EXISTS review_asks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT,
  kind        TEXT,           -- booking | order
  ref_id      INTEGER,
  status      TEXT DEFAULT 'scheduled',  -- scheduled | asked | rated | skipped | cancelled
  rating      INTEGER,
  due_at      TEXT,
  created_at  TEXT,
  updated_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_asks_ref ON review_asks(kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_review_asks_due ON review_asks(status, due_at);

-- How many times we argued with one objection. Two, then a human.
CREATE TABLE IF NOT EXISTS objection_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT,
  kind        TEXT,
  attempt     INTEGER,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_objection_number ON objection_attempts(number, kind);

-- A code per customer; when a stranger arrives quoting it, we know who sent them.
CREATE TABLE IF NOT EXISTS referrals (
  code        TEXT PRIMARY KEY,
  number      TEXT,
  uses        INTEGER DEFAULT 0,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_referrals_number ON referrals(number);

-- Every win-back message we have ever sent, so a cycle is never repeated.
CREATE TABLE IF NOT EXISTS reactivation_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT,
  segment     TEXT,          -- past | cold | date
  cycle       INTEGER,
  sent_at     TEXT,
  campaign    TEXT
);
CREATE INDEX IF NOT EXISTS idx_reactivation_number ON reactivation_log(number, sent_at);

-- Per-tenant AI budget. One tenant's busy week must not spend another's quota.
CREATE TABLE IF NOT EXISTS tenant_usage (
  day         TEXT,
  tenant      TEXT,
  llm_calls   INTEGER DEFAULT 0,
  PRIMARY KEY (day, tenant)
);

-- Self-healing: rules learned from the owner's own corrections wait here.
-- Nothing written to this table can change the bot's behaviour until it says
-- 'approved', and only then does it become a normal FAQ entry.
CREATE TABLE IF NOT EXISTS pending_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT,
  question    TEXT,
  answer      TEXT,
  status      TEXT DEFAULT 'pending',   -- pending | approved | rejected
  source      TEXT DEFAULT 'owner_correction',
  reason      TEXT,
  created_at  TEXT,
  decided_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_rules_status ON pending_rules(status, created_at);

-- Phase 6 part 1 ────────────────────────────────────────────
-- Which custom agent owns a conversation, and how many hand-offs it has used.
CREATE TABLE IF NOT EXISTS agent_chats (
  tenant      TEXT,
  chat        TEXT,
  agent       TEXT,
  handoffs    INTEGER DEFAULT 0,
  updated_at  TEXT,
  PRIMARY KEY (tenant, chat)
);

-- One row per thing an agent did: route, first_reply, handoff, order, booking.
-- Analytics only — nothing here changes what the bot says.
CREATE TABLE IF NOT EXISTS agent_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant      TEXT,
  chat        TEXT,
  agent       TEXT,
  kind        TEXT,
  detail      TEXT,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_events_created ON agent_events(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent, kind);

-- ── phase 6, part 3: the business brain ─────────────────────
-- Every proposal, every decision and its short rationale. The rationale is
-- capped in code (300 chars): the chain of thought itself is never stored.
CREATE TABLE IF NOT EXISTS brain_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT,
  chat TEXT,
  kind TEXT,              -- route | verify | next_best_action | strategy | experiment
  action TEXT,
  rationale TEXT,
  payload TEXT,
  outcome TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_brain_decisions_created ON brain_decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_brain_decisions_chat ON brain_decisions(chat);

CREATE TABLE IF NOT EXISTS brain_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT,
  kind TEXT,              -- campaign | faq | offer | followups | reactivation
  title TEXT,
  detail TEXT,
  payload TEXT,
  status TEXT DEFAULT 'proposed',   -- proposed | drafted | approved | rejected | done
  created_at TEXT,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT,
  metric TEXT,
  target INTEGER,
  due_at TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT,
  kind TEXT,              -- followup | offer | review_ask
  variant_a TEXT,
  variant_b TEXT,
  min_sample INTEGER DEFAULT 30,
  status TEXT DEFAULT 'running',
  winner TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS experiment_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id INTEGER,
  number TEXT,
  variant TEXT,
  outcome TEXT,           -- replied | converted | none
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_experiment_sends ON experiment_sends(experiment_id, variant);

CREATE TABLE IF NOT EXISTS brain_weights (
  tenant TEXT,
  key TEXT,
  value REAL,
  updated_at TEXT,
  PRIMARY KEY (tenant, key)
);
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
  add('calls', 'ended_at', 'TEXT');
  add('calls', 'apologized_at', 'TEXT');
  add('leads', 'score', 'INTEGER DEFAULT 0');
  add('leads', 'priority', 'TEXT');
  add('leads', 'next_action', 'TEXT');
  add('orders', 'eta', 'TEXT');
  add('orders', 'updated_at', 'TEXT');
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
export function enqueueOutbox(jid, payload, { kind = 'text', error = null, status = 'pending' } = {}) {
  run(
    'INSERT INTO outbox (jid, payload, kind, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [jid, JSON.stringify(payload), kind, status, error, new Date().toISOString()]
  );
  const row = get('SELECT * FROM outbox WHERE status = ? ORDER BY id DESC LIMIT 1', [status]);
  return row;
}

/**
 * Cloud API only: hold a message until the 24-hour window reopens.
 * A held row is deliberately invisible to dueOutbox(), so the retry loop will
 * not hammer Meta with a send that is certain to be refused.
 */
export function holdOutbox(jid, payload, { kind = 'text', error = null } = {}) {
  return enqueueOutbox(jid, payload, { kind, error, status: 'held' });
}

/** The customer wrote back → everything held for them can go now. */
export function releaseHeld(jid) {
  run("UPDATE outbox SET status = 'pending', error = NULL WHERE status = 'held' AND jid = ?", [jid]);
  return get("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending' AND jid = ?", [jid])?.n || 0;
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
  const held = get("SELECT COUNT(*) AS n FROM outbox WHERE status = 'held'")?.n || 0;
  return { pending, failed, sent, held };
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

export function updateCall(id, { status, outcome, endedAt = null, apologizedAt = null } = {}) {
  if (!id) return null;
  const fields = [];
  const values = [];
  if (endedAt) {
    fields.push('ended_at = ?');
    values.push(endedAt instanceof Date ? endedAt.toISOString() : String(endedAt));
  }
  if (apologizedAt) {
    fields.push('apologized_at = ?');
    values.push(apologizedAt instanceof Date ? apologizedAt.toISOString() : String(apologizedAt));
  }
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

// ── incidents ───────────────────────────────────────────────

export function findOpenIncident(key) {
  return get("SELECT * FROM incidents WHERE key = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [key]) || null;
}

export function openIncident({ key, kind, severity = 'warn', detail = null }) {
  run(
    `INSERT INTO incidents (key, kind, severity, detail, status, opened_at, notified_at, notify_count)
     VALUES (?,?,?,?,?,?,?,?)`,
    [key, kind, severity, detail, 'open', new Date().toISOString(), null, 0]
  );
  saveDB(true);
  const row = get("SELECT * FROM incidents WHERE key = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [key]);
  return row || null;
}

/** Record that the owner was told (or that a repeat was deliberately skipped). */
export function markIncidentNotified(id, at = new Date().toISOString()) {
  run('UPDATE incidents SET notified_at = ?, notify_count = notify_count + 1 WHERE id = ?', [at, id]);
  saveDB(true);
}

export function resolveIncident(id) {
  run("UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?", [new Date().toISOString(), id]);
  saveDB(true);
}

export function openIncidents() {
  return all("SELECT * FROM incidents WHERE status = 'open' ORDER BY id DESC");
}

export function recentIncidents(limit = 10) {
  return all('SELECT * FROM incidents ORDER BY id DESC LIMIT ?', [limit]);
}

export function incidentStats() {
  const row = get("SELECT COUNT(*) AS open FROM incidents WHERE status = 'open'");
  const day = get("SELECT COUNT(*) AS today FROM incidents WHERE opened_at >= ?", [new Date().toISOString().slice(0, 10)]);
  return { open: row?.open || 0, today: day?.today || 0 };
}

// ── privacy requests and audit ──────────────────────────────

export function addPrivacyRequest(number, { language = 'en' } = {}) {
  const existing = get("SELECT * FROM privacy_requests WHERE number = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", [number]);
  if (existing) return existing;
  run('INSERT INTO privacy_requests (number, status, language, created_at) VALUES (?,?,?,?)', [
    number,
    'pending',
    language,
    new Date().toISOString(),
  ]);
  saveDB(true);
  return get("SELECT * FROM privacy_requests WHERE number = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", [number]);
}

export function pendingPrivacyRequests(limit = 20) {
  return all("SELECT * FROM privacy_requests WHERE status = 'pending' ORDER BY id DESC LIMIT ?", [limit]);
}

export function resolvePrivacyRequests(number, status = 'done') {
  const changed = run("UPDATE privacy_requests SET status = ?, decided_at = ? WHERE number = ? AND status = 'pending'", [
    status,
    new Date().toISOString(),
    number,
  ]);
  if (changed) saveDB(true);
  return changed;
}

export function logPrivacyAction({ action, subjectHash, detail = null }) {
  run('INSERT INTO privacy_audit (action, subject_hash, detail, created_at) VALUES (?,?,?,?)', [
    action,
    subjectHash,
    detail ? JSON.stringify(detail).slice(0, 500) : null,
    new Date().toISOString(),
  ]);
  saveDB(true);
}

export function recentPrivacyAudit(limit = 10) {
  return all('SELECT * FROM privacy_audit ORDER BY id DESC LIMIT ?', [limit]);
}

// ── tags, notes, order events ───────────────────────────────

export function addContactTag({ tenant = null, number, tag, source = 'owner' }) {
  run('INSERT OR IGNORE INTO contact_tags (tenant, number, tag, source, created_at) VALUES (?,?,?,?,?)', [
    tenant, number, tag, source, new Date().toISOString(),
  ]);
  saveDB(true);
  return get('SELECT * FROM contact_tags WHERE tenant IS ? AND number = ? AND tag = ?', [tenant, number, tag]);
}

export function removeContactTag({ tenant = null, number, tag }) {
  // `run` does not report a row count, so check first: the caller wants to know
  // whether the tag was really there ("removed" vs "they never had it").
  const found = get('SELECT 1 AS x FROM contact_tags WHERE tenant IS ? AND number = ? AND tag = ?', [tenant, number, tag]);
  if (!found) return 0;
  run('DELETE FROM contact_tags WHERE tenant IS ? AND number = ? AND tag = ?', [tenant, number, tag]);
  saveDB(true);
  return 1;
}

export function contactTags(number, { tenant = null } = {}) {
  return all('SELECT tag, source, created_at FROM contact_tags WHERE tenant IS ? AND number = ? ORDER BY tag', [tenant, number]);
}

export function tagCounts({ tenant = null } = {}) {
  return all(
    `SELECT tag, COUNT(*) AS n, SUM(source = 'auto') AS auto
       FROM contact_tags WHERE tenant IS ?
      GROUP BY tag ORDER BY n DESC, tag`,
    [tenant]
  );
}

export function numbersWithTag(tag, { tenant = null } = {}) {
  return all('SELECT number FROM contact_tags WHERE tenant IS ? AND tag = ? ORDER BY number', [tenant, tag]).map((r) => r.number);
}

export function countTagsFor(number, { tenant = null } = {}) {
  return get('SELECT COUNT(*) AS n FROM contact_tags WHERE tenant IS ? AND number = ?', [tenant, number])?.n || 0;
}

export function addContactNote({ tenant = null, number, note, author = 'owner' }) {
  run('INSERT INTO contact_notes (tenant, number, note, author, created_at) VALUES (?,?,?,?,?)', [
    tenant, number, String(note || '').slice(0, 500), author, new Date().toISOString(),
  ]);
  saveDB(true);
  return get('SELECT * FROM contact_notes WHERE tenant IS ? AND number = ? ORDER BY id DESC LIMIT 1', [tenant, number]);
}

export function contactNotes(number, { tenant = null, limit = 20 } = {}) {
  return all('SELECT id, note, author, created_at FROM contact_notes WHERE tenant IS ? AND number = ? ORDER BY id DESC LIMIT ?', [
    tenant, number, limit,
  ]);
}

export function logOrderEvent({ orderId, from = null, to = null, actor = 'owner', detail = null }) {
  run('INSERT INTO order_events (order_id, from_status, to_status, actor, detail, created_at) VALUES (?,?,?,?,?,?)', [
    orderId, from, to, actor, detail ? String(detail).slice(0, 300) : null, new Date().toISOString(),
  ]);
  saveDB(true);
}

export function orderEvents(orderId) {
  return all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', [orderId]);
}

// How many reminders have been attempted for this order. A draft counts (it is
// a stage that has been spent), the "we are giving up" marker does not.
export function countOrderReminders(orderId) {
  return get(
    "SELECT COUNT(*) AS n FROM order_events WHERE order_id = ? AND detail LIKE 'reminder:%' AND detail NOT LIKE '%:stop'",
    [orderId]
  )?.n || 0;
}

export function ordersWithStatus(statuses = [], limit = 50) {
  if (!statuses.length) return [];
  const holes = statuses.map(() => '?').join(',');
  return all(`SELECT * FROM orders WHERE status IN (${holes}) ORDER BY id DESC LIMIT ?`, [...statuses, limit]);
}

export function setOrderEta(id, eta) {
  run('UPDATE orders SET eta = ?, updated_at = ? WHERE id = ?', [eta, new Date().toISOString(), id]);
  saveDB(true);
}

// ── MCP call log ────────────────────────────────────────────
// The log is the only place a tool call is remembered. Arguments are hashed,
// results are not kept: the point is to be able to answer "what did the bot
// send out, to whom, and did it work", not to build a second copy of the data.

export function logMcpCall({
  tenant = null, server = null, tool = null, argHash = null,
  ok = null, status = 'ok', ms = null, error = null, truncated = 0,
} = {}) {
  run(
    `INSERT INTO mcp_calls (tenant, server, tool, arg_hash, ok, status, ms, error, truncated, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [tenant, String(server || '').slice(0, 40), String(tool || '').slice(0, 80), argHash, ok === null ? null : ok ? 1 : 0, status, ms, error ? String(error).slice(0, 300) : null, truncated ? 1 : 0, new Date().toISOString()]
  );
  saveDB(true);
}

export function recentMcpCalls(limit = 10) {
  return all('SELECT * FROM mcp_calls ORDER BY id DESC LIMIT ?', [limit]);
}

export function mcpCallStats(sinceIso = null) {
  const row = sinceIso
    ? get('SELECT COUNT(*) AS total, SUM(ok = 0) AS errors FROM mcp_calls WHERE created_at >= ?', [sinceIso])
    : get('SELECT COUNT(*) AS total, SUM(ok = 0) AS errors FROM mcp_calls');
  return { total: row?.total || 0, errors: row?.errors || 0 };
}

/** Calls that actually reached a server today, for the per-tenant budget. */
export function mcpCallsSince(tenant, sinceIso) {
  const row = get('SELECT COUNT(*) AS n FROM mcp_calls WHERE tenant = ? AND created_at >= ? AND status NOT IN (?, ?, ?)', [
    tenant || null,
    sinceIso,
    'rejected',
    'budget',
    'breaker',
  ]);
  return row?.n || 0;
}

export function getMcpIdempotent(key) {
  if (!key) return null;
  const row = get('SELECT * FROM mcp_idempotency WHERE key = ?', [key]);
  if (!row) return null;
  try {
    return { ...row, result: row.result ? JSON.parse(row.result) : null };
  } catch {
    return { ...row, result: null };
  }
}

export function saveMcpIdempotent({ key, tenant = null, server, tool, result }) {
  if (!key) return false;
  run(
    `INSERT OR IGNORE INTO mcp_idempotency (key, tenant, server, tool, result, created_at)
     VALUES (?,?,?,?,?,?)`,
    [key, tenant, server, tool, JSON.stringify(result ?? null).slice(0, 8000), new Date().toISOString()]
  );
  saveDB(true);
  return true;
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

export function getOrder(id) {
  const o = get('SELECT * FROM orders WHERE id = ?', [id]);
  return o ? { ...o, items: safeJson(o.items) || [] } : null;
}

export function orderFor(chat) {
  return get("SELECT * FROM orders WHERE chat = ? ORDER BY id DESC LIMIT 1", [chat]);
}

export function setOrderStatus(id, status) {
  run('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
  saveDB(true);
  return get('SELECT * FROM orders WHERE id = ?', [id]);
}

export function ordersAwaitingPayment(limit = 10) {
  return all("SELECT * FROM orders WHERE status = 'awaiting_payment' ORDER BY id DESC LIMIT ?", [limit]).map((o) => ({
    ...o,
    items: safeJson(o.items) || [],
  }));
}

export function recentOrders(limit = 10) {
  return all('SELECT * FROM orders ORDER BY id DESC LIMIT ?', [limit]).map((o) => ({ ...o, items: safeJson(o.items) || [] }));
}

// ── intents ────────────────────────────────────────────────

export function logIntent({ tenant = null, chat = null, intent = 'other', agent = 'other', source = 'rules', confidence = 0 } = {}) {
  run('INSERT INTO message_intents (tenant, chat, intent, agent, source, confidence, created_at) VALUES (?,?,?,?,?,?,?)', [
    tenant,
    chat,
    intent,
    agent,
    source,
    confidence,
    new Date().toISOString(),
  ]);
  // no saveDB here: this table is analytics, it rides along with the next write
  return true;
}

export function intentCountsSince(sinceIso) {
  return all(
    `SELECT intent, agent, source, COUNT(*) AS count
       FROM message_intents
      WHERE created_at >= ?
      GROUP BY intent, agent, source
      ORDER BY count DESC`,
    [sinceIso]
  );
}

export function recentIntents(limit = 15) {
  return all('SELECT * FROM message_intents ORDER BY id DESC LIMIT ?', [limit]);
}

export function intentStatsForDay(dayKey = new Date().toISOString().slice(0, 10)) {
  return intentCountsSince(`${dayKey}T00:00:00.000Z`);
}

// ════════════════════════════════════════════════════════════
// Cloud API — delivery tracking and the 24-hour window
// ════════════════════════════════════════════════════════════

export function cloudTrack({ waId, tenant = null, number = null, kind = 'text', outboxId = null } = {}) {
  if (!waId) return null;
  const now = new Date().toISOString();
  run(
    `INSERT INTO cloud_messages (wa_id, tenant, number, kind, status, outbox_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'sent', ?, ?, ?)
     ON CONFLICT(wa_id) DO UPDATE SET updated_at = excluded.updated_at`,
    [waId, tenant, number, kind, outboxId, now, now]
  );
  return get('SELECT * FROM cloud_messages WHERE wa_id = ?', [waId]);
}

/**
 * Has this inbound Meta message already been handled?
 *
 * `cloud_messages` already exists with `wa_id` as its primary key, so the
 * ledger Meta's retries need is the one we already keep — no second table.
 */
export function cloudInboundSeen(waId) {
  if (!waId) return false;
  const row = get('SELECT kind FROM cloud_messages WHERE wa_id = ?', [waId]);
  return !!row && row.kind === 'inbound';
}

/** Record an inbound message id before it is acted on, so a retry is a no-op. */
export function cloudInboundMark(waId, { tenant = null, number = null, now = new Date().toISOString() } = {}) {
  if (!waId) return null;
  run(
    `INSERT INTO cloud_messages (wa_id, tenant, number, kind, status, created_at, updated_at)
     VALUES (?, ?, ?, 'inbound', 'received', ?, ?)
     ON CONFLICT(wa_id) DO NOTHING`,
    [waId, tenant, number, now, now]
  );
  return get('SELECT * FROM cloud_messages WHERE wa_id = ?', [waId]);
}

export function cloudMarkStatus(waId, status, { error = null } = {}) {
  if (!waId) return null;
  const row = get('SELECT * FROM cloud_messages WHERE wa_id = ?', [waId]);
  const now = new Date().toISOString();

  if (!row) {
    // A status for something we have no record of (e.g. sent before a restart).
    run(
      'INSERT INTO cloud_messages (wa_id, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [waId, status, error, now, now]
    );
    return get('SELECT * FROM cloud_messages WHERE wa_id = ?', [waId]);
  }

  run('UPDATE cloud_messages SET status = ?, error = ?, updated_at = ? WHERE wa_id = ?', [
    status,
    error ?? row.error ?? null,
    now,
    waId,
  ]);

  // Mirror onto the outbox row this send came from, so one queue tells the truth.
  if (row.outbox_id) {
    if (status === 'failed') updateOutbox(row.outbox_id, { status: 'failed', error: error || 'delivery failed' });
    else if (status === 'delivered' || status === 'read') updateOutbox(row.outbox_id, { status });
  }
  return get('SELECT * FROM cloud_messages WHERE wa_id = ?', [waId]);
}

export function cloudMessage(waId) {
  return get('SELECT * FROM cloud_messages WHERE wa_id = ?', [waId]);
}

export function cloudDeliveryStats() {
  return all('SELECT status, COUNT(*) AS n FROM cloud_messages GROUP BY status');
}

export function cloudWindowTouch(number, at = new Date().toISOString()) {
  run(
    `INSERT INTO cloud_windows (number, last_inbound, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(number) DO UPDATE SET last_inbound = excluded.last_inbound, updated_at = excluded.updated_at`,
    [number, at, new Date().toISOString()]
  );
}

export function cloudWindowGet(number) {
  return get('SELECT * FROM cloud_windows WHERE number = ?', [number]);
}

// ════════════════════════════════════════════════════════════
// Opt-outs — the strongest promise in the system
// ════════════════════════════════════════════════════════════

export function optOut(number, { reason = null, source = 'message' } = {}) {
  if (!number) return null;
  run(
    `INSERT INTO growth_optouts (number, reason, source, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(number) DO UPDATE SET reason = excluded.reason, source = excluded.source`,
    [number, reason, source, new Date().toISOString()]
  );
  saveDB(true);
  return get('SELECT * FROM growth_optouts WHERE number = ?', [number]);
}

export function optIn(number) {
  run('DELETE FROM growth_optouts WHERE number = ?', [number]);
  return true;
}

export function isOptedOut(number) {
  return !!get('SELECT * FROM growth_optouts WHERE number = ?', [number]);
}

export function optOutList(limit = 50) {
  return all('SELECT * FROM growth_optouts ORDER BY created_at DESC LIMIT ?', [limit]);
}

export function optOutCount() {
  return get('SELECT COUNT(*) AS n FROM growth_optouts')?.n || 0;
}

// ════════════════════════════════════════════════════════════
// Proactive sends — every attempt is on the record
// ════════════════════════════════════════════════════════════

export function logGrowthSend({ agent, number, reason = null, result = 'sent', detail = null, at = null } = {}) {
  // `at` exists so a fake clock and the log agree — the caps read this table.
  run('INSERT INTO growth_sends (agent, number, reason, result, detail, created_at) VALUES (?,?,?,?,?,?)', [
    agent,
    number,
    reason,
    result,
    detail,
    at || new Date().toISOString(),
  ]);
  return true;
}

/** How many proactive messages this person got since `sinceIso`. */
export function growthCountFor(number, sinceIso) {
  return (
    get("SELECT COUNT(*) AS n FROM growth_sends WHERE number = ? AND result = 'sent' AND created_at >= ?", [
      number,
      sinceIso,
    ])?.n || 0
  );
}

/** Tenant-wide daily count, and the per-agent breakdown the owner sees. */
export function growthStatsSince(sinceIso) {
  return all(
    `SELECT agent, result, COUNT(*) AS count
       FROM growth_sends
      WHERE created_at >= ?
      GROUP BY agent, result
      ORDER BY count DESC`,
    [sinceIso]
  );
}

// ════════════════════════════════════════════════════════════
// Drafts (owner approval)
// ════════════════════════════════════════════════════════════

export function addDraft({ number, agent, kind, text, reason = null, dueAt = null } = {}) {
  run(
    'INSERT INTO growth_drafts (number, agent, kind, text, reason, status, due_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [number, agent, kind, text, reason, 'pending', dueAt, new Date().toISOString()]
  );
  return get("SELECT * FROM growth_drafts WHERE status = 'pending' ORDER BY id DESC LIMIT 1");
}

export function getDraft(id) {
  return get('SELECT * FROM growth_drafts WHERE id = ?', [id]);
}

export function pendingDrafts(limit = 20) {
  return all("SELECT * FROM growth_drafts WHERE status = 'pending' ORDER BY id ASC LIMIT ?", [limit]);
}

export function pendingDraftFor(number, agent = null) {
  return agent
    ? get("SELECT * FROM growth_drafts WHERE number = ? AND agent = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", [number, agent])
    : get("SELECT * FROM growth_drafts WHERE number = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", [number]);
}

export function setDraftStatus(id, status, { sentAt = null } = {}) {
  run('UPDATE growth_drafts SET status = ?, sent_at = ? WHERE id = ?', [status, sentAt, id]);
  return getDraft(id);
}

/** Any pending draft for this person — used when they reply or opt out. */
export function cancelDraftsFor(number, reason = 'cancelled') {
  const rows = all("SELECT * FROM growth_drafts WHERE number = ? AND status = 'pending'", [number]);
  if (rows.length) run("UPDATE growth_drafts SET status = ? WHERE number = ? AND status = 'pending'", [reason, number]);
  return rows.length;
}

export function draftStatsSince(sinceIso) {
  return all(
    `SELECT agent, status, COUNT(*) AS count FROM growth_drafts WHERE created_at >= ? GROUP BY agent, status`,
    [sinceIso]
  );
}

// ════════════════════════════════════════════════════════════
// Bookings — the parts the agent needs beyond createBooking
// ════════════════════════════════════════════════════════════

export function getBooking(id) {
  return get('SELECT * FROM bookings WHERE id = ?', [id]);
}

export function isSlotTaken(service, date, time) {
  return !!get("SELECT * FROM bookings WHERE service = ? AND date = ? AND time = ? AND status = 'booked'", [
    service,
    date,
    time,
  ]);
}

/** Is this person already booked at that date/time, whatever the service? */
export function contactHasSlot(chat, date, time) {
  return !!get("SELECT * FROM bookings WHERE chat = ? AND date = ? AND time = ? AND status IN ('booked','confirmed')", [
    chat,
    date,
    time,
  ]);
}

export function cancelBooking(id, { by = 'customer', reason = null } = {}) {
  const booking = getBooking(id);
  if (!booking) return { ok: false, problem: 'not_found' };
  if (booking.status === 'cancelled') return { ok: true, booking, already: true };
  run("UPDATE bookings SET status = 'cancelled', notes = COALESCE(notes, '') || ? WHERE id = ?", [
    ` [cancelled by ${by}${reason ? `: ${reason}` : ''}]`,
    id,
  ]);
  run("UPDATE booking_reminders SET status = 'cancelled' WHERE booking_id = ? AND status = 'pending'", [id]);
  saveDB(true);
  return { ok: true, booking: getBooking(id) };
}

/**
 * Move a booking to a new slot. The old slot is freed at the same instant, so
 * two customers can never end up holding it.
 */
export function rescheduleBooking(id, { date, time } = {}) {
  const booking = getBooking(id);
  if (!booking) return { ok: false, problem: 'not_found' };
  if (booking.status === 'cancelled') return { ok: false, problem: 'cancelled' };

  const taken = get(
    "SELECT * FROM bookings WHERE service = ? AND date = ? AND time = ? AND status IN ('booked','confirmed') AND id <> ?",
    [booking.service, date, time, id]
  );
  if (taken) return { ok: false, problem: 'slot_taken', booking: taken };

  run("UPDATE bookings SET date = ?, time = ?, status = 'booked' WHERE id = ?", [date, time, id]);
  run("UPDATE booking_reminders SET status = 'cancelled' WHERE booking_id = ? AND status = 'pending'", [id]);
  saveDB(true);
  return { ok: true, booking: getBooking(id) };
}

export function bookingsOn(date, { statuses = ['booked', 'confirmed'] } = {}) {
  const marks = statuses.map(() => '?').join(',');
  return all(`SELECT * FROM bookings WHERE date = ? AND status IN (${marks}) ORDER BY time`, [date, ...statuses]);
}

export function bookingsBetween(fromDate, toDate) {
  return all(
    "SELECT * FROM bookings WHERE date >= ? AND date <= ? AND status IN ('booked','confirmed') ORDER BY date, time",
    [fromDate, toDate]
  );
}

/** The next booking this person has, if any. */
export function nextBookingFor(chat) {
  return get(
    "SELECT * FROM bookings WHERE chat = ? AND status IN ('booked','confirmed') ORDER BY date, time LIMIT 1",
    [chat]
  );
}

export function setBookingStatus(id, status) {
  run('UPDATE bookings SET status = ? WHERE id = ?', [status, id]);
  return getBooking(id);
}

/**
 * Bookings whose time has passed but that were never confirmed or closed.
 * @param {string} localCutoff wall-clock "YYYY-MM-DDTHH:MM" in the business's
 * timezone — bookings store wall-clock times, so the comparison has to as well.
 */
export function staleBookings(localCutoff) {
  return all("SELECT * FROM bookings WHERE status IN ('booked','confirmed') AND (date || 'T' || time) < ?", [
    String(localCutoff).slice(0, 16),
  ]);
}

// ── reminders ───────────────────────────────────────────────
export function addReminder({ bookingId, number, kind, dueAt }) {
  run('INSERT INTO booking_reminders (booking_id, number, kind, due_at, status, created_at) VALUES (?,?,?,?,?,?)', [
    bookingId,
    number,
    kind,
    dueAt,
    'pending',
    new Date().toISOString(),
  ]);
  return get("SELECT * FROM booking_reminders WHERE status = 'pending' ORDER BY id DESC LIMIT 1");
}

export function dueReminders(nowIso, limit = 20) {
  return all("SELECT * FROM booking_reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT ?", [
    nowIso,
    limit,
  ]);
}

export function setReminderStatus(id, status) {
  run('UPDATE booking_reminders SET status = ? WHERE id = ?', [status, id]);
}

export function remindersFor(bookingId) {
  return all('SELECT * FROM booking_reminders WHERE booking_id = ? ORDER BY due_at', [bookingId]);
}

// ════════════════════════════════════════════════════════════
// Phase 3 part 2 — reviews, objections, referrals
// ════════════════════════════════════════════════════════════

export function scheduleReviewAsk({ number, kind, refId, dueAt }) {
  if (!number || !kind || refId == null) return null;
  const existing = get('SELECT * FROM review_asks WHERE kind = ? AND ref_id = ?', [kind, refId]);
  if (existing) return existing;
  run(
    'INSERT INTO review_asks (number, kind, ref_id, status, due_at, created_at) VALUES (?,?,?,?,?,?)',
    [number, kind, refId, 'scheduled', dueAt, new Date().toISOString()]
  );
  saveDB(true);
  return get('SELECT * FROM review_asks WHERE kind = ? AND ref_id = ?', [kind, refId]);
}

export function dueReviewAsks(nowIso = new Date().toISOString(), limit = 20) {
  return all("SELECT * FROM review_asks WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at LIMIT ?", [nowIso, limit]);
}

export function reviewAsk(id) {
  return get('SELECT * FROM review_asks WHERE id = ?', [id]);
}

export function reviewAskFor(number) {
  return get("SELECT * FROM review_asks WHERE number = ? AND status IN ('scheduled','asked') ORDER BY id DESC LIMIT 1", [number]);
}

export function setReviewAsk(id, { status, rating = null } = {}) {
  run('UPDATE review_asks SET status = COALESCE(?, status), rating = COALESCE(?, rating), updated_at = ? WHERE id = ?', [
    status ?? null,
    rating,
    new Date().toISOString(),
    id,
  ]);
  saveDB(true);
}

export function reviewStats(sinceIso) {
  return all(
    `SELECT status, COUNT(*) AS count, AVG(rating) AS avg_rating
       FROM review_asks WHERE created_at >= ? GROUP BY status`,
    [sinceIso]
  );
}

export function logObjection({ number, kind, attempt }) {
  run('INSERT INTO objection_attempts (number, kind, attempt, created_at) VALUES (?,?,?,?)', [
    number,
    kind,
    attempt,
    new Date().toISOString(),
  ]);
  saveDB(true);
}

export function objectionAttempts(number, kind) {
  return get('SELECT COUNT(*) AS c FROM objection_attempts WHERE number = ? AND kind = ?', [number, kind])?.c || 0;
}

export function saveReferral({ code, number }) {
  run('INSERT OR IGNORE INTO referrals (code, number, uses, created_at) VALUES (?,?,0,?)', [code, number, new Date().toISOString()]);
  saveDB(true);
  return get('SELECT * FROM referrals WHERE code = ?', [code]);
}

export function getReferral(code) {
  if (!code) return null;
  return get('SELECT * FROM referrals WHERE code = ?', [String(code).toUpperCase()]);
}

export function referralFor(number) {
  return get('SELECT * FROM referrals WHERE number = ? ORDER BY created_at DESC LIMIT 1', [number]);
}

export function bumpReferral(code) {
  run('UPDATE referrals SET uses = COALESCE(uses, 0) + 1 WHERE code = ?', [String(code).toUpperCase()]);
  saveDB(true);
  return getReferral(code);
}

export function recentReferrals(limit = 10) {
  return all('SELECT * FROM referrals ORDER BY created_at DESC LIMIT ?', [limit]);
}

// ════════════════════════════════════════════════════════════
// Phase 3 part 3 — reactivation log, tenant budget, sources
// ════════════════════════════════════════════════════════════

export function logReactivation({ number, segment, cycle, campaign = null, at = null }) {
  run('INSERT INTO reactivation_log (number, segment, cycle, sent_at, campaign) VALUES (?,?,?,?,?)', [
    number,
    segment,
    cycle,
    at || new Date().toISOString(),
    campaign,
  ]);
  saveDB(true);
}

export function reactivationHistory(number) {
  return all('SELECT * FROM reactivation_log WHERE number = ? ORDER BY id DESC', [number]);
}

export function reactivationCountSince(sinceIso) {
  return get('SELECT COUNT(*) AS c FROM reactivation_log WHERE sent_at >= ?', [sinceIso])?.c || 0;
}

export function lastReactivation() {
  return get('SELECT * FROM reactivation_log ORDER BY id DESC LIMIT 1');
}

export function tenantUsage(day = todayKey(), tenant = 'default') {
  return get('SELECT * FROM tenant_usage WHERE day = ? AND tenant = ?', [day, tenant]) || { day, tenant, llm_calls: 0 };
}

export function bumpTenantUsage(tenant = 'default', amount = 1, day = todayKey()) {
  run(
    `INSERT INTO tenant_usage (day, tenant, llm_calls) VALUES (?,?,?)
     ON CONFLICT(day, tenant) DO UPDATE SET llm_calls = llm_calls + excluded.llm_calls`,
    [day, tenant, amount]
  );
  saveDB();
}

/** The first source tag we ever saw for this number, if any. */
export function sourceTags(number) {
  return all("SELECT detail, created_at FROM events WHERE type = 'source_tag' AND number = ? ORDER BY id", [number]);
}

/** Revenue attributed to a source, by the orders of the people who carried it. */
export function revenueBySource(rows = []) {
  let total = 0;
  for (const r of rows) total += Number(r.total) || 0;
  return total;
}

// ════════════════════════════════════════════════════════════
// Self-healing: candidate rules, and who said yes
// ════════════════════════════════════════════════════════════
export function addPendingRule({ number = null, question, answer, source = 'owner_correction', created_at = null } = {}) {
  const at = created_at || new Date().toISOString();
  run(
    'INSERT INTO pending_rules (number, question, answer, status, source, created_at) VALUES (?,?,?,?,?,?)',
    [number, question, answer, 'pending', source, at]
  );
  return get('SELECT * FROM pending_rules ORDER BY id DESC LIMIT 1');
}

export function pendingRules(status = 'pending', limit = 20) {
  return all('SELECT * FROM pending_rules WHERE status = ? ORDER BY id DESC LIMIT ?', [status, limit]);
}

export function getPendingRule(id) {
  return get('SELECT * FROM pending_rules WHERE id = ?', [Number(id)]);
}

export function decidePendingRule(id, status, { reason = null, at = null } = {}) {
  const row = getPendingRule(id);
  if (!row) return null;
  run('UPDATE pending_rules SET status = ?, reason = ?, decided_at = ? WHERE id = ?', [
    status,
    reason,
    at || new Date().toISOString(),
    Number(id),
  ]);
  return getPendingRule(id);
}

/** How many proposals were made since a given day (the daily cap). */
export function rulesProposedSince(iso) {
  return get('SELECT COUNT(*) AS c FROM pending_rules WHERE created_at >= ?', [iso])?.c || 0;
}

/** Any row at all with this question — pending, approved or rejected. */
export function ruleByQuestion(question) {
  const q = String(question || '').trim().toLowerCase();
  if (!q) return null;
  return get('SELECT * FROM pending_rules WHERE LOWER(TRIM(question)) = ? ORDER BY id DESC LIMIT 1', [q]);
}
