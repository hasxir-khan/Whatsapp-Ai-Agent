// Phase 7 part 2 integration. Real disk, SQLite, HTTP router and provider wire
// format; fake credentials, provider transport and WhatsApp lifecycle.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { isolate } from './helpers.js';

const root = isolate('part2');
Object.assign(process.env, { PLATFORM_ENABLED: '1', PLATFORM_SECRET: crypto.randomUUID(), PLATFORM_KEY_SECRET: crypto.randomUUID(),
  PLATFORM_DIR: path.join(root, 'platform'), TENANTS_DIR: path.join(root, 'tenants'), CONFIG_DIR: path.join(root, 'config'), PLATFORM_PUBLIC_URL: '' });
const db = await import('../platform/db.js');
const keys = await import('../platform/keys.js');
const cipher = await import('../platform/crypto.js');
const plans = await import('../platform/plans.js');
const accounts = await import('../platform/accounts.js');
const { issueSession } = await import('../platform/session.js');
const { handlePlatformRoute } = await import('../platform/routes.js');
const admin = await import('../src/services/adminPanel.js');
const llm = await import('../src/core/llm.js');
const connect = await import('../platform/connect.js');
const wizard = await import('../platform/wizard.js');
const usage = await import('../platform/usage.js');
const { diagnostics } = await import('../platform/diagnostics.js');
await db.initPlatformDb(); plans.seedPlans();
after(() => { db.closePlatformDb(); fs.rmSync(root, { recursive: true, force: true }); });
afterEach(() => { keys.resetKeyHooks(); connect.resetConnectHooks(); wizard.resetWizardHooks(); llm.__setFetch(null); admin.resetRateLimits(); });
const fake = (tail = '1111') => 'gsk_' + crypto.randomUUID().replaceAll('-', '') + tail;
const stamp = () => new Date().toISOString();
function account() {
  const id = crypto.randomUUID(), email = `${id}@example.com`;
  db.run('INSERT INTO accounts (id,email,email_norm,email_verified,created_at) VALUES (?,?,?,1,?)', [id,email,email,stamp()]);
  accounts.recordConsent(id);
  const session = issueSession(id);
  return { id, cookie: session.cookies.map((c) => c.split(';')[0]).join('; '), csrf: session.csrf };
}
async function api(auth, url, body, csrf = true) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = body === undefined ? 'GET' : 'POST';
  req.headers = { host: 'unit.invalid', ...(auth ? { cookie: auth.cookie } : {}), ...(csrf && auth ? { 'x-platform-csrf': auth.csrf } : {}) };
  req.socket = { remoteAddress: '203.0.113.41' };
  const res = { writeHead(status, headers) { Object.assign(this, { status, headers, headersSent: true }); }, end(text) { this.raw = String(text); } };
  assert.ok(await handlePlatformRoute(req, res, new URL(url, 'http://unit.invalid')));
  return { status: res.status, data: JSON.parse(res.raw), raw: res.raw, headers: res.headers };
}
let ordinal = 0;
async function tenant() {
  const auth = account(); ordinal++;
  const res = await api(auth, '/api/platform/tenants', { name: 'Fixture ' + ordinal, template: 'restaurant', number: String(923000000000 + ordinal), city: 'Islamabad' });
  assert.equal(res.status, 201, res.raw);
  const slug = res.data.slug, base = '/api/platform/tenants/' + slug;
  return { auth, slug, base, call: (route, body) => api(auth, base + route, body) };
}

test('GCM is randomized; wrong secret, tenant, version, tag or ciphertext fails closed', () => {
  const value = fake(), aad = 'cafe:key:1', sealed = cipher.encryptValue(value, { aad });
  assert.notEqual(sealed, cipher.encryptValue(value, { aad }));
  assert.deepEqual(cipher.decryptValue(sealed, { aad }), { ok: true, value });
  const parts = sealed.split('.');
  for (const result of [cipher.decryptValue(sealed, { aad, secret: crypto.randomUUID() }), cipher.decryptValue(sealed, { aad: 'other:key:1' }),
    cipher.decryptValue(sealed, { aad: 'cafe:key:2' }), cipher.decryptValue(parts.map((p,i) => i === 2 ? p.slice(0, 6) : p).join('.'), { aad }),
    cipher.decryptValue(parts.map((p,i) => i === 3 ? (p[0] === 'x' ? 'y' : 'x') + p.slice(1) : p).join('.'), { aad })]) {
    assert.equal(result.ok, false); assert.equal(result.value, undefined);
  }
  assert.ok(cipher.keySecretProblem('short')); assert.ok(cipher.keySecretProblem('change-' + 'me'.repeat(20)));
});

