// Install and upgrade acceptance, not live provider checks. No host .env,
// real owner profile, credentials, mail server or WhatsApp session required.
import assert from 'node:assert/strict';
import { test, after, afterEach } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { isolate } from './helpers.js';

const root = isolate('platform-deployment');
Object.assign(process.env, { PLATFORM_ENABLED:'1', PLATFORM_SECRET:randomUUID(), PLATFORM_KEY_SECRET:randomUUID(),
  ENV_FILE:path.join(root,'.env'), CONFIG_DIR:path.join(root,'config'), PLATFORM_DIR:path.join(root,'platform'), TENANTS_DIR:path.join(root,'tenants') });
const db = await import('../platform/db.js');
const { PLAN_SEEDS } = await import('../platform/schema.js');
const session = await import('../platform/session.js');
const { clientIp } = await import('../platform/http.js');
const mail = await import('../platform/mailer.js');
const accounts = await import('../platform/accounts.js');
const keys = await import('../platform/keys.js');
const { createPlatformServer, initPlatform } = await import('../platform/index.js');
const { doctorDiagnostics } = await import('../platform/diagnostics.js');
const { loginPage, signupPage, verifyPage, resetPage } = await import('../platform/views.js');
await db.initPlatformDb();
const baseline = { ...process.env };
const child = (args, env = process.env) => spawnSync(process.execPath, args, { env, encoding:'utf8', timeout:10000 });
afterEach(() => {
  mail.setMailer(null);
  for (const key of Object.keys(process.env)) if (!(key in baseline)) delete process.env[key];
  Object.assign(process.env, baseline);
});
after(() => { db.closePlatformDb(); fs.rmSync(root, { recursive:true, force:true }); });

test('upgrade a populated pre-BYOK SQLite file twice without losing tenants, usage or custom plans', async () => {
  fs.mkdirSync(process.env.PLATFORM_DIR, { recursive:true });
  const file = path.join(process.env.PLATFORM_DIR,'v1-fixture.db');
  const SQL = await initSqlJs(), v1 = new SQL.Database();
  // v1 (including real installs with user_version still zero).
  v1.run(`CREATE TABLE tenants(slug TEXT PRIMARY KEY,account_id TEXT NOT NULL,name TEXT NOT NULL,number TEXT,plan_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft',provision_step INTEGER NOT NULL DEFAULT 0,provision_error TEXT,paused_reason TEXT,
    trial_ends_at TEXT,link_status TEXT NOT NULL DEFAULT 'unlinked',link_updated_at TEXT,link_error TEXT,template TEXT,port INTEGER,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE plans(id TEXT PRIMARY KEY,name TEXT NOT NULL,trial_days INTEGER NOT NULL,price INTEGER NOT NULL,
    limits TEXT NOT NULL,features TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE usage_events(id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL,event_uid TEXT,created_at TEXT NOT NULL,
    day TEXT NOT NULL,month TEXT NOT NULL,provider TEXT,model TEXT,agent TEXT,kind TEXT NOT NULL,conversation TEXT,
    prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0,total_tokens INTEGER DEFAULT 0,estimated INTEGER DEFAULT 0,latency_ms INTEGER DEFAULT 0);
    INSERT INTO tenants(slug,account_id,name,status,created_at,updated_at) VALUES('old-shop','account','Old Shop','active','before','before');
    INSERT INTO usage_events(tenant,created_at,day,month,kind,total_tokens) VALUES('old-shop','before','then','then','chat',900);`);
  const growth = PLAN_SEEDS.find((p) => p.id === 'growth');
  for (const [id, features] of [['growth', growth.features.filter((f) => f !== 'conversationControl')],['starter',['customFlag']]]) {
    v1.run('INSERT INTO plans VALUES (?,?,14,123,?,?,?)',[id,id,'{}',JSON.stringify(features),'before']);
  }
  fs.writeFileSync(file,v1.export()); v1.close();
  for (let boot=0; boot<2; boot++) {
    await db.initPlatformDb({file}); assert.equal(db.get('PRAGMA user_version').user_version,2);
    assert.equal(db.get('SELECT * FROM tenants').name,'Old Shop'); assert.equal(db.get('SELECT status FROM tenants').status,'provisioned'); assert.equal(db.get('SELECT * FROM usage_events').total_tokens,900);
    for (const table of ['tenant_keys','compatibility_runs','settings_undo']) assert.deepEqual(db.all(`SELECT * FROM ${table}`),[]);
    assert.deepEqual(JSON.parse(db.get("SELECT features FROM plans WHERE id='growth'").features),growth.features);
    assert.equal(db.get("SELECT features FROM plans WHERE id='starter'").features,'["customFlag"]');
    assert.equal(db.get('SELECT key_slot,key_last4,error_category FROM usage_events').key_slot,null);
    assert.equal(keys.keySourceFor('old-shop'),'tenant'); assert.equal(db.get('SELECT test_chat_at FROM tenants').test_chat_at,null);
    if (!boot) db.closePlatformDb();
  }
  await db.initPlatformDb();
});

