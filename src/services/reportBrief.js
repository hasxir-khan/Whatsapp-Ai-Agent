import crypto from 'node:crypto';
import { masked } from './reportContract.js';
// The URL is a short-lived owner grant for ONE masked contact. The tenant also
// requires its ordinary inbox credential. Neither credential grants a platform
// login. No brief values pass through a platform server or analytics table.
export function briefGrant(contact, until, secret) {
  if (!masked(contact) || !secret) throw new Error('invalid_brief');
  return crypto.createHmac('sha256', secret).update(`report-brief-v1\0${contact}\0${until}`).digest('base64url');
}
export function validBriefGrant(contact, until, proof, secret, now = Date.now()) {
  if (
    !secret ||
    !masked(contact) ||
    !/^\d{13}$/.test(until) ||
    +until <= now ||
    +until > now + 5 * 60000 ||
    !/^[\w-]{43}$/.test(proof || '')
  )
    return false;
  return crypto.timingSafeEqual(Buffer.from(briefGrant(contact, until, secret)), Buffer.from(proof));
}

// Rendered on the tenant only. Never put a brief in a platform template.
const escape = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function briefHtml(payload = null) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Collected intake brief</title><style>body{font:1rem/1.5 system-ui;margin:2rem auto;padding:0 1rem;max-width:36rem;color:#182e29}dt{font-weight:650}dd{margin:0 0 1rem;white-space:pre-wrap;overflow-wrap:anywhere}</style><main><small>Tenant live inbox · owner only</small><h1>Collected intake brief</h1>${payload ? `<p>${escape(payload.contact)} · ${escape(payload.percent)}% complete</p><dl>${payload.collected.map((f) => `<dt>${escape(f.label)}</dt><dd>${escape(f.value)}</dd>`).join('')}</dl><p>Still needed: ${escape(payload.missing.join(', ') || 'none')}</p>` : '<p>Sign in to your normal tenant live inbox in another tab, then return here. If the link has expired, request a new brief link on the Leads page.</p><p><a href="">I’m signed in — open brief</a></p>'}</main></html>`;
}
