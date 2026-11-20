// Two boundaries not covered by HTTP fixtures: upgrade a pre-report v2 store,
// and move a generated tenant journal between separate OS processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  db,
  root,
  slug,
  owner,
  staff,
  outsider,
  now,
  from,
  day,
  phone,
  privateText,
  dir,
  reports,
  seed,
  store,
  dashboard,
  tenant,
  shiftDay,
  midnight,
  zone,
} from './fixtures/dashboard.js';
import { reportTables } from '../platform/reportSchema.js';
const admin = await import('../src/services/adminPanel.js'),
  provisioning = await import('../platform/provisioning.js'),
  wizard = await import('../platform/wizard.js'),
  accounts = await import('../platform/accounts.js'),
  usage = await import('../platform/usage.js'),
  keys = await import('../platform/keys.js');
const historic = 'legacy-studio',
  businessNumber = '12025550162',
  doc = 'private-file-' + businessNumber + '.txt';
const view = (s, page, options = {}) => dashboard(s, page, new URLSearchParams(options), { owner: true });

test('v2 upgrade: durable blind lookup, resume and undo, including filenames, database freelist and missing-volume rollback', async () => {
  const p = await provisioning.provisionTenant({
    slug: historic,
    name: 'Legacy studio',
    city: 'Fixture city',
    number: businessNumber,
    template: 'restaurant',
    accountId: owner.id,
  });
  assert.equal(p.ok, true);
  // Reconstruct the previous schema, including a large old draft that spans
  // several pages. Do not inspect real accounts or any repo configuration.
  for (const t of [...reportTables, 'report_schema', 'number_identity_salt']) db.run(`DROP TABLE ${t}`);
  for (const i of ['rpt_backfill', 'rpt_expire']) db.run(`DROP INDEX ${i}`);
  db.run('UPDATE tenants SET number=? WHERE slug=?', [businessNumber, historic]);
  db.run('INSERT INTO trial_numbers VALUES(?,?,?)', [businessNumber, owner.id, from]);
  const docs = [{ name: doc, bytes: 500, chunks: 2, at: from, notes: privateText }];
  db.run('INSERT OR REPLACE INTO wizard_drafts VALUES(?,4,?,?)', [
    historic,
    JSON.stringify({
      payment: { bank: { number: businessNumber } },
      notes: privateText.repeat(1000),
      documents: docs,
    }),
    from,
  ]);
  const token = crypto.randomUUID(),
    edits = [
      {
        id: 'business.city',
        path: 'business.city',
        env: false,
        value: admin.readTenantProfile(historic).business.city,
        before: privateText,
      },
    ];
  db.run('INSERT INTO settings_undo(id,slug,token,before,account_id,created_at) VALUES(?,?,?,?,?,?)', [
    'test-undo',
    historic,
    token,
    JSON.stringify(edits),
    owner.id,
    from,
  ]);
  db.run(
    'INSERT INTO usage_events(tenant,event_uid,created_at,day,month,conversation,provider,model,agent,kind,error_category) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [historic, 'legacy-uid', from, day, day.slice(0, 7), phone, 'groq', privateText, phone, 'voice', privateText],
  );
  const file = db.currentFile(),
    profile = path.join(admin.tenantDir(historic), 'config', 'owner.json');
  db.closePlatformDb();
  const before = fs.readFileSync(file);
  assert.ok(before.includes(privateText) && before.includes(businessNumber));
  fs.renameSync(profile, profile + '.unmounted');
  try {
    await assert.rejects(db.initPlatformDb(), /restore_tenant_volume/);
    assert.deepEqual(fs.readFileSync(file), before);
  } finally {
    fs.renameSync(profile + '.unmounted', profile);
  }
  await db.initPlatformDb();
  await store.reconcileTenant(historic);
  assert.equal(db.get('PRAGMA user_version').user_version, 2);
  assert.equal(db.get('SELECT version FROM report_schema').version, 1);
  const id = db.get('SELECT number FROM tenants WHERE slug=?', [historic]).number;
  assert.equal(provisioning.numberOwner('00' + businessNumber).slug, historic);
  assert.equal(db.get('SELECT number FROM trial_numbers').number, id);
  assert.equal(accounts.claimTrial({ number: businessNumber, accountId: outsider.id }).ok, false);
  assert.deepEqual(wizard.readDraft(historic).data, {
    documents: [{ name: 'Document 1', bytes: 500, chunks: 2, at: from }],
  });
  assert.equal(db.get('SELECT before FROM settings_undo').before, 'tenant-backup');
  assert.deepEqual(admin.readTenantUndo(historic, token), edits);
  assert.equal(
    fs.statSync(path.join(admin.tenantDir(historic), 'data', 'backups', `change-${token}.json`)).mode & 0o777,
    0o600,
  );
  assert.equal(
    (await import('../platform/settings.js')).undoSettings({ slug: historic, accountId: owner.id, token }).ok,
    true,
  );
  wizard.setWizardHooks({ ingest: async () => ({ ok: true, chunks: 3 }) });
  try {
    const r = await wizard.addDocument(historic, owner.id, { name: doc, buffer: Buffer.from('synthetic') });
    assert.equal(r.ok, true);
    assert.equal(r.document.name, doc);
    assert.equal(wizard.readDraft(historic).data.documents[1].name, 'Document 2');
  } finally {
    wizard.resetWizardHooks();
  }
  assert.equal(usage.record({ tenant: historic, uid: 'legacy-uid' }).duplicate, true);
  assert.equal((await provisioning.retryProvisioning(historic, { accountId: outsider.id })).ok, false);
  assert.equal(
    (await provisioning.retryProvisioning(historic, { accountId: owner.id, number: '12025550188' })).error,
    'bad_number',
  );
  db.closePlatformDb();
  await db.initPlatformDb();
  assert.equal(provisioning.businessNumberId(businessNumber), id);
  for (const marker of [privateText, phone, businessNumber, doc])
    assert.equal(
      fs.readFileSync(file).includes(marker),
      false,
      'redacted from persisted SQLite including free space',
    );
});

