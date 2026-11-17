#!/usr/bin/env node
// scripts/demo.js
// The tour: no WhatsApp account, no phone.
//
//   npm run demo
//
// It builds a throwaway tenant in ./demo, fills it with a few realistic
// conversations, registers a stand-in transport, and opens the live inbox.
//
// Two modes, decided by whether a real key is there:
//   • GROQ_API_KEY / GEMINI_API_KEY in .env → the real model answers. Every
//     reply is generated live, on the same code path as a real number.
//   • no key                          → the pipeline still runs for real
//     (language, catalogue, pricing, bookings, opt-outs); only the AI's wording
//     is canned, and the terminal plus the inbox say so plainly.
//
// Everything it writes lives under ./demo and is gitignored. Delete the folder
// and nothing is left behind.

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { aiMode, aiModeLabel } from '../src/dev/demoAi.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEMO = path.join(ROOT, 'demo');

// Read .env first, so a key the user already has is honoured instead of mocked.
dotenv.config({ path: process.env.ENV_FILE || path.join(ROOT, '.env'), quiet: true });
const AI = aiMode(process.env);

// ── the environment, decided before anything imports config ──
process.env.DEMO_MODE = '1';
process.env.DATA_DIR = path.join(DEMO, 'data');
process.env.CONFIG_DIR = path.join(DEMO, 'config');
process.env.SESSION_FOLDER = path.join(DEMO, 'sessions');
process.env.TMP_DIR = path.join(DEMO, 'tmp');
process.env.ENABLE_WEB = 'true';
process.env.PORT = process.env.DEMO_PORT || process.env.PORT || '3111';
process.env.HOST = process.env.DEMO_HOST || '0.0.0.0';
process.env.MY_NUMBER = process.env.MY_NUMBER || '920000000000';
process.env.MY_NAME = process.env.MY_NAME || 'Demo Owner';
process.env.DEMO_AI = AI.mode;
process.env.DEMO_PROVIDER = AI.provider || '';
// Only when there is no real key: lets the config loader finish without one.
// Removed from the picture entirely (and never used for a request) once the
// mock transport below installs itself.
if (AI.mode === 'canned') process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'demo-key-never-used';
process.env.DAILY_REPORT = 'false';
process.env.NOTIFY_NEW_CHATS = 'false';
process.env.QUIET_HOURS = '';
process.env.TRANSPORT = 'baileys';

fs.mkdirSync(path.join(DEMO, 'config'), { recursive: true });

const profileFile = path.join(DEMO, 'config', 'owner.json');
if (!fs.existsSync(profileFile)) {
  fs.writeFileSync(
    profileFile,
    JSON.stringify(
      {
        '//': 'Demo profile — safe to edit or delete. Created by npm run demo.',
        owner: { name: 'Demo Owner', brand: 'HasDevs Cafe', timezone: 'Asia/Karachi', location: 'Islamabad, Pakistan' },
        business: {
          name: 'HasDevs Cafe',
          type: 'Cafe & restaurant',
          city: 'Islamabad',
          timezone: 'Asia/Karachi',
          hours: 'Daily 12:00–23:00',
          phone: '+92 300 0000000',
          address: 'F-11 Markaz, Islamabad',
          currency: 'PKR',
          delivery: 'We deliver within 5 km, 30–40 minutes, Rs 150 charge.',
          bookingService: 'Table for 4',
          payment: {
            bank: { name: 'Meezan Bank', title: 'HasDevs Cafe', number: '01234567890123' },
            easypaisa: { title: 'HasDevs Cafe', number: '03000000000' },
            jazzcash: { title: '', number: '' },
            cod: true,
          },
          offers: ['10% off your next order this month'],
          invoice: { prefix: 'HD', footer: 'Shukriya! HasDevs Cafe — F-11 Markaz' },
        },
        catalog: {
          items: [
            { name: 'Chicken Karahi', kind: 'product', price: 1350, stock: 20, keywords: ['karahi', 'chicken'] },
            { name: 'Zinger Burger', kind: 'product', price: 650, stock: 35, keywords: ['zinger', 'burger'] },
            { name: 'Fries', kind: 'product', price: 250, stock: 50, keywords: ['fries'] },
            { name: 'Table for 4', kind: 'service', price: 0, duration: 90, keywords: ['table', 'booking', 'reserve'] },
          ],
        },
        policies: {
          maxDiscountPercent: 10,
          delivery: 'Deliver within 5 km. Free above Rs 2,000.',
          paymentTerms: 'Cash on delivery, or bank transfer in advance.',
          refund: 'Wrong order? We replace it, no questions.',
        },
        faqs: [
          { q: 'Do you deliver to F-11?', a: 'Yes — F-11, F-10 and G-11, within 30–40 minutes.' },
          { q: 'Do you have parking?', a: 'Yes, behind the markaz.' },
        ],
        features: {
          businessProfile: true,
          catalog: true,
          ownerEditing: true,
          bookingAgent: true,
          followUpAgent: true,
          closerAgent: true,
          reviewAgent: true,
          analystAgent: true,
          reactivationAgent: true,
          contentAgent: true,
          pdfInvoices: true,
          selfHealing: true,
          liveInbox: true,
          injectionGuard: true,
          growthApproval: true,
          managerAgent: true,
          rag: true,
          toolCalling: true,
        },
      },
      null,
      2
    )
  );
}

