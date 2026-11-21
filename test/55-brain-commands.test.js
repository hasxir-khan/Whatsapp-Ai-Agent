// Phase 6 Part 3 — the WhatsApp surface of the business brain, and the one
// place it touches a customer: the reasoning path in the message pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, fakeSock, textMessages, waitFor } from './helpers.js';

const dataDir = isolate('brain-cmd');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;

const BASE = {
  owner: { name: 'Example Owner', number: '923001234567', team: [] },
  business: {
    name: 'Demo Cafe',
    type: 'Restaurant',
    timezone: 'Asia/Karachi',
    hours: 'Daily 11:00–23:00',
    currency: 'PKR',
    offers: ['10% off your first order'],
  },
  catalog: { items: [{ name: 'Zinger Burger', kind: 'product', price: 650 }] },
  policies: {},
  features: {},
  brain: {},
};

function writeProfile(patch = {}) {
  const profile = {
    ...BASE,
    ...patch,
    business: { ...BASE.business, ...(patch.business || {}) },
    features: { ...BASE.features, ...(patch.features || {}) },
    brain: { ...BASE.brain, ...(patch.brain || {}) },
  };
  fs.writeFileSync(path.join(configDir, 'owner.json'), JSON.stringify(profile, null, 2));
}

writeProfile({ features: { businessBrain: true, reasoning: true, growthApproval: true } });

const db = await import('../src/utils/db.js');
const { reloadProfile } = await import('../src/services/profile.js');
const { mockTransport, setMockReply, __testSetPlan, __testClearPlan } = await import('../src/dev/mockLlm.js');
const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
const { handleIncoming } = await import('../src/handlers/messageHandler.js');
const { config } = await import('../src/config/env.js');

await db.initDB();
mockTransport();

const OWNER = config.owner.number;
const ownerJid = `${OWNER}@s.whatsapp.net`;
const run = (text) => handleOwnerCommand({}, ownerJid, text, OWNER);

const NOW = new Date('2026-11-17T10:00:00Z');
const at = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60000).toISOString();

function msg(number, role, content, minutesAgo) {
  db.run('INSERT INTO messages (number, role, kind, content, created_at) VALUES (?,?,?,?,?)', [
    number,
    role,
    'text',
    content,
    at(minutesAgo),
  ]);
}

function seedWeek() {
  for (const table of ['messages', 'leads', 'orders', 'bookings', 'review_asks', 'growth_sends', 'growth_optouts']) {
    db.run(`DELETE FROM ${table}`);
  }
  for (let i = 0; i < 22; i += 1) {
    const number = `9230012300${String(i).padStart(2, '0')}`;
    db.run('INSERT OR REPLACE INTO contacts (number, name, push_name) VALUES (?,?,?)', [number, `Customer ${i}`, `Customer ${i}`]);
    msg(number, 'user', i % 2 ? 'Do you have gift cards?' : 'How much is the burger?', 300 + i);
    msg(number, 'assistant', 'Let me check that.', 295 + i);
  }
}

// ── the menu and the switch ────────────────────────────────

test('.brain works with the flag off and explains how to turn it on', async () => {
  writeProfile({ features: { businessBrain: false, reasoning: false, growthApproval: true } });
  reloadProfile();

  const menu = await run('.brain');
  assert.match(menu.reply, /business brain is off/i);
  assert.match(menu.reply, /\.brain on/);

  for (const cmd of ['.strategy', '.do 1', '.why 1', '.goal', '.experiment']) {
    const res = await run(cmd);
    assert.match(res.reply, /business brain is off/i, cmd);
  }

  // The impact numbers exist regardless — they are counts, not a feature.
  const impact = await run('.impact');
  assert.match(impact.reply, /Impact/);
});

test('".brain on" and ".brain off" flip the flag and nothing else', async () => {
  writeProfile({ features: { businessBrain: false, reasoning: false, growthApproval: true } });
  reloadProfile();
  const on = await run('.brain on');
  assert.match(on.reply, /ON/);
  const saved = JSON.parse(fs.readFileSync(path.join(configDir, 'owner.json'), 'utf8'));
  assert.equal(saved.features.businessBrain, true);

  const off = await run('.brain off');
  assert.match(off.reply, /OFF/);
  const again = JSON.parse(fs.readFileSync(path.join(configDir, 'owner.json'), 'utf8'));
  assert.equal(again.features.businessBrain, false);

  writeProfile({ features: { businessBrain: true, reasoning: true, growthApproval: true } });
  reloadProfile();
});

