#!/usr/bin/env node
// scripts/simulate.js
// Test the assistant's brain from your terminal — no WhatsApp, no QR.
// It uses the exact same modules as the live bot: memory, intake, pricing,
// language detection, vision and speech.
//
//   npm run chat
//   npm run chat -- --number=447700900123
//
// In-chat commands:
//   /reset            start this conversation over
//   /state            show what the bot remembers about the "client"
//   /leads            show the saved lead
//   /voice <file>     send a voice note from disk
//   /image <file>     send an image from disk
//   /video <file>     send a video from disk
//   /doc <file>       send a PDF/DOCX/TXT
//   /quit

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { config } from '../src/config/env.js';
import { initDB, getLead, listLeads, dbStats, getContact } from '../src/utils/db.js';
import { generateReply, detectMood } from '../src/core/brain.js';
import { ingest, resetState, getState, mergeExternalFields } from '../src/core/projectIntake.js';
import { buildQuote, formatQuote } from '../src/core/pricing.js';
import * as memory from '../src/services/memory.js';
import { detectLanguage } from '../src/services/language.js';
import { analyzeImage, visionEnabled } from '../src/services/vision.js';
import { understandVideo, videoCapabilities } from '../src/services/video.js';
import { transcribe, sttEnabled } from '../src/services/transcription.js';
import { extractText, summarizeDocument, extractProjectBrief } from '../src/services/documents.js';
import { ttsEnabled } from '../src/services/tts.js';
import { llmStatus } from '../src/core/llm.js';
import { saveLeadToSheet } from '../src/services/sheets.js';
import { mockTransport } from '../src/dev/mockLlm.js';

const args = process.argv.slice(2);
const numberArg = args.find((a) => a.startsWith('--number='));
const NUMBER = (numberArg ? numberArg.split('=')[1] : '447700900123').replace(/\D/g, '');
const USE_MOCK = args.includes('--mock');

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

async function main() {
  await initDB({ file: path.join(config.paths.data, 'simulator.db') });

  if (!llmStatus().providers.length) {
    console.log(yellow('\n⚠️  No AI key configured — running with a canned mock so you can still see the flow.'));
    mockTransport();
  } else if (USE_MOCK) {
    mockTransport();
    console.log(dim('Using mock LLM (--mock).'));
  }

  console.log(`
${cyan('┌────────────────────────────────────────────────────────────┐')}
${cyan('│')}  🧪 Assistant simulator — you are the client: +${NUMBER}
${cyan('│')}  Owner: ${config.owner.name} · ${(config.owner.profile?.owner?.services || []).length} services loaded
${cyan('│')}  Eyes: ${visionEnabled() ? 'on' : 'off'} · Video: ${videoCapabilities().ready ? 'on' : 'off'} · Ears: ${sttEnabled() ? 'on' : 'off'} · Voice out: ${ttsEnabled() ? 'on' : 'off'}
${cyan('│')}  Type a message, or /image /voice /video /doc <path>
${cyan('└────────────────────────────────────────────────────────────┘')}
`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: green('client › ') });
  rl.prompt();

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      continue;
    }

    if (line === '/quit' || line === '/exit') rl.close();
    else if (line === '/reset') {
      resetState(NUMBER);
      console.log(dim('↺ intake cleared'));
    } else if (line === '/state') {
      printState(NUMBER);
    } else if (line === '/leads') {
      const lead = getLead(NUMBER);
      console.log(lead ? JSON.stringify(lead, null, 2) : dim('no lead saved yet'));
    } else if (line.startsWith('/image ')) {
      await handleImage(line.slice(7).trim());
    } else if (line.startsWith('/voice ')) {
      await handleVoice(line.slice(7).trim());
    } else if (line.startsWith('/video ')) {
      await handleVideo(line.slice(7).trim());
    } else if (line.startsWith('/doc ')) {
      await handleDocument(line.slice(5).trim());
    } else if (line.startsWith('/')) {
      console.log(dim('unknown command'));
    } else {
      await handleText(line);
    }

    rl.prompt();
  }

  console.log(dim('\nbye'));
  process.exit(0);
}

function contextFlags() {
  return {
    visionEnabled: visionEnabled(),
    videoEnabled: videoCapabilities().ready,
    ttsEnabled: ttsEnabled(),
    sttEnabled: sttEnabled(),
  };
}