// ── bring it up ─────────────────────────────────────────────
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

const db = await import('../src/utils/db.js');
await db.initDB();

// A few conversations so the inbox is not empty on the first page load.
const now = Date.now();
const seeds = [
  ['923001234567', 'Ayesha Khan', [
    ['user', 'Assalam o alaikum, do you deliver to F-11?', 95],
    ['assistant', 'Walaikum salam! Yes — F-11, F-10 and G-11, usually 30–40 minutes.', 94],
    ['user', 'Great, how much is the chicken karahi?', 12],
  ]],
  ['923005551234', 'Bilal Ahmed', [
    ['user', 'Zinger burger ka rate kya hai?', 60],
    ['assistant', 'Zinger Burger PKR 650. Chicken Karahi PKR 1,350.', 59],
    ['owner', 'Bhai aaj 10% off hai, 585 ho jayega.', 40],
    ['user', 'Theek hai, 2 bhej dein.', 6],
  ]],
  ['923007778899', 'Sana', [
    ['user', 'Kal shaam table for 4 available hai?', 180],
    ['assistant', 'Kal 6:30 aur 7:15 dono khali hain. Kaunsa theek hai?', 179],
  ]],
  ['447700900123', 'John (UK)', [
    ['user', 'Do you take card?', 300],
    ['assistant', 'Cash on delivery, or bank transfer in advance.', 299],
  ]],
];

const existing = db.get('SELECT COUNT(*) AS c FROM messages').c;
if (!existing) {
  for (const [number, name, lines] of seeds) {
    db.upsertContact(number, { name, push_name: name, jid: `${number}@s.whatsapp.net`, stage: 'lead' });
    for (const [role, text, minutesAgo] of lines) {
      db.saveMessage(number, role, text, 'text');
      const id = db.get('SELECT MAX(id) AS id FROM messages').id;
      db.run('UPDATE messages SET created_at = ? WHERE id = ?', [new Date(now - minutesAgo * 60000).toISOString(), id]);
    }
  }
}

// Real key → real model, no mock at all. No key → deterministic mock, so the
// page still demonstrably works without costing anything.
if (AI.mode === 'canned') {
  await import('../src/dev/mockLlm.js').then((m) => m.mockTransport());
}

// A stand-in transport. The handler records what it sends, so nothing is
// written twice; this only needs to behave like the real one.
const sent = [];
const { registerTransport } = await import('../src/transport/index.js');
registerTransport({
  slug: 'demo',
  kind: 'baileys',
  status: 'demo (no WhatsApp connection)',
  capabilities: { text: true, image: false, voice: false, video: false, document: true, presence: true },
  can: (name) => ['text', 'document', 'presence'].includes(name),
  async sendMessage(jid, payload = {}) {
    sent.push({ jid, payload });
    const preview = payload.text ? payload.text.replace(/\s+/g, ' ').slice(0, 70) : payload.document ? '[document]' : '[media]';
    console.log(dim(`  → ${jid.split('@')[0]}: ${preview}`));
    return { key: { id: `DEMO-${sent.length}` } };
  },
  async sendPresenceUpdate() {},
  async readMessages() {},
});

const { startServer } = await import('../src/server.js');
startServer();

const url = `http://localhost:${process.env.PORT}/inbox`;
console.log('');
console.log(
  bold(
    green(
      AI.mode === 'real'
        ? `  Demo is up — real AI (${AI.provider}), no WhatsApp account, no phone.`
        : '  Demo is up — no API key, no WhatsApp account, no phone.'
    )
  )
);
console.log(`  ${bold('Open:')} ${url}`);
console.log('');
console.log(dim('  Type in the "Type as a customer" bar at the top of the inbox.'));
console.log(dim('  The real pipeline answers: language, catalogue, pricing, bookings, opt-outs.'));
console.log(dim(`  ${aiModeLabel(AI)}`));
console.log('');
console.log(dim('  Or from a terminal:'));
console.log(dim(`    curl -s -X POST ${url.replace('/inbox', '/api/demo/message')} \\`));
console.log(dim(`      -H 'Content-Type: application/json' -d '{"text":"do you deliver to G-11?"}'`));
console.log('');
console.log(dim('  Everything lives in ./demo — delete the folder to forget it all.'));
console.log('');
