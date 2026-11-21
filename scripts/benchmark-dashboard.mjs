// Offline fleet read benchmark. One disposable seeder, an external HTTP load
// driver, and a freshly forked server per endpoint. Never open the live DB.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const TENANTS = 50,
  DAYS = 90,
  CLIENTS = 8;
const mib = (n) => +(n / 2 ** 20).toFixed(1);
const round = (n) => +n.toFixed(1);
const quantile = (xs, p) => xs.toSorted((a, b) => a - b)[Math.ceil(xs.length * p) - 1];
const slugFor = (i) => 'bench-' + String(i + 1).padStart(2, '0');
const memory = () => ({
  rssMiB: mib(process.memoryUsage.rss()),
  heapMiB: mib(process.memoryUsage().heapUsed),
  peakRssMiB: mib(process.resourceUsage().maxRSS * 1024),
});

// Feed the real report importer its v1 wire format, not 50 copies of one
// tenant's IDs. Seed the separate per-attempt ledger through its own writer.
async function bundles(slug, secret, at, changed = false) {
  const { alias } = await import('../src/services/reportContract.js');
  const { shiftDay } = await import('../src/services/reportCalendar.js');
  return Array.from({ length: DAYS }, (_, i) => {
    const day = shiftDay(process.env.BENCH_DAY, i - DAYS + 1),
      time = day + 'T12:00:00.000Z';
    const contacts = ['new-' + i, ...[0, 1, 2].map((n) => 'returning-' + ((i + n) % 24))].map((s) =>
      alias(s, secret),
    );
    return JSON.stringify({
      v: 1,
      day,
      at,
      zone: 'UTC',
      eventsComplete: true,
      people: contacts.map((who, j) => ({
        who,
        first_at: time,
        owner: +(j === 1),
        bot: 1,
        source: 'direct',
        response_ms: 60000,
      })),
      facts: [
        ['messages', 'user', '', changed ? 5 : 4],
        ['messages', 'assistant', '', 3],
        ['agent', 'sales', 'route', 2],
        ['source', 'direct', 'leads', 1],
        ['funnel', 'leads', '', 1],
        ['question', 'hours', '', 1],
        ['payment', 'pending', '', 1],
      ].map(([metric, a, b, n]) => ({ metric, hour: 12, a, b, n })),
      cards: [
        { kind: 'leads', at: time, contact: contacts[0], stage: 'new', assigned: 'owner', source: 'direct' },
        { kind: 'activity', at: time, contact: contacts[1], hour: 12, agent: 'sales', type: 'route', count: 2 },
        { kind: 'payments', at: time, type: 'payment', state: 'pending', order: i + 1, amount: 50 },
      ],
      current:
        i === DAYS - 1
          ? { currency: 'PKR', hoursKnown: true, minutesPerChat: 4, health: { lastMessage: time } }
          : null,
    });
  });
}
async function seed() {
  const db = await import('../platform/db.js'),
    { seedPlans } = await import('../platform/plans.js');
  const { recordConsent } = await import('../platform/accounts.js'),
    { issueSession } = await import('../platform/session.js');
  const { importReports, refreshMeter } = await import('../platform/reportStore.js'),
    { record } = await import('../platform/usage.js');
  const { pages } = await import('../platform/dashboard.js');
  await db.initPlatformDb();
  seedPlans();
  const accounts = [],
    checkpoints = [],
    at = new Date().toISOString(),
    start = performance.now();
  for (let i = 0; i < TENANTS; i++) {
    const slug = slugFor(i),
      id = randomUUID(),
      email = id + '@example.invalid',
      secret = randomBytes(24).toString('base64url');
    db.run('INSERT INTO accounts(id,email,email_norm,email_verified,created_at) VALUES(?,?,?,1,?)', [
      id,
      email,
      email,
      at,
    ]);
    recordConsent(id);
    db.run(
      "INSERT INTO tenants(slug,account_id,name,status,plan_id,created_at,updated_at) VALUES(?,?,?,'active','growth',?,?)",
      [slug, id, slug, at, at],
    );
    db.run("INSERT INTO memberships VALUES(?,?,'owner',?)", [id, slug, at]);
    db.run("INSERT INTO tenant_secrets VALUES(?,'PLATFORM_TENANT_TOKEN',?,?)", [slug, secret, at]);
    accounts.push({
      slug,
      cookie: issueSession(id)
        .cookies.map((s) => s.split(';')[0])
        .join('; '),
    });
    const lines = await bundles(slug, secret, at);
    assert.equal(importReports(slug, lines).imported, DAYS);
    for (const line of lines) {
      const { day } = JSON.parse(line);
      assert.ok(
        record({
          tenant: slug,
          uid: randomUUID(),
          at: day + 'T12:00:00.000Z',
          chatKey: 'returning-' + day.slice(-2),
          kind: 'chat',
          agent: 'sales',
          provider: 'groq',
          model: 'openai/gpt-oss-120b',
          totalTokens: 80,
        }).ok,
      );
    }
    assert.equal(refreshMeter(slug), DAYS);
    if ([1, 25, TENANTS].includes(i + 1)) {
      const times = [];
      for (let j = 0; j < 5; j++) {
        const a = performance.now();
        assert.ok(db.flush());
        times.push(performance.now() - a);
      }
      checkpoints.push({
        tenants: i + 1,
        dbMiB: mib(fs.statSync(db.currentFile()).size),
        flushMedianMs: round(quantile(times, 0.5)),
      });
    }
  }
  const spans = db.all('SELECT COUNT(*) dates,MIN(day) first,MAX(day) last FROM r_days GROUP BY slug');
  assert.equal(spans.length, TENANTS);
  assert.ok(
    spans.every((s) => s.dates === DAYS && s.first === spans[0].first && s.last === process.env.BENCH_DAY),
  );
  const counts = Object.fromEntries(
    ['r_days', 'r_people', 'r_facts', 'r_cards', 'usage_events', 'r_usage', 'r_meter', 'sessions'].map((t) => [
      t,
      db.get(`SELECT COUNT(*) n FROM ${t}`).n,
    ]),
  );
  assert.equal(counts.r_people, TENANTS * DAYS * 4);
  assert.equal(counts.r_cards, TENANTS * DAYS * 3);
  assert.equal(counts.usage_events, TENANTS * DAYS);
  assert.equal(counts.sessions, TENANTS);
  const result = {
    accounts,
    pages,
    first: spans[0].first,
    metrics: { seedMs: round(performance.now() - start), counts, checkpoints, ...memory() },
  };
  db.closePlatformDb();
  return result;
}
async function server() {
  const { createPlatformServer } = await import('../platform/index.js'),
    db = await import('../platform/db.js');
  const { importReports } = await import('../platform/reportStore.js');
  const before = memory(),
    a = performance.now();
  await db.initPlatformDb(); // normal DB save timer on; no background report/import job in read trials
  const openMs = round(performance.now() - a),
    http = createPlatformServer();
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let pendingBatch;
  process.on('message', async (command) => {
    if (command === 'stop') {
      delay.disable();
      http.closeAllConnections();
      await new Promise((r) => http.close(r));
      db.closePlatformDb();
      process.disconnect();
    } else if (command === 'measure') {
      delay.reset();
      process.send(true);
    } else if (command === 'stats') {
      process.send({ ...memory(), loopMaxMs: round(delay.max / 1e6) });
    } else if (command === 'prepareImport') {
      const slug = slugFor(0),
        secret = db.get("SELECT value FROM tenant_secrets WHERE slug=? AND name='PLATFORM_TENANT_TOKEN'", [
          slug,
        ]).value;
      pendingBatch = await bundles(slug, secret, new Date().toISOString(), true);
      process.send(true);
    } else if (command === 'import') {
      // Time a real changed generation including synchronous file exports. A
      // callback already queued on the same loop cannot run until it finishes.
      const a = performance.now(),
        next = new Promise((r) => setImmediate(() => r(performance.now() - a)));
      const result = importReports(slugFor(0), pendingBatch);
      assert.equal(result.imported, DAYS);
      assert.ok(result.ok);
      process.send({
        changedDates: result.imported,
        importMs: round(performance.now() - a),
        queuedCallbackMs: round(await next),
        ...memory(),
      });
    }
  });
  process.send({
    port: http.address().port,
    openMs,
    rssBeforeOpenMiB: before.rssMiB,
    rssReadyMiB: memory().rssMiB,
  });
}
async function withChild(mode, env, fn) {
  const cp = fork(fileURLToPath(import.meta.url), [mode], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const exit = once(cp, 'exit');
  const recv = () =>
    Promise.race([
      once(cp, 'message').then(([v]) => v),
      exit.then(([code]) => {
        throw Error(`Benchmark ${mode} exited early: ${code}`);
      }),
    ]);
  try {
    const ready = await recv();
    return await fn(ready, (cmd) => {
      const p = recv();
      cp.send(cmd);
      return p;
    });
  } finally {
    if (cp.connected) cp.send('stop');
    const [code] = await exit;
    assert.equal(code, 0, mode);
  }
}
async function load(n, width, request) {
  const times = [];
  let next = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < n) {
        const i = next++,
          a = performance.now();
        await request(i);
        times.push(performance.now() - a);
      }
    }),
  );
  return {
    p50: round(quantile(times, 0.5)),
    p95: round(quantile(times, 0.95)),
    rps: round((n * 1000) / (performance.now() - start)),
  };
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-fleet-bench-'));
  try {
    const env = {
      ...Object.fromEntries(
        ['PATH', 'HOME', 'SystemRoot'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
      ),
      BENCH_DAY: new Date().toISOString().slice(0, 10),
      NODE_ENV: 'test',
      ENV_FILE: path.join(root, '.env'),
      PLATFORM_DIR: path.join(root, 'platform'),
      TENANTS_DIR: path.join(root, 'tenants'),
      DATA_DIR: path.join(root, 'data'),
      CONFIG_DIR: path.join(root, 'config'),
      TMP_DIR: path.join(root, 'tmp'),
      SESSION_FOLDER: path.join(root, 'session'),
      PLATFORM_ENABLED: '1',
      PLATFORM_DASHBOARD: '1',
      PLATFORM_SECRET: randomUUID(),
      PLATFORM_KEY_SECRET: randomUUID(),
      PLATFORM_OPERATOR_TOKEN: randomUUID(),
      PLATFORM_OPERATOR_EMAIL: 'operator@example.invalid',
    };
    const fixture = await withChild('seed', env, async (r) => r);
    console.log(
      JSON.stringify({
        node: process.version,
        os: os.platform() + ' ' + os.arch(),
        cpus: os.availableParallelism(),
        ramMiB: mib(os.totalmem()),
        tenants: TENANTS,
        days: DAYS,
        concurrency: CLIENTS,
        ...fixture.metrics,
      }),
    );
    for (const [p, name] of [...fixture.pages, 'operator', 'mixed'].entries()) {
      const start = performance.now();
      await withChild('serve', env, async ({ port, openMs, rssBeforeOpenMiB, rssReadyMiB }, ask) => {
        const readyMs = round(performance.now() - start),
          op = name === 'operator',
          mixed = name === 'mixed';
        const urls = mixed ? TENANTS * fixture.pages.length : TENANTS;
        let operatorCookie;
        if (op) {
          const r = await fetch(`http://127.0.0.1:${port}/api/platform/operator/login`, {method:'POST',headers:{'content-type':'application/json','x-operator-login':'1'},body:JSON.stringify({credential:env.PLATFORM_OPERATOR_TOKEN})});
          assert.equal(r.status,200);
          operatorCookie=r.headers.get('set-cookie').split(';')[0];
        }
        async function request(i) {
          const { slug, cookie } = fixture.accounts[(i + p * CLIENTS) % TENANTS];
          const section = mixed
            ? fixture.pages[(Math.floor(i / TENANTS) + (i % TENANTS)) % fixture.pages.length]
            : name;
          const url = op
            ? `/platform/operator?p.tenants=${1 + (i % 2)}`
            : `/platform/reports/${slug}/${section}?range=custom&from=${fixture.first}&to=${env.BENCH_DAY}`;
          const headers = {cookie:op ? operatorCookie : cookie};
          const r = await fetch(`http://127.0.0.1:${port}` + url, { headers, redirect: 'error' }),
            html = await r.text();
          assert.equal(r.status, 200, name);
          assert.ok(
            op
              ? html.includes('Latest worker snapshot')
              : html.includes(`data-slug="${slug}"`) && html.includes('90/90 dates published'),
            name,
          );
        }
        const cold = await load(CLIENTS, CLIENTS, request); // first requests, including new HTTP connections
        await load(urls, CLIENTS, request); // prime every session/URL on this process
        const serial = await load(urls, 1, request);
        await ask('measure');
        const warm = await load(mixed ? urls : 2 * TENANTS, CLIENTS, request);
        console.log(
          JSON.stringify({
            page: name,
            readyMs,
            openMs,
            rssBeforeOpenMiB,
            rssReadyMiB,
            cold,
            serial,
            warm,
            ...(await ask('stats')),
          }),
        );
        if (mixed) {
          await ask('prepareImport');
          const [writerProbe, concurrentBurst] = await Promise.all([
            ask('import'),
            load(CLIENTS, CLIENTS, request),
          ]);
          console.log(JSON.stringify({ writerProbe, concurrentBurst }));
        }
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (process.send && process.argv[2] === 'seed') {
  process.once('message', () => process.disconnect());
  process.send(await seed());
} else if (process.send && process.argv[2] === 'serve') await server();
else await main();
