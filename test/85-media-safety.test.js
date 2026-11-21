import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isolate, fakeSock } from './helpers.js';
isolate('safety-media');
Object.assign(process.env, {
  VOICE_REPLY_MODE: 'match_voice',
  TTS_PROVIDERS: 'groq',
  REPLY_TARGET_MIN_MS: '15',
  REPLY_TARGET_MAX_MS: '30',
  TYPING_MIN_MS: '5',
  TYPING_MAX_MS: '10',
});
const { config } = await import('../src/config/env.js'),
  db = await import('../src/utils/db.js');
const { buildVoiceNote } = await import('../src/services/tts.js'),
  { sendHuman } = await import('../src/core/humanizer.js');
const { CloudTransport } = await import('../src/transport/cloud.js'),
  { BaileysTransport } = await import('../src/transport/baileys.js');
const { MediaTooBigError } = await import('../src/services/media.js');
const { transcribe } = await import('../src/services/transcription.js'),
  { hasFfmpeg } = await import('../src/services/ffmpeg.js');
const { understandVideo } = await import('../src/services/video.js');
config.owner.profile.features = {};
const fixture = (f) => fs.readFileSync(new URL('fixtures/media/' + f, import.meta.url));
await db.initDB();

test('unflagged real builder → timed and legacy senders: audio, readable quote, one companion (no invented top-level buffer)', async (t) => {
  const speech = t.mock.method(globalThis, 'fetch', async (u) => {
    assert.match(String(u), /audio\/speech$/);
    // The real Groq adapter asks for WAV: 0.1 s of synthetic 16 kHz mono silence.
    const header = Buffer.from(
      '52494646a40c000057415645666d74201000000001000100803e0000007d00000200100064617461800c0000',
      'hex'
    );
    return new Response(Buffer.concat([header, Buffer.alloc(3200)]), {
      headers: { 'Content-Type': 'audio/wav' },
    });
  });
  const voice = await buildVoiceNote('Here are the shop hours.', { langInfo: { code: 'en' } });
  assert.equal(speech.mock.callCount(), 1);
  assert.ok(Buffer.isBuffer(voice.payload.audio));
  for (const timed of [true, false]) {
    process.env.REPLY_TIMING = String(timed);
    config.timing.enabled = timed;
    for (const [text, companionText, keep] of [
      ['Come in tomorrow.', false, false],
      ['Website 60,000 to 180,000. Ecommerce 120,000 to 350,000.', false, true],
      ['Come in tomorrow.', true, true],
    ]) {
      const sock = fakeSock();
      await sendHuman(sock, '12025550111@s.whatsapp.net', text, { voice, companionText });
      const audio = sock.sent.filter((m) => m.payload.audio);
      assert.equal(audio.length, 1);
      assert.deepEqual(audio[0].payload, voice.payload);
      assert.equal(
        sock.sent.some((m) => m.payload.text),
        keep
      );
    }
    const refused = fakeSock(),
      send = refused.sendMessage;
    refused.sendMessage = async (j, p) => {
      if (p.audio) throw Error('invalid audio');
      return send(j, p);
    };
    await sendHuman(refused, '12025550112@s.whatsapp.net', 'See you soon.', { voice });
    assert.deepEqual(
      refused.sent.map((m) => m.payload.text),
      ['See you soon.']
    );
  }
});
test('unflagged Cloud media: declared, HTTP and streamed byte limits; same deadline at metadata and slow body', async () => {
  const incoming = { kind: 'video', mediaRef: { mediaId: 'film' } },
    signals = [];
  config.vision.maxVideoBytes = 4;
  let mode = 'metadata',
    second = 0;
  const cloud = new CloudTransport({
    token: 'fixture',
    fetchImpl: async (url, { signal }) => {
      signals.push(signal);
      assert.ok(signal instanceof AbortSignal);
      if (mode === 'slow-meta')
        return new Promise((_r, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        );
      if (String(url).endsWith('/film'))
        return Response.json({
          url: 'https://fixture.invalid/media',
          file_size: mode === 'metadata' ? 5 : 1,
        });
      second++;
      if (mode === 'header') return new Response('x', { headers: { 'Content-Length': '5' } });
      if (mode === 'slow')
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
            },
          })
        );
      return new Response('12345');
    },
  });
  await assert.rejects(cloud.getMedia(incoming), MediaTooBigError);
  assert.equal(second, 0);
  for (mode of ['header', 'stream']) {
    await assert.rejects(cloud.getMedia(incoming), MediaTooBigError);
    assert.equal(signals.at(-2), signals.at(-1));
  }
  const count = signals.length;
  await assert.rejects(
    cloud.getMedia({ ...incoming, kind: 'audio', seconds: config.stt.maxSeconds + 1 }),
    MediaTooBigError
  );
  assert.equal(signals.length, count);
  config.media.timeoutMs = 30;
  const keep = setTimeout(() => {}, 2000);
  try {
    for (mode of ['slow', 'slow-meta']) {
      await assert.rejects(cloud.getMedia(incoming), /timeout/i);
      assert.ok(signals.at(-1).aborted);
    }
  } finally {
    clearTimeout(keep);
  }
  config.vision.maxVideoBytes = 48 * 1024 * 1024;
  config.media.timeoutMs = 20000;
});
test('unflagged Baileys rejects wrapped audio/video declarations before the downloader is needed', async () => {
  const t = new BaileysTransport();
  for (const [field, limit] of [
    ['audioMessage', 25 * 1024 * 1024],
    ['videoMessage', config.vision.maxVideoBytes],
  ]) {
    const raw = {
      message: {
        ephemeralMessage: {
          message: {
            viewOnceMessageV2: {
              message: {
                [field]: {
                  seconds: 1,
                  fileLength: field === 'audioMessage' ? { low: limit + 1, high: 0 } : limit + 1,
                },
              },
            },
          },
        },
      },
    };
    await assert.rejects(t.getMedia({ raw }), MediaTooBigError);
  }
});
test('MAX_AUDIO_SECONDS before Whisper: overlength and unreadable refused, short audio is a measured metadata-free WAV', async (t) => {
  const captured = [];
  t.mock.method(globalThis, 'fetch', async (_u, { body }) => {
    captured.push(body.get('file'));
    return Response.json({ text: 'example words', duration: 2, language: 'English' });
  });
  config.stt.maxSeconds = 1;
  assert.equal(await transcribe(fixture('long.ogg')), null);
  assert.equal(await transcribe(Buffer.from('bad')), null);
  assert.equal(captured.length, 0);
  config.stt.maxSeconds = 10;
  const r = await transcribe(fixture('english.ogg'));
  if (hasFfmpeg()) {
    assert.equal(r.text, 'example words');
    assert.equal(captured.length, 1);
    const wav = Buffer.from(await captured[0].arrayBuffer());
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 36, 40), 'data');
    assert.equal(wav.length, 44 + wav.readUInt32LE(40));
    assert.ok(wav.length <= 44 + 32000 * 10);
  } else {
    assert.equal(r, null);
    assert.equal(captured.length, 0);
  }
  assert.deepEqual(fs.existsSync(config.paths.tmp) ? fs.readdirSync(config.paths.tmp) : [], []);
  config.stt.maxSeconds = 600;
});
test('legacy clip with flags off: fake vision receives JPEGs and fake STT only WAV, neither receives original; corrupt clip no calls', async (t) => {
  const original = fixture('product-demo.mp4'),
    requests = [];
  config.keys.gemini = 'synthetic';
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    requests.push({ url: String(url), body });
    if (String(url).endsWith('/audio/transcriptions'))
      return Response.json({ text: 'A lamp is here', duration: 3 });
    return Response.json({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  shown: 'A blue lamp',
                  subject: 'product',
                  sensitive: false,
                  unclear: false,
                }),
              },
            ],
          },
        },
      ],
    });
  });
  assert.equal(await understandVideo({ buffer: fixture('corrupt.mp4') }), null);
  assert.equal(requests.length, 0);
  const result = await understandVideo({ buffer: original });
  if (!hasFfmpeg()) {
    assert.equal(result, null);
    assert.equal(requests.length, 0);
    return;
  }
  assert.match(result.description, /lamp/);
  const kinds = [];
  for (const { url, body } of requests) {
    if (url.endsWith('/audio/transcriptions')) {
      const bytes = Buffer.from(await body.get('file').arrayBuffer());
      kinds.push(bytes.toString('ascii', 0, 4));
      assert.equal(body.get('file').type, 'audio/wav');
      assert.ok(!bytes.includes(original));
    } else {
      assert.match(url, /:generateContent$/);
      assert.ok(!body.includes(original.toString('base64')));
      const parts = JSON.parse(body).contents[0].parts.filter((p) => p.inline_data);
      assert.ok(parts.length > 0);
      for (const p of parts) {
        kinds.push(p.inline_data.mime_type);
        assert.equal(Buffer.from(p.inline_data.data, 'base64').readUInt16BE(0), 0xffd8);
      }
    }
  }
  assert.deepEqual([...new Set(kinds)].sort(), ['RIFF', 'image/jpeg']);
});
