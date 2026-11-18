// src/index.js
// Boot: config → memory → dashboard → transport → live.
//
// One process, one transport (Baileys by default, the Cloud API on request).
// Everything above the transport — memory, intake, tools, outbox, reports —
// is transport-agnostic, which is why this file is now mostly orchestration.

import { config, describeConfig, assertConfig } from './config/env.js';
import { initDB, startAutoSave, getSetting, logEvent } from './utils/db.js';
import { startServer } from './server.js';
import { startHealthMonitor } from './services/health.js';
import { startRetention } from './services/privacy.js';
import { botState, setStatus, bumpStat } from './state.js';
import { handleIncoming, startPendingFlusher } from './handlers/messageHandler.js';
import { startDailyReport } from './services/report.js';
import { startFollowUpLoop } from './services/followUps.js';
import { initSheet } from './services/sheets.js';
import { restoreSession } from './utils/sessionBackup.js';
import { flushOutbox, startOutboxLoop, outboxStatus } from './services/outbox.js';
import { sweepTemp } from './services/media.js';
import { hasLLM } from './core/llm.js';
import { visionEnabled } from './services/vision.js';
import { hasFfmpeg } from './services/ffmpeg.js';
import { sttEnabled } from './services/transcription.js';
import { buildReport } from './services/report.js';
import { featureOn } from './services/profile.js';
import { startBookingLoop } from './services/bookingAgent.js';
import { startFollowUpAgentLoop, followUpAgentEnabled } from './services/followUpAgent.js';
import { startAnalystLoop } from './services/analystAgent.js';
import { startReviewLoop } from './services/reviewAgent.js';
import { startReactivationLoop } from './services/reactivationAgent.js';
import { startContentLoop } from './services/contentAgent.js';
import { createTransport } from './transport/index.js';
import { describeCapabilities } from './transport/base.js';

let servicesStarted = false;
let bootedAt = null;
let transport = null;

function banner() {
  const line = '─'.repeat(58);
  console.log(`
┌${line}┐
│  🤖  WhatsApp Self-Knowledge Assistant  v9.16             │
│  ${config.bot.name.padEnd(54).slice(0, 54)}  │
└${line}┘
${describeConfig()}
`);
}

/** Start the background loops once, whatever the transport. */
function startServices(t) {
  if (servicesStarted) return;
  servicesStarted = true;
  startDailyReport(t);

  // Phase 3: the follow-up agent supersedes the older generic nudge loop when
  // its flag is on. Running both would double-message people.
  if (followUpAgentEnabled()) {
    startFollowUpAgentLoop(t);
  } else {
    startFollowUpLoop(t);
  }

  if (featureOn('bookingAgent')) startBookingLoop(t);

  // Phase 3 part 2: the analyst writes to the owner, the review agent writes
  // after a job is finished. Both are silent until their flag is on.
  if (featureOn('analystAgent')) startAnalystLoop({ transport: t });
  if (featureOn('reviewAgent')) startReviewLoop({ transport: t });
  if (featureOn('reactivationAgent')) startReactivationLoop({ transport: t });
  if (featureOn('contentAgent')) startContentLoop({ transport: t });

  startPendingFlusher(t);

  // Reliability alerts and retention run on their own timers, off the message
  // path: a monitor that needs a customer to write before it notices is not a
  // monitor. Both are no-ops unless their flag/env is set.
  startHealthMonitor({ onError: (err) => console.error('Health check failed:', err.message) });
  startRetention({ onError: (err) => console.error('Retention purge failed:', err.message) });
  startOutboxLoop(t);
}

function reportOnline(t) {
  const caps = describeCapabilities(t.capabilities);
  console.log(`\n✅ Online over ${t.kind}${t.kind === 'cloud' ? ` (webhook /webhook/${t.slug})` : ''}`);
  if (caps.unsupported.length) {
    console.log(`   Not available on ${t.kind}: ${caps.unsupported.join(', ')} — those features switch themselves off.`);
  }

  // Anything we could not send while the connection was down goes out now.
  const queued = outboxStatus().pending;
  if (queued) {
    console.log(`📤 Flushing ${queued} queued message${queued === 1 ? '' : 's'} from the outbox…`);
    flushOutbox(t).catch((err) => console.error('Outbox flush:', err.message));
  }

  if (!bootedAt) {
    bootedAt = new Date();
    setTimeout(() => {
      t.sendMessage(config.owner.jid, {
        text:
          `🟢 *Assistant is online* (${t.kind})\n\n${buildReport().split('\n').slice(0, 2).join('\n')}\n\n` +
          'Type .help to see commands.',
      }).catch((err) => {
        // On the Cloud API the owner may not have an open window yet; the
        // transport already told them why. Nothing else to do.
        console.log(`ℹ️  Could not send the startup note: ${err.message}`);
      });
    }, 4000);
  }
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

  try {
    transport = createTransport();
  } catch (err) {
    console.error(`\n❌ ${err.message}\n`);
    process.exit(1);
  }

  // Register before connecting: a webhook can arrive the instant we are live.
  transport.onMessage(async (incoming) => {
    bumpStat('received');
    try {
      await handleIncoming(transport, incoming);
    } catch (err) {
      console.error('Message handling failed:', err.message);
    }
  });

  transport.onStatus((event) => {
    if (event.type === 'open') {
      botState.connectedAt = botState.connectedAt || new Date();
      if (transport.kind === 'cloud') {
        setStatus('online');
        botState.me = { id: transport.phoneId, name: config.bot.name };
      }
      startServices(transport);
      reportOnline(transport);
    }
    if (event.type === 'ignored') bumpStat('ignored');
  });

  await transport.connect();

  if (getSetting('bot_enabled', true) === false) {
    console.log('ℹ️  Bot is currently OFF (set earlier with .ai off). Use .ai on to enable.');
  }
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err?.stack || err?.message || err);
});

const shutdown = () => {
  console.log('\n👋 Shutting down…');
  transport?.disconnect?.().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

boot().catch((err) => {
  console.error('Boot failed:', err);
  process.exit(1);
});
