// src/server.js
// Tiny status dashboard + QR page. No framework, no build step.
// Useful locally ("what's my bot doing?") and on free hosts where the process
// must expose a port anyway (Railway/Render health checks).

import http from 'node:http';
import QRCode from 'qrcode';
import { config } from './config/env.js';
import { botState, uptimeMinutes } from './state.js';
import { dbStats, recentEvents, getUsage, getSetting, listLeads, getContact } from './utils/db.js';
import { formatMoney } from './services/geo.js';
import { llmStatus } from './core/llm.js';
import { visionStatus } from './services/vision.js';
import { ttsStatus } from './services/tts.js';
import { videoCapabilities } from './services/video.js';
import { sttEnabled } from './services/transcription.js';
import { hasFfmpeg } from './services/ffmpeg.js';

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
    botEnabled: getSetting('bot_enabled', true) !== false,
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
    leads: listLeads(null, 6).map((l) => ({
      name: l.name || `+${l.number}`,
      project: l.project_type || '—',
      status: l.status || 'new',
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
      </div>
      <div class="small" style="margin-top:10px;">Groups, channels and status updates are blocked by design.</div>
    </div>
  </div>

  <div class="card" style="margin-bottom:14px;">
    <h2>Client pipeline</h2>
    <table>
      ${leads || '<tr><td class="small">No leads yet — the first real client conversation will appear here.</td></tr>'}
    </table>
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

export function startServer() {
  if (!config.server.enabled) {
    console.log('🌐 Dashboard disabled (ENABLE_WEB=false)');
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    try {
      if (url.pathname === '/qr.png') {
        if (!botState.qr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('No QR right now');
          return;
        }
        const png = await QRCode.toBuffer(botState.qr, { width: 420, margin: 1 });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(png);
        return;
      }

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: botState.status, uptime: uptimeMinutes() }));
        return;
      }

      if (url.pathname === '/api/status') {
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
    console.log(`🌐 Dashboard: http://${config.server.host}:${config.server.port}`);
  });

  server.on('error', (err) => console.error('Dashboard error:', err.message));
  return server;
}

export default { startServer };