test('.brain with the flag on is a three-line brief', async () => {
  seedWeek();
  const brief = await run('.brain');
  const lines = brief.reply.split('\n').filter(Boolean);
  assert.ok(lines.length <= 6, `the brief should be short, saw ${lines.length} lines`);
  assert.match(brief.reply, /chat/i);
});

// ── impact in the existing dashboard ───────────────────────

test('the growth dashboard gains the impact block only when the brain is on', async () => {
  writeProfile({ features: { businessBrain: false, growthApproval: true } });
  reloadProfile();
  const off = await run('.growth');
  assert.doesNotMatch(off.reply, /Impact this week/);

  writeProfile({ features: { businessBrain: true, growthApproval: true } });
  reloadProfile();
  const on = await run('.growth');
  assert.match(on.reply, /Impact this week/);
  assert.match(on.reply, /\.impact/);
});

test('the weekly report keeps its old text when the brain is off', async () => {
  writeProfile({ features: { businessBrain: false, growthApproval: true } });
  reloadProfile();
  const off = await run('.report week');
  assert.doesNotMatch(off.reply, /Business brain/);

  writeProfile({ features: { businessBrain: true, growthApproval: true } });
  reloadProfile();
  const on = await run('.report week');
  assert.match(on.reply, /Business brain/);
  assert.match(on.reply, /\.strategy/);
});

test('a lead dossier gains one suggestion, and only with the brain on', async () => {
  seedWeek();
  const number = '923001239900';
  db.run('INSERT OR REPLACE INTO contacts (number, name, push_name) VALUES (?,?,?)', [number, 'Quiet Quote', 'Quiet Quote']);
  msg(number, 'user', 'send the quote please', 4000);
  db.run('INSERT INTO leads (number, status, score, project_type, created_at) VALUES (?,?,?,?,?)', [
    number,
    'quoted',
    70,
    'cake',
    at(5000),
  ]);

  writeProfile({ features: { businessBrain: false, growthApproval: true } });
  reloadProfile();
  const off = await run(`.lead ${number}`);
  assert.doesNotMatch(off.reply, /Suggested/);

  writeProfile({ features: { businessBrain: true, growthApproval: true } });
  reloadProfile();
  const on = await run(`.lead ${number}`);
  assert.match(on.reply, /Suggested/);
});

// ── strategy, drafts, goals, experiments ───────────────────

test('.strategy ranks at most five actions and .do prepares a draft without sending', async () => {
  seedWeek();
  const strategy = await run('.strategy');
  assert.match(strategy.reply, /Weekly strategy/);
  assert.match(strategy.reply, /Do these next/);
  assert.match(strategy.reply, /\.do 1/);

  const sock = fakeSock();
  const before = db.get('SELECT COUNT(*) AS n FROM messages')?.n;
  const prepared = await run('.do 1');
  assert.match(prepared.reply, /draft|preview|FAQ/i);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM messages')?.n, before, 'nothing was sent to a customer');
  assert.equal(sock.sent.length, 0);

  const why = await run('.why 1');
  assert.match(why.reply, /Why 1/);
  assert.match(why.reply, /estimate/i);
});

