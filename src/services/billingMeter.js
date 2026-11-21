import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { get, all, run, saveDB, isOptedOut } from '../utils/db.js';
import { config, isTeam } from '../config/env.js';
import { workerAccess, billedWorker } from './billingLease.js';
const metric = { chat: 'conversations_month', voice: 'voice_minutes', video: 'videos_month' };
const rawSend = new WeakMap();
const copy = 'Thanks for your message. A team member will need to help you directly.';
function setup(month) {
  run(
    'CREATE TABLE IF NOT EXISTS billing_counts(month TEXT,kind TEXT,who TEXT,n INTEGER NOT NULL, PRIMARY KEY(month,kind,who))'
  );
  run('DELETE FROM billing_counts WHERE month<?', [month]);
}
function key(who) {
  const salt = process.env.TENANT_METER_KEY;
  if (!salt) throw Error('billing_meter_unavailable');
  return createHmac('sha256', salt).update(String(who)).digest('hex');
}
function summary(month) {
  const totals = Object.fromEntries(
    all(
      "SELECT kind,sum(n) n FROM billing_counts WHERE month=? AND kind IN ('chat','voice','video') GROUP BY kind",
      [month]
    ).map((r) => [r.kind, r.n])
  );
  const limits = all("SELECT who FROM billing_counts WHERE month=? AND kind='limit'", [month]).map(
    (r) => r.who
  );
  const doc = {
    month,
    conversations_month: totals.chat || 0,
    voice_seconds: totals.voice || 0,
    videos_month: totals.video || 0,
    limits,
  };
  const file = path.join(process.env.DATA_DIR, 'billing-usage.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(doc), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  saveDB(true);
}
export function admit(kind, units = 1, who = '', now = Date.now()) {
  const e = workerAccess(now);
  if (!e) return true;
  if (!e.canRun || !metric[kind] || !Number.isSafeInteger(units) || units < 1) return false;
  const month = new Date(now).toISOString().slice(0, 7);
  setup(month);
  const actor = kind === 'chat' ? key(who) : '';
  if (
    kind === 'chat' &&
    get('SELECT 1 FROM billing_counts WHERE month=? AND kind=? AND who=?', [month, kind, actor])
  )
    return true;
  const cap = e.limits[metric[kind]] * (kind === 'voice' ? 60 : 1);
  const used = get('SELECT COALESCE(sum(n),0) n FROM billing_counts WHERE month=? AND kind=?', [
    month,
    kind,
  ]).n;
  if (used + units > cap) {
    run("INSERT OR IGNORE INTO billing_counts VALUES(?,'limit',?,1)", [month, metric[kind]]);
    summary(month);
    return false;
  }
  run('INSERT INTO billing_counts VALUES(?,?,?,?) ON CONFLICT(month,kind,who) DO UPDATE SET n=n+excluded.n', [
    month,
    kind,
    actor,
    units,
  ]);
  summary(month);
  return true;
}
// Never give a general-purpose sender a bypass. Only these fixed strings can leave
// while paused. Silent by default, at most one direct handover per contact per day.
export async function handover(t, jid, number, now = Date.now()) {
  const e = workerAccess(now);
  if (
    !e ||
    (!e.canRun && !e.pausedReply) ||
    isOptedOut(number) ||
    (t.kind === 'cloud' && !t.windowOpen(number))
  )
    return;
  const day = new Date(now).toISOString().slice(0, 10),
    month = day.slice(0, 7);
  setup(month);
  const actor = key(number + day);
  if (get("SELECT 1 FROM billing_counts WHERE month=? AND kind='handover' AND who=?", [month, actor])) return;
  run("INSERT INTO billing_counts VALUES(?,'handover',?,1)", [month, actor]);
  saveDB(true);
  return rawSend.has(t) ? rawSend.get(t)(jid, { text: copy }) : t.sendMessage(jid, { text: copy });
}
export function protectTransport(t) {
  if (!billedWorker() || rawSend.has(t)) return;
  const send = t.send.bind(t);
  rawSend.set(t, send);
  const guard = (jid) => {
    const e = workerAccess();
    if (!e?.canRun) throw Error('assistant_paused');
    const number = String(jid).split('@')[0];
    if (number !== config.owner.number && !isTeam(number) && !admit('chat', 1, number))
      throw Error('assistant_limit');
  };
  t.send = async (jid, payload) => {
    guard(jid);
    return send(jid, payload);
  };
  // Cloud interactive messages can post directly without using send().
  if (typeof t.sendButtons === 'function') {
    const buttons = t.sendButtons.bind(t);
    t.sendButtons = async (jid, payload) => {
      guard(jid);
      return buttons(jid, payload);
    };
  }
}

export async function deliverOwnerNotices(t, now = Date.now()) {
  const e = workerAccess(now);
  if (!e?.canRun || !rawSend.has(t) || (t.kind === 'cloud' && !t.windowOpen(config.owner.number))) return;
  const month = new Date(now).toISOString().slice(0, 7);
  setup(month);
  for (const n of e.notices || []) {
    if (![1, 3, 7].includes(n.days) || Date.parse(n.end) <= +new Date(now)) continue;
    run('CREATE TABLE IF NOT EXISTS billing_notice(id TEXT PRIMARY KEY,at TEXT NOT NULL)');
    run('DELETE FROM billing_notice WHERE at<?', [new Date(+new Date(now) - 32 * 86400000).toISOString()]);
    if (get('SELECT 1 FROM billing_notice WHERE id=?', [n.id])) continue;
    run('INSERT INTO billing_notice VALUES(?,?)', [n.id, new Date(now).toISOString()]);
    saveDB(true);
    try {
      await rawSend.get(t)(config.owner.jid, {
        text: `Your assistant term ends on ${n.end.slice(0, 10)} UTC. Open Billing to review it.`,
      });
    } catch {
      run('DELETE FROM billing_notice WHERE id=?', [n.id]);
      saveDB(true);
    }
  }
}
