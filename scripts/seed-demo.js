#!/usr/bin/env node
// scripts/seed-demo.js
// Fills a throw-away database with a few realistic conversations so the
// dashboard has something to show. Never touches your real memory:
//
//   npm run demo        → seeds ./data/demo and opens the dashboard in dry run
//
// Delete ./data/demo whenever you like.

process.env.DATA_DIR = process.env.DATA_DIR || './data/demo';

const { initDB, upsertContact, saveMessage, saveLead, addFollowUp, bumpUsage, logEvent, setSummary, saveIntake, setFact, saveDB } = await import('../src/utils/db.js');

await initDB();

const now = Date.now();
const ago = (mins) => new Date(now - mins * 60000).toISOString();

function seedContact({ number, name, country, currency, language, stage, category, messages, summary, facts }) {
  upsertContact(number, {
    name,
    push_name: name,
    country,
    currency,
    language,
    stage,
    category: category || 'lead',
    increment_messages: false,
  });
  if (summary) setSummary(number, summary, messages.length);
  for (const [key, value] of Object.entries(facts || {})) setFact(number, key, value);

  messages.forEach((m, i) => {
    saveMessage(number, m.role, m.text, m.kind || 'text');
  });
}

// ── 1. UK e-commerce lead, quoted ──────────────────────────
seedContact({
  number: '447700900123',
  name: 'Emma Clarke',
  country: 'United Kingdom',
  currency: 'GBP',
  language: 'en',
  stage: 'quoted',
  messages: [
    { role: 'user', text: "Hi! I found you on GitHub. I run a small jackets brand and need an online store — about 6 products to start." },
    { role: 'assistant', text: 'Hey Emma 👋 Nice one. Are you shipping within the UK only, or international too?' },
    { role: 'user', text: "UK for now. I also need Stripe payments and a way to see orders without touching code." },
    { role: 'assistant', text: 'Got it: store + Stripe + a simple orders dashboard. What timeline are you working with?' },
    { role: 'user', text: "Ideally live before the winter drop — around 6 weeks. Budget is about £3,000." },
  ],
  summary:
    'Emma runs a small UK jackets brand. Wants a 6-product store with Stripe and an orders dashboard, live in ~6 weeks, budget ~£3,000. Quote sent; waiting on her decision.',
  facts: { company: 'Clarke Outerwear', country: 'United Kingdom', budget: '£3,000', timeline: '6 weeks', tech: 'Stripe' },
});
saveLead({
  number: '447700900123',
  name: 'Emma Clarke',
  company: 'Clarke Outerwear',
  country: 'United Kingdom',
  currency: 'GBP',
  project_type: 'E-commerce store',
  goal: 'Sell jackets online in the UK with Stripe checkout',
  features: 'catalogue, cart, checkout, Stripe payments, orders dashboard',
  timeline: '6 weeks',
  budget: '£3,000',
  quote_min: 220,
  quote_max: 430,
  quote_currency: 'GBP',
  status: 'quoted',
});
saveIntake('447700900123', {
  stage: 'quoted',
  fields: {
    projectType: 'e-commerce store',
    goal: 'sell jackets online in the UK',
    features: 'catalogue, cart, checkout, Stripe payments, orders dashboard',
    timeline: '6 weeks',
    budget: '£3,000',
  },
  asked: ['projectType', 'goal', 'features', 'timeline', 'budget'],
  quote: { local: { minText: '£220', maxText: '£430' }, pkrMin: 61600, pkrMax: 120400 },
  quoted_at: ago(90),
});
addFollowUp('447700900123', new Date(now + 20 * 3600 * 1000).toISOString(), 'Hi Emma — just checking in on the store. Did the scope and price make sense?', 1);
logEvent('quote_sent', '447700900123', { min: 61600, max: 120400 });

