// test/45-privacy.test.js
// Privacy tools, tested from the outside: what comes out, and what is left.
//
// The export test is an "only this person" test, not a "some rows" test. The
// forget test seeds every table the bot keeps, then checks them one by one,
// because "we delete everything" is a claim that is either true table by table
// or it is not true at all.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fakeSock, isolate } from './helpers.js';

const dataDir = isolate('privacy');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;

let envModule = null;

function writeProfile(patch = {}) {
  const profile = {
    owner: { name: 'T', number: '923001234567', timezone: 'Asia/Karachi' },
    business: { name: 'Test Cafe', type: 'Cafe', city: 'Islamabad', hours: 'Daily 00:00-23:59', currency: 'PKR' },
    catalog: { items: [{ id: 'karahi', name: 'Chicken Karahi', price: 1350, stock: 5 }] },
    features: { businessProfile: true, catalog: true, toolCalling: true, privacyTools: true, ...(patch.features || {}) },
  };
  fs.writeFileSync(path.join(configDir, 'owner.json'), JSON.stringify(profile, null, 2));
  envModule?.reloadProfile?.();
}

writeProfile();

const db = await import('../src/utils/db.js');
await db.initDB();

const env = await import('../src/config/env.js');
envModule = env;
env.reloadProfile();

const privacy = await import('../src/services/privacy.js');
const { invoiceDir } = await import('../src/services/invoice.js');

const CUSTOMER = '923001112233';
const OTHER = '923004445566';
const OWNER = '923001234567';

const MIN = 60_000;

function seed(number, { text = 'hello, is the karahi available?' } = {}) {
  db.upsertContact(number, { jid: `${number}@s.whatsapp.net`, name: `Name ${number.slice(-4)}`, push_name: 'Push' });
  db.saveMessage(number, 'user', text);
  db.saveMessage(number, 'assistant', 'Yes, 5 in stock.');
  db.run('INSERT INTO facts (number, key, value, updated_at) VALUES (?,?,?,?)', [number, 'likes', 'spicy', new Date().toISOString()]);
  db.run('INSERT INTO summaries (number, summary, msg_count, updated_at) VALUES (?,?,?,?)', [number, 'asked about karahi', 2, new Date().toISOString()]);
  db.run('INSERT INTO leads (number, name, status, notes) VALUES (?,?,?,?)', [number, 'Lead', 'new', 'hot lead']);
  // bookings are unique per slot, so two seeded contacts cannot share a table
  db.run('INSERT INTO bookings (chat, service, date, time, name, status) VALUES (?,?,?,?,?,?)', [number, 'Table', '2026-11-20', `19:0${number.slice(-1)}`, 'Lead', 'booked']);
  db.run('INSERT INTO orders (chat, items, total, currency, name, status) VALUES (?,?,?,?,?,?)', [number, '[{"name":"Karahi","qty":1}]', 1350, 'PKR', 'Lead', 'placed']);
  db.run('INSERT INTO followups (number, due_at, attempt, message, status) VALUES (?,?,?,?,?)', [number, new Date().toISOString(), 1, 'nudge', 'pending']);
  db.run('INSERT INTO referrals (code, number, uses, created_at) VALUES (?,?,?,?)', [`C${number.slice(-3)}`, number, 1, new Date().toISOString()]);
  db.run('INSERT INTO review_asks (number, kind, status) VALUES (?,?,?)', [number, 'job', 'sent']);
  db.run('INSERT INTO intake (number, stage, fields) VALUES (?,?,?)', [number, 'quoted', '{}']);
  db.run('INSERT INTO calls (number, name, video, status) VALUES (?,?,?,?)', [number, 'Lead', 0, 'missed']);
  db.run('INSERT INTO pending_rules (number, question, answer, status) VALUES (?,?,?,?)', [number, 'q', 'a', 'pending']);
  db.run('INSERT INTO reactivation_log (number, segment, cycle, sent_at) VALUES (?,?,?,?)', [number, 'cold', 1, new Date().toISOString()]);
  db.run('INSERT INTO growth_sends (agent, number, reason, result) VALUES (?,?,?,?)', ['followup', number, 'quiet', 'sent']);
  db.run('INSERT INTO growth_drafts (number, agent, kind, text, status) VALUES (?,?,?,?,?)', [number, 'followup', 'nudge', 'draft', 'sent']);
  db.run('INSERT INTO booking_reminders (booking_id, number, kind, due_at, status) VALUES (?,?,?,?,?)', [1, number, 'day_before', new Date().toISOString(), 'due']);
  db.run('INSERT INTO objection_attempts (number, kind, attempt) VALUES (?,?,?)', [number, 'price', 1]);
  db.run('INSERT INTO seen_messages (msg_id, number, kind, body) VALUES (?,?,?,?)', [`M-${number}`, number, 'text', 'hello']);
  db.run('INSERT INTO message_intents (tenant, chat, intent, agent, source) VALUES (?,?,?,?,?)', ['default', number, 'sales', 'sales', 'rules']);
  db.run('INSERT INTO tool_calls (tenant, chat, tool, args, status) VALUES (?,?,?,?,?)', ['default', number, 'check_stock', '{"item":"karahi"}', 'ok']);
  db.run('INSERT INTO outbox (jid, payload, kind, status) VALUES (?,?,?,?)', [`${number}@s.whatsapp.net`, '{"text":"hi"}', 'text', 'pending']);
  db.run('INSERT INTO cloud_messages (wa_id, tenant, number, kind, status) VALUES (?,?,?,?,?)', [`wamid.${number}`, 'default', number, 'text', 'sent']);
  db.run('INSERT INTO pending (number, payload, due_at) VALUES (?,?,?)', [number, '{"text":"later"}', new Date().toISOString()]);
  db.run('INSERT INTO growth_optouts (number, reason, source) VALUES (?,?,?)', [number, 'stop', 'customer']);
}

