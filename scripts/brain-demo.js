#!/usr/bin/env node
// scripts/brain-demo.js
// See the business brain work, with fake data and no WhatsApp.
//
//   npm run brain
//
// It builds a throw-away tenant under ./data/brain-demo, writes three weeks of
// invented conversations, orders and follow-up sends into it, then runs the same
// command handler your phone would hit and prints exactly what you would see:
// `.impact`, `.brain`, `.strategy`, `.why 1`, `.do 1`, `.goal`, `.experiment`.
//
// Two rules it will not break:
//   • every number is invented (92300… numbers, demo prices) — nothing is read
//     from your real database or your real config/owner.json;
//   • the reasoning router is left OFF, so nothing here needs an API key or
//     makes a network call. The output is the deterministic path on purpose:
//     that is what a key-less install shows.
//
// Delete ./data/brain-demo when you are done.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'data', 'brain-demo');

// ── the environment, decided before anything imports config ──
process.env.DATA_DIR = path.join(DIR, 'data');
process.env.CONFIG_DIR = path.join(DIR, 'config');
process.env.ENABLE_WEB = 'false';
process.env.MY_NUMBER = '923001234567';
process.env.MY_NAME = 'Demo Owner';
process.env.GROQ_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';
process.env.QUIET_HOURS = '';
process.env.NOTIFY_NEW_CHATS = 'false';
process.env.DAILY_REPORT = 'false';
process.env.TZ = process.env.TZ || 'Asia/Karachi';

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

// ── the fake tenant ──────────────────────────────────────────
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(DIR, 'config'), { recursive: true });

const profile = {
  owner: { name: 'Demo Owner', number: '923001234567', team: [] },
  business: {
    name: 'Demo Cafe',
    type: 'Restaurant',
    city: 'Islamabad',
    timezone: 'Asia/Karachi',
    hours: 'Daily 11:00–23:00',
    currency: 'PKR',
    offers: ['10% off your first order'],
    payment: { cod: true },
  },
  catalog: {
    items: [
      { name: 'Zinger Burger', kind: 'product', price: 650, cost: 420, stock: 25 },
      { name: 'Chicken Karahi', kind: 'product', price: 1450, cost: 1000, stock: 12 },
      { name: 'Family Platter', kind: 'product', price: 3200, cost: 2400, stock: 6 },
      { name: 'Mint Margarita', kind: 'product', price: 350, cost: 150, stock: 40 },
    ],
  },
  policies: {
    delivery: 'Free within 5 km over 2,000 PKR, otherwise 150 PKR.',
    payment: 'Cash on delivery, bank transfer, or card at the counter.',
  },
  faqs: [
    { q: 'Do you deliver?', a: 'Yes — within 5 km, 45–60 minutes, free over 2,000 PKR.' },
    { q: 'Is it halal?', a: 'Fully halal, certificate available on request.' },
  ],
  features: { businessProfile: true, catalog: true, toolCalling: true, bookingAgent: true },
  brain: {
    minutesPerConversation: 6,
    thinDataConversations: 20,
    dailyReasoningCalls: 200,
    autoRun: [],
  },
};

// The demo turns the brain on so the commands have something to answer, but it
// leaves reasoning off: no key, no network, no surprises.
profile.features.businessBrain = true;
fs.writeFileSync(path.join(DIR, 'config', 'owner.json'), JSON.stringify(profile, null, 2));

const db = await import('../src/utils/db.js');
const { config } = await import('../src/config/env.js');
const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');

await db.initDB();

// ── three weeks of invented history ─────────────────────────
const NOW = new Date();
const DAY = 24 * 3600 * 1000;
const at = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString();
const mins = (n) => n * 60000;

db.run('DELETE FROM messages');
db.run('DELETE FROM contacts');
db.run('DELETE FROM orders');
db.run('DELETE FROM bookings');
db.run('DELETE FROM leads');
db.run('DELETE FROM growth_sends');
db.run('DELETE FROM growth_optouts');
db.run('DELETE FROM review_asks');