test('actual isolated live-worker env and timer: fake provider fallback, key generations and enforced quota survive worker journal import', async () => {
  const fresh = await provisioning.provisionTenant({
    slug: 'worker-cafe',
    name: 'Worker Cafe',
    city: 'Test City',
    number: '12025550173',
    template: 'restaurant',
    accountId: owner.id,
  });
  assert.equal(fresh.ok, true);
  const s = fresh.slug,
    data = path.join(admin.tenantDir(s), 'data');
  for (let i = 0; i < 2; i++)
    assert.equal(
      keys.addKey({ slug: s, provider: 'groq', key: 'gsk_' + 'fake-' + crypto.randomUUID(), accountId: owner.id })
        .ok,
      true,
    );
  const child = `
    import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {once} from 'node:events';
    import {config} from './src/config/env.js';import {initDB,run} from './src/utils/db.js';import {chat,tenantBudget,__setFetch} from './src/core/llm.js';
    import {startReportLoop} from './src/services/tenantReports.js'; import {mediaUsage} from './src/services/mediaUsage.js';
    assert.equal(process.env.TENANT_WORKER_MODE,'live');assert.equal(process.env.TENANT_DASHBOARD,'1');assert.ok(!process.env.PLATFORM_OPERATOR_TOKEN&&!process.env.PLATFORM_KEY_SECRET&&!process.env.PLATFORM_ENABLED);
    await initDB();const who='12025550178';run('INSERT INTO messages(number,role,content,created_at) VALUES(?,?,?,?)',[who,'user','PRIVATE_WORKER_UTTERANCE',new Date().toISOString()]);
    let n=0;global.fetch=async()=>++n===1?new Response('invalid key',{status:401}):new Response(JSON.stringify({choices:[{message:{content:'test answer'}}],usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}}));
    __setFetch(global.fetch);const result=await chat({system:'stub',messages:[{role:'user',content:'PRIVATE_WORKER_UTTERANCE'}],chatKey:who+'@s.whatsapp.net',agent:'sales'});assert.equal(result.text,'test answer');assert.equal(n,2);assert.equal(tenantBudget().used,1);
    mediaUsage('embedding','groq','test-embedding',{input:15,estimated:true});
    // Await atomic publication by the boot-time timer (not publishReports()).
    const watcher=fs.watch(config.paths.data),deadline=setTimeout(()=>{throw Error('snapshot timeout')},8000),stop=startReportLoop();
    try{while(!fs.existsSync(path.join(config.paths.data,'dashboard-v1.jsonl')))await once(watcher,'change');}finally{stop();watcher.close();clearTimeout(deadline);}
    console.log('fixture child done');`;
  let workerError;
  keys.setKeyHooks({
    startTenant: async (slug, { isolated, extraEnv }) => {
      const env = { ...admin.tenantEnv(slug, { isolated }), ...extraEnv };
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
        env,
        encoding: 'utf8',
        timeout: 15000,
      });
      workerError = r.stderr;
      return { ok: r.status === 0 && r.stdout.includes('fixture child done') };
    },
  });
  try {
    const delivery = await keys.deliverKeysAtStart(s, { start: true });
    assert.equal(delivery.ok, true, workerError || delivery.error);
  } finally {
    keys.resetKeyHooks();
  }
  for (const file of ['usage-events.jsonl', 'dashboard-v1.jsonl']) {
    const body = fs.readFileSync(path.join(data, file), 'utf8');
    assert.ok(!body.includes('PRIVATE_WORKER_UTTERANCE') && !body.includes('12025550178'));
  }
  await store.reconcileTenant(s);
  const d = view(s, 'usage');
  assert.equal(d.metrics.calls, 3);
  assert.equal(d.metrics.tokens, 21);
  assert.equal(d.metrics.estimated, 1);
  assert.equal(d.metrics.errors, 1);
  assert.equal(d.metrics.callsLeft, Number(admin.readTenantEnv(s).TENANT_DAILY_LLM_CALLS) - 1);
  assert.equal(d.metrics.monthlyConversations, 1);
  assert.equal(view(s, 'overview').metrics.conversations, 1);
  assert.equal(d.meta.covered, 7);
  const fail = usage.byKey(s).find((k) => k.errors);
  assert.deepEqual(fail.error_categories, ['invalid']);
  assert.ok(fail.last_error_at);
  assert.equal(keys.healthFor(s).chain.find((k) => k.slot === 1).errors, 1);
});

