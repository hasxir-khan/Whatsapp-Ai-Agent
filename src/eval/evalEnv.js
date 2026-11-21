// src/eval/evalEnv.js
// The sandbox the harness runs in: a throwaway data directory, a throwaway
// config directory, a fake key so the provider list is not empty, and every
// delay turned down to nothing.
//
// Import this module before anything that reads config. It only sets
// environment variables — it does not import config itself, so nothing is
// cached too early.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = process.env.EVAL_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'wa-eval-'));
const configDir = path.join(dir, 'config');
fs.mkdirSync(configDir, { recursive: true });

process.env.DATA_DIR = dir;
process.env.CONFIG_DIR = configDir;
process.env.TMP_DIR = path.join(dir, 'tmp');
process.env.ENABLE_WEB = 'false';
process.env.MY_NUMBER = '923001234567';
process.env.MY_NAME = 'Eval Owner';
// A key that is never used for anything: deterministic mode answers every call
// itself, and live mode needs a real one from the environment.
process.env.GROQ_API_KEY = process.env.EVAL_REAL_KEY || 'eval-not-a-real-key';
process.env.GEMINI_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';
process.env.DEBOUNCE_MS = '0';
process.env.MIN_DELAY_MS = '1';
process.env.MAX_DELAY_MS = '3';
process.env.TYPING_CPS = '100000';
process.env.NOTIFY_NEW_CHATS = 'false';
process.env.DAILY_REPORT = 'false';
process.env.QUIET_HOURS = '';
process.env.VOICE_REPLY_MODE = 'off';
process.env.STREAMING_REPLIES = 'false';
process.env.SESSION_FOLDER = path.join(dir, 'sessions');
process.env.LOG_LEVEL = 'error';

export const evalDir = dir;
export const evalConfigDir = configDir;
export const ownerNumber = '923001234567';
export const defaultCustomer = '923007771122';

export function profilePath() {
  return path.join(configDir, 'owner.json');
}

export default { evalDir, evalConfigDir, ownerNumber, defaultCustomer, profilePath };
