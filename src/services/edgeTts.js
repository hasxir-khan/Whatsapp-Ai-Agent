// src/services/edgeTts.js
// Free, key-less, high-quality neural text-to-speech using the same endpoint
// Microsoft Edge's "Read aloud" feature uses. No API key, no billing, and it
// speaks ~100 languages (Urdu, Hindi, Arabic, Spanish, English…).
//
// It's an unofficial endpoint, so everything here is defensive: if Microsoft
// changes something, we reject and the caller falls back to another provider
// or to plain text.

import crypto from 'node:crypto';
import WebSocket from 'ws';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_VERSION = '130.0.2849.68';

// Microsoft has moved this endpoint before; try the known hosts in order.
const WSS_ENDPOINTS = [
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1',
  'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1',
];
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

const WINDOWS_EPOCH_OFFSET = 11644473600; // seconds between 1601-01-01 and 1970-01-01

function secMsGec() {
  const ticks = Math.floor(Date.now() / 1000 + WINDOWS_EPOCH_OFFSET);
  const rounded = ticks - (ticks % 300); // 5-minute window
  return crypto
    .createHash('sha256')
    .update(`${rounded}${TRUSTED_CLIENT_TOKEN}`)
    .digest('hex')
    .toUpperCase();
}

const uuidNoDash = () => crypto.randomUUID().replace(/-/g, '');