test('cached compatibility APIs keep requested periods and error detail; old raw history and missing worker evidence are not reported as complete', async () => {
  await seed();
  const old = shiftDay(day, -33),
    stamp = midnight(old, zone),
    month = old.slice(0, 7);
  usage.record({
    tenant: slug,
    at: stamp,
    uid: 'legacy-month',
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    promptTokens: 9,
    errorCategory: 'quota',
  });
  store.refreshMeter(slug);
  db.run('ALTER TABLE usage_events RENAME TO unavailable_raw_ledger');
  try {
    const summary = usage.summary(slug, { month, from: old, to: old });
    assert.equal(summary.daily.length, 1);
    assert.equal(summary.daily[0].bucket, old);
    assert.equal(summary.monthly[0].month, month);
    assert.equal(summary.models[0].total_tokens, 9);
    assert.equal(summary.totals.calls, 1);
    assert.equal(summary.events, 3);
    assert.deepEqual(summary.keys[0].error_categories, ['quota']);
    const q = new URLSearchParams({ range: 'custom', from: old, to: old });
    const d = dashboard(slug, 'overview', q, { owner: true });
    assert.equal(d.metrics.conversations, null);
    assert.equal(d.meta.covered, 0);
    const r = reports.tenantDay(old, { now, zone });
    assert.equal(r.eventsComplete, false);
    store.importReports(slug, [JSON.stringify(r)]);
    const meta = dashboard(slug, 'overview', q, { owner: true }).meta;
    assert.equal(meta.covered, 1);
    assert.equal(meta.eventDatesComplete, 0);
    assert.equal(usage.daily(slug, { from: day, to: day })[0].calls, 2);
    assert.equal(usage.byKey(slug, { month })[0].last_error_at, stamp);
    assert.equal(view(slug, 'usage').metrics.errors, 1);
  } finally {
    db.run('ALTER TABLE unavailable_raw_ledger RENAME TO usage_events');
  }
});

