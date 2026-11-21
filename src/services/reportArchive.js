// The tenant event log has a shorter (30-day) lifetime than some report plans.
// Before its existing purge, retain only sufficient counters, NEVER extend the
// life of a rag_miss question, receipt, note or model output for reporting.
import { alias, cleanCard } from './reportContract.js';
const parsed = (s) => {
  try {
    return JSON.parse(s) || {};
  } catch {
    return {};
  }
};
export function guardBucket(detail) {
  const problems = parsed(detail).problems || [],
    text = Array.isArray(problems) ? problems.join(' | ') : String(problems);
  if (/price range changed|not in the catalogue/i.test(text)) return 'price';
  if (/language: expected/i.test(text)) return 'language';
  if (/cut off:/i.test(text)) return 'cut';
  return /forbidden text/i.test(text) ? 'forbidden' : 'other';
}
export function questionType(text) {
  for (const [label, re] of [
    ['price', /price|cost|kitn|qeemat|قیمت/i],
    ['hours', /open|hours|timing/i],
    ['location', /where|address|location/i],
    ['booking', /book|appointment/i],
    ['delivery', /deliver|ship/i],
    ['payment', /pay|transfer/i],
    ['services', /service|offer/i],
  ])
    if (re.test(text)) return label;
  return 'other';
}
export function normaliseSource(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .trim();
  if (/^(qr|qrcode|qr_code|sticker)$/.test(s)) return 'qr';
  if (/^(link|bio|website|ig_bio|tiktok_bio)$/.test(s)) return 'link';
  if (/^(referral|ref)$/.test(s)) return 'referral';
  if (/^(ads?|ad|facebook|fb|instagram|ig|meta|google|tiktok)$/.test(s)) return 'ads';
  return 'direct';
}
export function initArchive(db) {
  db.run(`CREATE TABLE IF NOT EXISTS report_coverage(id INTEGER PRIMARY KEY,safe_from TEXT);
    CREATE TABLE IF NOT EXISTS report_lead_index(who TEXT PRIMARY KEY,number TEXT UNIQUE);
    CREATE TRIGGER IF NOT EXISTS report_forget_lead AFTER DELETE ON leads BEGIN DELETE FROM report_lead_index WHERE number=OLD.number; END;
    CREATE TABLE IF NOT EXISTS report_signals(at TEXT,metric TEXT,a TEXT,n INTEGER,value REAL,PRIMARY KEY(at,metric,a));
    CREATE TABLE IF NOT EXISTS report_sources(who TEXT,type TEXT,at TEXT,source TEXT,PRIMARY KEY(who,type));
    CREATE TABLE IF NOT EXISTS report_archive(id INTEGER PRIMARY KEY,at TEXT,data TEXT);
    CREATE INDEX IF NOT EXISTS rpt_event_purge ON events(created_at);`);
  db.run('INSERT OR IGNORE INTO report_coverage VALUES(1,?)', [
    new Date(Date.now() - 30 * 86400000).toISOString(),
  ]);
}
const signals = {
  duplicate_reply_blocked: 'doubleRepliesBlocked',
  reply_superseded: 'doubleRepliesBlocked',
  handoff: 'handoffs',
  closer_handoff: 'handoffs',
  complaint_handoff: 'handoffs',
  closer_discount_handoff: 'handoffs',
  inbox_reply: 'ownerReplies',
  bot_disclosure: 'botHonesty',
  reply_cut_detected: 'midSentenceCuts',
  reply_clipped_to_sentence: 'midSentenceCuts',
};
export function archiveBeforePurge(db, rows, retainedFrom, deleteBefore) {
  const secret = process.env.PLATFORM_TENANT_TOKEN;
  db.run('SAVEPOINT report_expiry');
  try {
    for (const t of ['report_signals', 'report_sources', 'report_archive'])
      db.run(`DELETE FROM ${t} WHERE at<?`, [retainedFrom]);
    for (const e of rows(
      'SELECT id,type,number,detail,created_at FROM events WHERE created_at>=? AND created_at<? ORDER BY id',
      [retainedFrom, deleteBefore],
    )) {
      let metric = 'accuracy',
        a = Object.hasOwn(signals, e.type) ? signals[e.type] : undefined,
        value = 0;
      if (e.type === 'reply_guard_rejected')
        a = {
          price: 'priceMismatch',
          language: 'wrongLanguage',
          cut: 'midSentenceCuts',
          forbidden: 'forbiddenText',
        }[guardBucket(e.detail)];
      if (e.type === 'rag_miss') {
        metric = 'unanswered';
        a = questionType(e.detail);
      }
      if (e.type === 'quote_sent' || e.type === 'quote_built') {
        metric = 'funnel';
        a = 'quotes';
      }
      if (e.type === 'report_voice_seconds') {
        metric = 'voice';
        a = '';
        value = Number(parsed(e.detail).seconds) || 0;
      }
      if (e.type === 'analyst_report_sent')
        db.run('INSERT OR REPLACE INTO report_archive VALUES(?,?,?)', [
          e.id,
          e.created_at,
          JSON.stringify(cleanCard('analyst', { ...parsed(e.detail), at: e.created_at })),
        ]);
      if (secret && ['source_tag', 'referral_attributed'].includes(e.type))
        db.run('INSERT OR IGNORE INTO report_sources VALUES(?,?,?,?)', [
          alias(e.number, secret),
          e.type,
          e.created_at,
          e.type === 'source_tag' ? normaliseSource(e.detail) : 'referral',
        ]);
      if (a !== undefined)
        db.run(
          `INSERT INTO report_signals VALUES(?,?,?,1,?) ON CONFLICT DO UPDATE SET n=n+1,value=value+excluded.value`,
          [e.created_at.slice(0, 16) + ':00.000Z', metric, a, value],
        );
    }
    db.run('DELETE FROM events WHERE created_at<?', [deleteBefore]);
    db.run('RELEASE report_expiry');
  } catch (err) {
    db.run('ROLLBACK TO report_expiry');
    db.run('RELEASE report_expiry');
    throw err;
  }
}