function escapeXml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSsml(text, voice, { rate = 0, pitch = 0, volume = 0 } = {}) {
  const lang = voice.split('-').slice(0, 2).join('-');
  const signed = (n) => `${n >= 0 ? '+' : ''}${n}`;
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='${signed(pitch)}Hz' rate='${signed(rate)}%' volume='${signed(volume)}%'>` +
    `${escapeXml(text)}` +
    `</prosody></voice></speak>`
  );
}

/**
 * @param {string} text
 * @param {object} opts
 * @param {string} opts.voice e.g. 'en-US-AriaNeural'
 * @returns {Promise<Buffer>} MP3 audio
 */
export function synthesizeEdge(text, { voice = 'en-US-AriaNeural', rate = 0, pitch = 0, volume = 0, timeoutMs = 30000, signal, beforeRequest } = {}) {
  let lastError = null;

  return (async () => {
    for (const base of WSS_ENDPOINTS) {
      signal?.throwIfAborted();
      beforeRequest?.();
      try {
        return await synthesizeOnce(text, { voice, rate, pitch, volume, timeoutMs, base, signal });
      } catch (err) {
        lastError = err;
        // A rejected handshake on the first host usually means try the next one
        continue;
      }
    }
    throw lastError || new Error('edge-tts failed');
  })();
}

function synthesizeOnce(text, { voice, rate, pitch, volume, timeoutMs, base, signal }) {
  return new Promise((resolve, reject) => {
    const connectionId = uuidNoDash();
    const requestId = uuidNoDash();
    const url =
      `${base}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}` +
      `&ConnectionId=${connectionId}`;

    let ws;
    const chunks = [];
    let settled = false;
    let gotAudio = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(value);
    };

    const abort = () => finish(new Error('edge-tts timeout'));
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });

    try {
      ws = new WebSocket(url, {
        headers: {
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } catch (err) {
      finish(err);
      return;
    }

    ws.on('open', () => {
      const stamp = new Date().toString();
      const configMessage =
        `X-Timestamp:${stamp}\r\n` +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: OUTPUT_FORMAT,
              },
            },
          },
        });
      ws.send(configMessage);

      const ssml = buildSsml(text, voice, { rate, pitch, volume });
      const ssmlMessage =
        `X-RequestId:${requestId}\r\n` +
        'Content-Type:application/ssml+xml\r\n' +
        `X-Timestamp:${stamp}\r\n` +
        'Path:ssml\r\n\r\n' +
        ssml;
      ws.send(ssmlMessage);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buffer.length < 2) return;
        const headerLength = buffer.readUInt16BE(0);
        const header = buffer.slice(2, 2 + headerLength).toString('utf8');
        if (header.includes('Path:audio')) {
          const audio = buffer.slice(2 + headerLength);
          if (audio.length) {
            chunks.push(audio);
            gotAudio = true;
          }
        }
        return;
      }

      const message = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      if (message.includes('Path:turn.end')) {
        if (!gotAudio) finish(new Error('edge-tts returned no audio'));
        else finish(null, Buffer.concat(chunks));
      }
    });

    ws.on('error', (err) => finish(err));
    ws.on('unexpected-response', (_req, res) => {
      finish(new Error(`edge-tts rejected (HTTP ${res?.statusCode})`));
    });
    ws.on('close', () => {
      if (!settled) {
        if (gotAudio) finish(null, Buffer.concat(chunks));
        else finish(new Error('edge-tts closed before audio finished'));
      }
    });
  });
}

export const EDGE_VOICES = {
  'en-US': ['en-US-AriaNeural', 'en-US-GuyNeural', 'en-US-JennyNeural', 'en-US-AndrewNeural', 'en-US-EmmaNeural'],
  'en-GB': ['en-GB-SoniaNeural', 'en-GB-RyanNeural', 'en-GB-LibbyNeural'],
  'ur-PK': ['ur-PK-UzmaNeural', 'ur-PK-AsadNeural'],
  'hi-IN': ['hi-IN-SwaraNeural', 'hi-IN-MadhurNeural'],
  'ar-SA': ['ar-SA-ZariyahNeural', 'ar-SA-HamedNeural'],
  'es-ES': ['es-ES-ElviraNeural', 'es-ES-AlvaroNeural'],
  'fr-FR': ['fr-FR-DeniseNeural', 'fr-FR-HenriNeural'],
  'de-DE': ['de-DE-KatjaNeural', 'de-DE-ConradNeural'],
  'pt-BR': ['pt-BR-FranciscaNeural', 'pt-BR-AntonioNeural'],
  'id-ID': ['id-ID-GadisNeural', 'id-ID-ArdiNeural'],
  'tr-TR': ['tr-TR-EmelNeural', 'tr-TR-AhmetNeural'],
  'ru-RU': ['ru-RU-SvetlanaNeural', 'ru-RU-DmitryNeural'],
  'zh-CN': ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural'],
  'ja-JP': ['ja-JP-NanamiNeural', 'ja-JP-KeitaNeural'],
  'ko-KR': ['ko-KR-SunHiNeural', 'ko-KR-InJoonNeural'],
  'bn-BD': ['bn-BD-NabanitaNeural', 'bn-BD-PradeepNeural'],
  'fa-IR': ['fa-IR-DilaraNeural', 'fa-IR-FaridNeural'],
  'sw-KE': ['sw-KE-ZuriNeural', 'sw-KE-RafikiNeural'],
  'ta-IN': ['ta-IN-PallaviNeural', 'ta-IN-ValluvarNeural'],
  'te-IN': ['te-IN-ShrutiNeural', 'te-IN-MohanNeural'],
  'gu-IN': ['gu-IN-DhwaniNeural', 'gu-IN-NiranjanNeural'],
  'th-TH': ['th-TH-PremwadeeNeural', 'th-TH-NiwatNeural'],
  'he-IL': ['he-IL-HilaNeural', 'he-IL-AvriNeural'],
  'el-GR': ['el-GR-AthinaNeural', 'el-GR-NestorasNeural'],
  'uk-UA': ['uk-UA-PolinaNeural', 'uk-UA-OstapNeural'],
  'nl-NL': ['nl-NL-ColetteNeural', 'nl-NL-MaartenNeural'],
  'pl-PL': ['pl-PL-ZofiaNeural', 'pl-PL-MarekNeural'],
  'fil-PH': ['fil-PH-BlessicaNeural', 'fil-PH-AngeloNeural'],
};

export default { synthesizeEdge, EDGE_VOICES };
