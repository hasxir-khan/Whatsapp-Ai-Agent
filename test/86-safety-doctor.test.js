import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as demo from './fixtures/dashboard.js';
const { diagnostics, doctorDiagnostics } = await import('../platform/diagnostics.js');
const { exportAccount } = await import('../platform/accounts.js');
const { buildBundle } = await import('../scripts/backup.js');
const { recordAudit } = await import('../platform/audit.js');
const { config } = await import('../src/config/env.js');
const { verifyModels, modelWarnings } = await import('../src/services/modelCatalog.js');
const { alias } = await import('../src/services/reportContract.js');
const { encryptValue, decryptValue } = await import('../platform/crypto.js');
const { run, all } = demo.db;

test('doctor catches missing, weak and mismatched managed contact secrets; backups, customer exports, audit and doctor never contain either canary', async () => {
  const name = 'PLATFORM_TENANT_TOKEN',
    master = process.env.PLATFORM_KEY_SECRET,
    token = process.env[name];
  const dir = path.dirname(demo.dir),
    file = path.join(dir, '.env');
  fs.writeFileSync(file, `export PLATFORM_KEY_SECRET="${master}"\n${name}=${token}\n`, { mode: 0o600 });
  const bundle = buildBundle({ dir, withKeys: true });
  assert.ok(!bundle.files['.env']);
  recordAudit({
    action: 'fixture_check',
    accountId: demo.owner.id,
    detail: { PLATFORM_KEY_SECRET: master, PLATFORM_TENANT_TOKEN: token },
  });
  const output = () =>
    JSON.stringify([
      Object.values(bundle.files).map((v) => Buffer.from(v, 'base64').toString()),
      exportAccount(demo.owner.id).export,
      all('SELECT detail FROM platform_audit'),
    ]);
  for (const k of [master, token]) assert.ok(!output().includes(k));
  run('DELETE FROM tenant_secrets WHERE slug=? AND name=?', [demo.slug, name]);
  assert.ok(diagnostics(all).warnings.includes('tenant_token_missing'));
  run('INSERT INTO tenant_secrets VALUES(?,?,?,?)', [
    demo.slug,
    name,
    'a'.repeat(40),
    demo.now.toISOString(),
  ]);
  assert.ok(diagnostics(all).warnings.includes('tenant_token_weak'));
  run('UPDATE tenant_secrets SET value=? WHERE slug=? AND name=?', [token, demo.slug, name]);
  fs.writeFileSync(file, `${name}=${crypto.randomUUID()}\n`);
  demo.db.flush();
  assert.ok((await doctorDiagnostics()).warnings.includes('tenant_token_mismatch'));
  fs.writeFileSync(file, `${name}=${token}\n`);
  run("INSERT INTO tenants(slug,account_id,name,status,created_at,updated_at) VALUES(?,?,?,'paused',?,?)", [
    'other-demo',
    demo.owner.id,
    'Example',
    demo.from,
    demo.from,
  ]);
  run('INSERT INTO tenant_secrets VALUES(?,?,?,?)', ['other-demo', name, token, demo.from]);
  assert.ok(diagnostics(all).warnings.includes('tenant_token_weak'));
  run('DELETE FROM tenant_secrets WHERE slug=?', ['other-demo']);
  run('DELETE FROM tenants WHERE slug=?', ['other-demo']);
  demo.db.flush();
  const repaired = await doctorDiagnostics();
  assert.ok(!repaired.warnings.some((w) => w.startsWith('tenant_token')));
  const before = fs.readFileSync(demo.db.currentFile());
  fs.writeFileSync(path.join(dir, 'tenant.json'), JSON.stringify({ slug: demo.slug, platformManaged: true }));
  for (const key of ['', 'short']) {
    const cli = spawnSync(process.execPath, ['scripts/doctor.js', 'platform'], {
      env: { ...process.env, PLATFORM_KEY_SECRET: key },
      encoding: 'utf8',
    });
    assert.match(cli.stdout, /key_secret_unusable/);
    assert.equal(cli.status, 1);
    assert.ok(!cli.stdout.includes(token));
    assert.ok(!cli.stdout.includes(master));
  }
  for (const arg of [token, 'PLATFORM_TENANT_TOKEN=' + token, 'PLATFORM_KEY_SECRET=' + master]) {
    const cli = spawnSync(process.execPath, ['scripts/tenant.js', 'keys', demo.slug, arg], {
      encoding: 'utf8',
    });
    assert.notEqual(cli.status, 0);
    assert.doesNotMatch(cli.stdout + cli.stderr, new RegExp(token + '|' + master));
  }
  assert.deepEqual(fs.readFileSync(demo.db.currentFile()), before);
  assert.match(fs.readFileSync('README.md', 'utf8'), /^## Backups and secrets$/m);
});
test('restoring the original secrets restores decryption and joins; replacing them does not', () => {
  const old = process.env.PLATFORM_KEY_SECRET,
    next = crypto.randomBytes(32).toString('base64url');
  const aad = 'fixture:slot:1',
    key = 'fixture-provider-value',
    e = encryptValue(key, { secret: old, aad });
  assert.equal(decryptValue(e, { secret: next, aad }).ok, false);
  assert.equal(decryptValue(e, { secret: old, aad }).value, key);
  const secret = process.env.PLATFORM_TENANT_TOKEN,
    who = alias(demo.phone, secret);
  assert.notEqual(alias(demo.phone, next), who);
  assert.equal(alias(demo.phone, secret), who);
});
test('model inventory checks every configured family and backup slot against list endpoints, including a later Gemini page', async () => {
  Object.assign(config.llm, {
    groqModels: ['chat-ok'],
    groqSmallModels: ['small-retired'],
    geminiModels: ['gemini-page-two'],
    openrouterTextModels: ['router-text'],
    openrouterAllowlist: ['router-allowed'],
  });
  Object.assign(config.vision, {
    geminiModels: ['vision-unknown'],
    openrouterModels: ['router-vision'],
    groqModels: ['groq-vision'],
  });
  Object.assign(config.stt, { model: 'speech-a', fallbackModel: 'speech-b' });
  config.embed.model = 'embed-unknown';
  config.tts.groqModelEnglish = 'synthesis-unknown';
  config.owner.profile.brain = { reasoningProvider: 'groq', reasoningModel: 'reasoning-unknown' };
  config.keys.gemini = 'demo-google';
  config.keys.openrouter = 'demo-router';
  process.env.GROQ_API_KEY_2 = 'demo-backup';
  const calls = [];
  const result = await verifyModels({
    fetchImpl: async (u, opts) => {
      const url = new URL(u);
      calls.push(url);
      assert.equal(opts.method, 'GET');
      assert.equal(opts.redirect, 'error');
      assert.ok(opts.signal);
      if (url.host === 'generativelanguage.googleapis.com') {
        assert.equal(opts.headers['x-goog-api-key'], 'demo-google');
        return Response.json(
          url.searchParams.has('pageToken')
            ? { models: [{ name: 'models/gemini-page-two' }] }
            : { models: [{ name: 'models/other' }], nextPageToken: 'next' }
        );
      }
      if (opts.headers.Authorization === 'Bearer demo-backup') return Response.json({}, { status: 429 });
      return Response.json({ data: [{ id: 'chat-ok' }] });
    },
  });
  const warnings = result.flatMap(modelWarnings).join('\n');
  for (const m of [
    'small-retired',
    'vision-unknown',
    'router-text',
    'router-allowed',
    'router-vision',
    'groq-vision',
    'speech-a',
    'speech-b',
    'embed-unknown',
    'synthesis-unknown',
    config.tts.groqModelArabic,
    'reasoning-unknown',
  ])
    assert.ok(warnings.includes('unknown model ' + m), m);
  assert.doesNotMatch(
    warnings,
    /unknown model (chat-ok|gemini-page-two)|demo-backup|demo-google|demo-router/
  );
  assert.match(warnings, /groq slot 2: model list unavailable \(HTTP 429\); names not verified/);
  assert.equal(calls.length, 5);
  const partial = await verifyModels({
    providers: ['gemini'],
    fetchImpl: async (u) =>
      new URL(u).searchParams.has('pageToken')
        ? Response.error()
        : Response.json({ models: [], nextPageToken: 'next' }),
  });
  assert.equal(partial[0].state, 'unverified');
  assert.equal(partial[0].unknown, undefined);
});
test('doctor CLI with media flags off and fake lists: four actionable missing settings and unknown model name', () => {
  const dir = fs.mkdtempSync(path.join(demo.root, 'doctor-'));
  fs.writeFileSync(
    path.join(dir, 'owner.json'),
    JSON.stringify({
      business: { languages: ['en', 'skr'], voice: { voiceByLanguage: { en: 'en-US-AriaNeural' } } },
      features: {},
    })
  );
  const stub = path.join(dir, 'catalog.cjs');
  fs.writeFileSync(
    stub,
    `const Module=require('node:module'), load=Module._load; Module._load=function(id,...args){return id==='ffmpeg-static'?null:load.call(this,id,...args)}; global.fetch=async(u,opts)=>{if(new URL(u).pathname!=="/api/v1/models"||opts.method!=="GET")throw Error();return Response.json({data:[{id:"on-list"}]});};`
  );
  const env = {
    ...process.env,
    CONFIG_DIR: dir,
    ENV_FILE: path.join(dir, 'no.env'),
    PLATFORM_ENABLED: '0',
    PLATFORM_KEY_SECRET: '',
    PATH: dir,
    FFMPEG_PATH: '',
    GROQ_VISION_MODEL: '',
    GEMINI_API_KEY: '',
    GOOGLE_API_KEY: '',
    OPENROUTER_API_KEY: '',
    TTS_PROVIDERS: 'edge',
  };
  const doctor = (section) =>
    spawnSync(process.execPath, ['--require', stub, 'scripts/doctor.js', section], { env, encoding: 'utf8' });
  const media = doctor('media');
  assert.equal(media.status, 0);
  assert.match(media.stdout, /missing TTS voice for skr/);
  assert.match(media.stdout, /missing vision key/);
  assert.match(media.stdout, /PLATFORM_KEY_SECRET missing or weak/);
  assert.match(media.stdout, /ffmpeg not found/);
  env.OPENROUTER_API_KEY = 'demo-router';
  env.OPENROUTER_MODELS = 'on-list,missing-name';
  const models = doctor('openrouter');
  assert.equal(models.status, 0);
  assert.match(models.stdout, /unknown model missing-name/);
  assert.doesNotMatch(models.stdout, /demo-router|unknown model on-list/);
});
