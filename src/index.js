// src/index.js
// Boot: config → memory → dashboard → WhatsApp connection → live.
//
// Designed to survive unattended free hosting: exponential reconnect, session
// restore from an env var, and no crash on a missing provider or a bad message.

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import { config, describeConfig, assertConfig } from './config/env.js';
import { initDB, startAutoSave, getSetting, logEvent } from './utils/db.js';
import { startServer } from './server.js';
import { botState, setStatus, setQr, clearQr, bumpStat } from './state.js';
import { handleIncoming, startPendingFlusher } from './handlers/messageHandler.js';
import { handleDeletedMessage } from './services/deletedMessages.js';
import { startDailyReport } from './services/report.js';
import { startFollowUpLoop } from './services/followUps.js';
import { initSheet } from './services/sheets.js';
import { restoreSession } from './utils/sessionBackup.js';
import { registerCalls } from './services/calls.js';
import { flushOutbox, startOutboxLoop, outboxStatus } from './services/outbox.js';
import { sweepTemp } from './services/media.js';
import { hasLLM } from './core/llm.js';
import { visionEnabled } from './services/vision.js';
import { hasFfmpeg } from './services/ffmpeg.js';
import { sttEnabled } from './services/transcription.js';
import { buildReport } from './services/report.js';

const logger = pino({ level: process.env.BAILEYS_LOG === 'debug' ? 'debug' : 'silent' });

let reconnectAttempts = 0;
let servicesStarted = false;
let bootedAt = null;

function banner() {
  const line = '─'.repeat(58);
  console.log(`
┌${line}┐
│  🤖  WhatsApp Self-Knowledge Assistant  v9.1              │
│  ${config.bot.name.padEnd(54).slice(0, 54)}  │
└${line}┘
${describeConfig()}
`);
}

async function boot() {
  banner();

  const problems = assertConfig();
  if (problems.length) {
    console.warn('⚠️  Setup notes:');
    for (const p of problems) console.warn(`   • ${p}`);
    console.warn('');
  }

  await initDB();
  startAutoSave();
  await restoreSession();
  await initSheet();

  sweepTemp();
  const cleanupTimer = setInterval(sweepTemp, 30 * 60 * 1000);
  cleanupTimer.unref?.();

  startServer();

  if (!hasLLM()) {
    console.warn('⚠️  No AI provider key set — the bot will answer with placeholders only.');
  }
  if (!visionEnabled()) {
    console.warn('⚠️  No vision provider — images/videos will be acknowledged but not described.');
  }
  if (!sttEnabled()) console.warn('⚠️  GROQ_API_KEY missing — voice notes cannot be transcribed.');
  if (!hasFfmpeg()) {
    console.warn('⚠️  ffmpeg not found — voice replies will be sent as audio files, not voice notes.');
  }

  if (config.dryRun) {
    setStatus('stopped');
    console.log('\n🧪 DRY RUN — dashboard is live, WhatsApp is not connected.');
    console.log(`   Open http://localhost:${config.server.port} to see it.\n`);
    return;
  }

  await connect();
}