const ask = (i) =>
  [
    'Do you have gift cards?',
    'How much is the zinger burger?',
    'Can I book a table for four tonight?',
    'Is the karahi spicy?',
    'Do you have gift cards?',
    'Kya delivery Shahzad Town tak hai?',
  ][i % 6];

function conversation({ number, name, minutesAgo, ownerTouched = false, reply = 'Yes — here are the details.', paidOrder = null, question = null }) {
  db.run('INSERT OR REPLACE INTO contacts (number, name, push_name, category, stage, first_seen, last_seen, message_count) VALUES (?,?,?,?,?,?,?,?)', [
    number,
    name,
    name,
    'lead',
    'quoted',
    at(minutesAgo * 60000),
    at(minutesAgo * 60000),
    2,
  ]);
  db.run('INSERT INTO messages (number, role, kind, content, created_at) VALUES (?,?,?,?,?)', [
    number,
    'user',
    'text',
    question || ask(number.length),
    at(mins(minutesAgo)),
  ]);
  db.run('INSERT INTO messages (number, role, kind, content, created_at) VALUES (?,?,?,?,?)', [
    number,
    ownerTouched ? 'owner' : 'assistant',
    'text',
    reply,
    at(mins(minutesAgo - 1)),
  ]);
  if (paidOrder !== null) {
    db.run('INSERT INTO orders (chat, items, total, currency, status, created_at) VALUES (?,?,?,?,?,?)', [
      `${number}@s.whatsapp.net`,
      'Zinger Burger ×1',
      paidOrder,
      'PKR',
      'paid',
      at(mins(minutesAgo - 2)),
    ]);
  }
}

// 26 conversations this week: 24 handled by the bot, 2 the owner stepped into.
let seedIndex = 1;
for (let i = 0; i < 24; i += 1) {
  conversation({
    number: `9230012${String(40000 + i).padStart(5, '0')}`,
    name: `Customer ${i + 1}`,
    minutesAgo: 240 + i * 17,
    paidOrder: i % 5 === 0 ? 650 : null,
    question: ask(i),
  });
}
for (let i = 0; i < 2; i += 1) {
  conversation({
    number: `9230012${String(49000 + i).padStart(5, '0')}`,
    name: `Handled By Owner ${i + 1}`,
    minutesAgo: 400 + i * 40,
    ownerTouched: true,
    reply: 'I will sort this out personally.',
    paidOrder: 1450,
  });
}

// A quoted lead that has gone quiet — the strongest next-best-action signal.
db.run('INSERT OR REPLACE INTO contacts (number, name, push_name, category, stage, first_seen, last_seen, message_count) VALUES (?,?,?,?,?,?,?,?)', [
  '923001277777',
  'Ayesha (quiet quote)',
  'Ayesha',
  'lead',
  'quoted',
  at(6 * DAY),
  at(4 * DAY),
  4,
]);
db.run('INSERT INTO messages (number, role, kind, content, created_at) VALUES (?,?,?,?,?)', [
  '923001277777',
  'user',
  'text',
  'ok please send me the quote for the family platter for 8 people',
  at(4 * DAY),
]);
db.run('INSERT INTO messages (number, role, kind, content, created_at) VALUES (?,?,?,?,?)', [
  '923001277777',
  'assistant',
  'text',
  'Sent — the 8-person platter comes to 6,400 PKR. Shall I hold Friday?',
  at(4 * DAY - mins(1)),
]);
db.run('INSERT INTO leads (number, name, project_type, quote_min, quote_max, quote_currency, status, score, created_at) VALUES (?,?,?,?,?,?,?,?,?)', [
  '923001277777',
  'Ayesha',
  'family platter',
  6400,
  6400,
  'PKR',
  'quoted',
  72,
  at(2 * DAY),
]);