test('bounded owner key chain: secrets absent from disk, GET, export and audit; revoke and rotate change actual spawn env', async () => {
  const t = await tenant(), primary = fake(), backup = fake('2222'), rotated = fake('3333');
  const add = (key) => t.call('/keys', { provider: 'groq', key });
  const first = await add(primary); assert.equal(first.status, 201); const id = first.data.key.id;
  assert.equal((await add(primary)).data.error, 'duplicate_key');
  assert.equal((await add(backup)).data.key.slot, 2);
  assert.equal((await add(fake('4444'))).status, 201);
  assert.equal((await add(fake())).data.error, 'chain_full');
  assert.equal((await t.call('/keys', { provider: 'unknown', key: primary })).data.error, 'unknown_provider');
  assert.equal((await t.call('/model', { provider: 'groq', model: 'typed-in' })).data.error, 'model_not_supported');
  assert.equal((await t.call('/keys/source', { source: 'platform' })).data.error, 'platform_keys_unavailable');
  const stored = keys.getKey(t.slug, id), dir = admin.tenantDir(t.slug);
  db.flush();
  assert.ok(!fs.readFileSync(db.currentFile()).includes(primary));
  for (const file of ['.env','config/owner.json','tenant.json']) assert.ok(!fs.readFileSync(path.join(dir,file),'utf8').includes(primary));
  for (const r of [first, ...await Promise.all(['','/keys','/connection','/settings','/usage','/checklist','/onboarding'].map((u) => t.call(u))),
    await api(t.auth, '/api/platform/audit'), await api(t.auth, '/api/platform/account/export', { withKeys: true })]) {
    assert.ok(r.status < 300); for (const secret of [primary,backup,stored.secret,stored.fingerprint_hash]) assert.ok(!r.raw.includes(secret));
  }
  assert.equal(keys.exportKeys(t.slug, { withKeys: true }).error, 'key_export_disabled');
  assert.equal(keys.exportKeys(t.slug).keys[0].key, undefined);
  let spawned;
  keys.setKeyHooks({ restartTenant: async (slug, opts) => { assert.equal(slug, t.slug); assert.equal(opts.isolated, true); spawned = opts.extraEnv; } });
  db.run("UPDATE tenants SET status='active' WHERE slug=?", [t.slug]);
  assert.equal((await t.call(`/keys/${id}/rotate`, { key: rotated })).data.key.version, 2);
  assert.equal(spawned.GROQ_API_KEY, rotated); assert.equal(spawned.GROQ_API_KEY_2, backup);
  assert.equal((await t.call(`/keys/${id}/revoke`, {})).status, 200);
  assert.equal(spawned.GROQ_API_KEY, ''); assert.equal(spawned.GOOGLE_API_KEY, '');
  assert.ok(!Object.values(spawned).includes(rotated)); assert.equal(keys.getKey(t.slug,id).secret, '');
  const child = admin.tenantEnv(t.slug, { isolated: true });
  for (const name of ['PLATFORM_KEY_SECRET','PLATFORM_SECRET','GROQ_API_KEY','MY_NUMBER']) assert.equal(child[name], undefined);
  const old = process.env.PLATFORM_KEY_SECRET;
  try { process.env.PLATFORM_KEY_SECRET = crypto.randomUUID(); assert.deepEqual(keys.deliveryEnv(t.slug), { ok: false, error: 'cannot_decrypt' }); assert.ok(diagnostics(db.all).errors.includes('cannot_decrypt')); }
  finally { process.env.PLATFORM_KEY_SECRET = old; }
});

test('test and compatibility actually call the chosen model with one tenant credential, fixed endpoints, timeout and no echoed provider errors', async () => {
  const t = await tenant(), key = 'sk-or-' + crypto.randomUUID();
  const id = (await t.call('/keys', { provider: 'openrouter', key })).data.key.id;
  const m = keys.modelFor(t.slug); let calls = 0, status = 403;
  llm.__setFetch(async (url, opts) => {
    calls++;
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(opts.headers.Authorization, `Bearer ${key}`);
    assert.equal(opts.redirect, 'error'); assert.ok(opts.signal instanceof AbortSignal);
    assert.equal(JSON.parse(opts.body).model, m.model);
    return new Response(status === 200 ? JSON.stringify({ choices: [{ message: { content: 'May I confirm?' } }] }) : `Rejected ${key}`, { status });
  });
  const refused = await t.call(`/keys/${id}/test`, {}); assert.equal(refused.data.state, 'no_permission'); assert.ok(!refused.raw.includes(key));
  assert.equal((await t.call('/compatibility', {})).data.error, 'consent_required'); assert.equal(calls, 1);
  status = 200;
  assert.equal((await t.call(`/keys/${id}/test`, {})).data.state, 'ok');
  const checked = await t.call('/compatibility', { consent: true, maxCalls: 1 });
  assert.equal(checked.status, 200, checked.raw); assert.equal(checked.data.calls, 8); assert.equal(calls, 10);
  assert.deepEqual(Object.keys(checked.data.categories).sort(), ['confirmation','language','price','scope']);
  for (let i=0; i<4; i++) assert.equal((await t.call(`/keys/${id}/test`, {})).status, 200);
  assert.equal((await t.call(`/keys/${id}/test`, {})).status, 429);
});

