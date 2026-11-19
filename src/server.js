// src/server.js
// Tiny status dashboard + QR page. No framework, no build step.
// Useful locally ("what's my bot doing?") and on free hosts where the process
// must expose a port anyway (Railway/Render health checks).

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { config, teamMembers } from './config/env.js';
import { botState, uptimeMinutes } from './state.js';
import { healthSnapshot } from './services/health.js';
import {
  dbStats, recentEvents, getUsage, getSetting, getContact,
  teamWorkload, recentCalls, callsToday,
} from './utils/db.js';
import { outboxStatus } from './services/outbox.js';
import { rankLeads, priorityMeta } from './services/leads.js';
import { formatMoney } from './services/geo.js';
import { llmStatus } from './core/llm.js';
import { visionStatus } from './services/vision.js';
import { ttsStatus } from './services/tts.js';
import { videoCapabilities } from './services/video.js';
import { sttEnabled } from './services/transcription.js';
import { hasFfmpeg } from './services/ffmpeg.js';
import { handleWebhookRequest } from './transport/webhooks.js';
import {
  authenticate, authRequired, clearCookieHeader, dashboardToken, mutationAllowed,
  rateLimit as webRateLimit, SECURITY_HEADERS, sessionCookieHeader, tokenExchange,
  webSecurityState,
} from './services/webAuth.js';
import { getTransport } from './transport/index.js';
import { handlePlatformRoute } from '../platform/routes.js';
import { initPlatform } from '../platform/index.js';
import { growthSnapshot, SOURCE_LABELS } from './services/growthDashboard.js';
import * as accuracyModule from './services/accuracy.js';
import {
  liveInboxEnabled, inboxChats, inboxThread, inboxReply,
  inboxTakeover, inboxRelease, inboxSummary, latestMessageId,
} from './services/liveInbox.js';
import {
  adminEnabled, adminMisconfigured, adminToken, verifyRequest, csrfOk, rateLimit, LIMITS,
  clientIp, audit, recentAudit, issueSession, parseCookies, COOKIE, CSRF_COOKIE,
  safeEqual, validSlug, listTenants, describeTenant, createTenantFromPanel, deleteTenantFromPanel,
  readTenantProfile, writeTenantProfile, setTenantKeys, probeKey, saveUpload, ingestUpload,
  startTenant, stopTenant, restartTenant, qrForTenant, tenantKeyFor, indexImagesFor, UPLOAD_MAX_BYTES, adminHooks,
} from './services/adminPanel.js';

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function buildStatus() {
  const stats = dbStats();
  const llm = llmStatus();
  const vision = visionStatus();
  const voice = ttsStatus();
  const video = videoCapabilities();
  const usage = getUsage();

  return {
    status: botState.status,
    connectedAt: botState.connectedAt,
    uptimeMinutes: uptimeMinutes(),
    owner: { name: config.owner.name, number: config.owner.number },
    me: botState.me,
    hasQr: !!botState.qr,
    pairingCode: botState.pairingCode,
    lastError: botState.lastError,
    dryRun: config.dryRun,
    transport: {
      kind: getTransport()?.kind || config.transport,
      slug: getTransport()?.slug || config.tenant.slug,
      status: getTransport()?.status || 'not started',
      webhookPath: getTransport()?.webhookPath || null,
      capabilities: getTransport()?.capabilities || null,
    },
    botEnabled: getSetting('bot_enabled', true) !== false,
    growth: growthSnapshot(),
    // Same report `.accuracy` texts and /api/accuracy serves.
    accuracy: accuracyModule.accuracyReport({ days: 7 }),
    stats,
    features: {
      llm: llm.providers,
      vision: vision.providers,
      nativeVideo: vision.nativeVideo,
      videoReady: video.ready,
      stt: sttEnabled(),
      tts: voice.enabled ? voice.mode : 'off',
      ffmpeg: hasFfmpeg(),
    },
    usage: {
      llmCalls: usage.llm_calls,
      llmLimit: config.limits.dailyLlmCalls,
      visionCalls: usage.vision_calls,
      visionLimit: config.limits.dailyVisionCalls,
      audioSeconds: Math.round(usage.stt_seconds),
      ttsChars: usage.tts_chars,
      ttsLimit: config.limits.dailyTtsChars,
    },
    // Reliability, as data: a monitor that only works when WhatsApp is up is
    // not a monitor. This is readable with no token, like the rest of status.
    health: healthSnapshot(),
    events: recentEvents(14)
      .filter((e) => !['ignored_chat', 'memory_summary_error'].includes(e.type))
      .map((e) => {
        const contact = e.number ? getContact(e.number) : null;
        return {
          type: e.type,
          label: EVENT_LABELS[e.type] || e.type.replace(/_/g, ' '),
          number: e.number,
          name: contact?.name || contact?.push_name || '',
          detail: e.detail,
          at: e.created_at,
        };
      }),
    team: [
      { name: config.owner.name, role: 'owner', number: config.owner.number, chats: null },
      ...teamMembers().map((m) => ({
        name: m.name,
        role: m.role,
        number: m.number,
        chats: teamWorkload().find((w) => w.operator === m.name)?.chats || 0,
      })),
    ],
    outbox: outboxStatus(),
    calls: {
      today: callsToday(),
      recent: recentCalls(5).map((c) => ({
        number: c.number,
        name: c.name || getContact(c.number)?.name || '',
        video: !!c.video,
        status: c.status,
        outcome: c.outcome || '',
        at: c.created_at,
      })),
      enabled: config.calls.enabled,
      delaySeconds: config.calls.delaySeconds,
      delayMinSeconds: config.calls.delayMinSeconds,
      delayMaxSeconds: config.calls.delayMaxSeconds,
    },
    leads: rankLeads({ limit: 6 }).map((l) => ({
      name: l.name || `+${l.number}`,
      project: l.project_type || '—',
      status: l.status || 'new',
      score: l.score,
      priority: l.priority,
      nextAction: l.nextAction,
      quote: l.quote_min
        ? `${formatMoney(l.quote_min, l.quote_currency || 'PKR')} – ${formatMoney(l.quote_max, l.quote_currency || 'PKR')}`
        : '',
      country: l.country || '',
    })),
  };
}