// ── 2. UAE client, mid-discovery, sent a voice note ────────
seedContact({
  number: '971501234567',
  name: 'Omar Al-Farsi',
  country: 'United Arab Emirates',
  currency: 'AED',
  language: 'en',
  stage: 'discovering',
  messages: [
    { role: 'user', text: '[voice] I need a dashboard for my logistics company — drivers, deliveries, invoices.', kind: 'voice' },
    { role: 'assistant', text: 'Makes sense. Is this replacing a spreadsheet, or do you already have a system?' },
    { role: 'user', text: 'We use Excel and WhatsApp groups right now 😅 around 40 drivers.' },
    { role: 'assistant', text: '40 drivers is a real workflow. Do you need live tracking, or just assignment + status updates?' },
  ],
  summary:
    'Omar runs a UAE logistics company with ~40 drivers, currently on Excel + WhatsApp. Wants a dashboard for drivers, deliveries and invoices. Live tracking still unanswered.',
  facts: { company: 'Farsi Logistics', country: 'UAE', team_size: '40 drivers', tech: 'Excel today' },
});
saveIntake('971501234567', {
  stage: 'discovering',
  fields: {
    projectType: 'web app',
    goal: 'manage drivers, deliveries and invoices for a 40-driver logistics company',
    features: 'driver assignment, delivery status, invoices, dashboard',
  },
  asked: ['projectType', 'goal', 'features'],
  quote: null,
});

// ── 3. US AI-bot enquiry, needs the owner ──────────────────
seedContact({
  number: '12025550143',
  name: 'Daniel Reyes',
  country: 'United States',
  currency: 'USD',
  language: 'en',
  stage: 'negotiating',
  messages: [
    { role: 'user', text: 'Do you build WhatsApp bots that can talk to patients? We are a small dental clinic.' },
    { role: 'assistant', text: 'Yes — mostly appointment reminders, FAQs and rescheduling. How many patients a month?' },
    { role: 'user', text: "Around 400. But my partner wants a discount if we pay for a year upfront." },
  ],
  summary:
    'Daniel runs a US dental clinic (~400 patients/month) and wants a WhatsApp bot for appointments. Asked about an annual upfront discount — needs the owner.',
  facts: { company: 'Bright Smile Dental', country: 'United States', decision_maker: 'Daniel + partner' },
});
logEvent('escalation', '12025550143', { reason: 'discount' });

// ── 4. Pakistani friend, casual ────────────────────────────
seedContact({
  number: '923001234567',
  name: 'Ali',
  country: 'Pakistan',
  currency: 'PKR',
  language: 'roman-ur',
  stage: 'new',
  category: 'friend',
  messages: [
    { role: 'user', text: 'yaar kal free ho? chai peete hain' },
    { role: 'assistant', text: 'kal shaam ke baad free hoon, 6 baje aa jao ☕' },
    { role: 'user', text: 'done 👍' },
  ],
  summary: 'Ali is a friend. Casual chats, no business context.',
});

// ── 5. A new enquiry nobody answered yet ───────────────────
seedContact({
  number: '4915112345678',
  name: 'Lena Fischer',
  country: 'Germany',
  currency: 'EUR',
  language: 'de',
  stage: 'new',
  messages: [
    { role: 'user', text: 'Hallo, ich brauche eine Webseite für mein Café in Berlin. Was kostet das?' },
  ],
  summary: 'Lena wants a website for her café in Berlin. Asked for a price.',
});

// ── activity + usage so the dashboard looks lived-in ──────
for (const [type, number] of [
  ['message_in', '447700900123'],
  ['message_in', '971501234567'],
  ['memory_summary', '971501234567'],
  ['new_contact', '4915112345678'],
  ['message_in', '12025550143'],
  ['followup_scheduled', '447700900123'],
]) logEvent(type, number, null);

bumpUsage('llm_calls', 47);
bumpUsage('llm_tokens', 38120);
bumpUsage('stt_seconds', 142);
bumpUsage('vision_calls', 6);
bumpUsage('tts_chars', 1840);

saveDB(true);
console.log('✅ Demo data seeded into', process.env.DATA_DIR);
