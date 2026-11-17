// src/services/video.js
// "Can you see what's in this video?" — three layers, in order of quality:
//   1. Native video understanding (Gemini free tier): frames + audio in one go.
//   2. ffmpeg frames  → vision model, plus Whisper for the soundtrack.
//   3. Whisper only (audio track) when nothing can look at pixels.
// Whatever happens, the caller gets an honest description or null.

import { config } from '../config/env.js';
import { logEvent } from '../utils/db.js';
import { analyzeVideo, analyzeFrames, visionEnabled } from './vision.js';
import { transcribe, sttEnabled } from './transcription.js';
import {
  hasFfmpeg, extractFrames, extractAudioForStt, duration, cleanup,
} from './ffmpeg.js';
import { writeTemp, tempDir, cleanupPath } from './media.js';

/**
 * @param {object} opts
 * @param {Buffer} opts.buffer
 * @param {string} opts.mimetype
 * @param {string} [opts.caption] what the client typed with the video
 * @param {string} [opts.context] project/client context
 * @returns {Promise<{description:string, transcript:string, provider:string, seconds:number}|null>}
 */
export async function understandVideo({ buffer, mimetype = 'video/mp4', caption = '', context = '', declaredSeconds = 0 }) {
  if (!buffer?.length) return null;
  const notes = [];

  // 1) Best path: native video
  if (visionEnabled()) {
    const native = await analyzeVideo({ buffer, mimetype, caption, context });
    if (native?.description) {
      return {
        description: native.description,
        transcript: '',
        provider: `${native.provider}:native`,
        seconds: declaredSeconds,
      };
    }
  }

  // 2) Frames + audio
  if (hasFfmpeg()) {
    const workDir = tempDir('video');
    let videoFile = null;
    try {
      const ext = /quicktime/.test(mimetype) ? 'mov' : /webm/.test(mimetype) ? 'webm' : /3gpp/.test(mimetype) ? '3gp' : 'mp4';
      videoFile = writeTemp(buffer, ext, 'video');

      const seconds = declaredSeconds || (await duration(videoFile)) || 0;
      const frames = await extractFrames(videoFile, workDir, {
        count: config.vision.videoFrames,
        totalSeconds: seconds,
      });

      let visual = '';
      if (frames.length && visionEnabled()) {
        const frameResult = await analyzeFrames({ frames, caption, context });
        if (frameResult?.description) visual = frameResult.description;
      }

      let transcript = '';
      if (sttEnabled()) {
        const audioPath = await extractAudioForStt(videoFile, `${workDir}/audio.mp3`);
        if (audioPath) {
          const fs = await import('node:fs/promises');
          const audioBuffer = await fs.readFile(audioPath);
          const result = await transcribe(audioBuffer, { mimetype: 'audio/mpeg' });
          if (result?.text) transcript = result.text;
        }
      }

      if (visual || transcript) {
        if (visual && transcript) notes.push('On-screen / visual content:', visual, '', 'What is said in the video:', transcript);
        else if (visual) notes.push(visual);
        else notes.push('Audio transcript of the video (visuals could not be analysed):', transcript);
        return {
          description: notes.join('\n'),
          transcript,
          provider: visual ? 'frames' : 'stt-only',
          seconds,
        };
      }
    } catch (err) {
      logEvent('video_frames_error', null, err.message);
    } finally {
      cleanupPath(videoFile);
      cleanup(workDir);
    }
  }

  // 3) Last resort: just listen to the audio track. WhatsApp videos are usually
  //    mp4, which Whisper accepts directly.
  if (sttEnabled()) {
    try {
      const result = await transcribe(buffer, { mimetype: mimetype.includes('mp4') ? 'audio/mp4' : mimetype });
      if (result?.text) {
        return {
          description: `Audio transcript only (I could not see the picture):\n${result.text}`,
          transcript: result.text,
          provider: 'stt-only',
          seconds: declaredSeconds,
        };
      }
    } catch (err) {
      logEvent('video_stt_error', null, err.message);
    }
  }

  return null;
}

export function videoCapabilities() {
  return {
    native: visionEnabled() && config.vision.providers.includes('gemini'),
    frames: hasFfmpeg() && visionEnabled(),
    audioOnly: sttEnabled(),
    ready: visionEnabled() || sttEnabled(),
  };
}

export default { understandVideo, videoCapabilities };
