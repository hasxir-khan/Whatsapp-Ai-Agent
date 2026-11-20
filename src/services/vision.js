import { mediaUsage } from './mediaUsage.js';
// src/services/vision.js
// Image + video understanding on a $0 budget.
//
// Provider chain (first one with a key wins, automatically):
//   1. Google Gemini free tier  — images AND native video understanding
//   2. OpenRouter free vision models — images (video via extracted frames)
//   3. Groq — only if a vision model is actually available on the account
// If no provider is configured the caller gets null and answers honestly
// instead of pretending it saw the picture.

import fs from 'node:fs';
import { config } from '../config/env.js';
import { bumpUsage, logEvent } from '../utils/db.js';
import { GEMINI_BASE, geminiHeaders, isKeyError, explainGeminiError } from '../utils/gemini.js';

const sticky = { image: null, video: null };

export function visionProviders() {
  const wanted = config.vision.providers;
  const available = [];
  if (config.keys.gemini && wanted.includes('gemini')) available.push('gemini');
  if (config.keys.openrouter && wanted.includes('openrouter')) available.push('openrouter');
  // Groq's hosted lineup changes often and currently has no vision model, so we
  // only use it when the user explicitly names one.
  if (config.keys.groq && wanted.includes('groq') && process.env.GROQ_VISION_MODEL) available.push('groq');
  return available;
}

export function visionEnabled() {
  return visionProviders().length > 0;
}

export function videoNativeEnabled() {
  return visionProviders().includes('gemini');
}

const DATA_URL = (buffer, mimetype) => `data:${mimetype || 'image/jpeg'};base64,${buffer.toString('base64')}`;

// ── Gemini ──────────────────────────────────────────────────
async function geminiGenerate({ model, parts, system, temperature = 0.4, maxTokens = 900 }) {
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const res = await fetch(url, {
    method: 'POST',
    headers: geminiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const raw = await res.text();

  if (!res.ok) {
    const err = new Error(explainGeminiError(res.status, raw));
    err.status = res.status;
    err.body = raw;
    err.model = model;
    err.keyInvalid = isKeyError(res.status, raw);
    throw err;
  }

  const data = JSON.parse(raw);
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('gemini vision: empty response');
  mediaUsage('vision', 'gemini', model, {
    input: data.usageMetadata?.promptTokenCount,
    output: data.usageMetadata?.candidatesTokenCount,
    estimated: !data.usageMetadata,
  });
  return text;
}

/** Upload a large file to Gemini's Files API and return its URI. */
async function geminiUpload(buffer, mimetype, displayName = 'whatsapp-media') {
  const startRes = await fetch(`${GEMINI_BASE.replace('/v1beta', '')}/upload/v1beta/files`, {
    method: 'POST',
    headers: geminiHeaders({
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buffer.length),
      'X-Goog-Upload-Header-Content-Type': mimetype,
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({ file: { display_name: displayName } }),
    signal: AbortSignal.timeout(30000),
  });

  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!startRes.ok || !uploadUrl) throw new Error(`file upload start failed (${startRes.status})`);

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(buffer.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: buffer,
    signal: AbortSignal.timeout(180000),
  });

  const text = await uploadRes.text();
  if (!uploadRes.ok) throw new Error(`file upload failed (${uploadRes.status}): ${text.slice(0, 200)}`);

  const data = JSON.parse(text);
  const file = data.file || {};
  if (!file.name) throw new Error('file upload: no file name');

  // Wait for processing (videos need transcoding)
  let state = file.state;
  for (let i = 0; i < 30 && state !== 'ACTIVE'; i++) {
    if (state === 'FAILED') throw new Error('gemini file processing failed');
    await new Promise((r) => setTimeout(r, 2000));
    const check = await fetch(`${GEMINI_BASE}/${file.name}`, {
      headers: geminiHeaders(),
      signal: AbortSignal.timeout(20000),
    });
    const info = await check.json();
    state = info.state || info.file?.state;
    if (state === 'ACTIVE') {
      return { uri: info.uri || info.file?.uri || file.uri, name: file.name, mimeType: file.mimeType || mimetype };
    }
  }

  if (state !== 'ACTIVE') throw new Error('gemini file processing timed out');
  return { uri: file.uri, name: file.name, mimeType: file.mimeType || mimetype };
}

async function geminiDeleteFile(name) {
  try {
    await fetch(`${GEMINI_BASE}/${name}`, {
      method: 'DELETE',
      headers: geminiHeaders(),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    /* ignore */
  }
}

async function withGeminiModels(kind, fn) {
  const models = config.vision.geminiModels;
  const preferred = sticky[kind]?.model;
  const ordered = preferred ? [preferred, ...models.filter((m) => m !== preferred)] : models;

  let lastError;
  for (const model of ordered) {
    try {
      const out = await fn(model);
      if (out) {
        sticky[kind] = { provider: 'gemini', model };
        return out;
      }
    } catch (err) {
      mediaUsage('vision', 'gemini', model, { error: 'provider_error' });
      lastError = err;
      if (err.keyInvalid) {
        logEvent('vision_bad_key', null, { status: err.status });
        console.error(`🔑 gemini vision: ${err.message}`);
        break;
      }
      if (err.status === 429) {
        logEvent('vision_rate_limited', null, { provider: 'gemini', model });
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }
      // 400/404 → model can't do this, try the next one
      if ([400, 403, 404].includes(err.status)) continue;
      if (err.status >= 500) continue;
      // Non-HTTP error (parsing etc.) — move on
      continue;
    }
  }
  if (lastError) logEvent('vision_error', null, lastError.message);
  return null;
}

// ── OpenAI-compatible vision (OpenRouter / Groq) ────────────
async function openAiVision({ provider, model, images, prompt, maxTokens = 900 }) {
  const url = provider === 'groq'
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';
  const key = provider === 'groq' ? config.keys.groq : config.keys.openrouter;

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          ...images.map((img) => ({
            type: 'image_url',
            image_url: { url: DATA_URL(img.buffer, img.mimetype) },
          })),
          { type: 'text', text: prompt },
        ],
      },
    ],
    temperature: 0.3,
    max_tokens: maxTokens,
  };

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  if (provider === 'openrouter') {
    headers['X-Title'] = config.bot.name;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const raw = await res.text();

  if (!res.ok) {
    const err = new Error(`${provider} vision ${res.status}: ${raw.slice(0, 250)}`);
    err.status = res.status;
    err.body = raw;
    throw err;
  }

  const data = JSON.parse(raw);
  const text = (data.choices?.[0]?.message?.content || '').toString().trim();
  if (!text) throw new Error(`${provider} vision: empty response`);
  mediaUsage('vision', provider, model, {
    input: data.usage?.prompt_tokens,
    output: data.usage?.completion_tokens,
    estimated: !data.usage,
  });
  return text;
}

