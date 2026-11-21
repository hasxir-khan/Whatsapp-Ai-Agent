// Same isolated worker DB, scripted reply adapter, live-call budget and
// scoreboard conventions as the chat suite. Live never loads recordings.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('../../test/fixtures/media/', import.meta.url));
const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

export async function runMedia({ live = false, only, maxCalls = 60, print = console.log } = {}) {
  const cases = read('manifest.json').filter((c) => !only || c.id.includes(only));
  if (!cases.length || !Number.isSafeInteger(maxCalls) || maxCalls < 0) throw Error('invalid media case or call cap');
  if (live) (await import('dotenv')).default.config({ path: process.env.ENV_FILE || '.env' });
  const keys = Object.fromEntries(['GROQ', 'GEMINI', 'OPENROUTER'].map((p) => [p, process.env[p + '_API_KEY'] || '']));
  const fake = (k) => !k || /^(?:test|eval|fake|recorded)[-_]/.test(k);
  if (
    live &&
    (fake(keys.GROQ) ||
      (cases.some((c) => c.kind === 'video' && !['audio-only', 'overlength', 'corrupt'].includes(c.id)) &&
        fake(keys.GEMINI) &&
        fake(keys.OPENROUTER) &&
        !process.env.GROQ_VISION_MODEL))
  )
    throw Error('Live media requires Groq STT and, for visual cases, a configured vision provider. No calls made.');
  if (process.env.EVAL_DIR) {
    fs.mkdirSync(process.env.EVAL_DIR, { recursive: true });
    process.env.EVAL_DIR = fs.mkdtempSync(path.join(process.env.EVAL_DIR, 'media-'));
  }
  const { profilePath } = await import('./evalEnv.js');
  for (const [p, k] of Object.entries(keys))
    process.env[p + '_API_KEY'] = live ? k : p === 'OPENROUTER' ? '' : 'recorded-adapter';
  process.env.VOICE_REPLY_MODE = 'match_voice';
  Object.assign(process.env, {
    TENANT: 'media-eval',
    MY_BRAND: 'Example lamp shop',
    MY_BIO: 'A fictitious lamp shop.',
    MY_PERSONALITY: 'Helpful and brief.',
    MY_LOCATION: 'Pakistan',
    MY_TIMEZONE: 'Asia/Karachi',
  });
  if (!live)
    Object.assign(process.env, {
      TTS_PROVIDERS: 'edge',
      STT_ENABLED: 'true',
      LLM_PROVIDERS: 'groq',
      VISION_PROVIDERS: 'gemini',
      MEDIA_VIDEO_MB: '25',
      MEDIA_VIDEO_SECONDS: '60',
      MEDIA_VIDEO_FRAMES: '6',
      MEDIA_VIDEOS_DAY: '10',
      MEDIA_VIDEOS_MONTH: '120',
      MEDIA_VISION_CALLS_DAY: '30',
      MEDIA_VISION_CALLS_MONTH: '300',
    });
  process.env.TENANT_DASHBOARD = '0';
  process.env.PLATFORM_USAGE_JOURNAL = '0';
  process.env.TENANT_VIDEOS_MONTH = '100';
  fs.writeFileSync(
    profilePath(),
    JSON.stringify({
      business: { name: 'Example lamp shop', type: 'shop', country: 'PK', languages: ['en', 'ur'] },
      features: { voiceLanguagePolicy: true, videoUnderstanding: true },
    })
  );
  const { config } = await import('../config/env.js');
  const { hasFfmpeg } = await import('../services/ffmpeg.js');
  if (live && !hasFfmpeg()) throw Error('Live media requires ffmpeg. No calls made.');
  const db = await import('../utils/db.js');
  await db.initDB();
  const { ScriptedModel, LiveModel } = await import('./model.js');
  const { summarise } = await import('./report.js');
  const { createReplyChannel } = await import('../core/replyChannel.js');
  const { sendHuman } = await import('../core/humanizer.js');
  const { handleMediaTurn } = await import('../handlers/mediaTurn.js');
  const { transcribe } = await import('../services/transcription.js');
  const { speechProviders } = await import('../services/tts.js');
  const { matchesVoiceLanguage } = await import('../services/voicePolicy.js');
  const { localMediaLine } = await import('../services/mediaReplies.js');
  const { __setFetch } = await import('../core/llm.js');
  const model = live ? new LiveModel({ maxCalls }).install() : new ScriptedModel().install();
  const recordings = live ? null : read('recordings.json');
  const original = globalThis.fetch;
  let rec,
    simulatedCalls = 0,
    replayedVoices = 0;
  const results = [];
  try {
    globalThis.fetch = live
      ? model.fetchImpl
      : async (url) => {
          simulatedCalls++;
          if (String(url).endsWith('/audio/transcriptions') && rec?.speech) return Response.json(rec.speech);
          if (String(url).includes(':generateContent') && rec?.visual)
            return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(rec.visual) }] } }] });
          throw Error('unrecorded media call');
        };
    print(
      `Media · ${live ? 'live providers' : 'recorded providers'} · ${hasFfmpeg() ? 'local ffmpeg' : 'recorded extraction (ffmpeg absent)'} · synthetic fixtures only`
    );
    for (const [i, c] of cases.entries()) {
      rec = recordings?.[c.id];
      if (!live) model.beginTurn([rec.reply, hasFfmpeg() && rec.spoken].filter(Boolean).map((text) => ({ text })));
      const number = String(12025550100 + i),
        jid = number + '@s.whatsapp.net';
      const contact = db.upsertContact(number, { jid });
      config.owner.profile.business.voice = { textScript: c.textScript || 'urdu' };
      for (const h of c.history || []) db.saveMessage(number, 'user', h, 'text');
      const data = fs.readFileSync(path.join(dir, c.file)),
        receivedAt = Date.now();
      const sent = [];
      const sock = {
        async getMedia() {
          return { buffer: data, mimetype: c.kind === 'video' ? 'video/mp4' : 'audio/ogg' };
        },
        async sendMessage(to, p) {
          sent.push({ to, text: p.text, audio: !!p.audio });
          return { key: { id: 'synthetic-' + sent.length } };
        },
        async sendPresenceUpdate() {},
        can() {
          return true;
        },
      };
      let transcript = '',
        sttCalled = false;
      const listen = async (b, opts) => {
        sttCalled = true;
        // No ffmpeg means production must refuse unmeasured audio. Replay the
        // recorded transcript here only, just like the recorded frame extraction.
        const out = !live && !hasFfmpeg() ? rec.speech : await transcribe(b, opts);
        transcript = out?.text || '';
        // Explicit fault injection after real STT in live mode, not a substitute transcript.
        return out && c.detectorOverride ? { ...out, language: c.detectorOverride } : out;
      };
      const video = { listen };
      if (!live && !hasFfmpeg())
        Object.assign(video, {
          probe: async () =>
            rec.seconds
              ? { seconds: rec.seconds, video: c.scene !== 'sound', audio: !!rec.speech || c.silentTrack }
              : null,
          frames: async () => [{ path: path.join(dir, 'reference.jpg') }],
          audio: async () => (rec.speech ? path.join(dir, 'english.ogg') : null), // transport placeholder only; recorded STT
        });
      const tts = live
        ? {
            ...speechProviders,
            edge: (t, opts) => speechProviders.edge(t, { ...opts, beforeRequest: () => model.reserve() }),
          }
        : {
            edge: async () => {
              replayedVoices++;
              return {
                provider: 'edge',
                ext: 'ogg',
                buffer: fs.readFileSync(path.join(dir, 'tts', c.file)),
                model: 'recorded',
              };
            },
          };
      const channel = createReplyChannel({ chat: number, batch: c.id, transport: sock, jid, sendHuman });
      const blockedBefore = model.blocked || 0;
      const out = await handleMediaTurn(
        {
          sock,
          jid,
          number,
          contact,
          items: [{ incoming: { kind: c.kind, id: c.id } }],
          ctx: { receivedAt },
          channel,
          noteSent() {},
        },
        { listen, video, tts }
      );
      const reply = sent.filter((m) => m.to === jid && m.text).at(-1)?.text || '';
      const expected = c.expected,
        text = c.kind === 'voice' ? transcript : Object.values(out?.summary || {}).join(' ');
      const languageOK =
        out?.policy.code === expected.language &&
        (matchesVoiceLanguage(reply, { language: expected.language, code: expected.language }) ||
          [
            'clarify',
            'shorter',
            'resend',
            'unavailable',
            'review',
            'directions',
            'availability',
            'product',
            'reference',
            'next',
          ].some((k) => reply === localMediaLine(k, expected.language)));
      const coverage = (terms, sample) =>
        terms?.length ? terms.filter((re) => new RegExp(re, 'iu').test(sample)).length / terms.length : null;
      const evidenceScore = coverage(expected.gist, text),
        replyScore = coverage(expected.replyGist, reply);
      const gistScore = replyScore === null ? evidenceScore : Math.min(evidenceScore ?? 1, replyScore);
      const fails = [];
      if (!languageOK) fails.push('language_mismatch');
      if (expected.outcome !== out?.outcome || !!expected.handoff !== !!out?.handoff) fails.push('outcome');
      if (gistScore !== null && gistScore < (live ? 0.5 : 1)) fails.push('gist');
      if (c.expectedAction === 'clarify' && reply !== localMediaLine('clarify', expected.language))
        fails.push('clarification');
      if (!live && model.endTurn()) fails.push('unused_reply');
      if (live && model.blocked > blockedBefore) fails.push('call_cap');
      if (!c.expectedAction && c.kind === 'voice' && reply === localMediaLine('clarify', expected.language))
        fails.push('unanswered');
      if (!live && c.kind === 'voice' && hasFfmpeg() && !sent.some((m) => m.to === jid && m.audio))
        fails.push('missing_audio');
      const r = {
        id: c.id,
        category: c.kind,
        status: fails.length ? 'FAIL' : 'PASS',
        reasons: fails,
        language: out?.policy.code,
        expectedLanguage: expected.language,
        languageOK,
        delivery: sent.some((m) => m.to === jid && m.audio) ? 'voice_and_text' : reply ? 'text' : 'none',
        transcriptQuality: sttCalled ? (out?.policy.quality ?? 0) : null,
        gistScore,
        gistBasis: evidenceScore === null ? 'handling_only' : replyScore === null ? 'evidence' : 'evidence_and_reply',
        latencyMs: Date.now() - receivedAt,
        outcome: out?.outcome,
      };
      results.push(r);
      print(
        `${r.status} ${r.id.padEnd(20)} language=${r.language || 'none'} (${languageOK ? 'correct' : 'WRONG'}) quality=${r.transcriptQuality ?? '—'} gist=${r.gistScore ?? '—'} ${r.latencyMs} ms${fails.length ? ' · ' + fails.join(', ') : ''}`
      );
    }
  } finally {
    globalThis.fetch = original;
    __setFetch(original);
  }
  const summary = summarise(results),
    calls = live ? model.calls : simulatedCalls + model.calls.length;
  print(
    `Media: ${summary.pass}/${summary.total} passed · ${live ? calls + '/' + maxCalls + ' live calls' : calls + ' recorded HTTP/model turns + ' + replayedVoices + ' TTS replays · no network'}`
  );
  return { results, summary, live, calls, replayedVoices, tokens: model.tokens || 0 };
}
