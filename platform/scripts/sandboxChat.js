// platform/scripts/sandboxChat.js
// One sandbox turn, in a throwaway child process.
//
// stdin  : {"text": "...", "number": "900000000000"}
// stdout : {"ok": true, "replies": ["..."]}
//
// The transport below is the whole safety story: it has no socket, it refuses to
// send to any number other than the sandbox one, and it records what the bot
// *would* have sent. The brain, the profile, the knowledge base and the
// conversation control settings are the tenant's real ones.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SANDBOX_NUMBER = process.env.SANDBOX_NUMBER || '900000000000';

function readInput() {
  return new Promise((resolve, reject) => {
    let raw = '';
    const timer = setTimeout(() => reject(new Error('no_input')), 5000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(raw.trim() || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on('error', reject);
  });
}

/** A transport that cannot reach WhatsApp, or anybody, ever. */
function sandboxTransport(number) {
  const sent = [];
  const refuse = (jid) => {
    const digits = String(jid || '').split('@')[0].replace(/\D/g, '');
    if (digits !== SANDBOX_NUMBER) {
      throw new Error(`sandbox: refusing to send to ${digits.slice(0, 4)}…`);
    }
  };
  return {
    sent,
    sandbox: true,
    name: 'sandbox',
    connected: true,
    user: { id: `${number}:1@s.whatsapp.net`, name: 'Sandbox' },
    async sendMessage(jid, payload) {
      refuse(jid);
      const text = typeof payload === 'string' ? payload : payload?.text || payload?.caption || '';
      if (text) sent.push(String(text));
      return { key: { id: `SANDBOX-${Date.now()}-${sent.length}` } };
    },
    async sendPresenceUpdate() {},
    async readMessages() {},
    async sendSeen() {},
    async downloadMedia() {
      return null;
    },
    async stop() {},
  };
}

async function main() {
  const input = await readInput();
  const text = String(input.text || '').trim().slice(0, 500);
  if (!text) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'empty_message' })}\n`);
    return;
  }

  // Running this script manually must never erase or open an actual tenant DB.
  const root = process.env.SANDBOX_ROOT || '';
  if (process.env.SANDBOX !== '1' || path.dirname(root) !== os.tmpdir() || !/^wa-sandbox-[a-f0-9-]{36}$/.test(path.basename(root))) throw new Error('not_a_sandbox');
  for (const [key, leaf] of [['DATA_DIR','data'],['SESSION_FOLDER','sessions'],['TMP_DIR','tmp']]) {
    const dir = path.join(root, leaf);
    if (process.env[key] !== dir) throw new Error('not_a_sandbox');
    fs.mkdirSync(dir, { mode: 0o700 });
  }

  const db = await import('../../src/utils/db.js');
  await db.initDB();
  const { handleIncoming, drainBatches } = await import('../../src/handlers/messageHandler.js');

  const number = SANDBOX_NUMBER;
  const transport = sandboxTransport(number);
  await handleIncoming(transport, {
    id: `SANDBOX-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    chat: `${number}@s.whatsapp.net`,
    number,
    pushName: 'Test customer (sandbox)',
    kind: 'text',
    text,
  });

  // Give fire-and-forget sends (typing indicators, deferred replies) a moment.
  await drainBatches({ timeoutMs: 40000 });
  process.stdout.write(`${JSON.stringify({ ok: true, replies: transport.sent, sandbox: true, number })}\n`);
  // The process is a scratch one; leave without flushing a database nobody owns.
  process.exit(0);
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'sandbox_failed' })}\n`);
  process.exit(1);
});