async function withOpenAiVision(provider, images, prompt, kind) {
  const models = provider === 'groq' ? config.vision.groqModels : config.vision.openrouterModels;
  const preferred = sticky[kind]?.provider === provider ? sticky[kind]?.model : null;
  const ordered = preferred ? [preferred, ...models.filter((m) => m !== preferred)] : models;

  let lastError;
  for (const model of ordered) {
    try {
      const text = await openAiVision({ provider, model, images, prompt });
      sticky[kind] = { provider, model };
      return text;
    } catch (err) {
      mediaUsage('vision', provider, model, { error: 'provider_error' });
      lastError = err;
      if (err.status === 429) await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
  }
  if (lastError) logEvent('vision_error', null, lastError.message);
  return null;
}

// ── prompts ─────────────────────────────────────────────────
const VISION_SYSTEM =
  'You are the eyes of a WhatsApp assistant that works for a freelance software developer. You describe media accurately and concisely so the assistant can reply like a human who actually looked at it. Never guess; say what you can see. Answer in English.';

function imagePrompt({ caption, context }) {
  return `A client sent this on WhatsApp.${caption ? ` Their caption: "${caption}".` : ''}${context ? `\nKnown context about this client/project: ${context}` : ''}

Describe it for the assistant:
1. What it is (photo / screenshot / design mockup / document / error screen / product…)
2. Exactly what's visible — layout, text, UI elements, colours, content. Transcribe important text/labels/error messages.
3. Anything the developer should react to (a bug, a design reference, a requirement, an invoice amount, a deadline…).

Be factual and compact: 3–7 short lines. No preamble.`;
}

function framesPrompt({ caption, context, count }) {
  return `These are ${count} screenshots taken evenly across a WhatsApp video a client sent.${caption ? ` Their caption: "${caption}".` : ''}${context ? `\nKnown context: ${context}` : ''}

Describe the video for the assistant:
1. What happens from start to end (walk through the frames in order).
2. What is on screen — app, UI, product, person, error, demo…
3. Transcribe any key on-screen text or numbers.
4. What the developer should notice or reply to.

Be factual: 4–8 short lines. No preamble.`;
}

function videoPrompt({ caption, context }) {
  return `A client sent this video on WhatsApp.${caption ? ` Their caption: "${caption}".` : ''}${context ? `\nKnown context about this client/project: ${context}` : ''}

Watch the whole video and describe it for the assistant:
1. What happens, in order (scenes, actions, screen recording steps).
2. What is shown on screen and any text/numbers that appear.
3. Any speech — summarise what is said.
4. What the developer should notice or reply to.

Be factual: 4–10 short lines. No preamble.`;
}

// ── public API ──────────────────────────────────────────────
/**
 * Understand an image.
 * @returns {Promise<{description:string, provider:string, model:string}|null>}
 */
export async function analyzeImage({ buffer, mimetype = 'image/jpeg', caption = '', context = '' }) {
  if (!buffer?.length) return null;
  const providers = visionProviders();
  if (!providers.length) {
    logEvent('vision_unavailable', null, 'no vision provider');
    return null;
  }

  bumpUsage('vision_calls', 1);

  for (const provider of providers) {
    if (provider === 'gemini') {
      const out = await withGeminiModels('image', (model) =>
        geminiGenerate({
          model,
          system: VISION_SYSTEM,
          parts: [
            { inline_data: { mime_type: mimetype, data: buffer.toString('base64') } },
            { text: imagePrompt({ caption, context }) },
          ],
        })
      );
      if (out) return { description: out, provider: 'gemini', model: sticky.image?.model };
    } else {
      const out = await withOpenAiVision(provider, [{ buffer, mimetype }], imagePrompt({ caption, context }), 'image');
      if (out) return { description: out, provider, model: sticky.image?.model };
    }
  }
  return null;
}

/**
 * Understand a video natively (Gemini), falling back to frames handled by the caller.
 * @returns {Promise<{description:string, provider:string, model:string}|null>}
 */
export async function analyzeVideo({ buffer, mimetype = 'video/mp4', caption = '', context = '' }) {
  if (!buffer?.length) return null;
  if (!visionProviders().includes('gemini')) return null;

  bumpUsage('vision_calls', 1);

  const INLINE_LIMIT = 15 * 1024 * 1024;
  let uploaded = null;

  try {
    let parts;

    if (buffer.length <= INLINE_LIMIT) {
      parts = [
        { inline_data: { mime_type: mimetype, data: buffer.toString('base64') } },
        { text: videoPrompt({ caption, context }) },
      ];
    } else {
      uploaded = await geminiUpload(buffer, mimetype, 'whatsapp-video');
      parts = [
        { file_data: { mime_type: uploaded.mimeType || mimetype, file_uri: uploaded.uri } },
        { text: videoPrompt({ caption, context }) },
      ];
    }

    const out = await withGeminiModels('video', (model) =>
      geminiGenerate({ model, system: VISION_SYSTEM, parts, temperature: 0.3, maxTokens: 1100 })
    );
    if (out) return { description: out, provider: 'gemini', model: sticky.video?.model };
    return null;
  } catch (err) {
    logEvent('video_native_error', null, err.message);
    return null;
  } finally {
    if (uploaded?.name) await geminiDeleteFile(uploaded.name);
  }
}

/**
 * Understand a set of extracted frames (used when native video isn't available).
 * @param {Array<{path:string, second:number}>} frames
 */
export async function analyzeFrames({ frames = [], caption = '', context = '' }) {
  if (!frames.length) return null;
  const providers = visionProviders();
  if (!providers.length) return null;

  bumpUsage('vision_calls', 1);

  const images = frames.slice(0, 8).map((f) => ({
    buffer: fs.readFileSync(f.path),
    mimetype: 'image/jpeg',
  }));
  const prompt = framesPrompt({ caption, context, count: images.length });

  for (const provider of providers) {
    if (provider === 'gemini') {
      const out = await withGeminiModels('image', (model) =>
        geminiGenerate({
          model,
          system: VISION_SYSTEM,
          parts: [
            ...images.map((img) => ({ inline_data: { mime_type: img.mimetype, data: img.buffer.toString('base64') } })),
            { text: prompt },
          ],
          maxTokens: 1000,
        })
      );
      if (out) return { description: out, provider: 'gemini', model: sticky.image?.model };
    } else {
      const out = await withOpenAiVision(provider, images, prompt, 'image');
      if (out) return { description: out, provider, model: sticky.image?.model };
    }
  }
  return null;
}

export function visionStatus() {
  return {
    providers: visionProviders(),
    nativeVideo: videoNativeEnabled(),
    sticky: { ...sticky },
  };
}

export default {
  analyzeImage, analyzeVideo, analyzeFrames, visionEnabled, videoNativeEnabled,
  visionProviders, visionStatus,
};