const EVENT_LABELS = {
  message_in: 'message in',
  quote_sent: 'quote sent',
  escalation: 'needs you',
  new_contact: 'new chat',
  memory_summary: 'memory updated',
  call_incoming: 'incoming call',
  call_answered: 'call answered',
  call_fallback: 'missed call → answered in chat',
  call_fallback_skipped: 'missed call (daily cap)',
  call_tts_failed: 'voice note failed on a call',
  followup_scheduled: 'follow-up queued',
  followup_sent: 'follow-up sent',
  handoff: 'you took over',
  contact_blocked: 'blocked',
  spam_signal: 'spam signal',
  deleted_message: 'message deleted',
  brief_extracted: 'brief read',
  stt_error: 'voice failed',
  vision_error: 'vision failed',
  tts_error: 'voice reply failed',
  llm_rate_limited: 'AI rate limited',
  connected: 'connected',
  paused_by_owner: 'paused',
};

const COLORS = {
  online: '#22c55e',
  waiting_for_qr: '#f59e0b',
  pairing: '#f59e0b',
  connecting: '#38bdf8',
  reconnecting: '#f59e0b',
  starting: '#94a3b8',
  stopped: '#ef4444',
};

function bar(value, limit) {
  const pct = Math.min(100, Math.round((value / Math.max(1, limit)) * 100));
  return `<div class="bar"><span style="width:${pct}%"></span></div><div class="small">${value} / ${limit}</div>`;
}

