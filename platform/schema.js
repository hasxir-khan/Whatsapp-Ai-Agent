// platform/schema.js
// The platform's own tables. One schema, two dialects.
//
// SQLite is what runs today (sql.js, like the bot — no native modules). Every
// statement is written so the Postgres version is a mechanical swap rather than
// a rewrite: text ids, ISO-8601 timestamps in TEXT, no dialect-only functions in
// queries, and placeholders converted by db.js when the dialect is `postgres`.

const SQLITE = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    email_norm TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'owner',
    status TEXT NOT NULL DEFAULT 'active',
    email_verified INTEGER NOT NULL DEFAULT 0,
    trial_seen INTEGER NOT NULL DEFAULT 0,
    disposable_domain INTEGER NOT NULL DEFAULT 0,
    exported_at TEXT,
    created_at TEXT NOT NULL,
    last_login_at TEXT,
    deleted_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    revoked_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS otp_codes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    account_id TEXT,
    purpose TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS consents (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    version TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    ip TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    trial_days INTEGER NOT NULL DEFAULT 14,
    price INTEGER NOT NULL DEFAULT 0,
    limits TEXT NOT NULL,
    features TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tenants (
    slug TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    number TEXT,
    plan_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    provision_step INTEGER NOT NULL DEFAULT 0,
    provision_error TEXT,
    paused_reason TEXT,
    trial_ends_at TEXT,
    link_status TEXT NOT NULL DEFAULT 'unlinked',
    link_updated_at TEXT,
    link_error TEXT,
    template TEXT,
    port INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memberships (
    account_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    role TEXT NOT NULL, -- owner | staff
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, slug)
  )`,
  `CREATE TABLE IF NOT EXISTS tenant_secrets (
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (slug, name)
  )`,
  `CREATE TABLE IF NOT EXISTS wizard_drafts (
    slug TEXT PRIMARY KEY,
    step INTEGER NOT NULL DEFAULT 1,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant TEXT NOT NULL,
    event_uid TEXT,
    created_at TEXT NOT NULL,
    day TEXT NOT NULL,
    month TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    agent TEXT,
    kind TEXT NOT NULL,
    conversation TEXT,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    estimated INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS usage_events_tenant_uid ON usage_events (tenant, event_uid)`,
  `CREATE INDEX IF NOT EXISTS usage_events_tenant_day ON usage_events (tenant, day)`,
  `CREATE TABLE IF NOT EXISTS platform_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    account_id TEXT,
    tenant TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    ip TEXT,
    ok INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS platform_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    account_id TEXT NOT NULL,
    tenant TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    read_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS trial_numbers (
    number TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    granted_at TEXT NOT NULL
  )`,
  // A tenant's own AI keys. `secret` is an AES-256-GCM envelope, never the key;
  // `fingerprint` is the last four characters, which is all any screen shows.
  `CREATE TABLE IF NOT EXISTS tenant_keys (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    provider TEXT NOT NULL,
    slot INTEGER NOT NULL,
    key_version INTEGER NOT NULL DEFAULT 1,
    fingerprint TEXT NOT NULL,
    fingerprint_hash TEXT,
    secret TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    label TEXT,
    added_by TEXT,
    created_at TEXT NOT NULL,
    rotated_at TEXT,
    revoked_at TEXT,
    last_used_at TEXT,
    last_tested_at TEXT,
    test_state TEXT,
    health TEXT NOT NULL DEFAULT 'unknown',
    health_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS tenant_keys_slug ON tenant_keys (slug, provider, status)`,
  // One row per compatibility run. Consent is recorded with it, because the run
  // spends the customer's own quota.
  `CREATE TABLE IF NOT EXISTS compatibility_runs (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL,
    categories TEXT,
    scenarios INTEGER NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 0,
    consent_at TEXT,
    created_at TEXT NOT NULL,
    detail TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS compatibility_runs_slug ON compatibility_runs (slug, created_at)`,
  // Every settings write keeps the profile it replaced, so "undo" is a fact
  // rather than a hope. 0700 folder, one row per write, pruned to the last 20.
  `CREATE TABLE IF NOT EXISTS settings_undo (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    token TEXT NOT NULL,
    before TEXT NOT NULL,
    changed TEXT,
    account_id TEXT,
    created_at TEXT NOT NULL,
    undone_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS settings_undo_slug ON settings_undo (slug, created_at)`,
];

const POSTGRES = JSON.parse(
  JSON.stringify(SQLITE)
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'BIGSERIAL PRIMARY KEY')
    .replace(/\bINTEGER\b/g, 'INTEGER')
    .replace(/`/g, "'"),
);

/** Bumped when a column is added so `migrate()` knows what to do. */
export const SCHEMA_VERSION = 2;

/**
 * Columns added after the first release. `initPlatformDb` applies them one by
 * one and ignores "duplicate column", so an old platform.db upgrades in place
 * without losing a row.
 */
export const MIGRATIONS = [
  'ALTER TABLE usage_events ADD COLUMN key_slot INTEGER',
  'ALTER TABLE usage_events ADD COLUMN key_last4 TEXT',
  'ALTER TABLE usage_events ADD COLUMN key_ref TEXT',
  'ALTER TABLE usage_events ADD COLUMN error_category TEXT',
  'ALTER TABLE tenants ADD COLUMN test_chat_at TEXT',
  'ALTER TABLE tenants ADD COLUMN key_source TEXT',
  'ALTER TABLE tenants ADD COLUMN model TEXT',
  'ALTER TABLE tenants ADD COLUMN model_override INTEGER NOT NULL DEFAULT 0',
];

export function schemaStatements(dialect = 'sqlite') {
  return dialect === 'postgres' ? POSTGRES : SQLITE;
}

/**
 * Seed plans. Entitlements only — there is no payment code anywhere in this
 * folder, and `price` is a label the owner sets, not something we charge.
 */
export const PLAN_SEEDS = [
  {
    id: 'free',
    name: 'Free trial',
    trial_days: 14,
    price: 0,
    limits: { dashboard_days: 31, conversations_month: 200, agents: 2, numbers: 1, voice_minutes: 0, llm_calls_day: 100 },
    features: ['liveInbox'],
  },
  {
    id: 'starter',
    name: 'Starter',
    trial_days: 14,
    price: 2500,
    limits: { dashboard_days: 60, conversations_month: 1500, agents: 4, numbers: 1, voice_minutes: 60, llm_calls_day: 600 },
    features: ['liveInbox', 'bookingAgent', 'followUpAgent', 'pdfInvoices', 'growthApproval'],
  },
  {
    id: 'growth',
    name: 'Growth',
    trial_days: 14,
    price: 6000,
    limits: { dashboard_days: 90, conversations_month: 6000, agents: 8, numbers: 2, voice_minutes: 300, llm_calls_day: 2000 },
    features: [
      'liveInbox', 'bookingAgent', 'followUpAgent', 'pdfInvoices', 'growthApproval',
      'analystAgent', 'closerAgent', 'reviewAgent', 'visualSearch', 'selfHealing',
      'multiAgent', 'conversationControl', 'marketingAgents', 'businessBrain', 'reasoning', 'sourceLinks',
      'reactivationAgent', 'contentAgent', 'mcpTools', 'privacyTools',
    ],
  },
];

export default { schemaStatements, SCHEMA_VERSION, MIGRATIONS, PLAN_SEEDS };
