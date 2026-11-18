// test/helpers.js
// Each test file runs in its own process, so env isolation here also isolates
// the database (DATA_DIR) and the fake AI provider.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function isolate(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wa-assistant-${name}-`));
  process.env.DATA_DIR = dir;
  process.env.TMP_DIR = path.join(dir, 'tmp');
  process.env.ENABLE_WEB = 'false';
  process.env.MY_NUMBER = '923001234567';
  process.env.MY_NAME = 'Test Owner';
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.GEMINI_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.DEBOUNCE_MS = '40';
  process.env.NOTIFY_NEW_CHATS = 'false';
  process.env.DAILY_REPORT = 'false';
  process.env.QUIET_HOURS = '';
  process.env.VOICE_REPLY_MODE = 'off'; // tests never hit the network for TTS
  process.env.MIN_DELAY_MS = '5'; // keep the human-style pauses tiny in tests
  process.env.MAX_DELAY_MS = '40';
  process.env.TYPING_CPS = '2000';
  process.env.SESSION_FOLDER = path.join(dir, 'sessions');
  return dir;
}

export function fakeSock() {
  const sent = [];
  const presence = [];
  const reads = [];
  return {
    sent,
    presence,
    reads,
    user: { id: '923001234567:1@s.whatsapp.net', name: 'Test Owner' },
    async sendMessage(jid, payload) {
      sent.push({ jid, payload });
      return { key: { id: `SENT-${sent.length}` } };
    },
    async sendPresenceUpdate(state, jid) {
      presence.push({ state, jid });
    },
    async readMessages(keys) {
      reads.push(keys);
    },
  };
}

export function textMessages(sent, number = '') {
  return sent
    .filter((m) => m.payload?.text && (!number || m.jid.startsWith(number)))
    .map((m) => m.payload.text);
}

export async function waitFor(fn, { timeout = 6000, interval = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('waitFor timed out');
}

export async function settle(ms = 300) {
  await new Promise((r) => setTimeout(r, ms));
}

export const CLIENT = {
  jid: '447700900123@s.whatsapp.net',
  number: '447700900123',
};

export function incomingMessage(text, overrides = {}) {
  return {
    ...overrides,
    key: {
      remoteJid: CLIENT.jid,
      fromMe: false,
      id: `MSG-${Math.random().toString(36).slice(2)}`,
      ...(overrides.key || {}),
    },
    message: { conversation: text, ...(overrides.message || {}) },
    pushName: 'John Client',
  };
}