test('doctor CLI reads a snapshot and diagnoses a distinct operator secret and stale worker without leaking fixtures', () => {
  db.run('UPDATE r_state SET at=? WHERE slug=?', [midnight(shiftDay(day, -2), zone), slug]);
  db.flush();
  const file = db.currentFile(),
    before = fs.readFileSync(file);
  const doctor = (token) =>
    spawnSync(process.execPath, ['scripts/doctor.js', 'platform'], {
      encoding: 'utf8',
      env: { ...process.env, PLATFORM_OPERATOR_TOKEN: token },
      timeout: 10000,
    });
  const bad = doctor(process.env.PLATFORM_SECRET);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /report_operator_credential/);
  assert.match(bad.stdout, /15 minutes/);
  const good = doctor(process.env.PLATFORM_OPERATOR_TOKEN);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /No blocking issues/);
  assert.ok(!good.stdout.includes(privateText));
  assert.deepEqual(fs.readFileSync(file), before);
});

test('changing business timezone rebuilds dated usage and refuses a stale generation in the old zone', () => {
  const s = 'calendar-fixture',
    at = '2026-03-09T04:30:00.000Z',
    clock = new Date('2026-03-09T16:00:00.000Z');
  db.run('INSERT INTO tenants(slug,account_id,name,status,plan_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [
    s,
    owner.id,
    'Calendar',
    'active',
    'growth',
    at,
    at,
  ]);
  const snapshot = (zone, stamp) =>
    JSON.stringify({ v: 1, day: '2026-03-09', zone, at: stamp, people: [], facts: [], cards: [], current: {} });
  const old = snapshot('America/New_York', clock.toISOString());
  store.importReports(s, [old], clock);
  usage.record({ tenant: s, uid: 'at-local-boundary', at, totalTokens: 2, conversation: phone });
  store.refreshMeter(s, clock);
  assert.equal(db.get('SELECT day FROM r_usage WHERE slug=? AND hour=-1', [s]).day, '2026-03-09');
  const newer = new Date(+clock + 1000);
  store.importReports(s, [snapshot('America/Los_Angeles', newer.toISOString())], newer);
  store.refreshMeter(s, newer);
  assert.deepEqual(db.get('SELECT day,SUM(tokens) n FROM r_usage WHERE slug=? AND hour=-1', [s]), {
    day: '2026-03-08',
    n: 2,
  });
  store.importReports(s, [old], newer);
  assert.equal(db.get('SELECT zone FROM r_state WHERE slug=?', [s]).zone, 'America/Los_Angeles');
});

test('tenant forget invalidates brief lookup immediately and removes masked lead/activity projections at the next publication', async () => {
  const { alias } = await import('../src/services/reportContract.js'),
    { forgetContact } = await import('../src/services/privacy.js');
  const id = alias(phone, process.env.PLATFORM_TENANT_TOKEN);
  assert.ok(db.get("SELECT 1 FROM r_cards WHERE slug=? AND kind='leads' AND contact=?", [slug, id]));
  tenant.run('INSERT OR REPLACE INTO report_sources VALUES(?,?,?,?)', [id, 'source_tag', from, 'qr']);
  assert.equal(forgetContact(phone).ok, true);
  assert.equal(tenant.get('SELECT 1 FROM report_lead_index WHERE who=?', [id]), null);
  assert.equal(tenant.get('SELECT 1 FROM report_sources WHERE who=?', [id]), null);
  const clock = new Date(Date.now() + 1);
  await reports.publishReports({ dir, zone, now: clock, days: 14 });
  await store.reconcileTenant(slug, { dir, now: clock });
  assert.equal(
    db.get("SELECT 1 FROM r_cards WHERE slug=? AND kind IN ('leads','activity') AND contact=?", [slug, id]),
    null,
  );
});
