#!/usr/bin/env node
// scripts/webhooks.js
// One public URL for every cloud tenant.
//
// Meta only lets you register one webhook URL per app, and a free tunnel only
// exposes one port. This runs a small reverse proxy that sends
//
//   https://<your-tunnel>/webhook/ayesha-designs  →  her process (port 3001)
//   https://<your-tunnel>/webhook/burger-point    →  their process (port 3002)
//
// Usage:
//   node scripts/webhooks.js                 # all tenants with TRANSPORT=cloud
//   node scripts/webhooks.js --port 8080
//   node scripts/webhooks.js --only ayesha-designs
//
// The tenants themselves still run with `node scripts/run-all.js`.

import fs from 'node:fs';
import path from 'node:path';
import { startGateway } from '../src/transport/gateway.js';

const ROOT = process.cwd();
const TENANTS = path.join(ROOT, 'tenants');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const only = arg('only');
const port = Number(arg('port', process.env.WEBHOOK_PORT || 8080));

function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function cloudTenants() {
  if (!fs.existsSync(TENANTS)) return [];
  return fs
    .readdirSync(TENANTS)
    .map((slug) => {
      const dir = path.join(TENANTS, slug);
      const manifest = path.join(dir, 'tenant.json');
      if (!fs.existsSync(manifest)) return null;
      try {
        const t = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        const env = readEnv(path.join(dir, '.env'));
        const cloud = (env.TRANSPORT || t.transport || '').toLowerCase() === 'cloud';
        return { slug: t.slug || slug, name: t.name, port: t.port || Number(env.PORT) || 3000, cloud, enabled: t.enabled !== false };
      } catch {
        return null;
      }
    })
    .filter((t) => t && t.enabled && t.cloud)
    .filter((t) => !only || t.slug === only);
}

const tenants = cloudTenants();

if (!tenants.length) {
  console.log('\nNo cloud tenants found.');
  console.log('Each tenant opts in from its own .env:');
  console.log('  TRANSPORT=cloud');
  console.log('  CLOUD_PHONE_ID=…  CLOUD_TOKEN=…  CLOUD_VERIFY_TOKEN=…  CLOUD_APP_SECRET=…\n');
  process.exit(0);
}

const routes = tenants.map((t) => ({ slug: t.slug, target: `http://127.0.0.1:${t.port}` }));

console.log(`\n🔀 ${tenants.length} cloud tenant${tenants.length === 1 ? '' : 's'} behind one port:`);
for (const t of tenants) console.log(`   ${t.name.padEnd(24)} /webhook/${t.slug} → 127.0.0.1:${t.port}`);

await startGateway({ routes, port });

console.log(`\nPut this in Meta → WhatsApp → Configuration → Webhook URL:`);
console.log(`   https://<your-tunnel-host>/webhook/${tenants[0].slug}`);
console.log('…and the same host for every other tenant, with its own slug.\n');
console.log('Expose this port with:  cloudflared tunnel --url http://localhost:' + port);
console.log('                    or:  ngrok http ' + port + '\n');

const shutdown = () => process.exit(0);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
