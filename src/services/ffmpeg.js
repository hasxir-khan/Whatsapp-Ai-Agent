// src/services/ffmpeg.js
// Optional ffmpeg helper. Used for (a) real WhatsApp voice notes (ogg/opus),
// (b) reading a video's audio track, (c) grabbing frames from a video when the
// vision provider can't take video directly.
//
// ffmpeg is OPTIONAL: everything degrades to a still-working path without it.

import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from '../config/env.js';

const require = createRequire(import.meta.url);

let cached; // undefined = not checked yet, null = unavailable

export function ffmpegPath() {
  if (cached !== undefined) return cached;

  const candidates = [];
  if (config.tts.ffmpegPath) candidates.push(config.tts.ffmpegPath);
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);

  // Optional dependency: only present if the user (or their host) installed it
  try {
    const mod = require('ffmpeg-static');
    if (mod) candidates.push(mod);
  } catch {
    /* not installed — fine */
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        cached = candidate;
        return cached;
      }
    } catch {
      /* ignore */
    }
  }

  // System ffmpeg
  try {
    const result = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 5000 });
    if (result.status === 0) {
      cached = 'ffmpeg';
      return cached;
    }
  } catch {
    /* ignore */
  }

  cached = null;
  return cached;
}

export function hasFfmpeg() {
  return !!ffmpegPath();
}

function run(args, { timeout = 60000 } = {}) {
  const bin = ffmpegPath();
  if (!bin) return Promise.reject(new Error('ffmpeg not available'));
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 1024 * 1024 * 32 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = String(stderr || '').slice(-8192);
        reject(error);
      } else {
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    });
  });
}

/** Convert any audio file to Ogg/Opus — the format WhatsApp needs for a voice note. */
export async function toOggOpus(inputPath, outputPath, { maxSeconds } = {}) {
  if (!hasFfmpeg()) return null;
  await run([
    '-y', '-i', inputPath,
    ...(maxSeconds ? ['-t', String(maxSeconds)] : []),
    '-map_metadata', '-1',
    '-ac', '1', '-ar', '48000',
    '-c:a', 'libopus', '-b:a', '48k',
    '-application', 'voip',
    outputPath,
  ]);
  return fs.existsSync(outputPath) ? outputPath : null;
}

/** Pull the audio track out of a video/audio file as mono 16 kHz WAV (ideal for speech-to-text). */
export async function extractAudioForStt(inputPath, outputPath) {
  if (!hasFfmpeg()) return null;
  await run(['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', outputPath]);
  return fs.existsSync(outputPath) ? outputPath : null;
}

/** Instantaneous audio peaks — used to detect silence / no audio track. */
export async function hasAudioTrack(inputPath) {
  if (!hasFfmpeg()) return null;
  try {
    const { stderr } = await run(['-i', inputPath, '-hide_banner']);
    return /Audio:/i.test(stderr);
  } catch (err) {
    return /Audio:/i.test(err.stderr || '');
  }
}

/** Duration in seconds, parsed from ffmpeg's banner (no ffprobe needed). */
export async function duration(inputPath) {
  if (!hasFfmpeg()) return null;
  let text = '';
  try {
    const res = await run(['-i', inputPath, '-hide_banner']);
    text = res.stderr;
  } catch (err) {
    text = err.stderr || '';
  }
  const match = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(text);
  if (!match) return null;
  return parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60 + parseFloat(match[3]);
}

/**
 * Grab evenly spaced JPEG frames from a video.
 * @returns {Promise<Array<{path:string, second:number}>>}
 */