// Last week, so the week-over-week arrows have something to compare against.
for (let i = 0; i < 12; i += 1) {
  conversation({
    number: `9230013${String(10000 + i).padStart(5, '0')}`,
    name: `Last Week ${i + 1}`,
    minutesAgo: 7 * 24 * 60 + 300 + i * 30,
    paidOrder: i % 3 === 0 ? 650 : null,
    question: ask(i + 3),
  });
}

// Proactive sends: some got a reply, one is old enough to count as ignored.
for (let i = 0; i < 8; i += 1) {
  const number = `9230012${String(40000 + i).padStart(5, '0')}`;
  db.run('INSERT INTO growth_sends (agent, number, reason, result, created_at) VALUES (?,?,?,?,?)', [
    'followup',
    number,
    'quiet for 3 days after a quote',
    'sent',
    at(mins(300 + i * 20)),
  ]);
}
db.run('INSERT INTO growth_sends (agent, number, reason, result, created_at) VALUES (?,?,?,?,?)', [
  'followup',
  '923001240009',
  'quiet for 4 days',
  'sent',
  at(5 * DAY),
]);

// A review ask that became a rating, and one still waiting.
db.run("INSERT INTO review_asks (number, kind, status, rating, created_at) VALUES (?,?,?,?,?)", ['923001240001', 'post_order', 'rated', 5, at(mins(400))]);
db.run("INSERT INTO review_asks (number, kind, status, created_at) VALUES (?,?,?,?)", ['923001240006', 'post_order', 'asked', at(mins(500))]);

// ── run the commands, exactly as WhatsApp would ─────────────
const OWNER = config.owner.number;
const jid = `${OWNER}@s.whatsapp.net`;

async function show(title, text) {
  console.log(`\n${bold(title)}  ${dim(`(you type: ${text})`)}`);
  console.log('─'.repeat(72));
  const res = await handleOwnerCommand({}, jid, text, OWNER);
  console.log(res?.reply || dim('(no reply)'));
}

console.log(bold('\n🧠 Business brain demo'));
console.log(dim(`Tenant: ${DIR}  ·  fake data only  ·  reasoning off, so no key and no network`));
console.log(dim('Same command handler your own WhatsApp number hits. Nothing here can message anyone.'));

await show('1. The week in numbers', '.impact');
await show('2. Today in three lines', '.brain');
await show('3. The weekly review and the ranked actions', '.strategy');
await show('4. Why action 1 is action 1', '.why 1');
await show('5. Prepare action 1 as a draft (nothing is sent)', '.do 1');
await show('6. A goal, with a projection', '.goal add 40 orders by ' + new Date(NOW.getTime() + 30 * DAY).toISOString().slice(0, 10));
await show('7. A/B test two follow-up lines', '.experiment new followup "Want me to hold your usual table?" | "Shall I save your usual slot?"');
// Teach the loop something first: the seeded conversations already replied to
// (or ignored) the follow-ups we sent, so two outcomes are recorded per action.
const learning = await import('../src/services/learning.js');
for (const number of ['923001240000', '923001240005', '923001240010']) learning.noteReplyOutcome(number);
learning.sweepOutcomes({ quietDays: 3 });
await show('8. What the loop has "learned" so far', '.brain weights');

console.log(`\n${bold('What just happened')}`);
console.log(
  [
    green('✓') + ' Every figure above is a SQL count over the seeded rows — no model was asked to count.',
    green('✓') + ' The plan, the ranking, the goal projection and the A/B split are deterministic code.',
    green('✓') + ' .do prepared a draft and sent nothing.',
    green('✓') + ' Two conversations show up as owner-handled, which is why automation is not 100%.',
  ].join('\n')
);
console.log(`\n${dim('Try it with your own numbers:')}`);
console.log('  .set features.businessBrain true   (in your real owner chat)');
console.log('  .impact → .strategy → .do 1');
console.log(`\n${dim('Clean up:')}  rm -rf ${path.relative(ROOT, DIR)}`);
console.log(dim('Your real config/owner.json and data/ were never opened.\n'));
process.exit(0);
