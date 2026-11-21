import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  tenant,
  db,
  reports,
  store,
  slug,
  phone,
  owner,
  now,
  from,
  day,
  ago,
  zone,
  pages,
  serve,
  operatorHeaders,
} from './fixtures/dashboard.js';

const usage = await import('../platform/usage.js');
const events = await import('../src/services/usageEvents.js');
const { provisionTenant, getTenantSecret } = await import('../platform/provisioning.js');
const { workerFreshness, staleBefore } = await import('../platform/reportFreshness.js');
const jid = phone + '@s.whatsapp.net';
// Independent oracle: compare stored fields, not the production helper to itself.
const encode = (bytes) =>
  'id-' + [...bytes.subarray(0, 8)].map((b) => 'abcdefghijklmnop'[b >> 4] + 'abcdefghijklmnop'[b & 15]).join('');
const hmac = (key, text) => encode(crypto.createHmac('sha256', key).update(text).digest());
const digest = (text) => crypto.createHash('sha256').update(text).digest();
after(() => db.closePlatformDb());

test('published people, leads and activity use the provisioned per-tenant HMAC, stable over dates and JID forms', async (t) => {
  for (const at of [from, ago(1)])
    tenant.run("INSERT INTO messages(number,role,created_at) VALUES(?,'user',?)", [phone, at]);
  tenant.run('INSERT INTO leads(number,created_at) VALUES(?,?)', [phone, from]);
  tenant.run("INSERT INTO agent_events(chat,agent,kind,created_at) VALUES(?,'sales','route',?)", [jid, from]);
  const ids = new Set();
  for (const [i, s] of ['mask-one', 'mask-two'].entries()) {
    assert.equal(
      (
        await provisionTenant({
          slug: s,
          name: s,
          number: `1202555018${i}`,
          city: 'Test City',
          accountId: owner.id,
        })
      ).ok,
      true,
    );
    t.after(() => store.eraseReports(s));
    const key = getTenantSecret(s, 'PLATFORM_TENANT_TOKEN');
    assert.equal(Buffer.from(key, 'base64url').length, 24);
    const expected = hmac(key, 'contact\0' + phone);
    const dir = path.join(process.env.TENANTS_DIR, s, 'data');
    await reports.publishReports({ dir, secret: key, now, days: 2, zone });
    const file = fs.readFileSync(path.join(dir, 'dashboard-v1.jsonl'), 'utf8');
    assert.ok(!file.includes(phone) && !file.includes(key));
    await store.reconcileTenant(s, { dir, now });
    assert.deepEqual(db.all('SELECT who FROM r_people WHERE slug=?', [s]), [{ who: expected }, { who: expected }]);
    assert.deepEqual(db.all("SELECT contact FROM r_cards WHERE slug=? AND kind IN ('activity','leads')", [s]), [
      { contact: expected },
      { contact: expected },
    ]);
    assert.notEqual(expected, encode(digest('contact\0' + phone)));
    ids.add(expected);
  }
  assert.equal(ids.size, 2, 'same input is not linkable across tenants');
  assert.throws(() => reports.tenantDay(day, { now, zone, secret: '' }), /identity_missing/);
});