test('session + CSRF cookie issue, selection and clearing depend on configured HTTPS, not headers', () => {
  const id = 'cookie-account';
  db.run('INSERT INTO accounts (id,email,email_norm,created_at) VALUES(?,?,?,?)',[id,'cookie@example.com','cookie@example.com',new Date().toISOString()]);
  process.env.PLATFORM_PUBLIC_URL='https://app.example.com';
  const issued = session.issueSession(id);
  for (const c of [...issued.cookies,...session.clearCookies()]) { assert.match(c,/^__Host-/); assert.match(c,/; Secure/); assert.match(c,/; Path=\//); assert.match(c,/SameSite=Strict/); assert.doesNotMatch(c,/Domain=/); }
  assert.match(issued.cookies[0],/HttpOnly/); assert.doesNotMatch(issued.cookies[1],/HttpOnly/); assert.ok(session.clearCookies().every((c) => c.includes('Max-Age=0')));
  const req = {headers:{cookie:issued.cookies.map((c)=>c.split(';')[0]).join('; '),'x-forwarded-proto':'http','x-platform-csrf':issued.csrf}};
  assert.equal(session.readSession(req).accountId,id); assert.ok(session.mutationAllowed(req,session.readSession(req)));
  req.headers.cookie=req.headers.cookie.replaceAll('__Host-',''); assert.equal(session.readSession(req).ok,false);
  process.env.PLATFORM_PUBLIC_URL='http://app.example.com'; assert.doesNotMatch(session.issueSession(id).cookies[0],/^__Host-|; Secure/);
  for (const render of [loginPage, signupPage, verifyPage, resetPage]) { const html = render(); assert.match(html,/src="\/platform\/auth.js"/); assert.match(html,/<form method="post"/); }
});

test('production plain HTTP refuses standalone and mounted startup; override must be exactly 1 and doctor warns', async () => {
  Object.assign(process.env,{NODE_ENV:'production',PLATFORM_PUBLIC_URL:'http://prod.example',PLATFORM_ALLOW_HTTP:'true',PLATFORM_DEV_SHOW_CODES:'1',PLATFORM_MAILER:'file'});
  await assert.rejects(initPlatform(),/HTTPS/i);
  for (const args of [['platform/index.js'],['src/index.js']]) {
    const proc=child(args); assert.equal(proc.status,1); assert.match(proc.stderr,/https PLATFORM_PUBLIC_URL/);
  }
  assert.ok((await doctorDiagnostics()).errors.includes('https_required'));
  process.env.PLATFORM_ALLOW_HTTP='1'; const ready=await initPlatform(); assert.equal(ready.ok,true);
  const check=await doctorDiagnostics(); assert.ok(check.ok); assert.deepEqual(check.warnings.sort(),['dev_show_codes_set','insecure_http_override','outbox_in_production']);
  const out=child(['scripts/doctor.js','platform']); assert.match(out.stdout,/outbox does not deliver email/); assert.match(out.stdout,/Unset PLATFORM_DEV_SHOW_CODES/); assert.match(out.stdout,/plain HTTP/);
  assert.equal(mail.showCodesInResponse(),false);
});

test('XFF and cloudflared trust the configured immediate peer and only its designated header', () => {
  process.env.NODE_ENV='production'; delete process.env.PLATFORM_TRUST_PROXY;
  const headers={'x-forwarded-for':'198.51.100.2, 198.51.100.3','cf-connecting-ip':'203.0.113.5'};
  const ip=(peer, h=headers)=>clientIp({socket:{remoteAddress:peer},headers:h});
  assert.equal(ip('10.0.0.5'),'10.0.0.5'); assert.equal(ip('198.51.100.10'),'198.51.100.10');
  process.env.PLATFORM_TRUST_PROXY='xff:10.0.0.5,cf:127.0.0.1';
  assert.equal(ip('::ffff:10.0.0.5'),'198.51.100.3'); assert.equal(ip('10.0.0.6'),'10.0.0.6');
  assert.equal(ip('127.0.0.1'),'203.0.113.5'); assert.equal(ip('198.51.100.10'),'198.51.100.10');
  assert.equal(ip('10.0.0.5',{'cf-connecting-ip':headers['cf-connecting-ip']}),'10.0.0.5');
  assert.equal(ip('127.0.0.1',{'cf-connecting-ip':'not an IP'}),'127.0.0.1');
});

test('HTTPS mail adapter is bounded, no redirects; failed mail cannot report delivered or fall back to a file', async () => {
  const token=randomUUID(); Object.assign(process.env,{PLATFORM_MAILER:'http',PLATFORM_MAIL_URL:'https://mail.example/send',PLATFORM_MAIL_TOKEN:token,PLATFORM_MAIL_FROM:'verify@example.com'});
  const message={to:'customer@example.com',subject:'Verification',text:'Fixture'};
  const result=await mail.httpMailer.send(message,async (url,o)=>{assert.equal(url.href,process.env.PLATFORM_MAIL_URL);assert.equal(o.headers.authorization,`Bearer ${token}`);
    assert.deepEqual(JSON.parse(o.body),{...message,from:'verify@example.com',to:[message.to]});assert.equal(o.redirect,'error');assert.ok(o.signal instanceof AbortSignal); return {ok:true};});
  assert.ok(result.ok); process.env.PLATFORM_MAIL_URL='http://mail.example';
  assert.equal((await mail.httpMailer.send(message,()=>assert.fail('no insecure fetch'))).ok,false);
  mail.setMailer({mode:'smtp',send:async()=>{throw Error(token)}});
  assert.deepEqual(await mail.sendMail(message),{ok:false,mode:'smtp'});
  const signup=await accounts.signupStart({email:'delivery@example.com',terms:true,privacy:true}); assert.equal(signup.error,'email_delivery_unavailable'); assert.equal(signup.devCode,undefined);
  const reset=await accounts.passwordResetStart({email:'delivery@example.com'}); assert.deepEqual(reset,await accounts.passwordResetStart({email:'unknown@example.com'}));
  assert.ok(!fs.existsSync(path.join(process.env.PLATFORM_DIR,'outbox.jsonl'))); assert.ok(!JSON.stringify(reset).includes(token));
});

test('read-only doctor and public readiness detect wrong master and unsupported source without disclosing tenant facts', async () => {
  const value='gsk_'+randomUUID(), slug='health-shop';
  db.run("INSERT INTO tenants(slug,account_id,name,created_at,updated_at) VALUES(?,'account','Fixture','then','then')",[slug]); assert.ok(keys.addKey({slug,provider:'groq',key:value}).ok);
  db.run("UPDATE tenants SET key_source='platform' WHERE slug=?",[slug]); db.flush();
  const file=db.currentFile(), before=fs.readFileSync(file); process.env.PLATFORM_KEY_SECRET=randomUUID();
  const check=await doctorDiagnostics(); assert.deepEqual(check.errors.sort(),['cannot_decrypt','platform_keys_unavailable']);assert.deepEqual(fs.readFileSync(file),before);
  const server=createPlatformServer(); await new Promise((r)=>server.listen(0,'127.0.0.1',r));
  try { const res=await fetch(`http://127.0.0.1:${server.address().port}/api/health`); assert.equal(res.status,503);const body=await res.text();assert.deepEqual(JSON.parse(body).errors.sort(),check.errors);for (const s of [value,value.slice(-4),slug,process.env.PLATFORM_KEY_SECRET]) assert.ok(!body.includes(s)); }
  finally { await new Promise((r)=>server.close(r)); }
});

test('link-only HTTP permits only GET liveness, authenticated status and QR, even with a valid dashboard token', async () => {
  const { config } = await import('../src/config/env.js');
  const { botState } = await import('../src/state.js');
  const { initDB } = await import('../src/utils/db.js');
  const { startServer } = await import('../src/server.js');
  const old = { ...config.server }, qr = botState.qr, token = randomUUID();
  process.env.TENANT_WORKER_MODE = 'link';
  Object.assign(config.server,{ host:'127.0.0.1', port:0, enabled:true, token });
  await initDB(); botState.qr = 'offline link fixture';
  const server = startServer();
  try {
    if (!server.listening) await new Promise((r) => server.once('listening',r));
    const request = (url, method='GET', auth=true) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method, headers: auth ? {authorization:'Bearer '+token} : {},
    });
    assert.equal((await request('/health','GET',false)).status,200);
    for (const url of ['/api/status','/qr.png']) {
      assert.equal((await request(url,'GET',false)).status,401);
      assert.equal((await request(url)).status,200);
    }
    for (const [path, method] of [['/','GET'],['/api/accuracy','GET'],['/webhook/fixture','POST'],['/api/status','POST'],['/platform','GET']]) {
      const res = await request(path,method);
      assert.equal(res.status,403); assert.equal((await res.json()).error,'link_only_worker');
    }
  } finally {
    await new Promise((r) => server.close(r)); Object.assign(config.server,old); botState.qr = qr;
  }
});