export async function extractFrames(inputPath, outDir, { count = 6, totalSeconds = null } = {}) {
  if (!hasFfmpeg()) return [];
  fs.mkdirSync(outDir, { recursive: true });

  const total = totalSeconds || (await duration(inputPath)) || 0;
  const frames = [];
  const n = Math.max(1, Math.min(12, count));
  const step = total > 0 ? total / (n + 1) : 1;

  for (let i = 1; i <= n; i++) {
    const second = total > 0 ? step * i : i;
    const out = path.join(outDir, `frame_${String(i).padStart(2, '0')}.jpg`);
    try {
      await run([
        '-y', '-ss', String(Math.max(0, second)), '-i', inputPath,
        '-frames:v', '1', '-q:v', '4', '-vf', 'scale=640:-2', out,
      ], { timeout: 30000 });
      if (fs.existsSync(out) && fs.statSync(out).size > 500) {
        frames.push({ path: out, second: Math.round(second) });
      }
    } catch {
      /* skip this frame */
    }
  }
  return frames;
}

export function cleanup(dir) {
  try {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export default {
  ffmpegPath, hasFfmpeg, toOggOpus, extractAudioForStt, extractFrames,
  duration, hasAudioTrack, cleanup,
};

// Do not let a playlist masquerade as an uploaded video or fetch a second
// input. Probe, decode and sample only local, self-contained containers.
const clipInput = file => ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file,pipe',
  '-format_whitelist', 'mov,matroska,webm', '-max_alloc', '67108864', '-max_pixels', '8294400', '-threads', '1', '-i', file];
export async function probeClip(file, { maxSeconds = config.media.maxSeconds } = {}) {
  // ffmpeg exits nonzero after printing stream info when no output is given.
  let banner = '';
  try { await run(clipInput(file), { timeout: 5000 }); } catch (err) { banner = err.stderr || ''; }
  const time = /^  Duration:\s*(\d+):(\d+):([\d.]+)/m.exec(banner);
  const seconds = time && (+time[1] * 3600 + +time[2] * 60 + +time[3]);
  const video = /Stream #[^\n]*Video:/.test(banner), audio = /Stream #[^\n]*Audio:/.test(banner);
  const dimensions = /Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(banner);
  if ((!video && !audio) || (video && (!dimensions || +dimensions[1] * +dimensions[2] > 3840 * 2160))) return null;
  if (seconds > maxSeconds) return { seconds, video, audio };
  // The container header can understate duration. Remux packets (no frame
  // decode) to a null sink and check the machine-readable media clock too.
  const { stdout } = await run(['-v','error','-progress','pipe:1', ...clipInput(file), '-map','0:v:0?',
    '-map','0:a:0?', '-c','copy','-t',String(maxSeconds+2),'-f','null','-'], {timeout:8000});
  const clock = [...stdout.matchAll(/^out_time_us=(\d+)$/gm)].reduce((n,m) => Math.max(n,Number(m[1])/1e6),0);
  if (!clock) return null;
  return { seconds: Math.max(seconds,clock), video, audio };
}
export async function sceneFrames(file, dir, { count, seconds }) {
  const max = Math.min(12, Math.max(1, count));
  // First visible frame + actual scene cuts, not six copies of a static shot.
  await run(['-y', ...clipInput(file), '-map', '0:v:0', '-an', '-sn', '-dn', '-t', String(seconds),
    '-filter_threads', '1', '-vf', "fps=4,scale=w='min(480,iw)':h='min(480,ih)':force_original_aspect_ratio=decrease,select='eq(n,0)+gt(scene,0.20)'",
    '-fps_mode', 'vfr', '-frames:v', String(max), '-q:v', '5', '-threads', '1', path.join(dir, 'scene-%02d.jpg')], { timeout: 20000 });
  return fs.readdirSync(dir).filter(n => /^scene-\d+\.jpg$/.test(n)).sort().slice(0, max).map(n => ({ path: path.join(dir,n) }));
}
export async function clipAudio(file, dir, { seconds }) {
  const out = path.join(dir, 'speech.mp3');
  const { stderr } = await run(['-y', ...clipInput(file), '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', String(seconds),
    '-af', 'volumedetect', '-ac','1','-ar','16000','-c:a','libmp3lame','-b:a','48k', '-map_metadata','-1',out], { timeout: 20000 });
  const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  return peak && Number(peak[1]) < -55 ? null : out;
}