test('.goal add creates one, .goal shows progress and .goal drop removes it', async () => {
  for (const table of ['goals']) db.run(`DELETE FROM ${table}`);
  const added = await run('.goal add 20 orders by 2026-12-31');
  assert.match(added.reply, /Goal #\d+/);
  assert.match(added.reply, /20 orders/);

  const list = await run('.goal');
  assert.match(list.reply, /orders: 0\/20/);

  const dropped = await run('.goal drop 1');
  assert.match(dropped.reply, /Dropped goal/);
});

test('.experiment starts one, reports "too early", and never adopts on its own', async () => {
  for (const table of ['experiments', 'experiment_sends']) db.run(`DELETE FROM ${table}`);
  const created = await run('.experiment new followup "Want me to hold your usual table?" | "Shall I save your usual slot?"');
  assert.match(created.reply, /Experiment #1/);

  const view = await run('.experiment 1');
  assert.match(view.reply, /too early/i);
  assert.equal(db.get('SELECT status FROM experiments WHERE id = 1')?.status, 'running');
});

test('a non-owner cannot run the brain commands', async () => {
  const res = await handleOwnerCommand({}, '923009999999@s.whatsapp.net', '.impact', '923009999999');
  assert.match(res.reply, /private|owner/i);
});

// ── the reasoning path in the pipeline ─────────────────────

test('with reasoning off the pipeline is unchanged', async () => {
  writeProfile({ features: { businessBrain: true, reasoning: false, growthApproval: true } });
  reloadProfile();
  __testSetPlan(['never used']);
  setMockReply(() => 'The Zinger Burger is 650 rupees.');
  const sock = fakeSock();
  const number = '923001237001';
  await handleIncoming(sock, {
    key: { remoteJid: `${number}@s.whatsapp.net`, fromMe: false, id: 'MSG-R1' },
    message: { conversation: 'price of the burger?' },
    pushName: 'Test Customer',
  });
  await waitFor(() => textMessages(sock.sent, number).length > 0, 4000);
  assert.equal(textMessages(sock.sent, number).length, 1);
  assert.equal(db.all("SELECT * FROM brain_decisions WHERE kind = 'reasoning'").length, 0, 'no plan was made');
  setMockReply(null);
});

test('with reasoning on a complex turn gets a plan, and a wrong number is retried or handed over', async () => {
  writeProfile({ features: { businessBrain: true, reasoning: true, growthApproval: true } });
  reloadProfile();
  db.run("DELETE FROM settings WHERE key LIKE 'brain_reasoning_%'");

  // The plan is available; the first reply invents a price, the second is honest.
  __testSetPlan(['check the order record', 'quote the catalogue price']);
  let calls = 0;
  setMockReply(() => {
    calls += 1;
    return calls === 1 ? 'That will be 4321 rupees, and I have booked it.' : 'The Zinger Burger is 650 rupees. Shall I confirm the order?';
  });

  const sock = fakeSock();
  const number = '923001237002';
  await handleIncoming(sock, {
    key: { remoteJid: `${number}@s.whatsapp.net`, fromMe: false, id: 'MSG-R2' },
    message: { conversation: 'I was charged twice last time and nobody replied. I want a refund and the burger again, what will you do about it?' },
    pushName: 'Test Customer',
  });
  await waitFor(() => textMessages(sock.sent, number).length > 0, 6000);

  const texts = textMessages(sock.sent, number);
  assert.ok(texts.length >= 1, 'something was sent');
  // The invented number must never reach the customer.
  for (const text of texts) assert.doesNotMatch(text, /4321/);
  assert.ok(texts.some((t) => /650/.test(t)), `expected the honest price, saw ${JSON.stringify(texts)}`);

  const trail = db.all("SELECT kind, action, rationale, outcome FROM brain_decisions ORDER BY id");
  assert.ok(trail.some((row) => row.kind === 'reasoning'), 'the plan was recorded');
  assert.ok(trail.some((row) => row.kind === 'verify'), 'the rejection was recorded');
  for (const row of trail) assert.ok(String(row.rationale).length <= 300);

  setMockReply(null);
  __testClearPlan();
});

test('two failed checks hand the chat to the owner instead of guessing', async () => {
  writeProfile({ features: { businessBrain: true, reasoning: true, growthApproval: true } });
  reloadProfile();
  db.run("DELETE FROM settings WHERE key LIKE 'brain_reasoning_%'");
  __testSetPlan(['check the record']);
  setMockReply(() => 'It costs 7777 rupees and I already delivered it.');

  const sock = fakeSock();
  const number = '923001237003';
  await handleIncoming(sock, {
    key: { remoteJid: `${number}@s.whatsapp.net`, fromMe: false, id: 'MSG-R3' },
    message: { conversation: 'refund please — the wrong item arrived twice and the bill is wrong, what are you doing about it?' },
    pushName: 'Test Customer',
  });
  await waitFor(() => textMessages(sock.sent, number).length > 0, 6000);

  const texts = textMessages(sock.sent, number);
  for (const text of texts) assert.doesNotMatch(text, /7777/);
  assert.ok(
    texts.some((t) => /owner/i.test(t)),
    `expected a hand-off sentence, saw ${JSON.stringify(texts)}`
  );
  const trail = db.all("SELECT action FROM brain_decisions WHERE kind = 'verify'");
  assert.ok(trail.some((row) => row.action === 'handoff'));

  setMockReply(null);
  __testClearPlan();
});

test('with no model at all the router quietly does nothing', async () => {
  writeProfile({ features: { businessBrain: true, reasoning: true, growthApproval: true } });
  reloadProfile();
  db.run("DELETE FROM settings WHERE key LIKE 'brain_reasoning_%'");
  const llm = await import('../src/core/llm.js');
  llm.__setFetch(async () => {
    throw new Error('offline');
  });
  try {
    __testSetPlan(['x']);
    const turn = await import('../src/services/reasoning.js').then((R) =>
      R.reasonAboutTurn({ text: 'refund and a replacement, second time', now: new Date() })
    );
    assert.equal(turn.used, false);
  } finally {
    mockTransport();
    __testClearPlan();
  }
});
