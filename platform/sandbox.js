// platform/sandbox.js
// The "try it" step, done honestly.
//
// A real test chat has to be the real brain, or it teaches the owner nothing.
// But it must never touch a customer, a real chat, or the assistant's own
// database. So the platform runs the tenant's brain in a short-lived child
// process with:
//   • its own data directory (`<tenant>/tmp/sandbox-data`) — real memory, wiped
//     scope;
//   • a contact number WhatsApp will never issue (900000000000);
//   • a fake transport that records what would have been sent and refuses any
//     other number;
//   • no web server, no session folder, voice replies off.
//
// If the platform is running somewhere it cannot spawn that (a separate box, a
// read-only container) it says so instead of inventing a reply.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../src/config/env.js';

export const SANDBOX_NUMBER = '900000000000';

export function sandboxPaths(slug) {
  const base = path.join(config.root, 'tenants', String(slug));
  return {
    tenantDir: base,
    dataDir: path.join(base, 'tmp', 'sandbox-data'),
    tmpDir: path.join(base, 'tmp', 'sandbox-tmp'),
    sessions: path.join(base, 'tmp', 'sandbox-sessions'),
    script: path.join(config.root, 'platform', 'scripts', 'sandboxChat.js'),
  };
}

/**
 * @returns {Promise<{ok:boolean, replies?:string[], error?:string}>}
 */
export async function runSandboxChat(slug, text, { timeoutMs = 45000, spawnImpl = spawn } = {}) {
  const paths = sandboxPaths(slug);
  const { tenantEnv } = await import('../src/services/adminPanel.js');
  let env;
  try {
    env = tenantEnv(slug);
  } catch {
    return { ok: false, error: 'no_tenant' };
  }

  const childEnv = {
    ...env,
    // Never the real database, never the real session.
    DATA_DIR: paths.dataDir,
    TMP_DIR: paths.tmpDir,
    SESSION_FOLDER: paths.sessions,
    ENABLE_WEB: 'false',
    LOG_LEVEL: 'error',
    PLATFORM_USAGE_JOURNAL: '',
    VOICE_REPLY_MODE: 'off',
    SANDBOX: '1',
    SANDBOX_NUMBER,
  };

  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let finished = false;
    const child = spawnImpl(process.execPath, [paths.script], { cwd: config.root, env: childEnv });
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on?.('data', (chunk) => {
      out += chunk.toString();
    });
    child.stderr?.on?.('data', (chunk) => {
      err += chunk.toString();
    });
    child.on?.('error', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, error: 'spawn_failed' });
    });
    child.on?.('close', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || '{}');
        if (parsed?.ok) resolve({ ok: true, replies: parsed.replies || [], sandbox: true, number: SANDBOX_NUMBER });
        else resolve({ ok: false, error: parsed?.error || 'sandbox_failed', detail: (err || '').slice(-200) });
      } catch {
        resolve({ ok: false, error: 'sandbox_failed', detail: (err || out).slice(-200) });
      }
    });

    try {
      child.stdin?.end?.(`${JSON.stringify({ text: String(text).slice(0, 500), number: SANDBOX_NUMBER })}\n`);
    } catch {
      /* handled by close/error */
    }
  });
}

export default { runSandboxChat, sandboxPaths, SANDBOX_NUMBER };