test('journal, direct sink, old replay, migrated DB and quota agree on one keyed identity; missing worker key omits the ID', async (t) => {
  const install = db.get('SELECT salt FROM number_identity_salt').salt;
  const input = digest(jid).toString('hex').slice(0, 16); // the vulnerable previous journal value
  const oldKey = install + '\0' + slug,
    expected = hmac(oldKey, 'chat\0' + input);
  const expectedWho = hmac(oldKey, 'meter\0' + expected);
  const at = now.toISOString(),
    file = events.journalFile();
  const previous = Object.fromEntries(
    ['PLATFORM_DASHBOARD', 'PLATFORM_USAGE_JOURNAL', 'TENANT_METER_KEY'].map((k) => [k, process.env[k]]),
  );
  t.after(() => {
    events._resetUsageEvents();
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  // A materialised v1 row already has both HMAC layers. The upgrade must not
  // invalidate its high-water mark or meter the returning contact a second time.
  db.run(
    "INSERT INTO usage_events(tenant,event_uid,created_at,day,month,kind,conversation) VALUES(?,?,?,?,?,'chat',?)",
    [slug, crypto.randomUUID(), at, day, day.slice(0, 7), expected],
  );
  store.refreshMeter(slug, now);
  assert.equal(db.get('SELECT who FROM r_meter WHERE slug=?', [slug]).who, expectedWho);
  process.env.PLATFORM_DASHBOARD = '0'; // upgrade also protects installations NOT running an importer
  db.run(
    "INSERT INTO usage_events(tenant,event_uid,created_at,day,month,kind,conversation) VALUES(?,?,?,?,?,'chat',?)",
    [slug, 'old-ledger', at, day, day.slice(0, 7), input],
  );
  db.closePlatformDb();
  await db.initPlatformDb();
  assert.equal(
    db.get('SELECT conversation FROM usage_events WHERE event_uid=?', ['old-ledger']).conversation,
    expected,
  );
  assert.ok(
    !fs.readFileSync(db.currentFile()).includes(input),
    'legacy digest removed from saved DB including free pages',
  );
  usage.attachUsageSink();
  assert.equal(events.recordUsage({ tenant: slug, chatKey: jid, at }).mode, 'sink');
  assert.ok(usage.record({ tenant: slug, chatKey: jid, at }).ok);
  usage.detachUsageSink();
  process.env.PLATFORM_DASHBOARD = '1';
  process.env.PLATFORM_USAGE_JOURNAL = '1';
  process.env.TENANT_METER_KEY = usage.meterKeyForTenant(slug).toString('hex');
  function journal(event) {
    assert.equal(events.recordUsage({ tenant: slug, at, ...event }).mode, 'journal');
    return JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1));
  }
  assert.equal(journal({ chatKey: jid }).conversation, expected);
  const journalBody = fs.readFileSync(file, 'utf8');
  for (const privateValue of [input, phone, install, process.env.TENANT_METER_KEY])
    assert.ok(!journalBody.includes(privateValue));
  fs.appendFileSync(file, JSON.stringify({ uid: 'old-journal', conversation: input, at }) + '\n');
  const importFile = () => usage.ingestJournal({ slug, dataDir: path.dirname(file) });
  assert.equal(importFile().imported, 2);
  fs.writeFileSync(file, journalBody);
  assert.equal(importFile().duplicates, 1);
  store.refreshMeter(slug, now);
  assert.deepEqual(db.all('SELECT DISTINCT conversation FROM usage_events WHERE tenant=?', [slug]), [
    { conversation: expected },
  ]);
  assert.deepEqual(db.all('SELECT who FROM r_meter WHERE slug=?', [slug]), [{ who: expectedWho }]);
  assert.equal(usage.conversations(slug, { month: at.slice(0, 7) }), 1);
  assert.equal(db.get('SELECT SUM(calls) n FROM r_usage WHERE slug=? AND hour=-1', [slug]).n, 6);
  assert.equal(journal({ conversation: phone }).conversation, hmac(oldKey, 'chat\0' + phone));
  const maskShaped = 'id-' + 'a'.repeat(16);
  assert.equal(journal({ conversation: maskShaped }).conversation, hmac(oldKey, 'chat\0' + maskShaped));
  assert.equal(importFile().imported, 2); // drain before changing worker identity in this fixture
  const shadow = 'meter-shadow';
  db.run(
    "INSERT INTO tenants(slug,name,account_id,status,created_at,updated_at) VALUES(?,?,?,'provisioned',?,?)",
    [shadow, shadow, owner.id, at, at],
  );
  process.env.TENANT_METER_KEY = usage.meterKeyForTenant(shadow).toString('hex');
  const second = journal({ tenant: shadow, chatKey: jid }).conversation;
  const shadowKey = install + '\0' + shadow;
  assert.equal(second, hmac(shadowKey, 'chat\0' + input));
  assert.equal(usage.ingestJournal({ slug: shadow, dataDir: path.dirname(file) }).imported, 1);
  store.refreshMeter(shadow, now);
  assert.equal(db.get('SELECT who FROM r_meter WHERE slug=?', [shadow]).who, hmac(shadowKey, 'meter\0' + second));
  assert.notEqual(second, expected);
  delete process.env.TENANT_METER_KEY;
  assert.equal(journal({ conversation: phone, chatKey: jid }).conversation, null);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(phone));
});

test('worker cutoff matches doctor: exactly 15 minutes is not overdue; 1 ms later is', () => {
  const at = staleBefore(now);
  assert.deepEqual(workerFreshness(at, now), { minutes: 15, state: 'fresh' });
  assert.deepEqual(workerFreshness(at, +now + 1), { minutes: 15, state: 'stale' });
  assert.deepEqual(workerFreshness(new Date(+now + 1000).toISOString(), now), { minutes: 0, state: 'fresh' });
  assert.deepEqual(workerFreshness(null, now), { minutes: null, state: 'missing' });
});

test('every served report shows worker age and explicit stale/missing states even when the importer is current', async () => {
  const { http, origin } = await serve();
  const get = async (url, headers) => {
    const r = await fetch(origin + url, { headers });
    assert.equal(r.status, 200, url);
    return r.text();
  };
  const op = await operatorHeaders(origin);
  const other = 'fresh-worker';
  db.run(
    "INSERT INTO tenants(slug,name,account_id,status,plan_id,created_at,updated_at) VALUES(?,?,?,'active','growth',?,?)",
    [other, other, owner.id, from, from],
  );
  const current = JSON.stringify(reports.tenantDay(day, { zone, now }).current);
  const snapshot = (s, minutes) => {
    const time = new Date(Date.now() - minutes * 60000 - 3000).toISOString();
    db.run('INSERT OR REPLACE INTO r_state VALUES(?,?,?,?)', [s, zone, time, current]);
  };
  try {
    snapshot(other, 2);
    for (const minutes of [4, 18, null, 0]) {
      if (minutes === null) db.run('DELETE FROM r_state WHERE slug=?', [slug]);
      else snapshot(slug, minutes);
      store.refreshMeter(slug, new Date()); // importer's heartbeat alone must not clear the warning
      for (const page of pages) {
        const html = await get(`/platform/reports/${slug}/${page}`, { cookie: owner.cookie });
        assert.ok(html.includes(minutes === null ? 'Updated: unknown' : `Updated ${minutes} min ago`), page);
        assert.equal(html.includes('Worker report overdue: no report received for 18 min'), minutes === 18, page);
        assert.equal(html.includes('No worker report available.'), minutes === null, page);
        assert.equal(html.includes('class="worker-warning"'), minutes === 18 || minutes === null, page);
      }
      const fleet = await get('/platform/operator', op);
      assert.ok(fleet.includes(`Latest worker snapshot · <b>Updated ${minutes === 0 ? 0 : 2} min ago`));
      if (minutes === 18) assert.match(fleet, /1 overdue .*Worker report overdue: no report received for 18 min/s);
      if (minutes === null) assert.match(fleet, /1 with no worker report.*No worker report available/s);
      assert.ok(!fleet.includes(slug));
    }
  } finally {
    await new Promise((resolve) => http.close(resolve));
  }
});
