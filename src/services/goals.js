// src/services/goals.js
// Phase 6 Part 3 — goals the owner sets in one line.
//
// ".goal add 20 orders by 2026-12-31" — the metric is read from the database,
// never from the owner's wording. Three active goals at most, because more than
// that is a wish list, not a plan.

import { featureOn } from './profile.js';
import { config } from '../config/env.js';
import * as db from '../utils/db.js';

export const MAX_ACTIVE_GOALS = 3;
export const METRICS = ['bookings', 'orders', 'revenue', 'leads', 'reviews'];

const DAY = 24 * 3600 * 1000;

export function goalsEnabled() {
  return featureOn('businessBrain');
}

const tenant = () => config.tenant?.slug || null;

function metricCount(metric, since, until = new Date().toISOString()) {
  switch (metric) {
    case 'bookings':
      return Number(db.get('SELECT COUNT(*) AS n FROM bookings WHERE created_at >= ? AND created_at <= ?', [since, until])?.n) || 0;
    case 'orders':
      return Number(db.get("SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND created_at <= ? AND status NOT IN ('cancelled')", [since, until])?.n) || 0;
    case 'revenue':
      return Number(db.get("SELECT COALESCE(SUM(total),0) AS n FROM orders WHERE created_at >= ? AND created_at <= ? AND status IN ('paid','delivered','completed')", [since, until])?.n) || 0;
    case 'leads':
      return Number(db.get('SELECT COUNT(*) AS n FROM leads WHERE created_at >= ? AND created_at <= ?', [since, until])?.n) || 0;
    case 'reviews':
      return Number(db.get("SELECT COUNT(*) AS n FROM review_asks WHERE created_at >= ? AND created_at <= ? AND status = 'rated'", [since, until])?.n) || 0;
    default:
      return 0;
  }
}

/** Parse `.goal add 20 orders by 2026-12-31`. */
export function parseGoal(text = '') {
  const body = String(text || '').trim();
  const m = body.match(/(\d[\d,]*)\s*(bookings?|orders?|revenue|leads?|reviews?)/i);
  const date = body.match(/\b(\d{4}-\d{2}-\d{2})\b/) || body.match(/\bby\s+(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\b/i);
  if (!m) return { ok: false, reason: 'no metric in that — try: .goal add 20 orders by 2026-12-31' };
  const rawMetric = m[2].toLowerCase();
  const metric = rawMetric.startsWith('booking') ? 'bookings' : rawMetric.startsWith('order') ? 'orders' : rawMetric.startsWith('lead') ? 'leads' : rawMetric.startsWith('review') ? 'reviews' : 'revenue';
  const target = Number(m[1].replace(/,/g, ''));
  if (!(target > 0)) return { ok: false, reason: 'the target must be a positive number' };
  if (!date) return { ok: false, reason: 'add a date: .goal add 20 orders by 2026-12-31' };

  let iso = date[1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const parts = iso.split(/[\/-]/).map(Number);
    const [d, mo, y] = parts;
    iso = `${y < 100 ? 2000 + y : y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const due = new Date(`${iso}T23:59:59Z`);
  if (Number.isNaN(due.getTime())) return { ok: false, reason: 'that date does not read as a date' };
  if (due.getTime() <= Date.now()) return { ok: false, reason: 'that date is in the past' };
  return { ok: true, metric, target, dueAt: due.toISOString(), due: iso };
}

export function addGoal({ metric, target, dueAt, now = new Date() } = {}) {
  const active = db.all("SELECT * FROM goals WHERE tenant = ? AND status = 'active'", [tenant()]);
  if (active.length >= MAX_ACTIVE_GOALS) {
    return { ok: false, reason: `you already have ${MAX_ACTIVE_GOALS} active goals — finish or drop one first:\n${active.map((g) => `  #${g.id} ${g.metric} ${g.target} by ${g.due_at.slice(0, 10)}`).join('\n')}` };
  }
  db.run('INSERT INTO goals (tenant, metric, target, due_at, status, created_at) VALUES (?,?,?,?,?,?)', [
    tenant(),
    metric,
    Math.round(target),
    dueAt,
    'active',
    now.toISOString(),
  ]);
  const goal = db.get('SELECT * FROM goals WHERE tenant = ? ORDER BY id DESC LIMIT 1', [tenant()]);
  return { ok: true, goal };
}

export function listGoals({ status = null } = {}) {
  return status
    ? db.all('SELECT * FROM goals WHERE tenant = ? AND status = ? ORDER BY due_at', [tenant(), status])
    : db.all('SELECT * FROM goals WHERE tenant = ? ORDER BY status, due_at', [tenant()]);
}

export function dropGoal(id) {
  const goal = db.get('SELECT * FROM goals WHERE tenant = ? AND id = ?', [tenant(), Number(id)]);
  if (!goal) return { ok: false, reason: 'no goal with that number' };
  db.run("UPDATE goals SET status = 'dropped' WHERE id = ?", [goal.id]);
  return { ok: true, goal };
}

/**
 * Progress from the database: how much is done, how much time is left, and
 * whether the current pace reaches the target.
 */
export function goalProgress(goal, { now = new Date() } = {}) {
  const created = Date.parse(goal.created_at) || now.getTime();
  const due = Date.parse(goal.due_at) || now.getTime();
  const current = metricCount(goal.metric, goal.created_at, now.toISOString());
  const totalMs = Math.max(1, due - created);
  const elapsedMs = Math.max(0, now.getTime() - created);
  const ratio = Math.min(1, elapsedMs / totalMs);
  const projected = ratio > 0.05 ? Math.round(current / ratio) : null;
  const percent = goal.target ? Math.min(100, Math.round((current / goal.target) * 100)) : 0;
  const remainingDays = Math.max(0, Math.ceil((due - now.getTime()) / DAY));

  let status = 'on track';
  if (current >= goal.target) status = 'done';
  else if (projected === null) status = 'too early to project';
  else if (projected < goal.target * 0.8) status = 'off track';
  else if (projected < goal.target) status = 'slightly behind';

  return {
    id: goal.id,
    metric: goal.metric,
    target: goal.target,
    current,
    percent,
    projected,
    remainingDays,
    due: goal.due_at.slice(0, 10),
    status,
    warn: status === 'off track' || (status === 'slightly behind' && remainingDays <= 7),
  };
}

export function goalsText({ now = new Date() } = {}) {
  const goals = listGoals({ status: 'active' });
  const lines = ['🎯 *Goals*', ''];
  if (!goals.length) {
    lines.push('No goals yet. One line sets one:');
    lines.push('  .goal add 20 orders by 2026-12-31');
    lines.push(`Metrics: ${METRICS.join(', ')} · max ${MAX_ACTIVE_GOALS} active`);
    return lines.join('\n');
  }
  for (const goal of goals) {
    const p = goalProgress(goal, { now });
    lines.push(
      `#${goal.id} ${p.metric}: ${p.current}/${p.target} (${p.percent}%) · ${p.remainingDays}d left · ${p.status}` +
        (p.projected !== null ? ` · projected ${p.projected}` : '')
    );
    if (p.warn) lines.push(`   ⚠️ at this pace you finish short — .strategy has the next best actions`);
    if (p.current === 0 && p.remainingDays >= 27) lines.push('   counting starts from when you set the goal');
  }
  lines.push('', `.goal drop <n> removes one · max ${MAX_ACTIVE_GOALS} active`);
  return lines.join('\n');
}

export default { parseGoal, addGoal, listGoals, dropGoal, goalProgress, goalsText, METRICS, MAX_ACTIVE_GOALS, goalsEnabled };
