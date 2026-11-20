// platform/index.js
// The control plane, as a layer and as an app.
//
//   import { handlePlatformRoute } from './platform/index.js'   → mount it
//   node platform/index.js                                       → run it alone
//
// Standalone: one control-plane DB writer. Managed tenant workers are started
// through the platform, not by the generic fleet supervisor.
//
// With PLATFORM_ENABLED unset nothing here is reachable: `handlePlatformRoute`
// returns false for every path, so the bot's own routes answer exactly as they
// did before.

import http from 'node:http';
import { platformEnabled, platformMisconfigured, platformPort, platformSecret, platformDir, transportProblem } from './env.js';
import { ensurePlatformDb, flush } from './db.js';
import { handlePlatformRoute } from './routes.js';
import { attachUsageSink, detachUsageSink } from './usage.js';
import { seedPlans, expireTrials } from './plans.js';
import { PLATFORM_HEADERS } from './http.js';

export { handlePlatformRoute } from './routes.js';

/**
 * Mount-time setup: open the platform database, seed plans, and let the bot's
 * single LLM call site report into this process when it is the same process.
 * Safe to call when the platform is off (it does nothing).
 */
export function assertPlatformTransport() {
  if (platformEnabled() && transportProblem()) throw new Error(transportProblem());
}
export async function initPlatform() {
  assertPlatformTransport();
  if (!platformEnabled() || platformMisconfigured()) return { ok: false, enabled: platformEnabled() };
  await ensurePlatformDb();
  seedPlans();
  attachUsageSink();
  return { ok: true, enabled: true, dir: platformDir(), secretSet: !!platformSecret() };
}

export function shutdownPlatform() {
  detachUsageSink();
  flush();
}

// ── standalone app ──────────────────────────────────────────
export function createPlatformServer() {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
      return;
    }
    try {
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, platform: platformEnabled() }));
        return;
      }
      const handled = await handlePlatformRoute(req, res, url);
      if (!handled) {
        res.writeHead(404, { ...PLATFORM_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'platform_error' }));
      }
      console.error('platform error:', err?.message || err);
    }
  });
}

async function main() {
  if (!platformEnabled()) {
    console.error('PLATFORM_ENABLED is not set. Set PLATFORM_ENABLED=1 (and PLATFORM_SECRET) to start the control plane.');
    process.exit(1);
  }
  if (platformMisconfigured()) {
    console.error(transportProblem() || 'PLATFORM_ENABLED is on but PLATFORM_SECRET is empty. Refusing to start.');
    process.exit(1);
  }
  await initPlatform();
  const port = platformPort();
  const server = createPlatformServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`🧭 Platform on http://0.0.0.0:${port}`);
    console.log(`   data: ${platformDir()}`);
  });

  // Trial expiry can also be driven by cron; this keeps a single-box install
  // honest without one.
  const timer = setInterval(() => {
    expireTrials().catch(() => {});
  }, 15 * 60000);
  timer.unref?.();

  const stop = () => {
    shutdownPlatform();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

const isDirect = (() => {
  try {
    return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isDirect) {
  main().catch((err) => {
    console.error('Platform failed to start:', err?.message || err);
    process.exit(1);
  });
}

export default { initPlatform, shutdownPlatform, createPlatformServer, handlePlatformRoute };