test('FAIL follows its model, not the most recent run; override is explicit and another failed run clears it', async () => {
  const t = await tenant(); await t.call('/keys', { provider:'groq', key:fake() });
  const a = keys.modelFor(t.slug), b = { provider:'groq', model:'llama-3.1-8b-instant' };
  keys.setKeyHooks({ runScenario: async ({ model, expect }) => ({ text: model === a.model ? 'Rs 987654.' : expect === 'scope' ? 'Only orders, sorry.' : 'جی، ji, confirm?' }) });
  assert.equal((await t.call('/compatibility', { ...a, consent:true })).data.status, 'FAIL');
  assert.equal((await t.call('/compatibility', { ...b, consent:true })).data.status, 'PASS');
  assert.equal((await t.call('/model', a)).data.error, 'compatibility_failed'); assert.equal(keys.deliveryEnv(t.slug).ok, false);
  assert.ok((await t.call('/model', { ...a, override:true })).data.overridden);
  assert.equal(keys.deliveryEnv(t.slug).env.GROQ_MODELS, a.model);
  assert.equal((await t.call('/compatibility', { ...a, consent:true })).data.blocked, true); assert.equal(keys.modelState(t.slug).override, false);
});

test('per-tenant owner, membership and CSRF gates precede new reads, writes, probes and worker actions', async () => {
  const t = await tenant(), outsider = account(), staff = account();
  db.run('INSERT INTO memberships VALUES (?,?,?,?)', [staff.id,t.slug,'staff',stamp()]);
  const id = (await t.call('/keys', { provider:'groq', key:fake() })).data.key.id;
  for (const p of ['/keys','/connection','/settings','/checklist','/onboarding']) assert.equal((await api(outsider, t.base+p)).status,404);
  assert.equal((await api(staff, t.base+'/keys')).status,403);
  for (const p of ['/keys','/keys/source','/keys/test', ...['test','revoke','rotate'].map((a) => `/keys/${id}/${a}`),
    '/model','/compatibility','/settings','/settings/undo','/wizard/5','/test-chat','/connect/start','/pause','/resume','/go-live']) {
    assert.equal((await api(outsider,t.base+p,{})).status,404,p);
    assert.equal((await api(staff,t.base+p,{})).status,403,p);
    assert.equal((await api(t.auth,t.base+p,{},false)).data.error,'csrf',p);
  }
  const second = await tenant(); assert.equal((await second.call(`/keys/${id}/revoke`, {})).status,404);
  await api(staff,'/api/platform/account/export',{}); assert.equal((await api(staff,'/api/platform/account/delete',{confirm:'DELETE'})).status,200);
  assert.equal((await t.call('/keys')).data.chain[0].status, 'active');
});

test('real onboarding gate, server-attested test and owner pause/resume including expired-trial refusal', async () => {
  const t = await tenant(); const started = [], stopped = [];
  keys.setKeyHooks({ probe: async () => ({ok:true}), runScenario: async () => ({text:'Only orders, sorry. جی، ji, confirm?'}),
    startTenant: async (_,o) => started.push(o.extraEnv), restartTenant: async (_,o) => started.push(o.extraEnv), stopTenant: async (slug) => stopped.push(slug) });
  connect.setConnectHooks({ probeStatus: async () => ({status:'online'}) });
  assert.equal((await t.call('/resume',{})).data.error,'not_paused');
  assert.equal((await t.call('/connect/start',{})).status,200); assert.equal(started[0].TENANT_WORKER_MODE,'link'); assert.equal(started[0].GROQ_API_KEY,'');
  assert.equal((await t.call('/go-live',{})).data.error,'checklist_incomplete'); assert.equal(started.length,1);
  assert.equal((await t.call('/wizard/7',{patch:{test:{ok:true}}})).status,400);
  assert.equal((await t.call('/wizard/4',{patch:{documents:[{name:'not-learned'}]}})).status,400);
  const invalid = await t.call('/wizard/2',{patch:{business:{languages:'Urdu'}}}); assert.equal(invalid.data.fieldErrors[0].field,'business.languages');
  const saved = await t.call('/wizard/3',{patch:{payment:{bank:{name:'Fixture bank',number:'000001'}},faqs:[{q:'Where?',a:'Islamabad'}]}});
  assert.equal(saved.status,200,saved.raw); assert.equal(wizard.readDraft(t.slug).step,4);
  const value = fake(); const id = (await t.call('/keys',{provider:'groq',key:value})).data.key.id;
  await t.call(`/keys/${id}/test`,{}); await t.call('/compatibility',{consent:true});
  wizard.setWizardHooks({sandboxChat:async () => ({replies:[]})}); assert.equal((await t.call('/test-chat',{text:'hello'})).data.error,'no_reply');
  assert.deepEqual((await t.call('/checklist')).data.missing,['testChat']);
  // Real sandbox brain and fake socket: STOP is deterministic, no provider call.
  wizard.resetWizardHooks(); const chat = await t.call('/test-chat',{text:'stop'}); assert.equal(chat.status,200,chat.raw);
  assert.equal(chat.data.number,'900000000000'); assert.ok(chat.data.replies.length);
  assert.equal((await t.call('/go-live',{})).data.status,'active'); assert.equal(started.at(-1).GROQ_API_KEY,value);
  assert.equal((await t.call('/pause',{})).data.status,'paused'); assert.deepEqual(stopped,[t.slug]);
  const dir = path.join(admin.tenantDir(t.slug),'sessions');
  fs.writeFileSync(path.join(dir,'creds.json'),JSON.stringify({me:{id:'linked-fixture'}}));
  fs.writeFileSync(path.join(dir,'connected.marker'),JSON.stringify({at:stamp()}));
  connect.setConnectHooks({probeStatus:async () => null}); // a stopped worker cannot answer the status probe
  assert.equal((await t.call('/resume',{})).data.status,'active'); assert.equal(started.at(-1).TENANT_WORKER_MODE,'live');
  db.run("UPDATE tenants SET status='paused',paused_reason='trial_expired' WHERE slug=?",[t.slug]);
  assert.equal((await t.call('/resume',{})).data.error,'paused');
});

