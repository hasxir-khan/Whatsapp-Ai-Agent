// src/transport/gateway.js
// One public port, many cloud tenants.
//
// Meta wants ONE webhook URL per app, and a tunnel exposes ONE port. Each
// tenant process already serves /webhook/<slug> on its own port, so this
// gateway is a small, dumb reverse proxy that puts all of them behind a single
// address:
//
//   https://<tunnel>/webhook/ayesha-designs  →  127.0.0.1:3001/webhook/ayesha-designs
//   https://<tunnel>/webhook/burger-point    →  127.0.0.1:3002/webhook/burger-point
//
// It forwards the raw bytes untouched, because the signature Meta sends is
// computed over those exact bytes.

import http from 'node:http';
import https from 'node:https';
import { slugFromPath } from './webhooks.js';

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/**
 * @param {{slug:string, target:string}[]} routes  target like "http://127.0.0.1:3001"
 */
export function createGateway({ routes = [], onRequest = null } = {}) {
  const bySlug = new Map(routes.map((r) => [r.slug, r.target]));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const slug = slugFromPath(url.pathname);

    if (!slug) {
      send(res, 404, routes.length ? `Try /webhook/<slug>. Known: ${[...bySlug.keys()].join(', ')}` : 'No cloud tenants configured.');
      return;
    }

    const target = bySlug.get(slug);
    if (!target) {
      send(res, 404, `No cloud tenant "${slug}". Known: ${[...bySlug.keys()].join(', ') || 'none'}`);
      return;
    }

    let targetUrl;
    try {
      targetUrl = new URL(url.pathname + url.search, target);
    } catch {
      send(res, 500, `Bad target for "${slug}": ${target}`);
      return;
    }

    onRequest?.({ slug, path: url.pathname });

    const lib = targetUrl.protocol === 'https:' ? https : http;
    const upstream = lib.request(
      targetUrl,
      {
        method: req.method,
        headers: { ...req.headers, host: targetUrl.host },
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      }
    );

    upstream.on('error', (err) => {
      // The tenant process may be restarting; Meta retries, and so should we
      // say the truth rather than a fake 200.
      send(res, 502, `Tenant "${slug}" unreachable: ${err.message}`);
    });

    req.pipe(upstream);
  });

  return server;
}

export function startGateway({ routes = [], port = 3001, host = '0.0.0.0' } = {}) {
  const server = createGateway({ routes });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`🔀 Webhook gateway on http://${host}:${port}`);
      for (const r of routes) console.log(`   /webhook/${r.slug} → ${r.target}`);
      resolve(server);
    });
  });
}

export default { createGateway, startGateway };