function counts(number) {
  const jid = `${number}@s.whatsapp.net`;
  const one = (sql, params = [number]) => db.get(sql, params)?.n || 0;
  return {
    messages: one('SELECT COUNT(*) AS n FROM messages WHERE number = ?'),
    seen_messages: one('SELECT COUNT(*) AS n FROM seen_messages WHERE number = ?'),
    facts: one('SELECT COUNT(*) AS n FROM facts WHERE number = ?'),
    summaries: one('SELECT COUNT(*) AS n FROM summaries WHERE number = ?'),
    intake: one('SELECT COUNT(*) AS n FROM intake WHERE number = ?'),
    leads: one('SELECT COUNT(*) AS n FROM leads WHERE number = ?'),
    followups: one('SELECT COUNT(*) AS n FROM followups WHERE number = ?'),
    pending: one('SELECT COUNT(*) AS n FROM pending WHERE number = ?'),
    pending_rules: one('SELECT COUNT(*) AS n FROM pending_rules WHERE number = ?'),
    calls: one('SELECT COUNT(*) AS n FROM calls WHERE number = ?'),
    review_asks: one('SELECT COUNT(*) AS n FROM review_asks WHERE number = ?'),
    referrals: one('SELECT COUNT(*) AS n FROM referrals WHERE number = ?'),
    reactivation_log: one('SELECT COUNT(*) AS n FROM reactivation_log WHERE number = ?'),
    growth_sends: one('SELECT COUNT(*) AS n FROM growth_sends WHERE number = ?'),
    growth_drafts: one('SELECT COUNT(*) AS n FROM growth_drafts WHERE number = ?'),
    booking_reminders: one('SELECT COUNT(*) AS n FROM booking_reminders WHERE number = ?'),
    objection_attempts: one('SELECT COUNT(*) AS n FROM objection_attempts WHERE number = ?'),
    growth_optouts: one('SELECT COUNT(*) AS n FROM growth_optouts WHERE number = ?'),
    message_intents: one('SELECT COUNT(*) AS n FROM message_intents WHERE chat = ? OR chat = ?', [number, jid]),
    bookings: one('SELECT COUNT(*) AS n FROM bookings WHERE chat = ? OR chat = ?', [number, jid]),
    orders: one('SELECT COUNT(*) AS n FROM orders WHERE chat = ? OR chat = ?', [number, jid]),
    tool_calls: one('SELECT COUNT(*) AS n FROM tool_calls WHERE chat = ? OR chat = ?', [number, jid]),
    outbox: one('SELECT COUNT(*) AS n FROM outbox WHERE jid = ? OR jid = ?', [number, jid]),
    cloud_messages: one('SELECT COUNT(*) AS n FROM cloud_messages WHERE number = ?'),
  };
}

