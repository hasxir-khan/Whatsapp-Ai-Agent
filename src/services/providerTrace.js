// src/services/providerTrace.js
// Who actually answered, in what time, and why the first choice did not.
//
// With Groq, Gemini and OpenRouter all configured, "which model wrote this?"
// used to be unanswerable — and when one provider timed out the customer could
// get two replies from two different models. Every completed reply now leaves a
// row here: provider, model, latency, tokens and the fallback reason when the
// chain moved. `.debug last` shows the last five (owner only).

import * as db from '../utils/db.js';
import { config } from '../config/env.js';

const MAX_ROWS = 400;

function ensureTable() {
  try {
    db.run(
      `CREATE TABLE IF NOT EXISTS llm_trace (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         tenant TEXT, chat TEXT, kind TEXT, provider TEXT, model TEXT,
         ms INTEGER, tokens INTEGER, fallback TEXT, reason TEXT, ok INTEGER, created_at TEXT
       )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_llm_trace_chat ON llm_trace (chat, id)');
  } catch {
    /* tracing must never break a reply */
  }
}

/**
 * @param {{chat?:string, kind?:string, provider?:string, model?:string, ms?:number,
 *          tokens?:number, fallback?:string|null, reason?:string|null, ok?:boolean,
 *          at?:Date}} entry
 */
export function record(entry = {}) {
  ensureTable();
  try {
    db.run(
      'INSERT INTO llm_trace (tenant, chat, kind, provider, model, ms, tokens, fallback, reason, ok, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [
        config.tenant?.slug || null,
        entry.chat || null,
        entry.kind || 'reply',
        entry.provider || null,
        entry.model || null,
        Number.isFinite(entry.ms) ? Math.round(entry.ms) : null,
        Number.isFinite(entry.tokens) ? Math.round(entry.tokens) : null,
        entry.fallback || null,
        entry.reason ? String(entry.reason).slice(0, 160) : null,
        entry.ok === false ? 0 : 1,
        (entry.at ? new Date(entry.at) : new Date()).toISOString(),
      ]
    );
    db.run('DELETE FROM llm_trace WHERE id <= (SELECT MAX(id) FROM llm_trace) - ?', [MAX_ROWS]);
  } catch {
    /* ignore */
  }
}

export function last(limit = 5) {
  ensureTable();
  try {
    return db.all('SELECT * FROM llm_trace ORDER BY id DESC LIMIT ?', [Math.max(0, limit)]);
  } catch {
    return [];
  }
}

export function lastFor(chat, limit = 5) {
  ensureTable();
  try {
    return db.all('SELECT * FROM llm_trace WHERE chat = ? ORDER BY id DESC LIMIT ?', [chat, Math.max(0, limit)]);
  } catch {
    return [];
  }
}

function ago(iso) {
  const diff = Date.now() - new Date(iso || 0).getTime();
  if (!Number.isFinite(diff) || diff < 0) return 'now';
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** The `.debug last` body: the last five replies, one line each. */
export function formatLast({ limit = 5 } = {}) {
  const rows = last(limit);
  if (!rows.length) return 'No model calls recorded yet since this database was created.';
  const lines = ['🧪 Last replies (newest first)'];
  for (const r of rows) {
    const bits = [
      `${r.provider || '?'}/${r.model || '?'}`,
      r.ms !== null ? `${r.ms} ms` : 'no latency',
      r.tokens ? `${r.tokens} tokens` : 'no token count',
      r.ok ? 'ok' : 'failed',
      r.chat ? `+${r.chat}` : null,
      ago(r.created_at),
    ].filter(Boolean);
    lines.push(`• ${bits.join(' · ')}`);
    if (r.fallback) lines.push(`   fallback: ${r.fallback}${r.reason ? ` — ${r.reason}` : ''}`);
  }
  return lines.join('\n');
}

export function _resetForTests() {
  ensureTable();
  try {
    db.run('DELETE FROM llm_trace');
  } catch {
    /* ignore */
  }
}

export default { record, last, lastFor, formatLast, _resetForTests };
