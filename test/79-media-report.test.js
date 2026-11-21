import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, day, dir, zone, now, reports, store, dashboard, slug, db } from './fixtures/dashboard.js';
const plans = await import('../platform/plans.js');
const { countMedia } = await import('../src/services/mediaLimits.js');
const { reportPage } = await import('../platform/reportView.js');

test('published scorecard reaches the real, tenant-scoped usage page with monthly plan entitlement', async () => {
  for (const [k, n] of Object.entries({
    videos: 3,
    processed: 3,
    refused: 1,
    video_ms: 1600,
    voice: 4,
    correct: 3,
    errors: 2,
  }))
    countMedia(k, n, undefined, now);
  countMedia('processed', 99, 'another-shop', now);
  await reports.publishReports({ dir, now, days: 2, zone });
  await store.reconcileTenant(slug, { dir, now });
  const q = new URLSearchParams({ range: 'custom', from: day, to: day }),
    data = dashboard(slug, 'usage', q, { now });
  assert.equal(data.metrics.voiceReplyLanguage, 75);
  assert.equal(data.metrics.videosProcessed, 3);
  assert.equal(data.metrics.videosRefused, 1);
  assert.equal(data.metrics.videoProcessingMs, 400);
  assert.equal(data.metrics.mediaProviderErrors, 2);
  assert.equal(data.metrics.monthlyVideos, 3);
  assert.equal(data.metrics.videoEntitlement, plans.getPlan('growth').limits.videos_month);
  assert.match(reportPage(data, q), /Voice and video/);
  for (const [id, n] of [
    ['free', 0],
    ['starter', 30],
    ['growth', 120],
  ])
    assert.equal(plans.getPlan(id).limits.videos_month, n);
  const legacy = plans.getPlan('starter').limits;
  delete legacy.videos_month;
  db.run('UPDATE plans SET limits=? WHERE id=?', [JSON.stringify(legacy), 'starter']);
  assert.equal(plans.getPlan('starter').limits.videos_month, 30);
  legacy.videos_month = 0;
  db.run('UPDATE plans SET limits=? WHERE id=?', [JSON.stringify(legacy), 'starter']);
  assert.equal(plans.getPlan('starter').limits.videos_month, 0);
});

test('media doctor names missing ffmpeg, missing vision key and the specific allowed language without a voice', () => {
  const cfg = path.join(root, 'doctor-profile');
  fs.mkdirSync(cfg);
  fs.writeFileSync(
    path.join(cfg, 'owner.json'),
    JSON.stringify({
      business: { languages: ['ur', 'skr'], voice: { voiceByLanguage: { ur: 'ur-PK-UzmaNeural' } } },
      features: { voiceLanguagePolicy: true, videoUnderstanding: true },
    })
  );
  const r = spawnSync(process.execPath, ['scripts/doctor.js', 'media'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: root,
      FFMPEG_PATH: '',
      CONFIG_DIR: cfg,
      GEMINI_API_KEY: '',
      OPENROUTER_API_KEY: '',
      GROQ_VISION_MODEL: '',
      TTS_PROVIDERS: 'edge',
    },
  });
  const output = r.stdout + r.stderr;
  assert.equal(r.status, 1);
  assert.match(output, /missing vision key/);
  assert.match(output, /missing TTS voice for skr/);
  // An installed optional ffmpeg-static still legitimately works without PATH.
  if (!output.includes('ffmpeg: ')) assert.match(output, /protected video and capped voice replies require ffmpeg/);
});

test('live media refuses absent keys before any spending; no fallback to the recorded provider', () => {
  const r = spawnSync(process.execPath, ['scripts/eval.js', '--media', '--live', '--max-calls', '1'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GROQ_API_KEY: '',
      GEMINI_API_KEY: '',
      OPENROUTER_API_KEY: '',
      ENV_FILE: path.join(root, 'absent'),
    },
  });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /No calls made/);
  assert.doesNotMatch(r.stdout, /recorded providers/);
});