function page(data) {
  const color = COLORS[data.status] || '#94a3b8';
  const qrBlock = data.hasQr
    ? `<div class="card qr">
         <h2>Scan to connect</h2>
         <img src="/qr.png?t=${Date.now()}" alt="WhatsApp QR" />
         <p class="small">WhatsApp → Linked devices → Link a device</p>
       </div>`
    : data.pairingCode
      ? `<div class="card"><h2>Pairing code</h2><div class="code">${esc(data.pairingCode)}</div>
         <p class="small">WhatsApp → Linked devices → Link with phone number</p></div>`
      : '';

  const events = data.events
    .map(
      (e) =>
        `<tr><td class="small">${esc(new Date(e.at).toLocaleTimeString('en-GB'))}</td>
         <td><code>${esc(e.label)}</code></td>
         <td class="small">${esc(e.name || (e.number ? `+${e.number}` : ''))}</td>
         <td class="small">${esc((e.detail || '').toString().slice(0, 70))}</td></tr>`
    )
    .join('');

  const leads = data.leads
    .map(
      (l) =>
        `<tr><td>${esc(l.name)}</td><td class="small">${esc(l.project)}</td>
         <td class="small">${esc(l.quote)}</td>
         <td class="small">${priorityMeta(l.priority).emoji} ${l.score ?? '—'}</td>
         <td class="small">${esc(l.nextAction || '')}</td>
         <td><span class="tag">${esc(l.status)}</span></td></tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(config.owner.name)}'s WhatsApp Assistant</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: radial-gradient(1200px 600px at 20% -10%, #12324a 0%, #0b1220 45%, #070b13 100%);
         color:#e8eef7; min-height:100vh; }
  .wrap { max-width: 1020px; margin: 0 auto; padding: 28px 20px 60px; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing:.2px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing:.12em; color:#8ea3bd; margin:0 0 12px; }
  .sub { color:#8ea3bd; font-size: 13px; margin-bottom: 22px; }
  .pill { display:inline-flex; align-items:center; gap:8px; padding:6px 12px; border-radius:999px;
          background: rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08); font-size:12px; }
  .dot { width:8px; height:8px; border-radius:50%; background:${color}; box-shadow:0 0 12px ${color}; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(210px,1fr)); gap:14px; margin:18px 0; }
  .card { background: rgba(255,255,255,.035); border:1px solid rgba(255,255,255,.07);
          border-radius:16px; padding:16px; backdrop-filter: blur(6px); }
  .k { font-size: 26px; font-weight: 650; letter-spacing:-.02em; }
  .small { font-size: 12px; color:#8ea3bd; }
  .bar { height:6px; background: rgba(255,255,255,.08); border-radius:99px; overflow:hidden; margin:8px 0 6px; }
  .bar span { display:block; height:100%; background: linear-gradient(90deg,#38bdf8,#22c55e); }
  .qr { text-align:center; grid-column: span 2; }
  .qr img { width: 240px; height:240px; border-radius: 14px; background:#fff; padding:8px; }
  .code { font: 700 30px ui-monospace, monospace; letter-spacing:.35em; padding:12px 0; }
  table { width:100%; border-collapse: collapse; }
  td { padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.05); vertical-align: top; }
  code { background: rgba(56,189,248,.12); color:#7dd3fc; padding:2px 6px; border-radius:6px; font-size:11px; }
  .row { display:flex; gap:10px; flex-wrap:wrap; }
  .tag { font-size:11px; padding:3px 9px; border-radius:999px; background:rgba(56,189,248,.12); color:#7dd3fc; }
  .tag.off { background:rgba(148,163,184,.12); color:#94a3b8; }
  footer { margin-top:26px; color:#64748b; font-size:11px; }
  .funnel { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .step { flex:1 1 110px; background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.06);
          border-radius:12px; padding:10px; text-align:center; }
  .step .k { font-size:20px; }
  .arrow { color:#38bdf8; }
</style></head>
<body><div class="wrap">
  <div class="row" style="justify-content:space-between; align-items:flex-start;">
    <div>
      <h1>${esc(config.owner.name)}'s WhatsApp Assistant</h1>
      <div class="sub">+${esc(config.owner.number)} · ${esc(config.bot.name)}${data.dryRun ? ' · DRY RUN' : ''}</div>
    </div>
    <div class="pill"><span class="dot"></span> ${esc(data.status.replace(/_/g, ' '))}${
      data.uptimeMinutes ? ` · ${data.uptimeMinutes}m` : ''
    }</div>
  </div>

  ${qrBlock}

  <div class="grid">
    <div class="card"><h2>Conversations</h2><div class="k">${data.stats.contacts}</div><div class="small">contacts in memory</div></div>
    <div class="card"><h2>Messages</h2><div class="k">${data.stats.messages}</div><div class="small">stored, searchable</div></div>
    <div class="card"><h2>Leads</h2><div class="k">${data.stats.leads}</div><div class="small">${data.stats.pendingFollowUps} follow-ups queued</div></div>
    <div class="card"><h2>Bot</h2><div class="k" style="color:${data.botEnabled ? '#22c55e' : '#ef4444'}">${data.botEnabled ? 'ON' : 'OFF'}</div><div class="small">/ai on|off from WhatsApp</div></div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>AI quota today</h2>
      ${bar(data.usage.llmCalls, data.usage.llmLimit)}
      <div class="small" style="margin-top:10px;">Images / video</div>
      ${bar(data.usage.visionCalls, data.usage.visionLimit)}
    </div>
    <div class="card">
      <h2>Voice quota</h2>
      <div class="small">Audio listened: ${data.usage.audioSeconds}s</div>
      ${bar(data.usage.ttsChars, data.usage.ttsLimit)}
    </div>
    <div class="card">
      <h2>Capabilities</h2>
      <div class="row">
        <span class="tag ${data.features.llm.length ? '' : 'off'}">chat: ${data.features.llm.join('/') || 'none'}</span>
        <span class="tag ${data.features.vision.length ? '' : 'off'}">vision: ${data.features.vision.join('/') || 'none'}</span>
        <span class="tag ${data.features.stt ? '' : 'off'}">voice in</span>
        <span class="tag ${data.features.tts !== 'off' ? '' : 'off'}">voice out: ${data.features.tts}</span>
        <span class="tag ${data.features.videoReady ? '' : 'off'}">video</span>
        <span class="tag ${data.features.ffmpeg ? '' : 'off'}">ffmpeg</span>
        <span class="tag">${esc(data.transport.kind)}</span>
      </div>
      <div class="small" style="margin-top:10px;">
        Transport: ${esc(data.transport.kind)}${data.transport.webhookPath ? ` · webhook ${esc(data.transport.webhookPath)}` : ''}
        ${data.transport.capabilities && !data.transport.capabilities.presence ? '· no typing indicators' : ''}
        <br />Groups, channels and status updates are blocked by design.
      </div>
    </div>
  </div>

  ${growthSection(data.growth)}
  ${accuracySection(data.accuracy)}

  <div class="card" style="margin-bottom:14px;">
    <h2>Client pipeline <span class="small" style="font-weight:400;">— score · next action</span></h2>
    <table>
      ${leads || '<tr><td class="small">No leads yet — the first real client conversation will appear here.</td></tr>'}
    </table>
  </div>

  <div class="row" style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px,1fr)); gap:14px; margin-bottom:14px;">
    <div class="card" style="margin:0;">
      <h2>Team</h2>
      <table>
        ${data.team
          .map(
            (m) => `<tr><td>${esc(m.name)}</td>
              <td class="small">${esc(m.role)}</td>
              <td class="small">${m.chats === null ? 'everything' : `${m.chats} chat${m.chats === 1 ? '' : 's'}`}</td></tr>`
          )
          .join('')}
      </table>
      <div class="small" style="margin-top:8px;">
        ${data.team.length > 1 ? 'Teammates can use .mine .takeover .release from their own WhatsApp.' : 'Add teammates in config/owner.json → owner.team to share the workload.'}
      </div>
    </div>

    <div class="card" style="margin:0;">
      <h2>Calls</h2>
      <div class="k">${data.calls.today}</div>
      <div class="small">
        ${data.calls.enabled ? `unanswered calls are answered in chat after ${data.calls.delaySeconds}s` : 'missed-call rescue is off'}
      </div>
      <table style="margin-top:10px;">
        ${data.calls.recent
          .map(
            (c) => `<tr><td>${esc(c.name || `+${c.number}`)}</td>
              <td class="small">${c.video ? 'video' : 'voice'}</td>
              <td><span class="tag">${esc(c.status)}</span></td></tr>`
          )
          .join('') || '<tr><td class="small">No calls yet.</td></tr>'}
      </table>
    </div>
  </div>

  <div class="card">
    <h2>Recent activity</h2>
    <table>${events || '<tr><td class="small">No activity yet.</td></tr>'}</table>
  </div>

  <footer>
    Memory lives in <code>data/assistant.db</code>. Commands are typed in your own WhatsApp chat (.help).
    ${data.lastError ? `<br/>Last error: ${esc(data.lastError)}` : ''}
  </footer>
</div></body></html>`;
}

const AUTH_COOKIE = 'wa_dash';

/**
 * The dashboard is business data. Every private page and API route needs the
 * shared session (src/services/webAuth.js): a Bearer token for scripts, or the
 * signed HttpOnly cookie a browser gets by exchanging a `?token=` once.
 *
 * A `?token=` is *not* accepted here — by the time a route is reached it has
 * already been turned into a cookie and redirected away (see tokenExchange).
 * With no token configured this is only true on a loopback (or explicit demo)
 * bind; anywhere else the server refuses to start.
 */
export function authorised(req, url) {
  if (url && url.searchParams?.get('token') !== null && url.searchParams?.get('token') !== undefined) {
    // Never authenticate on the URL itself, even before the exchange runs.
    return false;
  }
  return authenticate(req).ok;
}

/**
 * One binary download per tracked source: `…/sources/<source>/qr.png`,
 * `qr.svg` or `poster.pdf`.
 *
 * Both the inbox and the admin panel reach this, and both have already proved
 * who they are before it is called — that is the whole reason it takes an
 * `auth` label instead of doing its own checks. Nothing here writes anything:
 * a GET on the dashboard cannot change a row.
 */
async function sendSourceAsset(req, res, pathname, { auth = 'inbox', secure = false } = {}) {
  const headers = (extra = {}) =>
    auth === 'admin'
      ? adminHeaders({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }, secure)
      : { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra };

  const parts = pathname.split('/').filter(Boolean); // ['api','inbox'|'admin','sources',source,file]
  const source = parts[3] ? decodeURIComponent(parts[3]) : '';
  const file = parts[4] || 'qr.png';

  const L = await import('./services/sourceLinks.js');
  if (!L.sourceLinksEnabled()) {
    res.writeHead(404, headers({ 'Content-Type': 'application/json; charset=utf-8' }));
    res.end(JSON.stringify({ error: 'Source links are off', hint: '.set features.sourceLinks true' }));
    return true;
  }

  const link = L.sourceLink(source);
  if (!link) {
    res.writeHead(404, headers({ 'Content-Type': 'application/json; charset=utf-8' }));
    res.end(JSON.stringify({ error: 'unknown_source' }));
    return true;
  }

  try {
    if (file === 'qr.png') {
      const png = await L.qrPng(link.url);
      res.writeHead(200, headers({ 'Content-Type': 'image/png', 'Content-Disposition': `inline; filename="${link.source}-qr.png"` }));
      res.end(png);
      return true;
    }
    if (file === 'qr.svg') {
      const svg = await L.qrSvg(link.url);
      res.writeHead(200, headers({ 'Content-Type': 'image/svg+xml', 'Content-Disposition': `attachment; filename="${link.source}-qr.svg"` }));
      res.end(svg);
      return true;
    }
    if (file === 'poster.pdf') {
      const P = await import('./services/poster.js');
      const built = await P.buildPoster({ link });
      if (!built.ok) {
        res.writeHead(500, headers({ 'Content-Type': 'text/plain; charset=utf-8' }));
        res.end(`Could not build the poster: ${built.reason}`);
        return true;
      }
      res.writeHead(200, headers({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${built.fileName}"` }));
      res.end(built.buffer);
      return true;
    }
    res.writeHead(404, headers({ 'Content-Type': 'application/json; charset=utf-8' }));
    res.end(JSON.stringify({ error: 'not_found', hint: 'qr.png, qr.svg or poster.pdf' }));
    return true;
  } catch (err) {
    res.writeHead(500, headers({ 'Content-Type': 'text/plain; charset=utf-8' }));
    res.end(`Could not build that file: ${err.message}`);
    return true;
  }
}

export function accuracySection(accuracy) {
  // The card is rendered from the same report `.accuracy` texts and
  // /api/accuracy returns, so the three can never disagree.
  const { accuracySection: render } = accuracyModule;
  return render(accuracy || accuracyModule.accuracyReport());
}

export function growthSection(growth) {
  if (!growth) return '';
  const f = growth.funnel;
  const steps = f
    .map(
      (step, i) =>
        `<div class="step"><div class="small">${esc(step.label)}</div>
           <div class="k">${step.value}</div>
           <div class="small">${i === 0 ? 'top' : step.fromPrevious == null ? '—' : `${step.fromPrevious}% of previous`}</div>
         </div>`
    )
    .join('<span class="arrow">→</span>');

  const agents = growth.agents
    .filter((a) => a.sent || a.skipped || a.idle === false)
    .map(
      (a) =>
        `<tr><td>${esc(a.agent)}</td>
          <td class="small">${a.sent}</td>
          <td class="small">${a.replied}</td>
          <td class="small">${a.converted}</td>
          <td class="small">${a.optOuts}</td>
          <td class="small">${a.skipped || 0} skipped${a.held ? ` · ${a.held} held` : ''}</td></tr>`
    )
    .join('');

  const sources = growth.sources
    .map(
      (s) =>
        `<tr><td>${esc(s.label || SOURCE_LABELS[s.source] || s.source)}</td>
          <td class="small">${s.conversations}</td>
          <td class="small">${s.leads}</td>
          <td class="small">${s.paidOrders}</td>
          <td class="small">${esc(formatMoney(s.revenue))}</td></tr>`
    )
    .join('');

  const links = growth.sourceLinks?.enabled ? growth.sourceLinks.sources : [];
  const linkRows = links
    .map(
      (l) =>
        `<tr><td>${esc(l.label || l.source)}</td>
          <td class="small">${l.conversations}</td>
          <td class="small">${l.leads}</td>
          <td class="small">${l.orders}</td>
          <td class="small">${esc(formatMoney(l.revenue))}</td>
          <td class="small">${l.stale ? `⚠️ ${l.ageDays}d, no chats` : ''}</td></tr>`
    )
    .join('');

  return `
  <div class="card" style="margin-bottom:14px;">
    <h2>Growth funnel</h2>
    <div class="funnel">${steps}</div>
  </div>

  <div class="row" style="display:grid; grid-template-columns: repeat(auto-fit, minmax(320px,1fr)); gap:14px; margin-bottom:14px;">
    <div class="card" style="margin:0;">
      <h2>Agents</h2>
      <table>
        <tr><td class="small">agent</td><td class="small">sent</td><td class="small">replied</td>
            <td class="small">converted</td><td class="small">opt-outs</td><td class="small">other</td></tr>
        ${agents || '<tr><td class="small">No proactive messages yet.</td></tr>'}
      </table>
    </div>
    <div class="card" style="margin:0;">
      <h2>Where they came from</h2>
      <table>
        <tr><td class="small">source</td><td class="small">chats</td><td class="small">leads</td>
            <td class="small">paid</td><td class="small">revenue</td></tr>
        ${sources || '<tr><td class="small">No conversations yet.</td></tr>'}
      </table>
      <div class="small" style="margin-top:8px;">Tag a QR or an ad link with #qr, #ads, #link — the first message carries it.</div>
    </div>
  </div>

  ${
    growth.sourceLinks?.enabled
      ? `<div class="card">
    <h2>Tracked links</h2>
    <table>
      <tr><td class="small">source</td><td class="small">chats</td><td class="small">leads</td>
          <td class="small">paid</td><td class="small">revenue</td><td class="small">note</td></tr>
      ${linkRows || '<tr><td class="small">No tracked links yet — .link instagram in WhatsApp makes one.</td></tr>'}
    </table>
    <div class="small" style="margin-top:8px;">Create with <code>.link &lt;source&gt;</code>, print with <code>.qr</code> or <code>.poster</code>. A source with no chats after two weeks is in the wrong place.</div>
  </div>`
      : ''
  }
  `;
}

// ════════════════════════════════════════════════════════════
// Live inbox — the owner's screen
// ════════════════════════════════════════════════════════════
const INBOX_CSP = "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'";

/**
 * One page, no framework, no build step, no external requests: it has to work
 * on a phone over a slow link, and it must not phone anywhere.
 */
/**
 * The inbox page lives in src/web/inbox.html: one static file, no build step,
 * no external requests, no framework. Read once at first use.
 */
let inboxPageCache = null;
export function inboxPage() {
  if (inboxPageCache === null) {
    inboxPageCache = fs.readFileSync(new URL('./web/inbox.html', import.meta.url), 'utf8');
  }
  return inboxPageCache;
}

async function readJsonBody(req, limit = 16 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** JSON helper: one shape for every inbox response, including failures. */
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// ── the admin panel (Phase 4 Part 3) ────────────────────────
// Admin-only, and strict about it: no token configured means the routes do not
// exist (404); a wrong or missing token means 401; every mutation needs CSRF
// when it arrives with a cookie, is rate limited, and leaves an audit row.
const ADMIN_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const ADMIN_STATIC = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
let adminPageCache = null;
let adminLoginCache = null;

/** One static file, no build step, no external requests. Read once. */
export function adminPage() {
  if (adminPageCache === null) {
    adminPageCache = fs.readFileSync(new URL('./web/admin.html', import.meta.url), 'utf8');
  }
  return adminPageCache;
}

export function adminLoginPage() {
  if (adminLoginCache === null) {
    adminLoginCache = fs.readFileSync(new URL('./web/admin-login.html', import.meta.url), 'utf8');
  }
  return adminLoginCache;
}

function adminHeaders(extra = {}, secure = false) {
  return {
    'Content-Security-Policy': ADMIN_CSP,
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
    ...extra,
  };
}

function adminJson(res, status, body, secure = false) {
  res.writeHead(status, adminHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, secure));
  res.end(JSON.stringify(body));
}

function isSecure(req) {
  return (
    String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ||
    req?.socket?.encrypted === true
  );
}

function sessionCookies(value, csrf, secure) {
  const flags = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  const csrfFlags = `Path=/; SameSite=Strict${secure ? '; Secure' : ''}`;
  return [`${COOKIE}=${encodeURIComponent(value)}; ${flags}`, `${CSRF_COOKIE}=${encodeURIComponent(csrf)}; ${csrfFlags}`];
}

export async function handleAdminRoute(req, res, url) {
  const pathname = url.pathname;
  if (pathname !== '/admin' && !pathname.startsWith('/api/admin')) return false;

  // No token, no panel — not even to say hello.
  if (!adminEnabled()) {
    if (adminMisconfigured() && pathname === '/admin') {
      res.writeHead(404, adminHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      res.end('The admin panel is on but ADMIN_TOKEN is empty. Set it in .env, then restart.');
      return true;
    }
    adminJson(res, 404, { error: 'not_found' }, isSecure(req));
    return true;
  }

  const secure = isSecure(req);
  const ip = clientIp(req);
  const method = (req.method || 'GET').toUpperCase();

  // ── login: the only unauthenticated endpoint, and the most rate limited ──
  if (pathname === '/api/admin/login' && method === 'POST') {
    const limit = rateLimit(`login:${ip}`, LIMITS.login);
    if (!limit.ok) {
      audit('login_rate_limited', { ip, ok: false });
      adminJson(res, 429, { error: 'too_many_attempts', retryAfter: limit.retryAfter }, secure);
      return true;
    }
    const body = await readJsonBody(req, 4 * 1024);
    const token = String(body?.token || '');
    if (!token || !safeEqual(token, adminToken())) {
      audit('login_failed', { ip, ok: false });
      adminJson(res, 401, { error: 'unauthorised' }, secure);
      return true;
    }
    const session = issueSession();
    const csrf = crypto.randomBytes(18).toString('base64url');
    res.writeHead(200, adminHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookies(session.value, csrf, secure) }, secure));
    res.end(JSON.stringify({ ok: true, csrf, expiresAt: session.expiresAt }));
    audit('login', { ip });
    return true;
  }

  // Everything below needs proof.
  if (pathname === '/admin' && method === 'GET') {
    const auth = verifyRequest(req);
    if (!auth.ok) {
      res.writeHead(401, adminHeaders(ADMIN_STATIC, secure));
      res.end(adminLoginPage());
      audit('page_denied', { ip, ok: false });
      return true;
    }
    res.writeHead(200, adminHeaders(ADMIN_STATIC, secure));
    res.end(adminPage());
    return true;
  }

  const auth = verifyRequest(req);
  if (!auth.ok) {
    adminJson(res, 401, { error: 'unauthorised' }, secure);
    return true;
  }

  const apiLimit = rateLimit(`api:${ip}`, LIMITS.api);
  if (!apiLimit.ok) {
    adminJson(res, 429, { error: 'rate_limited', retryAfter: apiLimit.retryAfter }, secure);
    return true;
  }

  const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  let body = null;
  if (mutating) {
    const limit = pathname.endsWith('/knowledge') ? UPLOAD_MAX_BYTES + 64 * 1024 : 64 * 1024;
    body = await readJsonBody(req, limit);
    if (!csrfOk(req, auth, body)) {
      audit('csrf_rejected', { ip, detail: pathname, ok: false });
      adminJson(res, 403, { error: 'csrf_failed' }, secure);
      return true;
    }
  }

  const respond = (status, payload) => {
    adminJson(res, status, payload, secure);
    return true;
  };

  if (pathname === '/api/admin/session' && method === 'GET') {
    return respond(200, { ok: true, via: auth.via, csrf: auth.csrf || null, tenant: config.tenant.slug });
  }

  if (pathname === '/api/admin/logout' && method === 'POST') {
    res.writeHead(200, adminHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': [`${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`, `${CSRF_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict`] }, secure));
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (pathname === '/api/admin/tenants' && method === 'GET') {
    return respond(200, { ok: true, tenants: listTenants(), root: config.tenant.slug });
  }

  if (pathname === '/api/admin/tenants' && method === 'POST') {
    const limit = rateLimit(`create:${ip}`, LIMITS.create);
    if (!limit.ok) return respond(429, { error: 'rate_limited', retryAfter: limit.retryAfter });
    try {
      const created = await createTenantFromPanel({
        name: body?.name,
        number: body?.number,
        template: body?.template || null,
        slug: body?.slug || null,
        port: body?.port || null,
      });
      audit('tenant_create', { slug: created.slug, ip, detail: { template: body?.template || null } });
      return respond(201, { ok: true, tenant: created });
    } catch (err) {
      audit('tenant_create_failed', { ip, detail: err.message, ok: false });
      return respond(400, { error: err.message });
    }
  }

  if (pathname === '/api/admin/sources' && method === 'GET') {
    const L = await import('./services/sourceLinks.js');
    return respond(200, {
      ok: true,
      tenant: config.tenant.slug,
      ...(L.sourceLinksEnabled() ? L.sourceSummary() : { enabled: false, sources: [], stale: [], total: 0 }),
    });
  }

  if (pathname.startsWith('/api/admin/sources/') && method === 'GET') {
    return await sendSourceAsset(req, res, pathname, { auth: 'admin', secure });
  }

  if (pathname === '/api/admin/audit' && method === 'GET') {
    return respond(200, { ok: true, entries: recentAudit(url.searchParams.get('limit') || 50) });
  }

  const match = pathname.match(/^\/api\/admin\/tenants\/([^/]+)(?:\/([a-z-]+))?$/);
  if (!match) return respond(404, { error: 'not_found' });

  const slug = decodeURIComponent(match[1]);
  const action = match[2] || null;
  if (!validSlug(slug)) {
    audit('bad_slug', { ip, detail: slug, ok: false });
    return respond(400, { error: 'invalid_slug' });
  }

  const known = describeTenant(slug);
  if (!known) return respond(404, { error: 'not_found' });

  if (!action && method === 'GET') return respond(200, { ok: true, tenant: known });

  if (!action && method === 'DELETE') {
    const limit = rateLimit(`delete:${ip}`, LIMITS.delete);
    if (!limit.ok) return respond(429, { error: 'rate_limited', retryAfter: limit.retryAfter });
    try {
      const result = deleteTenantFromPanel(slug, body?.confirm);
      audit('tenant_delete', { slug, ip, detail: { confirmed: true } });
      return respond(200, { ok: true, ...result });
    } catch (err) {
      audit('tenant_delete_refused', { slug, ip, detail: err.message, ok: false });
      return respond(err.message === 'confirmation_required' ? 400 : 404, { error: err.message });
    }
  }

  if (action === 'profile' && method === 'GET') {
    try {
      const profile = readTenantProfile(slug);
      return respond(200, { ok: true, profile });
    } catch (err) {
      return respond(404, { error: err.message });
    }
  }

  if (action === 'profile' && method === 'PUT') {
    const result = writeTenantProfile(slug, body?.profile);
    if (!result.ok) {
      audit('profile_rejected', { slug, ip, detail: result.errors, ok: false });
      return respond(400, { error: 'invalid_profile', errors: result.errors });
    }
    audit('profile_saved', { slug, ip, detail: { bytes: result.bytes } });
    return respond(200, { ok: true, reloaded: result.reloaded, warnings: result.warnings });
  }

  if (action === 'agents' && method === 'GET') {
    try {
      const A = await import('./services/agents.js');
      const P = await import('./services/agentPacks.js');
      const profile = readTenantProfile(slug);
      const rows = Array.isArray(profile?.agents) ? profile.agents : [];
      const packId = profile?.industry || profile?.template || null;
      return respond(200, {
        ok: true,
        featureOn: profile?.features?.multiAgent === true,
        marketingOn: profile?.features?.marketingAgents === true,
        pack: packId ? { id: packId, label: P.packLabel(packId) } : null,
        max: A.MAX_AGENTS,
        agents: rows.map((a) => ({
          id: a.id,
          name: a.name || a.id,
          role: a.role || 'custom',
          enabled: a.enabled === true,
          instructions: a.instructions || '',
          tools: Array.isArray(a.tools) ? a.tools : [],
          hours: a.hours || null,
          handoff: a.handoff || null,
          never: Array.isArray(a.never) ? a.never : [],
        })),
      });
    } catch (err) {
      return respond(404, { error: err.message });
    }
  }

  // One field at a time, validated the same way the WhatsApp command validates
  // it, then written through the existing profile writer (which re-checks the
  // whole document and reloads it live).
  if (action === 'agents' && method === 'POST') {
    try {
      const A = await import('./services/agents.js');
      const profile = readTenantProfile(slug);
      const rows = Array.isArray(profile.agents) ? [...profile.agents] : [];
      const id = String(body?.id || '').trim();
      const index = rows.findIndex((a) => a.id === id);
      if (index < 0) return respond(404, { error: 'unknown_agent' });

      const agent = { ...rows[index] };
      if (typeof body?.enabled === 'boolean') agent.enabled = body.enabled;
      if (typeof body?.instructions === 'string') agent.instructions = body.instructions.trim();
      if (typeof body?.name === 'string' && body.name.trim()) agent.name = body.name.trim();

      const check = A.validateAgent(agent);
      if (check.errors.length) {
        audit('agent_rejected', { slug, ip, detail: check.errors, ok: false });
        return respond(400, { error: 'invalid_agent', errors: check.errors });
      }

      rows[index] = agent;
      // The flag follows the roster, exactly like the WhatsApp command.
      const anyOn = rows.some((a) => a.enabled === true);
      const saved = writeTenantProfile(slug, {
        ...profile,
        agents: rows,
        features: { ...(profile.features || {}), multiAgent: anyOn },
      });
      if (!saved.ok) return respond(400, { error: 'invalid_profile', errors: saved.errors });

      audit('agent_saved', { slug, ip, detail: { id, enabled: agent.enabled === true } });
      return respond(200, { ok: true, reloaded: saved.reloaded, warnings: saved.warnings || [] });
    } catch (err) {
      return respond(400, { error: err.message });
    }
  }

  if (action === 'keys' && method === 'POST') {
    try {
      const result = setTenantKeys(slug, body?.keys || {});
      audit('keys_written', { slug, ip, detail: { saved: result.saved } });
      return respond(200, { ok: true, ...result });
    } catch (err) {
      audit('keys_rejected', { slug, ip, detail: err.message, ok: false });
      return respond(400, { error: err.message });
    }
  }

  if (action === 'test-key' && method === 'POST') {
    const provider = String(body?.provider || 'groq');
    // A key typed into the form, or the one already on disk — tested here, in
    // the server. The value never travels back to the browser either way.
    const key = String(body?.key || '') || tenantKeyFor(slug, provider);
    if (!key) return respond(400, { error: 'no_key_to_test' });
    const result = await probeKey({ provider, key });
    audit('key_probe', { slug, ip, detail: { provider, ok: result.ok, reason: result.reason } });
    return respond(200, { ok: true, result });
  }

  if (action === 'knowledge' && method === 'POST') {
    const limit = rateLimit(`upload:${ip}`, LIMITS.upload);
    if (!limit.ok) return respond(429, { error: 'rate_limited', retryAfter: limit.retryAfter });
    let buffer;
    try {
      buffer = Buffer.from(String(body?.contentBase64 || ''), 'base64');
    } catch {
      return respond(400, { error: 'bad_base64' });
    }
    const saved = saveUpload(slug, { name: body?.name, buffer });
    if (!saved.ok) {
      audit('upload_rejected', { slug, ip, detail: saved.reason, ok: false });
      return respond(400, saved);
    }
    const ingested = await ingestUpload(slug, saved.file);
    audit('knowledge_upload', { slug, ip, detail: { name: saved.name, bytes: saved.bytes, chunks: ingested.chunks ?? null } });
    return respond(200, { ok: true, saved: { name: saved.name, bytes: saved.bytes, type: saved.type }, ingested });
  }

  if (action === 'qr' && method === 'GET') {
    try {
      return respond(200, await qrForTenant(slug));
    } catch (err) {
      return respond(400, { error: err.message });
    }
  }

  if (action === 'index-images' && method === 'POST') {
    try {
      const result = await indexImagesFor(slug);
      audit('visual_index', { slug, ip, detail: { indexed: result.indexed ?? null, skipped: result.skipped ?? null, mode: result.mode } });
      return respond(200, { ok: true, ...result });
    } catch (err) {
      audit('visual_index_failed', { slug, ip, detail: err.message, ok: false });
      return respond(400, { error: err.message });
    }
  }

  if (['start', 'stop', 'restart'].includes(action) && method === 'POST') {
    try {
      // Through the hook, so a test never spawns a real bot.
      const runner = action === 'start' ? adminHooks.start : action === 'stop' ? adminHooks.stop : adminHooks.restart;
      const result = action === 'stop' ? await runner(slug) : await runner(slug);
      audit(`tenant_${action}`, { slug, ip, detail: { pid: result.pid ?? null } });
      return respond(200, { ok: true, ...result, tenant: describeTenant(slug) });
    } catch (err) {
      audit(`tenant_${action}_failed`, { slug, ip, detail: err.message, ok: false });
      return respond(400, { error: err.message });
    }
  }

  return respond(404, { error: 'not_found' });
}

/**
 * Demo only (DEMO_MODE=1): a visitor types as a customer and the real pipeline
 * answers. Never present in a normal deployment, and still behind the token.
 */
export async function handleDemoRoute(req, res, url) {
  if (url.pathname !== '/api/demo/message') return false;

  if (process.env.DEMO_MODE !== '1') {
    sendJson(res, 404, { error: 'not_a_demo' });
    return true;
  }
  if (!authenticate(req).ok) {
    sendJson(res, 401, { error: 'unauthorised' });
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return true;
  }

  const body = await readJsonBody(req);
  const text = String(body?.text || '').trim().slice(0, 500);
  if (!text) {
    sendJson(res, 400, { error: 'empty' });
    return true;
  }

  const number = String(body?.number || '923001234567').replace(/\D/g, '').slice(0, 15) || '923001234567';
  const transport = getTransport();
  if (!transport) {
    sendJson(res, 503, { error: 'no_transport' });
    return true;
  }

  try {
    const { handleIncoming } = await import('./handlers/messageHandler.js');
    await handleIncoming(transport, {
      id: `DEMO-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      chat: `${number}@s.whatsapp.net`,
      number,
      pushName: 'Demo customer',
      kind: 'text',
      text,
    });
    sendJson(res, 200, { ok: true, number });
  } catch (err) {
    sendJson(res, 500, { error: 'handler_failed', detail: err.message });
  }
  return true;
}

/**
 * Every /api/inbox* route. Returns true when it handled the request.
 * Kept in one function so the auth check cannot be forgotten on a new route.
 */
async function handleInboxRoute(req, res, url) {
  const pathname = url.pathname;
  if (pathname !== '/inbox' && !pathname.startsWith('/api/inbox')) return false;

  if (!liveInboxEnabled()) {
    if (pathname === '/inbox') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Live inbox is off. Turn it on with: .set features.liveInbox true');
    } else {
      sendJson(res, 404, { error: 'disabled', hint: '.set features.liveInbox true' });
    }
    return true;
  }

  const auth = authenticate(req);
  if (!auth.ok) {
    if (pathname === '/inbox') {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Locked</title><p>The inbox needs <code>?token=…</code> (DASHBOARD_TOKEN).</p>');
    } else {
      sendJson(res, 401, { error: 'unauthorised' });
    }
    return true;
  }

  if (pathname === '/inbox') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': INBOX_CSP,
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(inboxPage());
    return true;
  }

  // The read-only source strip on the inbox page. Counts and links only: the
  // page can look, and can download a QR, but nothing here writes.
  if (pathname === '/api/inbox/sources' && (req.method === 'GET' || !req.method)) {
    const L = await import('./services/sourceLinks.js');
    if (!L.sourceLinksEnabled()) {
      sendJson(res, 200, { enabled: false, sources: [], stale: [], total: 0 });
      return true;
    }
    sendJson(res, 200, L.sourceSummary());
    return true;
  }

  if (pathname.startsWith('/api/inbox/sources/') && (req.method === 'GET' || !req.method)) {
    return await sendSourceAsset(req, res, pathname, { auth: 'inbox' });
  }

  if (pathname === '/api/inbox' && (req.method === 'GET' || !req.method)) {
    sendJson(res, 200, {
      chats: inboxChats(),
      summary: inboxSummary(),
      latestId: latestMessageId(),
      demo: process.env.DEMO_MODE === '1',
      // 'real' when the demo found an API key, 'canned' when it did not.
      demoAi: process.env.DEMO_MODE === '1' ? process.env.DEMO_AI || 'canned' : null,
      demoAiProvider: process.env.DEMO_MODE === '1' ? process.env.DEMO_PROVIDER || null : null,
    });
    return true;
  }

  // /api/inbox/<number>[/action]
  const parts = pathname.split('/').filter(Boolean); // ['api','inbox','<number>','action']
  const number = parts[2] ? decodeURIComponent(parts[2]).replace(/\D/g, '') : null;
  const action = parts[3] || null;

  if (!number) {
    sendJson(res, 404, { error: 'not_found' });
    return true;
  }

  if (!action && req.method === 'GET') {
    const after = url.searchParams.get('after');
    sendJson(res, 200, inboxThread(number, { after: after ? Number(after) : null }));
    return true;
  }

  if (action === 'reply' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { error: 'bad_json' });
      return true;
    }
    // A cookie can be sent by another site; a Bearer header cannot. Same rule
    // as the admin panel: one implementation, two surfaces.
    if (!mutationAllowed(req, auth, body)) {
      sendJson(res, 403, { error: 'csrf', hint: 'Send X-Admin-CSRF, or call from the same origin.' });
      return true;
    }
    const result = await inboxReply({
      number,
      text: body.text,
      transport: getTransport(),
      now: new Date(),
    });
    const { status = 200, ...rest } = result;
    sendJson(res, status, rest);
    return true;
  }

  if ((action === 'takeover' || action === 'release') && req.method === 'POST') {
    const body = (await readJsonBody(req)) || {};
    if (!mutationAllowed(req, auth, body)) {
      sendJson(res, 403, { error: 'csrf', hint: 'Send X-Admin-CSRF, or call from the same origin.' });
      return true;
    }
    const result = action === 'takeover' ? inboxTakeover(number, { minutes: body.minutes }) : inboxRelease(number);
    sendJson(res, result.ok ? 200 : 400, result);
    return true;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
  return true;
}

// What startServer() decided about exposure, for doctor to report as a fact.
let webRefusal = null;

export function webSecurityStatus() {
  const state = webSecurityState();
  return {
    ...state,
    listening: !!startedServer,
    dashboard: state.ok,
    webhooks: !!startedServer,
    health: !!startedServer,
    refused: webRefusal,
  };
}

let startedServer = null;

export function startServer() {
  // The platform keeps its own state and, in a single-process install, receives
  // usage events from this process's LLM client. Off unless PLATFORM_ENABLED.
  if (process.env.PLATFORM_ENABLED) {
    initPlatform().catch((err) => console.error('platform init failed:', err?.message || err));
  }

  if (!config.server.enabled) {
    console.log('🌐 Dashboard disabled (ENABLE_WEB=false)');
    return null;
  }

  // No token + a reachable bind address = the dashboard, the growth figures and
  // the QR code on the open internet. Refuse *the dashboard*, not the process:
  // Cloud API webhooks are how customers get answered and /health is how a
  // monitor knows we are alive, so both keep working.
  const exposure = webSecurityState();
  if (!exposure.ok) {
    webRefusal = { reason: exposure.reason, message: exposure.message, host: config.server.host, at: new Date().toISOString() };
    console.error(`🔒 ${exposure.message}`);
    console.error('   Webhooks (/webhook/<slug>) and /health stay up; the dashboard, inbox, growth figures and QR code are off.');
  } else if (exposure.mode === 'local' && !exposure.loopback) {
    console.warn('🔒 No DASHBOARD_TOKEN and a public bind: demo mode is serving fake data to anyone who asks. Never put real customers here.');
  } else {
    webRefusal = null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    try {
      // Every browser-facing answer says the same thing about referrers.
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
        if (!res.hasHeader?.(k)) res.setHeader(k, v);
      }

      // `?token=` is a one-time ticket: exchange it for the signed HttpOnly
      // cookie and send the browser to the same URL without it. The token never
      // reaches HTML, a log line, or anybody's Referer.
      const exchange = tokenExchange(req, url);
      if (exchange) {
        if (!exchange.ok) {
          res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('That token is not valid.');
          return;
        }
        res.writeHead(302, {
          Location: exchange.location || '/',
          'Set-Cookie': exchange.value,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        res.end();
        return;
      }

      // Cloud API webhooks: /webhook/<slug> (GET verification, POST messages).
      // Unknown slugs answer honestly instead of pretending to be Meta's friend.
      if (await handleWebhookRequest(req, res, url)) return;

      // Restricted mode (no token on a public bind). The process is still here
      // for Meta and for a monitor; the business surfaces are not.
      if (!exposure.ok) {
        if (url.pathname === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: true, uptime: uptimeMinutes() }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Dashboard disabled: no DASHBOARD_TOKEN on a public bind. Webhooks and /health only.');
        return;
      }

      // Phase 7: the customer platform is a separate layer. It answers only its
      // own paths (/platform, /api/platform) and only when PLATFORM_ENABLED is
      // set; otherwise this returns false at once and nothing below changes.
      if (await handlePlatformRoute(req, res, url)) return;

      // The admin panel owns /admin and /api/admin, and answers 404 unless it is
      // switched on with a token. Routed first so nothing below can shadow it.
      if (await handleAdminRoute(req, res, url)) return;

      // Demo endpoint (DEMO_MODE=1 only), then the live inbox.
      if (await handleDemoRoute(req, res, url)) return;
      if (await handleInboxRoute(req, res, url)) return;

      if (url.pathname === '/qr.png') {
        // The QR *is* the login: whoever scans it owns the WhatsApp account.
        // So: auth first, then a rate limit, then only while unpaired.
        if (!authenticate(req).ok) {
          res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('Unauthorised');
          return;
        }
        const limited = webRateLimit('qr', { max: 20, windowMs: 60000 });
        if (!limited.ok) {
          res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(limited.retryAfter), 'Cache-Control': 'no-store' });
          res.end('Too many QR requests');
          return;
        }
        if (!botState.qr || botState.status === 'online') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('No QR right now');
          return;
        }
        const png = await QRCode.toBuffer(botState.qr, { width: 420, margin: 1 });
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store, no-cache, must-revalidate, private',
          Pragma: 'no-cache',
          Expires: '0',
        });
        res.end(png);
        return;
      }

      if (url.pathname === '/health') {
        // Public on purpose, and useless on purpose: a monitor needs to know the
        // process is up. No number, tenant, provider or pairing state — that is
        // business information and it lives behind the session.
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, uptime: uptimeMinutes() }));
        return;
      }

      if (url.pathname === '/api/growth') {
        if (!authenticate(req).ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorised' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(growthSnapshot(), null, 2));
        return;
      }

      if (url.pathname === '/api/accuracy') {
        if (!authenticate(req).ok) {
          res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'unauthorised' }));
          return;
        }
        const { accuracyReport } = await import('./services/accuracy.js');
        const days = Number(url.searchParams.get('days')) || 7;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(accuracyReport({ days }), null, 2));
        return;
      }

      if (url.pathname === '/api/status') {
        if (!authenticate(req).ok) {
          res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'unauthorised' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(buildStatus(), null, 2));
        return;
      }

      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (!authenticate(req).ok) {
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('<!doctype html><title>Locked</title><p>This dashboard needs DASHBOARD_TOKEN. Open it once as <code>/?token=…</code> and the browser will keep a signed cookie.</p>');
          return;
        }
        const html = page(buildStatus());
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Dashboard error: ${err.message}`);
    }
  });

  server.listen(config.server.port, config.server.host, () => {
    startedServer = server;
    const guard = exposure.ok
      ? exposure.mode === 'private'
        ? 'token required'
        : 'local only, no token'
      : 'dashboard off — webhooks and /health only';
    console.log(`🌐 Web: http://${config.server.host}:${config.server.port} (${guard})`);
  });

  server.on('error', (err) => console.error('Dashboard error:', err.message));
  return server;
}

export { handleInboxRoute, readJsonBody };
export default { startServer, inboxPage };