test('catalogue writes to effective bot paths, validates before writing, honors plan gates, backs up privately, undoes profile AND env', async () => {
  const t = await tenant(); const read = () => admin.readTenantProfile(t.slug), old = read();
  assert.ok((await t.call('/settings')).data.groups[0].entries.some((e) => e.disabled && e.gate.upgradeTo));
  const denied = await t.call('/settings',{patch:{'voice.mode':'match_voice','business.city':'Changed'}}); assert.equal(denied.status,403); assert.equal(read().business.city,old.business.city);
  assert.equal((await t.call('/wizard/5',{patch:{conversation:{scope:'open'}}})).status,403);
  plans.assignPlan({slug:t.slug,planId:'growth'});
  const oldMode = admin.readTenantEnv(t.slug).VOICE_REPLY_MODE;
  const fields = [{ id:'order', label:'Order', ask:'Pickup or delivery?' }, {id:'address',label:'Address',ask:'Where?',askIf:{field:'order',equals:'delivery'}}];
  const applied = await t.call('/settings',{patch:{'business.hours':'Weekdays 10–5','intake.fields':fields,'intake.required':['order'],
    'conversation.scope':'business_only','conversation.replyTiming':{targetMinMs:500,targetMaxMs:1500},'voice.mode':'off'}});
  assert.equal(applied.status,200,applied.raw); assert.deepEqual(read().business.intake.fields,fields); assert.equal(read().business.tone.replyTiming.targetMinMs,500);
  assert.equal(admin.readTenantEnv(t.slug).VOICE_REPLY_MODE,'off');
  assert.equal(fs.statSync(path.join(admin.tenantDir(t.slug),'data','backups',applied.data.backup)).mode & 0o777,0o600);
  for (const patch of [{'business.hours':'Wrong','conversation.scope':'nonsense'},{'agents.0.instructions':'A'.repeat(401)},{'intake.fields':Array(13).fill(fields[0])},
    {'intake.fields':[{...fields[0],askIf:{field:'missing',equals:'x'}}]}, {'business.llm.key':'no'}]) {
    assert.equal((await t.call('/settings',{patch})).status,400); assert.equal(read().business.hours,'Weekdays 10–5');
  }
  assert.equal((await t.call('/wizard/2',{patch:{business:{city:'Lahore'}}})).status,200);
  assert.equal((await t.call('/settings/undo',{token:applied.data.undoToken})).status,200);
  assert.equal(admin.readTenantEnv(t.slug).VOICE_REPLY_MODE,oldMode); assert.equal(read().business.hours,old.business.hours); assert.equal(read().business.city,'Lahore');
  assert.ok(!(await api(t.auth,'/api/platform/audit')).raw.includes('Weekdays 10–5'));
});

test('usage and health bind to tenant, slot and last four, not a stale replacement', async () => {
  const t = await tenant(), val = fake(), id = (await t.call('/keys',{provider:'groq',key:val})).data.key.id;
  const event = { tenant:t.slug, provider:'groq', model:'model-a', keySlot:1, keyLast4:val.slice(-4), keyRef:`${id}:1` };
  usage.record({...event,errorCategory:'invalid'}); assert.equal(keys.healthFor(t.slug).alerts[0].health,'invalid');
  usage.record({...event,totalTokens:7}); assert.equal(keys.healthFor(t.slug).alerts.length,0);
  await t.call(`/keys/${id}/rotate`,{key:fake('2222')}); usage.record({...event,totalTokens:4});
  const active = keys.healthFor(t.slug).chain[0]; assert.equal(active.health,'unknown'); assert.equal(active.calls,0);
  assert.equal(keys.usagePerKey(t.slug)[0].tokens,11); assert.deepEqual(keys.usagePerKey(t.slug)[0].errorCategories,['invalid']);
  await api(t.auth,'/api/platform/account/export',{}); await api(t.auth,'/api/platform/account/delete',{confirm:'DELETE'});
  assert.deepEqual(keys.listKeys(t.slug),[]); assert.deepEqual(keys.usagePerKey(t.slug),[]);
});