test('live runner wiring (simulated network): actual extracted frames, hard wire cap, wrong reply language fails', async (t) => {
  if (!(await import('../src/services/ffmpeg.js')).hasFfmpeg()) {
    t.skip('requires ffmpeg');
    return;
  }
  const preload = path.join(root, 'record-live-wire.mjs');
  fs.writeFileSync(
    preload,
    `
    import fs from 'node:fs';
    import https from 'node:https';
    // Exercise ws through its real handshake path without opening a socket.
    https.request = () => { fs.appendFileSync(process.env.WIRE,'wss\\n'); throw Error('synthetic handshake failure'); };
    globalThis.fetch=async(url,options)=>{
      let kind='';let body;
      if(String(url).includes(':generateContent')){
        const p=JSON.parse(options.body).contents[0].parts;
        if(!p.some(x=>x.inline_data?.mime_type==='image/jpeg') || p.some(x=>x.file_data || x.inline_data?.mime_type==='video/mp4'))throw Error('unexpected input');
        kind='frames';body={candidates:[{content:{parts:[{text:JSON.stringify({shown:'A blue lamp lights up.',onScreenText:'DESK LAMP',subject:'product',unclear:false,sensitive:false})}]}}]};
      }else if(String(url).endsWith('/transcriptions')){kind='stt';body={text:'کیا آپ مجھے دکان کا پتہ بتا سکتے ہیں؟',language:'Urdu',duration:5};}
      else if(String(url).endsWith('/chat/completions')){kind='reply';body={choices:[{message:{content:'کیا آپ دکان کا پتہ پوچھ رہے ہیں؟'}}]};}
      else throw Error('unexpected call');
      if (process.env.EDGE_TEST==='1' && kind==='stt') body={text:'Could you tell me when the shop opens today?',language:'English',duration:5};
      if (process.env.EDGE_TEST==='1' && kind==='reply') body={choices:[{message:{content:'Are you asking about the shop hours?'}}]};
      fs.appendFileSync(process.env.WIRE,kind+'\\n');if (process.env.FAIL_HTTP==='1')return new Response('',{status:500});return Response.json(body);
    };`
  );
  function probe(only, cap, env = {}) {
    const out = path.join(root, 'media-live-report.json'),
      wire = path.join(root, 'wire');
    fs.writeFileSync(wire, '');
    const r = spawnSync(
      process.execPath,
      [
        '--import',
        preload,
        'scripts/eval.js',
        '--media',
        '--live',
        '--only',
        only,
        '--max-calls',
        String(cap),
        '--out',
        out,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          WIRE: wire,
          GROQ_API_KEY: 'synthetic-only',
          GEMINI_API_KEY: 'synthetic-only',
          TTS_PROVIDERS: 'groq',
          LLM_PROVIDERS: 'groq',
          ...env,
        },
      }
    );
    return {
      status: r.status,
      stdout: r.stdout + r.stderr,
      wire: fs.readFileSync(wire, 'utf8').trim(),
      report: JSON.parse(fs.readFileSync(out)).media,
    };
  }
  const one = probe('silent', 1);
  assert.equal(one.status, 0, one.stdout);
  assert.equal(one.wire, 'frames');
  assert.equal(one.report.calls, 1);
  const zero = probe('silent', 0);
  assert.equal(zero.status, 1);
  assert.equal(zero.wire, '');
  assert.ok(zero.report.results[0].reasons.includes('call_cap'));
  const mismatch = probe('english', 4);
  assert.equal(mismatch.status, 1, mismatch.stdout);
  assert.ok(mismatch.report.results[0].reasons.includes('language_mismatch'));
  assert.equal(mismatch.wire, 'stt\nreply');
  const edge = probe('english', 3, { EDGE_TEST: '1', TTS_PROVIDERS: 'edge' });
  assert.equal(edge.status, 1, edge.stdout);
  assert.equal(edge.report.calls, 3);
  assert.equal(edge.wire, 'stt\nreply\nwss');
  assert.ok(edge.report.results[0].reasons.includes('call_cap'));
  const http = probe('silent', 1, { FAIL_HTTP: '1' });
  assert.equal(http.status, 1, http.stdout);
  assert.equal(http.report.calls, 1);
  assert.equal(http.wire, 'frames');
  assert.ok(http.report.results[0].reasons.includes('call_cap'));
});