async function respond(parts, humanText) {
  const modelText = parts.join('\n\n');
  const langInfo = detectLanguage(humanText);
  const mood = detectMood(humanText);
  const dossier = { ...memory.getDossier(NUMBER), mood };
  const explicitPrice = /\b(price|pricing|cost|charge|rate|quote|how much|kitna|budget)\b/i.test(humanText);

  const intake = await ingest(NUMBER, modelText, { explicitPriceQuestion: explicitPrice });
  const quote = intake.readyToQuote ? intake.quote || buildQuote(intake.state.fields, NUMBER) : null;

  const reply = await generateReply({
    number: NUMBER,
    text: modelText,
    langInfo,
    dossier,
    intakeState: intake.state,
    features: contextFlags(),
    extraNote: quote ? 'A quote card is sent separately; only write a short lead-in.' : '',
  });

  memory.saveUserTurn(NUMBER, humanText, 'text', { lang: langInfo.code, mood });
  memory.saveAssistantTurn(NUMBER, reply.text || '', 'text');

  console.log(`\n${cyan('bot ›')} ${reply.text}\n`);

  if (quote) {
    console.log(yellow('─── quote card (sent as a second message) ───'));
    console.log(formatQuote(quote, intake.state.fields));
    console.log(yellow('─────────────────────────────────────────────\n'));

    const { markQuoted } = await import('../src/core/projectIntake.js');
    markQuoted(intake.state, quote);
    const contact = getContact(NUMBER) || {};
    const lead = {
      number: NUMBER,
      name: contact.name || 'Simulator client',
      country: quote.country,
      currency: quote.local.currency,
      project_type: quote.serviceName,
      goal: intake.state.fields.goal,
      features: intake.state.fields.features,
      timeline: intake.state.fields.timeline || quote.timeline,
      budget: intake.state.fields.budget,
      tech: (quote.stack || []).join(', '),
      quote_min: quote.local.min,
      quote_max: quote.local.max,
      quote_currency: quote.local.currency,
      status: 'quoted',
    };
    const { saveLead } = await import('../src/utils/db.js');
    saveLead(lead);
    saveLeadToSheet(lead).catch(() => {});
    console.log(dim(`lead saved · follow-up would be scheduled · provider ${reply.provider}/${reply.model}`));
  } else {
    console.log(dim(`lang=${langInfo.code} mood=${mood} · ${reply.provider}/${reply.model} · next question: ${intake.nextField || '—'} · completeness ${Math.round((intake.completeness || 0) * 100)}%`));
  }

  memory.summarizeIfNeeded(NUMBER).catch(() => {});
}

async function handleText(text) {
  await respond([text], text);
}

async function handleImage(file) {
  if (!fs.existsSync(file)) return console.log(dim('file not found'));
  const buffer = fs.readFileSync(file);
  const ext = path.extname(file).slice(1) || 'jpg';
  const mimetype = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

  if (!visionEnabled()) return console.log(dim('no vision provider configured'));
  const vision = await analyzeImage({
    buffer,
    mimetype,
    caption: '',
    context: memory.getDossier(NUMBER).summary || '',
  });
  if (!vision) return console.log(dim('vision failed'));
  console.log(dim(`\n[image understood via ${vision.provider}]\n${vision.description}\n`));
  await respond([`[Image] ${vision.description}`], vision.description);
}

async function handleVoice(file) {
  if (!fs.existsSync(file)) return console.log(dim('file not found'));
  if (!sttEnabled()) return console.log(dim('speech-to-text not configured'));
  const buffer = fs.readFileSync(file);
  const ext = path.extname(file).slice(1) || 'ogg';
  const mimetype = ext === 'ogg' ? 'audio/ogg' : ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
  const result = await transcribe(buffer, { mimetype });
  if (!result) return console.log(dim('transcription failed'));
  console.log(dim(`\n[voice note transcribed · ${result.language} · ${Math.round(result.duration)}s]\n"${result.text}"\n`));
  await respond([`[Voice note] ${result.text}`], result.text);
}

async function handleVideo(file) {
  if (!fs.existsSync(file)) return console.log(dim('file not found'));
  if (!videoCapabilities().ready) return console.log(dim('video understanding not configured'));
  const buffer = fs.readFileSync(file);
  const ext = path.extname(file).slice(1) || 'mp4';
  const mimetype = ext === 'mov' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : 'video/mp4';
  const result = await understandVideo({ buffer, mimetype, context: memory.getDossier(NUMBER).summary || '' });
  if (!result) return console.log(dim('video analysis failed'));
  console.log(dim(`\n[video understood via ${result.provider}]\n${result.description}\n`));
  await respond([`[Video] ${result.description}`], result.description);
}

async function handleDocument(file) {
  if (!fs.existsSync(file)) return console.log(dim('file not found'));
  const buffer = fs.readFileSync(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  const mimetype =
    ext === 'pdf' ? 'application/pdf'
      : ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'text/plain';
  const text = await extractText(buffer, { mimetype, fileName: path.basename(file) });
  if (!text) return console.log(dim('could not read that file'));
  const extracted = await extractProjectBrief(text, { context: JSON.stringify(getState(NUMBER).fields) });
  if (extracted) {
    mergeExternalFields(NUMBER, extracted);
    console.log(dim(`[brief extracted] ${JSON.stringify(extracted).slice(0, 260)}`));
  }
  const summary = (await summarizeDocument(text)) || text.slice(0, 500);
  console.log(dim(`\n[document] ${summary}\n`));
  await respond([`[Document: ${path.basename(file)}] ${summary}`], summary);
}

function printState(number) {
  const contact = getContact(number);
  const dossier = memory.getDossier(number);
  const state = getState(number);
  console.log(
    JSON.stringify(
      {
        contact: contact
          ? { name: contact.name, stage: contact.stage, language: contact.language, messages: contact.message_count }
          : null,
        lang_detected: detectLanguage(dossier.recent.at(-1)?.content || '').code,
        summary: dossier.summary,
        facts: dossier.facts,
        intake: state.fields,
        asked: state.asked,
        quote: state.quote ? `${state.quote.local.minText} – ${state.quote.local.maxText}` : null,
        db: dbStats(),
        leads: listLeads().length,
      },
      null,
      2
    )
  );
}

process.on('SIGINT', () => process.exit(0));
main().catch((err) => {
  console.error('Simulator crashed:', err);
  process.exit(1);
});