function reset() {
  for (const table of [
    'messages', 'seen_messages', 'facts', 'summaries', 'intake', 'leads', 'followups', 'pending',
    'pending_rules', 'calls', 'review_asks', 'referrals', 'reactivation_log', 'growth_sends',
    'growth_drafts', 'booking_reminders', 'objection_attempts', 'growth_optouts', 'message_intents',
    'bookings', 'orders', 'tool_calls', 'outbox', 'cloud_messages', 'privacy_requests', 'privacy_audit',
    'contacts',
  ]) {
    db.run(`DELETE FROM ${table}`);
  }
  writeProfile();
}

// ── the flag ────────────────────────────────────────────────

test('privacy tools are off unless the owner turns them on', async () => {
  reset();
  writeProfile({ features: { privacyTools: false } });
  assert.equal(privacy.privacyEnabled(), false);

  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const sock = fakeSock();
  const reply = await handleOwnerCommand(sock, '923001234567@s.whatsapp.net', `.forget ${CUSTOMER} ${CUSTOMER}`, OWNER);
  assert.match(reply.reply, /Privacy tools are off/);
  assert.equal(counts(CUSTOMER).messages, 0);
  writeProfile();
});

// ── export ──────────────────────────────────────────────────

test('an export contains one contact, and nothing about anyone else', () => {
  reset();
  seed(CUSTOMER, { text: 'my secret order is karahi' });
  seed(OTHER, { text: 'this belongs to the other person' });

  const exported = privacy.exportContact(CUSTOMER);
  assert.equal(exported.ok, true);
  assert.equal(exported.number, CUSTOMER);

  assert.ok(exported.payload.messages.length === 2);
  assert.ok(exported.payload.messages.every((m) => !JSON.stringify(m).includes(OTHER)));
  assert.ok(!exported.text.includes(OTHER), 'no trace of the other contact in the file');
  assert.doesNotMatch(exported.text, /this belongs to the other person/);
  assert.match(exported.text, /my secret order is karahi/);

  // Every section that should be there, is.
  for (const key of ['contact', 'messages', 'facts', 'leads', 'bookings', 'orders', 'followups', 'referrals', 'reviews', 'consents']) {
    assert.ok(key in exported.payload, `${key} missing from the export`);
  }
  assert.equal(exported.payload.bookings.length, 1);
  assert.equal(exported.payload.orders.length, 1);
  assert.equal(exported.payload.facts[0].key, 'likes');
  assert.equal(exported.counts.messages, 2);
});

test('export builds a file name that says whose data it is', () => {
  const name = privacy.exportFileName(CUSTOMER, new Date('2026-11-16T10:20:30Z'));
  assert.match(name, /^export-923001112233-2026-11-16-10-20-30\.json$/);
});

test('.export <number> sends that file to the owner', async () => {
  reset();
  seed(CUSTOMER);
  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const sock = fakeSock();
  await handleOwnerCommand(sock, '923001234567@s.whatsapp.net', `.export ${CUSTOMER}`, OWNER);

  const doc = sock.sent.find((m) => m.payload?.document);
  assert.ok(doc, 'a document was sent');
  assert.match(doc.payload.fileName, new RegExp(`^export-${CUSTOMER}-`));
  const body = JSON.parse(doc.payload.document.toString('utf8'));
  assert.equal(body.format, 'wa-assistant-contact-export');
  assert.ok(body.messages.length >= 2);
  assert.ok(!JSON.stringify(body).includes(OTHER));
});

// ── forget ──────────────────────────────────────────────────

test('forget removes every table, one by one', () => {
  reset();
  seed(CUSTOMER);
  seed(OTHER);

  const before = counts(CUSTOMER);
  for (const [table, n] of Object.entries(before)) {
    assert.ok(n > 0, `seed did not write ${table}`);
  }

  const result = privacy.forgetContact(CUSTOMER);
  assert.equal(result.ok, true);

  const after = counts(CUSTOMER);
  // The only thing allowed to remain is the opt-out marker.
  assert.equal(after.growth_optouts, 1, 'the "never message them again" marker stays');
  for (const [table, n] of Object.entries(after)) {
    if (table === 'growth_optouts') continue;
    assert.equal(n, 0, `${table} still holds rows after forget`);
  }

  const contact = db.getContact(CUSTOMER);
  assert.ok(contact, 'the contact row stays as a shell');
  assert.equal(contact.is_blocked, 1);
  assert.equal(contact.category, 'forgotten');
  assert.equal(contact.name, null);
  assert.equal(contact.push_name, null);
  assert.ok(new Date(contact.bot_paused_until) > new Date(Date.now() + 365 * 86400000), 'paused essentially forever');

  // The other person is untouched: a deletion is not a burst radius.
  assert.ok(counts(OTHER).messages > 0);
  assert.equal(db.getContact(OTHER).is_blocked, 0);
});

