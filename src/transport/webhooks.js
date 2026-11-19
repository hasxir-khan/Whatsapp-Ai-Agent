// src/transport/webhooks.js
// Serving /webhook/<slug> from a plain node:http server.
//
// Kept separate from server.js so the dashboard stays a dashboard and the
// webhook path can be mounted by anything: this process's server, the
// multi-tenant gateway, or a test.

import { transportFor, transports } from './index.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Read the raw body — signatures are computed over bytes, not over JSON. */
export function readRawBody(req, { limit = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    const fail = (err) => {
      if (done) return;
      done = true;
      // Do NOT destroy the socket here: the caller still has to write the 413.
      // Draining instead of killing keeps the response deliverable and stops the
      // client from filling memory.
      req.removeAllListeners('data');
      req.resume();
      reject(err);
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        const err = new Error(`webhook body too large (limit ${limit} bytes)`);
        err.code = 'too_large';
        fail(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => fail(err));
  });
}

/** /webhook/<slug> → slug, or null when the path is something else. */
export function slugFromPath(pathname = '') {
  const m = /^\/webhook\/([A-Za-z0-9._-]{1,64})\/?$/.exec(pathname);
  if (m) return m[1];
  if (/^\/webhook\/?$/.test(pathname)) return 'default';
  return null;
}

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

/**
 * Handle one webhook request.
 * @returns {Promise<boolean>} true when the request was ours to answer
 */
export async function handleWebhookRequest(req, res, url) {
  const slug = slugFromPath(url.pathname);
  if (!slug) return false;

  const transport = transportFor(slug);

  if (!transport) {
    // Never pretend success to Meta: an unknown tenant is a misconfigured URL.
    const known = transports().map((t) => t.slug);
    send(
      res,
      404,
      known.length
        ? `No cloud tenant "${slug}". Known: ${known.join(', ')}`
        : 'Cloud transport is not running in this process (TRANSPORT=cloud not set).'
    );
    return true;
  }

  if (typeof transport.verifyWebhook !== 'function') {
    send(res, 405, `Tenant "${slug}" is not on the Cloud API (transport: ${transport.kind}).`);
    return true;
  }

  if (req.method === 'GET') {
    const result = transport.verifyWebhook(Object.fromEntries(url.searchParams));
    send(res, result.status, result.body);
    return true;
  }

  if (req.method === 'POST') {
    let rawBody = '';
    try {
      rawBody = await readRawBody(req);
    } catch (err) {
      if (err.code === 'too_large') {
        send(res, 413, err.message);
      } else {
        send(res, 400, `Could not read the body: ${err.message}`);
      }
      return true;
    }

    const result = await transport.handleWebhook({ rawBody, headers: req.headers });
    send(res, result.status, result.body);
    return true;
  }

  send(res, 405, 'Method not allowed');
  return true;
}

export default { handleWebhookRequest, readRawBody, slugFromPath };