test('real managed restart without a prior PID: final spawn config wins over stale dotenv, host providers and sticky routing', async () => {
  const { spawnSync } = await import('node:child_process');
  const t = await tenant(), other = await tenant(), key = fake(), orKey = 'sk-or-' + crypto.randomUUID();
  const otherKey = fake('9876'); await other.call('/keys',{provider:'groq',key:otherKey});
  await t.call('/keys',{provider:'openrouter',key:orKey}); await t.call('/keys',{provider:'groq',key});
  const m = 'google/gemini-2.0-flash-exp:free'; await t.call('/model',{provider:'openrouter',model:m});
  const dir = admin.tenantDir(t.slug), file=path.join(dir,'tenant.json');
  const meta=JSON.parse(fs.readFileSync(file)); delete meta.platformManaged; fs.writeFileSync(file,JSON.stringify(meta)); // v1 folder
  const stale = fake('6666'); for (const name of ['GROQ_API_KEY_2','GOOGLE_API_KEY','GEMINI_API_KEY']) admin.writeTenantEnvValue(t.slug,name,stale);
  await assert.rejects(admin.startTenant(t.slug,{spawnImpl:()=>assert.fail('CLI/admin must not launch a managed worker')}),/use_platform_dashboard/);
  assert.throws(()=>admin.setTenantKeys(t.slug,{GROQ_API_KEY:key}),/use_platform_dashboard/);
  const skip = spawnSync(process.execPath,['scripts/run-all.js','--only',t.slug],{env:process.env,encoding:'utf8',timeout:5000}); assert.equal(skip.status,0); assert.match(skip.stdout,/No tenants to run/);
  const secrets = {PLATFORM_MAIL_TOKEN:crypto.randomUUID(),WA_SESSION:crypto.randomUUID(),GROQ_API_KEY_3:fake(),OPENROUTER_API_KEY:'host-only'};
  const prior = Object.fromEntries(Object.keys(secrets).map((k)=>[k,process.env[k]])); Object.assign(process.env,secrets);
  let snapshot;
  try {
    keys.setKeyHooks({restartTenant:(slug,opts)=>admin.restartTenant(slug,{...opts,spawnImpl:(_cmd,_args,config)=>{snapshot=config.env;return {unref(){}}}})});
    assert.equal((await keys.deliverKeysAtStart(t.slug)).ok,true);
    for (const v of [stale,otherKey,...Object.values(secrets),process.env.PLATFORM_KEY_SECRET,process.env.PLATFORM_SECRET]) assert.ok(!Object.values(snapshot).includes(v));
    assert.equal(snapshot.ENV_FILE,path.join(dir,'.env')); assert.equal(snapshot.CONFIG_DIR,path.join(dir,'config')); assert.equal(snapshot.DATA_DIR,path.join(dir,'data'));
    // Boot the real config and llm.chat under precisely the captured spawn env;
    // only the provider wire is fake. Seed stickiness for the non-selected one.
    const run=spawnSync(process.execPath,['--input-type=module','-e',`
      import assert from 'node:assert/strict'; import {config} from './src/config/env.js'; import {initDB} from './src/utils/db.js';
      import {chat,__setFetch} from './src/core/llm.js'; await initDB();
      for (const name of ['GROQ_API_KEY_2','GEMINI_API_KEY','GOOGLE_API_KEY','GROQ_API_KEY_3']) assert.equal(process.env[name],'');
      const observed=[]; __setFetch(async (url, o)=>{ observed.push({url,model:JSON.parse(o.body).model,auth:o.headers.Authorization});return new Response(JSON.stringify({choices:[{message:{content:'OK'}}]})); });
      const messages=[{role:'user',content:'fixture'}], chatKey='sticky-test'; delete process.env.LLM_PREFERRED_PROVIDER;
      await chat({messages,chatKey}); process.env.LLM_PREFERRED_PROVIDER='openrouter';
      await chat({messages,chatKey,provider:'groq',model:'unapproved'});
      assert.ok(observed[0].url.includes('groq.com')); assert.ok(observed[1].url.includes('openrouter.ai'));
      assert.ok(observed[1].model===process.env.OPENROUTER_ALLOWED_MODELS); assert.ok(observed[1].auth==='Bearer '+process.env.OPENROUTER_API_KEY);
      console.log('routing-verified');`],{env:snapshot,encoding:'utf8',timeout:10000});
    assert.equal(run.status,0,run.stderr.replaceAll(orKey,'[fixture]')); assert.match(run.stdout,/routing-verified/);
    assert.equal(snapshot.OPENROUTER_ALLOWED_MODELS,m); assert.equal(snapshot.OPENROUTER_API_KEY,orKey);
  } finally {for(const [k,v] of Object.entries(prior)) if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('link worker can register or persist a WhatsApp session but never receives chats, calls, or sends replies', async () => {
  const { EventEmitter }=await import('node:events'); const { BaileysTransport }=await import('../src/transport/baileys.js');
  const transport=new BaileysTransport(), ev=new EventEmitter(), sock={ev,sendMessage:()=>assert.fail('must not send')};
  process.env.TENANT_WORKER_MODE='link';
  try {
    await transport.connect({load:async()=>({useMultiFileAuthState:async()=>({state:{creds:{registered:true},keys:{}},saveCreds:()=>{}}),
      fetchLatestBaileysVersion:async()=>({version:[1,0,0]}),Browsers:{ubuntu:()=>[]},makeCacheableSignalKeyStore:()=>({}),default:()=>sock})});
    assert.deepEqual(ev.eventNames().sort(),['connection.update','creds.update']); await assert.rejects(transport.send('fixture',{text:'no'}),/link_only_worker/);
  } finally {delete process.env.TENANT_WORKER_MODE;}
});

test('a FAIL while live stops the worker; losing provider access is incomplete, not a stored verdict',async()=>{
  const t=await tenant(); await t.call('/keys',{provider:'groq',key:fake()}); const model=keys.modelFor(t.slug);
  let outage=false,stops=0;
  keys.setKeyHooks({runScenario:async()=>{if(outage)throw Error('offline');return {text:'Rs 87654321'}},stopTenant:async()=>{stops++}});
  db.run("UPDATE tenants SET status='active' WHERE slug=?",[t.slug]);const failed=await t.call('/compatibility',{consent:true});
  assert.equal(failed.data.status,'FAIL'); assert.equal(failed.data.worker,'stopped'); assert.equal(stops,1);
  outage=true; const r=await t.call('/compatibility',{consent:true});assert.equal(r.status,502);assert.equal(r.data.calls,1);
  assert.equal(keys.latestRun(t.slug,model.provider,model.model).id,failed.data.id);
});

test('journal slug and deduplication are tenant-bound, and reusing a slot never lets an older event mark the replacement healthy', async()=>{
  const a=await tenant(), b=await tenant(), id=(await a.call('/keys',{provider:'groq',key:fake()})).data.key.id;
  await a.call(`/keys/${id}/revoke`,{}); const fresh=(await a.call('/keys',{provider:'groq',key:fake()})).data.key;
  assert.equal(fresh.slot,1); assert.notEqual(fresh.id,id);
  const dir=path.join(admin.tenantDir(a.slug),'data'); const event={tenant:b.slug, uid:'same-fixture',keySlot:1,keyLast4:'1111',provider:'groq',model:'old',totalTokens:3,at:'2020-01-01T00:00:00Z'};
  usage.record(event);fs.writeFileSync(path.join(dir,'usage-events.jsonl'),JSON.stringify(event)+'\n'); assert.equal(usage.ingestJournal({slug:a.slug}).imported,1);
  assert.equal(keys.healthFor(a.slug).chain.find((r)=>r.id===fresh.id).health,'unknown'); assert.equal(keys.healthFor(a.slug).chain.find((r)=>r.id===fresh.id).calls,0);
  assert.equal(usage.byKey(b.slug)[0].calls,1); assert.equal(usage.byKey(a.slug)[0].calls,1);
});

test('rollback and undo do not overwrite unrelated edits, a changed value or a downgraded plan',async()=>{
  const t=await tenant(); plans.assignPlan({slug:t.slug,planId:'growth'});
  const before=admin.readTenantEnv(t.slug).VOICE_REPLY_MODE; const dir=admin.tenantDir(t.slug), block=path.join(dir,'data','backups');
  fs.writeFileSync(block,'not a backup directory');const failed=await t.call('/settings',{patch:{'voice.mode':'off'}}); assert.equal(failed.data.error,'tenant_files_unavailable');assert.equal(admin.readTenantEnv(t.slug).VOICE_REPLY_MODE,before);fs.unlinkSync(block);
  const patch={'agents.0.instructions':'Ask the owner if unsure.','agents.0.enabled':true,'voice.mode':'off'}; const changed=await t.call('/settings',{patch});assert.equal(changed.status,200,changed.raw);
  assert.equal(admin.readTenantProfile(t.slug).agents[0].instructions,patch['agents.0.instructions']);
  assert.equal((await t.call('/settings/undo',{token:'old-token'})).data.error,'not_latest_change');
  plans.assignPlan({slug:t.slug,planId:'free'}); assert.equal((await t.call('/settings/undo',{})).data.error,'plan_disallowed');
  plans.assignPlan({slug:t.slug,planId:'growth'}); const p=admin.readTenantProfile(t.slug);p.agents[0].instructions='A separate owner edit';admin.writeTenantProfile(t.slug,p);
  assert.equal((await t.call('/settings/undo',{})).data.error,'setting_changed_since');assert.equal(admin.readTenantProfile(t.slug).agents[0].instructions,'A separate owner edit');
});

test('accepted upload goes through the real learner into this tenant only',async()=>{
  const t=await tenant();const other=await tenant();
  const r=await wizard.addDocument(t.slug,t.auth.id,{name:'fixture-menu.txt',buffer:Buffer.from('Fixture cafe menu. Our counter opens at noon and closes at seven. We serve a seasonal menu made fresh every morning.')});
  assert.ok(r.ok,JSON.stringify(r)); assert.ok(r.document.chunks>0); assert.ok(fs.existsSync(path.join(admin.tenantDir(t.slug),'data','assistant.db')));
  assert.deepEqual(wizard.readDraft(other.slug).data.documents||[],[]);assert.ok(!fs.existsSync(path.join(admin.tenantDir(other.slug),'data','assistant.db')));
});

test('rotation replaces a real running PID; revoking its only key reaps the replacement before returning', async()=>{
  const {spawn}=await import('node:child_process');const t=await tenant(), children=[], envs=[];
  const id=(await t.call('/keys',{provider:'groq',key:fake()})).data.key.id;
  keys.setKeyHooks({restartTenant:(slug,opts)=>admin.restartTenant(slug,{...opts,spawnImpl:(exe,_args,launch)=>{
    // Same process selection, PID file, env, stop and wait as production. Only
    // the executable's entrypoint is inert: no WhatsApp socket or model API.
    const child=spawn(exe,['-e','setTimeout(()=>{},10000)'],launch);children.push(child);envs.push(launch.env);return child;
  }})});
  try {
    db.run("UPDATE tenants SET status='active' WHERE slug=?",[t.slug]);assert.ok((await keys.deliverKeysAtStart(t.slug)).ok);
    const replacement=fake('9876');assert.equal((await t.call(`/keys/${id}/rotate`,{key:replacement})).data.worker,'restarted');
    assert.ok(children[0].exitCode!==null||children[0].signalCode);assert.notEqual(children[1].pid,children[0].pid);assert.equal(envs[1].GROQ_API_KEY,replacement);
    const revoke=await t.call(`/keys/${id}/revoke`,{});assert.equal(revoke.data.worker,'stopped');assert.ok(children[1].exitCode!==null||children[1].signalCode);
    assert.equal(admin.tenantRunning(t.slug),false);assert.equal(db.get('SELECT status FROM tenants WHERE slug=?',[t.slug]).status,'provisioned');
  } finally {for(const child of children) if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');}
});

test('expiry queues behind worker transitions and rechecks state; cannot launch a queued link past its deadline',async()=>{
  const t=await tenant(), now=Date.now(); db.run('UPDATE tenants SET trial_ends_at=? WHERE slug=?',[new Date(now-5000).toISOString(),t.slug]);
  const order=[]; let release, started; const entered=new Promise((r)=>{started=r});
  const hold=keys.withWorker(t.slug,async()=>{order.push('busy');started();await new Promise((r)=>{release=r})});await entered;
  const expiry=plans.expireTrials({now,stop:async()=>{order.push('stop');return {ok:true}}});
  release();await hold;await expiry;assert.deepEqual(order,['busy','stop']);
  assert.equal((await t.call('/connect/start',{})).status,409);assert.equal((await t.call('/pairing',{})).status,409);assert.equal((await t.call('/resume',{})).status,409);
});

test('operator export needs two opt-ins, writes only a new private file and never prints credentials',async()=>{
  const {spawnSync}=await import('node:child_process'); const t=await tenant(), key=fake(); await t.call('/keys',{provider:'groq',key});
  const run=(name,flag,allow='')=>spawnSync(process.execPath,['platform/scripts/exportKeys.js',t.slug,path.join(root,name),...(flag?['--with-keys']:[])],{env:{...process.env,PLATFORM_ALLOW_KEY_EXPORT:allow},encoding:'utf8',timeout:5000});
  assert.equal(run('safe.json',false,'1').status,0);assert.ok(!fs.readFileSync(path.join(root,'safe.json'),'utf8').includes(key));
  assert.equal(run('refused.json',true).status,1);assert.equal(fs.existsSync(path.join(root,'refused.json')),false);
  const opted=run('private.json',true,'1'); assert.equal(opted.status,0);assert.ok(!`${opted.stdout}${opted.stderr}`.includes(key));assert.equal(JSON.parse(fs.readFileSync(path.join(root,'private.json')))[0].key,key);
  assert.equal(fs.statSync(path.join(root,'private.json')).mode&0o777,0o600);assert.equal(run('safe.json',true,'1').status,1);
});

test('an old worker finishing after an in-place rotation with identical last four cannot set the new key’s health', async () => {
  const events = await import('../src/services/usageEvents.js');
  const t = await tenant();
  const id = (await t.call('/keys', { provider: 'groq', key: fake('5555') })).data.key.id;
  const oldRefs = keys.deliveryEnv(t.slug).env.LLM_KEY_REFS;
  const event = { tenant: t.slug, provider: 'groq', keySlot: 1, keyLast4: '5555' };
  const prior = process.env.LLM_KEY_REFS, sink = events.currentRecorder();
  try {
    events.setUsageRecorder(usage.record);
    process.env.LLM_KEY_REFS = oldRefs;
    events.recordUsage({ ...event, totalTokens: 5 });
    assert.ok(keys.getKey(t.slug, id).last_used_at);
    const rotated = await t.call(`/keys/${id}/rotate`, { key: fake('5555') });
    assert.equal(rotated.data.key.version, 2);
    assert.equal(rotated.data.key.lastUsedAt, null);
    events.recordUsage({ ...event, errorCategory: 'invalid' }); // completed on the old generation *after* rotation
    assert.equal(keys.healthFor(t.slug).chain[0].calls, 0);
    assert.equal(keys.healthFor(t.slug).chain[0].health, 'unknown');
    process.env.LLM_KEY_REFS = keys.deliveryEnv(t.slug).env.LLM_KEY_REFS;
    events.recordUsage({ ...event, totalTokens: 8 });
    assert.equal(keys.healthFor(t.slug).chain[0].tokens, 8);
    assert.equal(keys.healthFor(t.slug).chain[0].health, 'active');
    const byVersion = keys.usagePerKey(t.slug).sort((a,b) => a.version - b.version);
    assert.deepEqual(byVersion.map((v) => [v.version,v.calls,v.errors]), [[1,2,1],[2,1,0]]);
  } finally {
    events.setUsageRecorder(sink);
    if (prior === undefined) delete process.env.LLM_KEY_REFS; else process.env.LLM_KEY_REFS = prior;
  }
});

test('journal recovery replays a flushed .importing batch once and preserves appends on the new path', async () => {
  const { consumeUsageJournal } = await import('../src/services/usageEvents.js');
  const t = await tenant(), dir = path.join(admin.tenantDir(t.slug),'data');
  const file = path.join(dir,'usage-events.jsonl');
  const event = (uid) => JSON.stringify({ tenant: t.slug, uid, totalTokens: 2 }) + '\n';
  fs.writeFileSync(file,event('first'));
  const interrupted = consumeUsageJournal(dir, (lines) => {
    assert.ok(!fs.existsSync(file));
    fs.appendFileSync(file,event('second')); // a worker appends after the rename, before commit/unlink
    usage.record(JSON.parse(lines[0])); assert.ok(db.flush());
    return { ok: false }; // simulate interruption before the batch could be removed
  });
  assert.equal(interrupted.ok,false); assert.ok(fs.existsSync(file+'.importing'));
  assert.deepEqual(usage.ingestJournal({slug:t.slug}),{ok:true,imported:0,duplicates:1});
  assert.ok(!fs.existsSync(file+'.importing')); assert.ok(fs.existsSync(file));
  assert.deepEqual(usage.ingestJournal({slug:t.slug}),{ok:true,imported:1,duplicates:0});
  assert.equal(usage.summary(t.slug).totals.total_tokens,4); assert.ok(!fs.existsSync(file));
});

test('an explicitly failed fallback model is removed from a running worker without blocking its chosen provider', async () => {
  const { defaultModel } = await import('../platform/models.js');
  const t = await tenant();
  await t.call('/keys', { provider: 'groq', key: fake() });
  await t.call('/keys', { provider: 'openrouter', key: 'sk-or-' + crypto.randomUUID() });
  assert.equal(keys.modelFor(t.slug).provider, 'groq');
  let delivered;
  keys.setKeyHooks({ runScenario: async () => ({text:'Rs 789123'}), restartTenant: async (_slug, opts) => { delivered = opts.extraEnv; } });
  db.run("UPDATE tenants SET status='active' WHERE slug=?", [t.slug]);
  const check = await t.call('/compatibility', { provider:'openrouter', model:defaultModel('openrouter'), consent:true });
  assert.equal(check.data.status, 'FAIL'); assert.equal(check.data.worker,'restarted');
  assert.equal(delivered.OPENROUTER_API_KEY, ''); assert.equal(delivered.LLM_PROVIDERS,'groq');
  assert.ok(delivered.GROQ_API_KEY); assert.equal(keys.modelState(t.slug).blocked,false);
});

test('revoke and destruction queue behind in-flight delivery; a later write cannot resurrect a tenant or its key', async () => {
  const { destroyTenant } = await import('../platform/provisioning.js');
  const t = await tenant(), id = (await t.call('/keys', {provider:'groq',key:fake()})).data.key.id;
  db.run("UPDATE tenants SET status='active' WHERE slug=?",[t.slug]);
  let entered, release;
  const starting = new Promise((r) => { entered = r; }), unblock = new Promise((r) => { release = r; });
  const actions = [];
  keys.setKeyHooks({ restartTenant: async () => { actions.push('restart'); entered(); await unblock; }, stopTenant: async () => { actions.push('stop'); } });
  const rotate = t.call(`/keys/${id}/rotate`, {key:fake('2222')});
  await starting;
  const revoke = keys.applyToWorker(t.slug, () => keys.revokeKey({slug:t.slug,keyId:id}));
  const destroy = destroyTenant(t.slug,{accountId:t.auth.id});
  try { assert.equal(keys.getKey(t.slug,id).status,'active'); assert.deepEqual(actions,['restart']); }
  finally { release(); }
  assert.equal((await rotate).data.worker,'restarted'); assert.equal((await revoke).worker,'stopped');
  assert.ok((await destroy).ok); assert.deepEqual(actions,['restart','stop','stop']);
  assert.equal(keys.getKey(t.slug,id),null); assert.equal(fs.existsSync(admin.tenantDir(t.slug)),false);
  const late = await keys.applyToWorker(t.slug, () => assert.fail('must check for deletion before mutating'));
  assert.equal(late.status,404);
});
