// Application composition root. The bot's HTTP server takes an optional route;
// neither its brain nor a managed tenant worker loads the control-plane store.
import '../src/config/env.js'; // reads ENV_FILE before deciding what to mount

async function start() {
  let handleRoute = null;
  if (!process.env.TENANT_WORKER_MODE && /^(1|true|yes|on)$/i.test((process.env.PLATFORM_ENABLED || '').trim())) {
    const platform = await import('../platform/index.js');
    await platform.initPlatform(); // refuse insecure production auth before bot boot or listen
    handleRoute = platform.handlePlatformRoute;
  }
  const { boot } = await import('../src/boot.js');
  await boot({ handleRoute });
}

start().catch((err) => {
  console.error('Boot failed:', err?.message || 'startup error');
  process.exit(1);
});
