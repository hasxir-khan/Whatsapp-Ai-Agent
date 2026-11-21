// test/47-crm.test.js
// The mini CRM: tags a human typed, tags the rules derived, and the one place
// they are used — a campaign audience.
//
// The rule that gets its own tests here is that a tag only ever *narrows* what
// the existing rules already allowed. A tag must never be a way around an
// opt-out, a block, a takeover or a forgotten contact.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isolate } from './helpers.js';

const dataDir = isolate('crm');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;

let envModule = null;

function writeProfile(patch = {}) {
  const profile = {
    owner: { name: 'T', number: '923001234567', timezone: 'Asia/Karachi' },
    business: {
      name: 'Test Cafe', type: 'Cafe', city: 'Islamabad',
      hours: 'Daily 00:00-23:59', currency: 'PKR',
      ...(patch.business || {}),
    },
    catalog: { items: [{ id: 'karahi', name: 'Chicken Karahi', price: 1350, stock: 5 }] },
    features: {
      businessProfile: true, catalog: true, growthApproval: false,
      crm: true, orderTracking: true, reactivationAgent: true, privacyTools: true,
      ...(patch.features || {}),
    },
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

const crm = await import('../src/services/crm.js');
const growth = await import('../src/services/growth.js');
const privacy = await import('../src/services/privacy.js');
const reactivation = await import('../src/services/reactivationAgent.js');
const { inboxThread } = await import('../src/services/liveInbox.js');
const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');

const VIP = '923008881111';
const REGULAR = '923008882222';
const COLD = '923008883333';
const OWNER = '923001234567';
const OWNER_JID = `${OWNER}@s.whatsapp.net`;

const NOON = new Date('2026-11-17T08:00:00.000Z');
const DAY = 86_400_000;

function jidFor(number) {
  return `${number}@s.whatsapp.net`;
}

function contact(number, patch = {}) {
  db.upsertContact(number, { jid: jidFor(number), name: `Name ${number.slice(-4)}`, ...patch });
  return db.getContact(number);
}

/** An order old enough for `.campaign` to consider the person a past customer. */
function oldOrder(number, { status = 'paid', total = 1350, daysAgo = 60 } = {}) {
  const created = new Date(NOON.getTime() - daysAgo * DAY).toISOString();
  db.run(
    'INSERT INTO orders (chat, items, total, currency, name, status, key, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [jidFor(number), JSON.stringify([{ name: 'Karahi', qty: 1, price: total }]), total, 'PKR', 'Customer', status, `crm-${number}-${Math.random()}`, created]
  );
}

function reset() {
  db.run('DELETE FROM contact_tags');
  db.run('DELETE FROM contact_notes');
  db.run('DELETE FROM orders');
  db.run('DELETE FROM order_events');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM contacts');
  db.run('DELETE FROM growth_optouts');
  db.run('DELETE FROM reactivation_log');
  db.run('DELETE FROM leads');
  db.run('DELETE FROM referrals');
  db.run('DELETE FROM message_intents');
  db.run('DELETE FROM events');
}

// ── tags ────────────────────────────────────────────────────

test('tags are normalised: lowercase, dashes, no punctuation', () => {
  assert.equal(crm.normaliseTag('  Big Spender!! '), 'big-spender');
  assert.equal(crm.normaliseTag('#VIP'), 'vip');
  assert.equal(crm.normaliseTag('ordered   twice'), 'ordered-twice');
  assert.equal(crm.normaliseTag(''), null);
  assert.equal(crm.normaliseTag('!!!'), null);
  assert.equal(crm.normaliseTag('a'.repeat(80)).length, crm.MAX_TAG_LENGTH);
});

test('adding the same tag twice is harmless', () => {
  reset();
  contact(VIP);
  const first = crm.addTag(VIP, 'VIP');
  assert.equal(first.ok, true);
  assert.equal(first.tag, 'vip');
  assert.equal(first.already, undefined);

  const second = crm.addTag(VIP, 'vip');
  assert.equal(second.already, true);
  assert.equal(crm.tagsFor(VIP).length, 1);
});

test('a contact cannot hold more than twenty tags', () => {
  reset();
  contact(VIP);
  for (let i = 0; i < crm.MAX_TAGS_PER_CONTACT; i++) {
    assert.equal(crm.addTag(VIP, `tag-${i}`).ok, true);
  }
  const extra = crm.addTag(VIP, 'one-too-many');
  assert.equal(extra.ok, false);
  assert.equal(extra.reason, 'too_many_tags');
  assert.equal(extra.limit, crm.MAX_TAGS_PER_CONTACT);
  assert.equal(crm.tagsFor(VIP).length, crm.MAX_TAGS_PER_CONTACT);
});

test('a tag cannot be nonsense, and a number is required', () => {
  reset();
  contact(VIP);
  assert.equal(crm.addTag(VIP, '!!!').reason, 'invalid_tag');
  assert.equal(crm.addTag('', 'vip').reason, 'invalid_number');
});

test('untagging removes exactly one tag', () => {
  reset();
  contact(VIP);
  crm.addTag(VIP, 'vip');
  crm.addTag(VIP, 'evening-only');

  const removed = crm.removeTag(VIP, 'VIP');
  assert.equal(removed.removed, true);
  assert.deepEqual(crm.tagsFor(VIP).map((t) => t.tag), ['evening-only']);

  const again = crm.removeTag(VIP, 'vip');
  assert.equal(again.removed, false);
});

test('tags are per tenant: another business sees none of them', () => {
  reset();
  contact(VIP);
  crm.addTag(VIP, 'vip', { tenantSlug: 'tenant-a' });
  assert.equal(crm.tagsFor(VIP, { tenantSlug: 'tenant-a' }).length, 1);
  assert.equal(crm.tagsFor(VIP, { tenantSlug: 'tenant-b' }).length, 0);
});

test('.tags counts them and .find lists the people', async () => {
  reset();
  contact(VIP);
  contact(REGULAR);
  crm.addTag(VIP, 'vip');
  crm.addTag(REGULAR, 'vip');
  crm.addTag(REGULAR, 'evening-only');

  const counts = await handleOwnerCommand({ kind: 'baileys' }, OWNER_JID, '.tags');
  assert.match(counts.reply, /vip: 2/);
  assert.match(counts.reply, /evening-only: 1/);

  const found = await handleOwnerCommand({ kind: 'baileys' }, OWNER_JID, '.find vip');
  assert.match(found.reply, new RegExp(VIP));
  assert.match(found.reply, new RegExp(REGULAR));
  assert.match(found.reply, /2 contact/);
});

test('notes are kept, trimmed and capped', () => {
  reset();
  contact(VIP);
  const res = crm.addNote(VIP, '  prefers   evening delivery  ');
  assert.equal(res.ok, true);
  assert.equal(res.note.note, 'prefers evening delivery');

  const long = crm.addNote(VIP, 'x'.repeat(900));
  assert.equal(long.note.note.length, crm.MAX_NOTE_LENGTH);

  assert.equal(crm.addNote(VIP, '   ').reason, 'empty_note');
  assert.equal(crm.notesFor(VIP).length, 2, 'newest first');
  assert.equal(crm.notesFor(VIP)[0].note.length, crm.MAX_NOTE_LENGTH);
});

test('.note and .lead put the notes in front of the owner', async () => {
  reset();
  contact(VIP);
  const saved = await handleOwnerCommand({ kind: 'baileys' }, OWNER_JID, `.note ${VIP} asked about a bulk order`);
  assert.match(saved.reply, /Noted on/);

  const lead = await handleOwnerCommand({ kind: 'baileys' }, OWNER_JID, `.lead ${VIP}`);
  assert.match(lead.reply, /asked about a bulk order/);
});

// ── auto tags ───────────────────────────────────────────────

test('a brand-new contact is tagged new, and loses it after real conversation', () => {
  reset();
  contact(VIP);
  assert.deepEqual(crm.deriveAutoTags(VIP, { now: NOON }), ['new']);

  for (let i = 0; i < 3; i++) db.saveMessage(VIP, 'user', 'hello');
  assert.deepEqual(crm.deriveAutoTags(VIP, { now: NOON }), []);
});

test('two orders make a repeat customer, and vip needs a spend threshold', () => {
  reset();
  contact(VIP);
  oldOrder(VIP, { total: 2000 });
  assert.ok(!crm.deriveAutoTags(VIP, { now: NOON }).includes('repeat'), 'one order is not repeat');

  oldOrder(VIP, { total: 2000 });
  const two = crm.deriveAutoTags(VIP, { now: NOON });
  assert.ok(two.includes('repeat'));
  assert.ok(!two.includes('vip'), 'no threshold set means nobody is a vip by spend');

  writeProfile({ business: { crm: { vipSpend: 3000 } } });
  assert.ok(crm.deriveAutoTags(VIP, { now: NOON }).includes('vip'), '4,000 spent beats the 3,000 line');
  writeProfile();
});

test('cancelled orders do not count towards spend', () => {
  reset();
  contact(VIP);
  oldOrder(VIP, { status: 'paid', total: 2000 });
  oldOrder(VIP, { status: 'cancelled', total: 5000 });
  writeProfile({ business: { crm: { vipSpend: 3000 } } });
  assert.ok(!crm.deriveAutoTags(VIP, { now: NOON }).includes('vip'));
  writeProfile();
});

test('a complaint and a referral are remembered as tags, cold comes from silence', () => {
  reset();
  contact(VIP);
  // upsertContact stamps last_seen with "now", so the silence is written after it.
  db.run('UPDATE contacts SET last_seen = ? WHERE number = ?', [new Date(NOON.getTime() - 60 * DAY).toISOString(), VIP]);
  db.saveMessage(VIP, 'user', 'my order was cold');
  db.saveMessage(VIP, 'user', 'and late');
  db.saveMessage(VIP, 'assistant', 'sorry about that');
  db.run('INSERT INTO message_intents (chat, intent, agent, source, created_at) VALUES (?,?,?,?,?)', [
    jidFor(VIP), 'complaint', 'manager', 'rules', new Date().toISOString(),
  ]);
  db.run('INSERT INTO referrals (code, number, uses, created_at) VALUES (?,?,?,?)', ['REF1', VIP, 1, new Date().toISOString()]);

  const tags = crm.deriveAutoTags(VIP, { now: NOON });
  assert.ok(tags.includes('complaint'));
  assert.ok(tags.includes('referrer'));
  assert.ok(tags.includes('cold'));
});

test('applyAutoTags adds and removes, but never touches a human tag', () => {
  reset();
  contact(VIP);
  crm.addTag(VIP, 'vip');          // owner said so
  crm.applyAutoTags(VIP, { now: NOON });

  const after = crm.tagsFor(VIP);
  assert.deepEqual(after.map((t) => t.tag).sort(), ['new', 'vip']);
  assert.equal(after.find((t) => t.tag === 'vip').source, 'owner');
  assert.equal(after.find((t) => t.tag === 'new').source, 'auto');

  // Once they have actually spoken, "new" is removed but the owner's tag stays.
  for (let i = 0; i < 3; i++) db.saveMessage(VIP, 'user', 'hello');
  const again = crm.applyAutoTags(VIP, { now: NOON });
  assert.deepEqual(again.removed, ['new']);
  assert.deepEqual(crm.tagsFor(VIP).map((t) => t.tag), ['vip']);
});

test('auto tags are derived when an order is created', async () => {
  reset();
  contact(VIP);
  oldOrder(VIP, { total: 1000 });
  oldOrder(VIP, { total: 1000 });
  const orders = await import('../src/services/orders.js');
  const latest = db.get('SELECT * FROM orders WHERE chat = ? ORDER BY id DESC LIMIT 1', [jidFor(VIP)]);
  await orders.onOrderPlaced(db.getOrder(latest.id), { now: NOON });
  assert.ok(crm.tagsFor(VIP).some((t) => t.tag === 'repeat'), 'the hook tagged a two-order customer');
  assert.equal(crm.tagsFor(VIP).find((t) => t.tag === 'repeat').source, 'auto');
});

// ── segments ────────────────────────────────────────────────

test('a campaign can be narrowed to one tag', () => {
  reset();
  for (const number of [VIP, REGULAR, COLD]) {
    contact(number);
    oldOrder(number, { daysAgo: 90 });
  }
  crm.addTag(VIP, 'vip');
  crm.addTag(REGULAR, 'vip');
  crm.addTag(COLD, 'evening-only');

  const everyone = reactivation.segments(NOON, {}).map((r) => r.number).sort();
  assert.deepEqual(everyone, [COLD, REGULAR, VIP].sort());

  const vips = reactivation.segments(NOON, { tag: 'vip' }).map((r) => r.number).sort();
  assert.deepEqual(vips, [REGULAR, VIP].sort());

  const none = reactivation.segments(NOON, { tag: 'nobody-has-this' });
  assert.equal(none.length, 0);
});

test('a tag never overrides an opt-out, a block or a takeover', () => {
  reset();
  contact(VIP);
  contact(REGULAR);
  contact(COLD);
  for (const number of [VIP, REGULAR, COLD]) {
    oldOrder(number, { daysAgo: 90 });
    crm.addTag(number, 'vip');
  }

  growth.recordOptOut(VIP, 'asked us to stop');
  db.blockContact(REGULAR, true);
  db.setContactPaused(COLD, new Date(NOON.getTime() + 60 * 60 * 1000).toISOString());

  const tagged = reactivation.segments(NOON, { tag: 'vip' });
  assert.equal(tagged.length, 0, 'the tag found nobody the rules still allow');
});

test('a forgotten contact is not in a tagged audience', async () => {
  reset();
  contact(VIP);
  contact(REGULAR);
  oldOrder(VIP, { daysAgo: 90 });
  oldOrder(REGULAR, { daysAgo: 90 });
  crm.addTag(VIP, 'vip');
  crm.addTag(REGULAR, 'vip');

  const res = privacy.forgetContact(VIP, { reason: 'asked' });
  assert.equal(res.ok, true);

  const tagged = reactivation.segments(NOON, { tag: 'vip' }).map((r) => r.number);
  assert.deepEqual(tagged, [REGULAR]);
  assert.equal(crm.tagsFor(VIP).length, 0, 'the tags went with them');
});

test('.campaign preview tag:vip counts the narrowed list', async () => {
  reset();
  contact(VIP);
  contact(REGULAR);
  oldOrder(VIP, { daysAgo: 90 });
  oldOrder(REGULAR, { daysAgo: 90 });
  crm.addTag(VIP, 'vip');

  const all = await handleOwnerCommand({ kind: 'baileys' }, OWNER_JID, '.campaign preview');
  const narrowed = await handleOwnerCommand({ kind: 'baileys' }, OWNER_JID, '.campaign preview tag:vip');
  assert.match(narrowed.reply, /tag: ?vip|vip/i);
  assert.notEqual(all.reply, narrowed.reply);

  const nobody = await handleOwnerCommand({ kind: 'baileys' }, OWNER_JID, '.campaign preview tag:ghost');
  assert.match(nobody.reply, /0|nobody|no one|nothing/i);
});

// ── privacy + inbox ─────────────────────────────────────────

test('export includes tags, notes and order history', () => {
  reset();
  contact(VIP);
  oldOrder(VIP, { daysAgo: 3 });
  const order = db.get('SELECT * FROM orders WHERE chat = ? ORDER BY id DESC LIMIT 1', [jidFor(VIP)]);
  db.logOrderEvent({ orderId: order.id, from: null, to: 'placed', actor: 'bot', detail: 'created' });
  crm.addTag(VIP, 'vip');
  crm.addNote(VIP, 'wants the corner table');

  const doc = privacy.exportContact(VIP);
  assert.equal(doc.ok, true);
  assert.deepEqual(doc.payload.tags.map((t) => t.tag), ['vip']);
  assert.equal(doc.payload.notes[0].note, 'wants the corner table');
  assert.equal(doc.payload.orderHistory.length, 1);
  assert.equal(doc.payload.orderHistory[0].to_status, 'placed');
  assert.equal(doc.counts.tags, 1, 'the counts line mentions them too');
  assert.equal(doc.counts.orderHistory, 1);
});

test('forget deletes tags, notes and the order timeline', () => {
  reset();
  contact(VIP);
  oldOrder(VIP, { daysAgo: 3 });
  const order = db.get('SELECT * FROM orders WHERE chat = ? ORDER BY id DESC LIMIT 1', [jidFor(VIP)]);
  db.logOrderEvent({ orderId: order.id, from: null, to: 'placed', actor: 'bot', detail: 'created' });
  crm.addTag(VIP, 'vip');
  crm.addNote(VIP, 'wants the corner table');

  const res = privacy.forgetContact(VIP, { reason: 'asked' });
  assert.equal(res.ok, true);
  assert.ok(res.removed.contact_tags >= 1);
  assert.ok(res.removed.contact_notes >= 1);
  assert.ok(res.removed.order_events >= 1);

  assert.equal(db.contactTags(VIP).length, 0);
  assert.equal(db.contactNotes(VIP).length, 0);
  assert.equal(db.orderEvents(order.id).length, 0);

  // Idempotent: running it again is not an error.
  const again = privacy.forgetContact(VIP, { reason: 'asked' });
  assert.equal(again.ok, true);
});

test('the inbox thread carries a read-only CRM strip', () => {
  reset();
  contact(VIP);
  db.saveMessage(VIP, 'user', 'hello');
  crm.addTag(VIP, 'vip');
  crm.addNote(VIP, 'ring twice');

  const thread = inboxThread(VIP);
  assert.equal(thread.contact.number, VIP);
  assert.ok(thread.crm, 'the panel data is there');
  assert.deepEqual(thread.crm.tags.map((t) => t.tag), ['vip']);
  assert.equal(thread.crm.notes[0].note, 'ring twice');
  assert.ok(Array.isArray(thread.crm.profile.autoTags));
});

test('with crm off there is no panel and no commands', async () => {
  reset();
  contact(VIP);
  writeProfile({ features: { crm: false } });

  assert.equal(crm.crmEnabled(), false);
  assert.equal(inboxThread(VIP).crm, null);
  assert.equal(crm.addTag(VIP, 'vip').reason, 'disabled');

  const res = await handleOwnerCommand({ kind: 'baileys' }, OWNER_JID, `.tag ${VIP} vip`);
  assert.match(res.reply, /CRM is off/);
  writeProfile();
});