test('a forgotten contact is never messaged again', () => {
  reset();
  seed(CUSTOMER);
  privacy.forgetContact(CUSTOMER);

  assert.equal(db.isOptedOut(CUSTOMER), true, 'the opt-out gate other agents check');
  const { isOptedOut } = db;
  assert.equal(isOptedOut(CUSTOMER), true);
  const contact = db.getContact(CUSTOMER);
  assert.ok(contact.bot_paused_until && new Date(contact.bot_paused_until) > new Date());
});

test('forget is idempotent and writes one audit line, not two', () => {
  reset();
  seed(CUSTOMER);

  const first = privacy.forgetContact(CUSTOMER);
  const auditsAfterFirst = db.recentPrivacyAudit(10).length;
  const second = privacy.forgetContact(CUSTOMER);

  assert.equal(second.ok, true);
  assert.equal(second.already, true, 'the second run says so instead of pretending');
  assert.equal(db.recentPrivacyAudit(10).length, auditsAfterFirst, 'no second audit line');
  assert.equal(first.total > 0, true);
});

test('the audit line names nobody and quotes nothing', () => {
  reset();
  seed(CUSTOMER, { text: 'my address is 12 Test Street' });
  privacy.forgetContact(CUSTOMER);

  const [audit] = db.recentPrivacyAudit(5);
  assert.equal(audit.action, 'forget');
  assert.match(audit.subject_hash, /^[0-9a-f]{16}$/);
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(CUSTOMER));
  assert.doesNotMatch(JSON.stringify(audit), /12 Test Street/);
  assert.equal(audit.subject_hash, privacy.subjectHash(CUSTOMER), 'the hash is stable, so a repeat is visible');
});

test('the owner cannot forget themselves', () => {
  reset();
  seed(OWNER);
  const result = privacy.forgetContact(OWNER);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'owner_number');
  assert.ok(counts(OWNER).messages > 0, 'nothing was deleted');
});

test('forget deletes the PDF invoices that belong to that contact\'s orders', () => {
  reset();
  seed(CUSTOMER);
  const dir = invoiceDir();
  fs.mkdirSync(dir, { recursive: true });
  const orderId = db.get('SELECT id FROM orders WHERE chat = ?', [CUSTOMER]).id;
  const mine = path.join(dir, `INV-2026-${String(orderId).padStart(4, '0')}.pdf`);
  const someoneElse = path.join(dir, 'INV-2026-9999.pdf');
  fs.writeFileSync(mine, '%PDF-1.4 fake');
  fs.writeFileSync(someoneElse, '%PDF-1.4 fake');

  const result = privacy.forgetContact(CUSTOMER);
  assert.equal(fs.existsSync(mine), false, "the contact's invoice is gone");
  assert.equal(fs.existsSync(someoneElse), true, "someone else's invoice is not");
  assert.equal(result.removed.invoices, 1);
  fs.unlinkSync(someoneElse);
});

// ── the customer's own request ──────────────────────────────

test('"delete my data" is understood in English, Roman Urdu and Urdu', () => {
  const yes = [
    'delete my data please',
    'please remove all my information',
    'I want to be deleted',
    'mera data delete karo',
    'meri maloomat hata do',
    'mujhe delete kar do',
    'میرا ڈیٹا ڈیلیٹ کرو',
  ];
  for (const text of yes) assert.equal(privacy.isDeletionRequest(text), true, text);

  const no = [
    'what is the price of the karahi?',
    'delete the extra cheese from my order',
    'mera order kab ayega?',
    'can you remove the onion?',
    '',
  ];
  for (const text of no) assert.equal(privacy.isDeletionRequest(text), false, text);
});

test('a request is recorded for the owner, acknowledged in the customer\'s language', () => {
  reset();
  const result = privacy.requestDeletion(CUSTOMER, { language: 'ur' });
  assert.equal(result.ok, true);
  const queue = privacy.privacyQueue(5);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].number, CUSTOMER);

  assert.match(privacy.deletionAcknowledgement('ur'), /ڈیٹا/);
  assert.match(privacy.deletionAcknowledgement('roman'), /delete|record/i);
  assert.match(privacy.deletionAcknowledgement('en'), /request/i);

  // Asking twice is one queue item, not two.
  privacy.requestDeletion(CUSTOMER);
  assert.equal(privacy.privacyQueue(5).length, 1);
});

