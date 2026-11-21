// Reproducible, offline end-to-end read budget; includes session + ACL + SQL +
// SSR + loopback HTTP. The worker and importer run first, never on a page read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tenant,
  db,
  reports,
  store,
  serve,
  operatorHeaders,
  dir,
  now,
  midnight,
  day,
  zone,
  shiftDay,
  slug,
  pages,
  owner,
} from './fixtures/dashboard.js';

const BUDGET_MS = 350,
  N = 50000;
test('50,000 observations over 90 business dates: every dashboard page inside its warm p95 budget', async () => {
  const start = performance.now(),
    dates = Array.from({ length: 90 }, (_, i) => Date.parse(midnight(shiftDay(day, i - 89), zone)));
  const sql = tenant.getDB(),
    insert = sql.prepare('INSERT INTO messages(number,role,content,created_at) VALUES(?,?,?,?)'),
    route = sql.prepare("INSERT INTO agent_events(chat,agent,kind,created_at) VALUES(?,'sales','route',?)"),
    lead = sql.prepare('INSERT INTO leads(number,created_at) VALUES(?,?)'),
    payment = sql.prepare(
      "INSERT INTO decision_requests(id,type,status,created_at) VALUES(?,'payment','pending',?)",
    ),
    call = db
      .ensureOpen()
      .prepare(
        "INSERT INTO usage_events(tenant,event_uid,day,month,created_at,kind,provider,agent,total_tokens,estimated) VALUES(?,?,?,?,?,'chat','groq','sales',80,1)",
      );
  for (let i = 0; i < N; i++) {
    const at = new Date(dates[i % 90] + (Math.floor(i / 90) % 600) * 60000).toISOString(),
      who = String(100000 + (i % 192)),
      k = i % 7;
    if (k < 3) insert.run([who, k === 2 ? 'assistant' : 'user', 'Are you open?', at]);
    else if (k === 3) route.run([who, at]);
    else if (k === 4) lead.run([String(i + 300000), at]);
    else if (k === 5) payment.run(['DR-' + i, at]);
    else call.run([slug, 'event-' + i, at.slice(0, 10), at.slice(0, 7), at]);
  }
  for (const st of [insert, route, lead, payment, call]) st.free();
  await reports.publishReports({ dir, now, days: 90, zone });
  await store.reconcileTenant(slug, { dir, now });
  assert.equal(db.get('SELECT COUNT(*) n FROM r_days').n, 90);
  assert.equal(
    db.get("SELECT SUM(n) n FROM r_facts WHERE metric='messages' AND hour=-1").n +
      db.get("SELECT SUM(n) n FROM r_facts WHERE metric='agent' AND hour=-1").n +
      db.get("SELECT COUNT(*) n FROM r_cards WHERE kind IN ('leads','payments')").n +
      db.get('SELECT SUM(calls) n FROM r_usage WHERE hour=-1').n,
    N,
  );
  // A page consulting a raw ledger now fails, rather than merely benchmarking
  // a lucky query plan. The tenant store has no business being opened either.
  db.run('ALTER TABLE usage_events RENAME TO unavailable_replay_ledger');
  console.log(`Materialised ${N} observations in ${Math.round(performance.now() - start)} ms`);
  const { http, origin } = await serve();
  try {
    for (const name of [...pages, 'operator']) {
      const url =
        name === 'operator'
          ? '/platform/operator'
          : `/platform/reports/${slug}/${name}?range=custom&from=${shiftDay(day, -89)}&to=${day}`;
      const headers =
        name === 'operator'
          ? await operatorHeaders(origin)
          : { cookie: owner.cookie };
      const times = [];
      for (let i = 0; i < 8; i++) {
        const a = performance.now();
        const r = await fetch(origin + url, { headers });
        assert.equal(r.status, 200, name);
        await r.text();
        if (i) times.push(performance.now() - a);
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.ceil(times.length * 0.95) - 1];
      console.log(`${name}: p95 ${p95.toFixed(1)} ms, budget ${BUDGET_MS} ms`);
      assert.ok(p95 < BUDGET_MS, `${name}: ${p95}ms exceeds ${BUDGET_MS}ms`);
    }
  } finally {
    await new Promise((r) => http.close(r));
    db.closePlatformDb();
  }
});