async function connect() {
  setStatus(botState.connectedAt ? 'reconnecting' : 'connecting');

  const { state, saveCreds } = await useMultiFileAuthState(config.paths.sessions);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = [2, 3000, 1017531287];
  }

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    emitOwnEvents: false,
    defaultQueryTimeoutMs: 60000,
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  // Missed-call rescue: when nobody picks up within CALL_FALLBACK_SECONDS,
  // the assistant starts the conversation in chat instead.
  if (config.calls.enabled) registerCalls(sock);

  // ── pairing code (nicer than a QR on a headless host) ────
  if (!state.creds.registered && config.session.pairingNumber) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(config.session.pairingNumber);
        botState.pairingCode = code;
        setStatus('pairing');
        console.log(`\n📞 Pairing code for +${config.session.pairingNumber}: ${code}`);
        console.log('   WhatsApp → Linked devices → Link with phone number → enter the code\n');
      } catch (err) {
        console.error('Pairing code failed:', err.message);
      }
    }, 3500);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      setQr(qr);
      try {
        const ascii = await QRCode.toString(qr, { type: 'terminal', small: true });
        console.log(ascii);
        await QRCode.toFile(config.paths.qr, qr, { width: 420, margin: 1 });
        console.log(`\n📸 QR ready — scan it, or open the dashboard: http://localhost:${config.server.port}`);
        console.log('   WhatsApp → Linked devices → Link a device\n');
      } catch (err) {
        console.error('QR render error:', err.message);
      }
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      clearQr();
      botState.connectedAt = new Date();
      botState.me = sock.user ? { id: sock.user.id, name: sock.user.name || sock.user.verifiedName } : null;
      setStatus('online');
      console.log(`\n✅ Connected as ${botState.me?.name || config.owner.name} (${botState.me?.id || 'unknown'})\n`);

      logEvent('connected', null, botState.me?.id || null);

      if (!servicesStarted) {
        servicesStarted = true;
        startDailyReport(sock);
        startFollowUpLoop(sock);
        startPendingFlusher(sock);
        startOutboxLoop(sock);
      }

      // Anything we could not send while the connection was down goes out now.
      const queued = outboxStatus().pending;
      if (queued) {
        console.log(`📤 Flushing ${queued} queued message${queued === 1 ? '' : 's'} from the outbox…`);
        flushOutbox(sock).catch((err) => console.error('Outbox flush:', err.message));
      }

      if (!bootedAt) {
        bootedAt = new Date();
        setTimeout(() => {
          sock
            .sendMessage(config.owner.jid, {
              text:
                `🟢 *Assistant is online*\n\n${buildReport().split('\n').slice(0, 2).join('\n')}\n\n` +
                'Type .help to see commands.',
            })
            .catch(() => {});
        }, 4000);
      }

      if (getSetting('bot_enabled', true) === false) {
        console.log('ℹ️  Bot is currently OFF (set earlier with .ai off). Use .ai on to enable.');
      }
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      clearQr();
      botState.lastError = lastDisconnect?.error?.message || String(reason);
      console.log(`🔴 Connection closed (${reason || 'unknown'})`);

      if (reason === DisconnectReason.loggedOut) {
        setStatus('stopped');
        console.log('❌ Logged out. Delete ./sessions and restart to scan again.');
        process.exit(0);
      }
      if (reason === DisconnectReason.connectionReplaced) {
        setStatus('stopped');
        console.log('❌ Session replaced by another WhatsApp Web session. Exiting to avoid a loop.');
        process.exit(0);
      }

      reconnectAttempts += 1;
      const delay = Math.min(30000, 1500 * 2 ** Math.min(5, reconnectAttempts));
      setStatus('reconnecting');
      console.log(`🔄 Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})…`);
      setTimeout(() => connect().catch((err) => console.error('Reconnect failed:', err.message)), delay);
    }
  });

  // ── incoming messages ────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg?.message) {
        bumpStat('ignored');
        continue;
      }
      bumpStat('received');
      try {
        await handleIncoming(sock, msg);
      } catch (err) {
        console.error('Message handling failed:', err.message);
      }
    }
  });

  sock.ev.on('messages.update', async (updates) => {
    try {
      await handleDeletedMessage(sock, updates);
    } catch (err) {
      console.error('Delete handler failed:', err.message);
    }
  });

  // Contacts/groups/receipts: nothing to do, but don't let them bubble up
  sock.ev.on('groups.upsert', () => {});
  sock.ev.on('messages.reaction', () => {});

  return sock;
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err?.stack || err?.message || err);
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down…');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down…');
  process.exit(0);
});

boot().catch((err) => {
  console.error('Boot failed:', err);
  process.exit(1);
});