test('the owner sees the queue and must type the number twice', async () => {
  reset();
  seed(CUSTOMER);
  privacy.requestDeletion(CUSTOMER);
  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const sock = fakeSock();

  const queue = await handleOwnerCommand(sock, '923001234567@s.whatsapp.net', '.forget', OWNER);
  assert.match(queue.reply, new RegExp(CUSTOMER));

  const once = await handleOwnerCommand(sock, '923001234567@s.whatsapp.net', `.forget ${CUSTOMER}`, OWNER);
  assert.match(once.reply, /type it twice/i);
  assert.ok(counts(CUSTOMER).messages > 0, 'one mention deletes nothing');

  const mismatch = await handleOwnerCommand(sock, '923001234567@s.whatsapp.net', `.forget ${CUSTOMER} ${OTHER}`, OWNER);
  assert.match(mismatch.reply, /do not match/i);
  assert.ok(counts(CUSTOMER).messages > 0);

  const twice = await handleOwnerCommand(sock, '923001234567@s.whatsapp.net', `.forget ${CUSTOMER} ${CUSTOMER}`, OWNER);
  assert.match(twice.reply, /Forgot/);
  assert.equal(counts(CUSTOMER).messages, 0);
  assert.equal(privacy.privacyQueue(5).length, 0, 'the request is closed by the deletion');
});

// ── retention ───────────────────────────────────────────────

test('retention is off by default and purges bodies only when asked', () => {
  reset();
  seed(CUSTOMER);
  delete process.env.PRIVACY_RETENTION_DAYS;
  const off = privacy.purgeRetention({ days: 0 });
  assert.equal(off.ok, false);
  assert.equal(off.reason, 'disabled');

  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  db.run('UPDATE messages SET created_at = ? WHERE id = (SELECT MIN(id) FROM messages WHERE number = ?)', [old, CUSTOMER]);

  const purged = privacy.purgeRetention({ days: 30 });
  assert.equal(purged.ok, true);
  assert.equal(purged.purged, 1);

  const rows = db.all('SELECT content, created_at FROM messages WHERE number = ? ORDER BY id', [CUSTOMER]);
  assert.equal(rows[0].content, '[purged]', 'the old body is gone');
  assert.match(rows[1].content, /5 in stock/, 'the recent one is untouched');
  assert.equal(rows.length, 2, 'the rows (and therefore the counts) stay');
});

test('retention removes old media files and leaves recent ones', () => {
  reset();
  const dir = env.config.paths.tmp;
  fs.mkdirSync(dir, { recursive: true });
  const oldFile = path.join(dir, 'old_photo.jpg');
  const newFile = path.join(dir, 'new_photo.jpg');
  fs.writeFileSync(oldFile, 'x');
  fs.writeFileSync(newFile, 'x');
  const old = new Date(Date.now() - 60 * 86400000);
  fs.utimesSync(oldFile, old, old);

  const result = privacy.purgeRetention({ days: 30 });
  assert.equal(result.media >= 1, true);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(newFile), true);
  fs.unlinkSync(newFile);
});

// ── the customer end, through the handler ───────────────────

test('a customer writing "delete my data" gets an acknowledgement, not a conversation', async () => {
  reset();
  const { handleIncoming } = await import('../src/handlers/messageHandler.js');
  const sock = fakeSock();
  sock.sendMessage = async (jid, payload) => {
    sock.sent.push({ jid, payload });
    return { key: { id: `S-${sock.sent.length}` } };
  };
  sock.can = () => true;
  sock.user = { id: '923001234567:1@s.whatsapp.net' };

  await handleIncoming(sock, {
    key: { remoteJid: '923007771122@s.whatsapp.net', fromMe: false, id: 'PRIV-1' },
    message: { conversation: 'mera data delete karo' },
    pushName: 'Test Client',
  });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !sock.sent.some((m) => m.payload?.text)) {
    await new Promise((r) => setTimeout(r, 100));
  }

  const replies = sock.sent.map((m) => m.payload?.text).filter(Boolean);
  assert.ok(replies.length >= 1, 'the customer got an answer');
  assert.match(replies.join('\n'), /owner|مالک/i);
  assert.equal(privacy.privacyQueue(5).length, 1, 'and the owner has a request to approve');

  // The owner was pinged with the command to run.
  const ownerPing = sock.sent.find((m) => m.jid.startsWith('923001234567') && String(m.payload?.text).includes('.forget'));
  assert.ok(ownerPing, 'the owner was told, with the command in the message');
});
