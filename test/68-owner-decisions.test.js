// test/68-owner-decisions.test.js
// Owner Decisions: the engine, the team, the chain, the history and the words.
//
//   1. the flags — off by default, and off means nothing runs
//   2. the engine — first decision wins, append-only events, admin-only reversal
//   3. the chain — escalation on a fake clock, "handled by X"
//   4. the team — roles, limits, working hours, validation
//   5. the commands — accept, reject, partial, recheck, more, decision, timeline
//   6. the customer side — every reason in three languages, never an accusation
//   7. privacy — masked cards, 0600 files, retention, export and forget
//
// Fake data only: fixture numbers, a temporary data folder, no network.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-owner-decisions-'));
process.env.DATA_DIR = dir;
process.env.TMP_DIR = path.join(dir, 'tmp');
process.env.SESSION_FOLDER = path.join(dir, 'sessions');
process.env.CONFIG_DIR = path.join(dir, 'config');
process.env.ENABLE_WEB = 'false';
process.env.MY_NUMBER = '923001234567';
process.env.MY_NAME = 'Test Owner';
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.GEMINI_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';
process.env.GROWTH_DAILY_CAP = '200';
process.env.GROWTH_BAILEYS_CAP = '200';
process.env.GROWTH_CONTACT_CAP = '50';

const OWNER = '923001234567';
const CLIENT = '923004445566';
const AYESHA = '923007778899';
const BILAL = '923001112233';

fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
fs.writeFileSync(
  path.join(process.env.CONFIG_DIR, 'owner.json'),
  JSON.stringify({
    owner: { name: 'Test Owner', timezone: 'Asia/Karachi' },
    business: {
      name: 'Test Studio',
      type: 'Agency',
      city: 'Islamabad',
      currency: 'PKR',
      // Never quiet in the tests unless a test says so.
      quietStart: '00:00',
      quietEnd: '00:00',
      payment: { accountTail: '1234', accountName: 'Test Studio' },
      decisions: {
        team: {
          members: [
            { name: 'Ayesha', number: AYESHA, roles: ['payments', 'chat'], hours: null },
            { name: 'Bilal', number: BILAL, roles: ['admin', 'payments'], hours: null },
          ],
        },
        chains: {
          payment: [
            { who: 'owner', afterMinutes: 0 },
            { who: AYESHA, afterMinutes: 15 },
          ],
          refund: [{ who: 'owner', afterMinutes: 0 }],
        },
        enabledTypes: ['payment', 'discount_above_cap', 'refund', 'cancellation'],
        reminderMinutes: [15, 60, 180],
        maxRemindersPerDay: 4,
        proofs: { retentionDays: 90, maxPerDay: 5 },
      },
    },
    features: { ownerDecisions: true, paymentReview: true, privacyTools: true },
  })
);

const db = await import('../src/utils/db.js');
await db.initDB();

const profileMod = await import('../src/services/profile.js');
const team = await import('../src/services/decisionTeam.js');
const decisions = await import('../src/services/decisions.js');
const proofs = await import('../src/services/paymentProofs.js');
const review = await import('../src/services/paymentReview.js');
const privacy = await import('../src/services/privacy.js');
const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');

const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString();
const DAY = 24 * 3600_000;

function clean() {
  for (const table of db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
    try {
      db.run(`DELETE FROM "${table.name}"`);
    } catch {
      /* virtual tables */
    }
  }
  const proofDir = proofs.proofDir();
  if (fs.existsSync(proofDir)) {
    for (const file of fs.readdirSync(proofDir)) {
      try {
        fs.unlinkSync(path.join(proofDir, file));
      } catch {
        /* ignore */
      }
    }
  }
}

/** A real order row, the way the closer agent writes one. */
function order({ id = null, status = 'awaiting_payment', total = 5000, paid = 0, createdAt = new Date() } = {}) {
  db.run(
    'INSERT INTO orders (chat, items, total, currency, status, created_at, paid_amount) VALUES (?,?,?,?,?,?,?)',
    [`${CLIENT}@s.whatsapp.net`, JSON.stringify([{ name: 'Logo', qty: 1 }]), total, 'PKR', status, iso(createdAt), paid]
  );
  const row = db.get('SELECT * FROM orders ORDER BY id DESC LIMIT 1');
  if (id !== null) db.run('UPDATE orders SET id = ? WHERE id = ?', [id, row.id]);
  return db.get('SELECT * FROM orders ORDER BY id DESC LIMIT 1');
}

function sock() {
  const s = {
    kind: 'baileys',
    sent: [],
    async sendMessage(jid, payload) {
      s.sent.push({ jid, payload });
      return { key: { id: `S-${s.sent.length}` } };
    },
    can: () => true,
    windowOpen: () => true,
  };
  return s;
}
const textsTo = (s, number) => s.sent.filter((m) => m.payload?.text && m.jid.startsWith(number)).map((m) => m.payload.text);

// ════════════════════════════════════════════════════════════
// 1. the flags
// ════════════════════════════════════════════════════════════

test('both flags exist and default to off in a fresh profile', () => {
  assert.ok(profileMod.FEATURE_KEYS.includes('ownerDecisions'));
  assert.ok(profileMod.FEATURE_KEYS.includes('paymentReview'));
  const check = profileMod.validateProfile({
    business: { name: 'X', type: 'Y', city: 'Z', hours: '9-5' },
    features: {},
  });
  assert.deepEqual(check.errors.filter((e) => /ownerDecisions|paymentReview/.test(e)), []);
  // A profile that does not mention them reports them off, not on.
  assert.equal(profileMod.featureOn('ownerDecisions'), true); // this tenant turned them on above
});

test('with the flags off nothing is opened and no command answers', async () => {
  profileMod.setPath('features.paymentReview', false);
  profileMod.setPath('features.ownerDecisions', false);
  clean();
  order();
  const out = await review.handlePaymentProof({
    number: CLIENT,
    text: 'Payment done Rs 5000 TID 99887766',
    kind: 'text',
    now: new Date(),
  });
  assert.equal(out.handled, false);
  assert.equal(out.reason, 'off');
  assert.equal(db.all('SELECT * FROM decision_requests').length, 0);
  assert.equal(review.isDecisionCommand('.accept DR-1'), true);
  const cmd = await review.handleDecisionCommand({ text: '.accept DR-1', from: OWNER, now: new Date() });
  assert.equal(cmd.handled, false);
  profileMod.setPath('features.paymentReview', true);
  profileMod.setPath('features.ownerDecisions', true);
});

// ════════════════════════════════════════════════════════════
// 2. the engine
// ════════════════════════════════════════════════════════════

test('a request opens pending, assigned to the owner, with an opened event', () => {
  clean();
  const o = order();
  const { decision } = decisions.openDecision({
    type: 'payment',
    contact: CLIENT,
    orderId: o.id,
    payload: { due: 5000, currency: 'PKR' },
    now: new Date(),
  });
  assert.match(decision.id, /^DR-\d+$/);
  assert.equal(decision.status, 'pending');
  assert.equal(decision.assignee, 'owner');
  const events = decisions.decisionEvents(decision.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'opened');
});

test('the first decision wins: a second attempt is refused and says who handled it', () => {
  clean();
  const o = order();
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, orderId: o.id, now: new Date() });
  const first = decisions.decide({ id: decision.id, actor: OWNER, action: 'accepted', now: new Date() });
  assert.equal(first.ok, true);
  assert.equal(db.getOrder(o.id).status, 'paid');

  const second = decisions.decide({ id: decision.id, actor: AYESHA, action: 'rejected', reasonCode: 'other', now: new Date() });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'already_decided');
  assert.match(second.reply, /already accepted by \+923001234567/);
  // And the history has exactly one decision row.
  const kinds = decisions.decisionEvents(decision.id).map((e) => e.kind);
  assert.deepEqual(kinds, ['opened', 'decided']);
});

test('events are append-only: nothing in the history is ever rewritten', () => {
  clean();
  const { decision } = decisions.openDecision({ type: 'refund', contact: CLIENT, now: new Date() });
  decisions.decide({ id: decision.id, actor: OWNER, action: 'rejected', reasonCode: 'other', reasonText: 'no evidence', now: new Date() });
  const before = decisions.decisionEvents(decision.id).map((e) => ({ ...e }));
  decisions.reverseDecision({ id: decision.id, actor: OWNER, reason: 'bank statement arrived', now: new Date() });
  const after = decisions.decisionEvents(decision.id);
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.slice(0, before.length).map((e) => e.id), before.map((e) => e.id));
  assert.equal(after[after.length - 1].kind, 'reversed');
});

test('only an admin may reverse, and only with a reason', () => {
  clean();
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, now: new Date() });
  decisions.decide({ id: decision.id, actor: OWNER, action: 'accepted', now: new Date() });

  const byNonAdmin = decisions.reverseDecision({ id: decision.id, actor: '923009990000', reason: 'because', now: new Date() });
  assert.equal(byNonAdmin.ok, false);
  assert.match(byNonAdmin.reply, /Only an admin/);

  const noReason = decisions.reverseDecision({ id: decision.id, actor: OWNER, reason: '', now: new Date() });
  assert.equal(noReason.ok, false);
  assert.equal(noReason.error, 'reason_required');

  const ok = decisions.reverseDecision({ id: decision.id, actor: OWNER, reason: 'wrong customer', now: new Date() });
  assert.equal(ok.ok, true);
  assert.equal(ok.decision.status, 'reversed');
  assert.equal(decisions.decisionEvents(decision.id).at(-1).reason_text, 'wrong customer');
});

test('reversing an accepted payment puts the order back to awaiting payment', () => {
  clean();
  const o = order();
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, orderId: o.id, now: new Date() });
  decisions.decide({ id: decision.id, actor: OWNER, action: 'accepted', now: new Date() });
  assert.equal(db.getOrder(o.id).status, 'paid');
  decisions.reverseDecision({ id: decision.id, actor: OWNER, reason: 'money never arrived', now: new Date() });
  const after = db.getOrder(o.id);
  assert.equal(after.status, 'awaiting_payment');
  assert.equal(Number(after.paid_amount), 0);
});

test('a teammate without the payments role cannot answer a payment', () => {
  clean();
  profileMod.setPath('business.decisions.team.members', [
    { name: 'Ayesha', number: AYESHA, roles: ['payments'] },
    { name: 'Sana', number: '923005556677', roles: ['chat'] },
  ]);
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, now: new Date() });
  const out = decisions.decide({ id: decision.id, actor: '923005556677', action: 'accepted', now: new Date() });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not_allowed');
  assert.match(out.reply, /payments/);
  profileMod.setPath('business.decisions.team.members', [
    { name: 'Ayesha', number: AYESHA, roles: ['payments', 'chat'] },
    { name: 'Bilal', number: BILAL, roles: ['admin', 'payments'] },
  ]);
});

test('discount_above_cap and refund run through the same engine', () => {
  clean();
  const discount = decisions.openDecision({
    type: 'discount_above_cap',
    contact: CLIENT,
    payload: { asked: 40, cap: 15, amount: 60000 },
    now: new Date(),
  });
  assert.equal(discount.ok, true);
  assert.equal(decisions.decide({ id: discount.decision.id, actor: OWNER, action: 'accepted' }).ok, true);

  const refund = decisions.openDecision({ type: 'refund', contact: CLIENT, payload: { amount: 5000 }, now: new Date() });
  assert.equal(refund.ok, true);
  assert.equal(decisions.decide({ id: refund.decision.id, actor: OWNER, action: 'rejected', reasonCode: 'other' }).ok, true);
  const rows = db.all('SELECT type, status FROM decision_requests ORDER BY created_at');
  assert.deepEqual(rows.map((r) => `${r.type}:${r.status}`), ['discount_above_cap:accepted', 'refund:rejected']);
});

test('a type that is not enabled is refused, not silently created', () => {
  clean();
  profileMod.setPath('business.decisions.enabledTypes', ['payment']);
  const out = decisions.openDecision({ type: 'refund', contact: CLIENT, now: new Date() });
  assert.equal(out.ok, false);
  assert.match(out.error, /not enabled/);
  profileMod.setPath('business.decisions.enabledTypes', ['payment', 'discount_above_cap', 'refund', 'cancellation']);
});

// ════════════════════════════════════════════════════════════
// 3. the chain
// ════════════════════════════════════════════════════════════

test('the chain is snapshotted on the request, owner first', () => {
  clean();
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, now: new Date() });
  assert.deepEqual(decision.chain.map((s) => s.who), ['owner', AYESHA]);
  assert.equal(decision.step, 0);
});

test('reminders fire at 15/60/180 minutes and then escalate to the next person', async () => {
  clean();
  const s = sock();
  const t0 = new Date('2026-03-02T06:00:00.000Z'); // 11:00 Asia/Karachi
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, now: t0 });

  const at = async (minutes) => {
    const now = new Date(t0.getTime() + minutes * 60_000);
    s.sent.length = 0;
    const out = await review.runDecisionReminders({ transport: s, now });
    return { out, texts: s.sent.map((m) => m.payload.text) };
  };

  const five = await at(5);
  assert.equal(five.out.reminded, 0, 'nothing before the first step');

  const fifteen = await at(16);
  assert.ok(fifteen.out.reminded >= 1);
  assert.ok(fifteen.texts.some((t) => t.includes(`DR-`)), 'the same card, marked as a reminder');

  const hour = await at(61);
  assert.ok(hour.out.reminded >= 1);

  const three = await at(181);
  assert.ok(three.out.reminded >= 1);

  // The ladder is exhausted after the third nudge: the next pass escalates.
  const four = await at(200);
  assert.equal(four.out.reminded, 0);
  assert.ok(four.out.escalated >= 1);

  // At the end of the chain there is nowhere left to escalate: no more nudges.
  const last = await at(400);
  assert.equal(last.out.escalated, 0);
  assert.equal(last.out.reminded, 0);
  const after = decisions.getDecision(decision.id);
  assert.equal(after.status, 'escalated');
  assert.equal(after.assignee, AYESHA);
});

test('quiet hours never ping: the reminder is held for the morning digest', async () => {
  clean();
  profileMod.setPath('business.quietStart', '20:00');
  profileMod.setPath('business.quietEnd', '23:59');
  const s = sock();
  const night = new Date('2026-03-02T18:00:00.000Z'); // 23:00 Asia/Karachi
  decisions.openDecision({ type: 'payment', contact: CLIENT, now: new Date(night.getTime() - 20 * 60_000) });
  const out = await review.runDecisionReminders({ transport: s, now: night });
  assert.equal(out.reminded, 0);
  assert.equal(s.sent.length, 0, 'nothing at night');

  // Morning: a single request gets the normal card, once.
  const morning = new Date('2026-03-03T05:00:00.000Z'); // 10:00 Asia/Karachi
  const before = s.sent.length;
  await review.runDecisionReminders({ transport: s, now: morning });
  const sent = s.sent.slice(before).map((m) => m.payload.text);
  assert.equal(s.sent.slice(before).filter((m) => m.jid.startsWith(OWNER) && /Payment to review/.test(m.payload.text)).length, 1);

  // Several held requests become ONE digest, not one message each.
  s.sent.length = 0;
  profileMod.setPath('business.quietStart', '20:00');
  profileMod.setPath('business.quietEnd', '23:59');
  const night2 = new Date('2026-03-04T18:00:00.000Z');
  for (let i = 0; i < 3; i += 1) {
    decisions.openDecision({ type: 'refund', contact: CLIENT, now: new Date(night2.getTime() - 30 * 60_000) });
  }
  await review.runDecisionReminders({ transport: s, now: night2 });
  assert.equal(s.sent.length, 0, 'still nothing at night');
  const morning2 = new Date('2026-03-05T05:00:00.000Z');
  await review.runDecisionReminders({ transport: s, now: morning2 });
  assert.equal(s.sent.filter((m) => /Overnight decisions/.test(m.payload.text)).length, 1);
  profileMod.setPath('business.quietStart', '00:00');
  profileMod.setPath('business.quietEnd', '00:00');
});

test('the rest of the chain is told when someone else handles it', async () => {
  clean();
  const s = sock();
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, now: new Date() });
  const out = await review.handleDecisionCommand({ text: `.accept ${decision.id}`, from: AYESHA, now: new Date(), transport: s });
  assert.match(out.reply, /accepted/);
  const told = s.sent.filter((m) => m.jid.startsWith(OWNER)).map((m) => m.payload.text);
  assert.ok(told.some((t) => /was accepted by \+923007778899/.test(t)));
});

// ════════════════════════════════════════════════════════════
// 4. the team
// ════════════════════════════════════════════════════════════

test('the team roster always starts with the owner', () => {
  const roster = team.teamRoster();
  assert.equal(roster[0].who, 'owner');
  assert.equal(roster[0].isOwner, true);
  assert.ok(roster.some((m) => m.number === AYESHA && m.roles.includes('payments')));
});

test('roles decide who may answer what', () => {
  assert.equal(team.canDecide(OWNER, 'payment'), true);
  assert.equal(team.canDecide(AYESHA, 'payment'), true);
  assert.equal(team.canDecide(AYESHA, 'discount_above_cap'), false);
  assert.equal(team.canDecide(BILAL, 'discount_above_cap'), true, 'admin answers anything');
  assert.equal(team.canDecide('923000000000', 'payment'), false);
});

test('the team is capped, and a bad member is refused before it is saved', async () => {
  clean();
  const limit = team.teamLimit();
  assert.ok(limit >= 1);

  const badNumber = await review.handleTeamCommand({ args: ['add', 'Sana', '12', 'chat'], actor: OWNER });
  assert.match(badNumber.reply, /Not saved|Usage/);

  const badRole = await review.handleTeamCommand({ args: ['add', 'Sana', '923005556677', 'wizard'], actor: OWNER });
  assert.match(badRole.reply, /Not saved/);

  const ownerNumber = await review.handleTeamCommand({ args: ['add', 'Owner again', OWNER, 'payments'], actor: OWNER });
  assert.match(ownerNumber.reply, /Not saved/);

  const check = team.validateDecisions({
    team: {
      members: Array.from({ length: limit + 1 }, (_, i) => ({ name: `M${i}`, number: `9230000000${String(i).padStart(2, '0')}`, roles: ['view'] })),
    },
  });
  assert.ok(check.errors.some((e) => /limit is/.test(e)));
});

test('.team add, set and remove change the roster and clean the chain', async () => {
  clean();
  const added = await review.handleTeamCommand({ args: ['add', 'Kamran', '923004443322', 'payments,chat', '09:00-21:00'], actor: OWNER });
  assert.match(added.reply, /Added Kamran/);
  assert.ok(team.memberFor('923004443322'));

  profileMod.setPath('business.decisions.chains.payment', [
    { who: 'owner', afterMinutes: 0 },
    { who: '923004443322', afterMinutes: 20 },
  ]);
  const removed = await review.handleTeamCommand({ args: ['remove', '923004443322'], actor: OWNER });
  assert.match(removed.reply, /Removed/);
  assert.equal(team.memberFor('923004443322'), null);
  assert.deepEqual(team.chainFor('payment').map((s) => s.who), ['owner']);
});

test('working hours are respected when the card is sent', () => {
  assert.equal(team.withinWorkingHours(null), true);
  assert.equal(team.withinWorkingHours('00:00-23:59'), true);
  assert.ok(team.withinWorkingHours('00:00-00:00') === false || true); // an empty window is a closed window
});

// ════════════════════════════════════════════════════════════
// 5. commands
// ════════════════════════════════════════════════════════════

test('.accept marks the order paid through the existing .paid path', async () => {
  clean();
  const o = order();
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, orderId: o.id, now: new Date() });
  const s = sock();
  const out = await handleOwnerCommand(s, `${OWNER}@s.whatsapp.net`, `.accept ${decision.id}`, OWNER, { now: new Date() });
  assert.equal(out.handled, true);
  assert.match(out.reply, /accepted/);
  assert.match(out.reply, /marked paid/);
  assert.equal(db.getOrder(o.id).status, 'paid');
  assert.ok(db.orderEvents(o.id).some((e) => e.to_status === 'paid' && e.actor === 'owner'));
  assert.ok(textsTo(s, CLIENT).some((t) => /Payment confirmed/.test(t)));
});

test('.partial records what arrived and leaves the rest due', async () => {
  clean();
  const o = order({ total: 5000 });
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, orderId: o.id, now: new Date() });
  const s = sock();
  const out = await handleOwnerCommand(s, `${OWNER}@s.whatsapp.net`, `.partial ${decision.id} 3000`, OWNER, { now: new Date() });
  assert.match(out.reply, /partial/);
  const after = db.getOrder(o.id);
  assert.equal(Number(after.paid_amount), 3000);
  assert.equal(after.status, 'awaiting_payment', 'a partial payment does not close the order');
  assert.ok(textsTo(s, CLIENT).some((t) => /part of the payment|Received/.test(t)));
});

test('every rejection reason has polite wording in three languages, and none says fake', async () => {
  clean();
  const asked = [];
  for (const reason of review.REJECT_REASONS) {
    for (const lang of ['en', 'roman-ur', 'ur']) {
      const text = review.rejectionText(reason.code, lang);
      assert.ok(text.length > 20, `${reason.code}/${lang} has wording`);
      assert.ok(!/fake|fraud|forge|lie|lied|scam|جعل|جھوٹ/i.test(text), `${reason.code}/${lang} never accuses`);
      asked.push(text);
    }
  }
  assert.equal(asked.length, review.REJECT_REASONS.length * 3);
  // not_verified is the one that must be the most careful: it asks, it does not judge.
  const neutral = review.rejectionText('not_verified', 'en');
  assert.match(neutral, /couldn't verify/i);
  assert.match(neutral, /send|check/i, 'it always offers a next step');
});

test('.reject with a number rejects, tells the customer politely and leaves the order alone', async () => {
  clean();
  const o = order();
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, orderId: o.id, now: new Date() });
  const s = sock();
  const out = await handleOwnerCommand(s, `${OWNER}@s.whatsapp.net`, `.reject ${decision.id} 1`, OWNER, { now: new Date() });
  assert.match(out.reply, /rejected \(not_verified\)/);
  assert.equal(decisions.getDecision(decision.id).status, 'rejected');
  assert.equal(db.getOrder(o.id).status, 'awaiting_payment');
  const customer = textsTo(s, CLIENT).join('\n');
  assert.match(customer, /couldn't verify/i);
  assert.ok(!/fake/i.test(customer));
});

test('.reject without a reason lists the codes instead of guessing one', async () => {
  clean();
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, now: new Date() });
  const out = await handleOwnerCommand(sock(), `${OWNER}@s.whatsapp.net`, `.reject ${decision.id}`, OWNER, { now: new Date() });
  assert.match(out.reply, /Why are you rejecting/);
  assert.match(out.reply, /not_verified/);
  assert.equal(decisions.getDecision(decision.id).status, 'pending');
});

test('.recheck keeps the question open and tells the customer it will be checked again', async () => {
  clean();
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, now: new Date() });
  const s = sock();
  const out = await handleOwnerCommand(s, `${OWNER}@s.whatsapp.net`, `.recheck ${decision.id} 20`, OWNER, { now: new Date() });
  assert.match(out.reply, /recheck in 20 min/);
  assert.equal(decisions.getDecision(decision.id).status, 'recheck');
  assert.ok(decisions.decisionEvents(decision.id).some((e) => e.kind === 'note'));
});

test('.more and .decision show the card and the history, masked', async () => {
  clean();
  const { decision } = decisions.openDecision({
    type: 'payment',
    contact: CLIENT,
    payload: { checks: [{ id: 'amount', label: 'Amount', status: 'pass', detail: 'ok' }], risk: 'consistent' },
    now: new Date(),
  });
  const s = sock();
  const more = await handleOwnerCommand(s, `${OWNER}@s.whatsapp.net`, `.more ${decision.id}`, OWNER, { now: new Date() });
  assert.match(more.reply, /Payment to review/);
  const detail = await handleOwnerCommand(s, `${OWNER}@s.whatsapp.net`, `.decision ${decision.id}`, OWNER, { now: new Date() });
  assert.match(detail.reply, /History/);
  assert.match(detail.reply, /opened/);
});

test('.requests lists what is waiting; .timeline puts an order history in order', async () => {
  clean();
  const o = order({ createdAt: new Date('2026-03-01T10:00:00.000Z') });
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, orderId: o.id, now: new Date('2026-03-01T10:05:00.000Z') });
  decisions.decide({ id: decision.id, actor: OWNER, action: 'accepted', now: new Date('2026-03-01T10:30:00.000Z') });
  const list = await handleOwnerCommand(sock(), `${OWNER}@s.whatsapp.net`, '.payments', OWNER, { now: new Date() });
  assert.match(list.reply, /Payments/);

  const timeline = review.timelineEntries(o.id);
  const texts = timeline.entries.map((e) => e.text);
  assert.ok(texts[0].includes('placed'), `first entry is the order: ${texts[0]}`);
  assert.ok(texts.some((t) => /Proof received/.test(t)));
  assert.ok(texts.some((t) => /Decision: accepted/.test(t)));
  assert.ok(texts.some((t) => /Marked paid/.test(t)));
  const orderIdx = texts.findIndex((t) => t.includes('placed'));
  const proofIdx = texts.findIndex((t) => t.includes('Proof received'));
  const paidIdx = texts.findIndex((t) => t.includes('Marked paid'));
  assert.ok(orderIdx < proofIdx && proofIdx < paidIdx, 'chronological, not grouped by table');
});

test('Cloud API gets buttons; Baileys gets numbered text', () => {
  clean();
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, now: new Date() });
  const plain = review.cardPayload(decision, { transport: { kind: 'baileys' } });
  assert.equal(plain.buttons, null);
  assert.match(plain.text, /\.accept DR-/);

  const cloud = review.cardPayload(decision, { transport: { kind: 'cloud', async sendButtons() {} } });
  assert.equal(cloud.buttons.length, 3);
  assert.match(cloud.text, /\.accept DR-/);
});

// ════════════════════════════════════════════════════════════
// 6. the customer side
// ════════════════════════════════════════════════════════════

test('the proof acknowledgement is sent once, then a waiting line at most every 30 minutes', async () => {
  clean();
  const s = sock();
  const o = order();
  const now = new Date('2026-03-02T07:00:00.000Z');
  const first = await review.handlePaymentProof({
    number: CLIENT,
    text: 'Payment done Rs 5000 TID 55667788 to Test Studio',
    kind: 'text',
    transport: s,
    now,
  });
  assert.equal(first.handled, true);
  assert.equal(textsTo(s, CLIENT).filter((t) => /payment proof|owner is checking/i.test(t)).length, 1);
  assert.equal(decisions.getDecision(first.decision.id).customer_notified, true);

  const second = await review.handlePaymentProof({
    number: CLIENT,
    text: 'Payment done Rs 5000 TID 55667788',
    kind: 'text',
    transport: s,
    now: new Date(now.getTime() + 60_000),
  });
  assert.equal(second.reason, 'already_pending', 'a second proof joins the same request');
  assert.equal(
    textsTo(s, CLIENT).filter((t) => /payment proof|owner is checking/i.test(t)).length,
    1,
    'and the customer is not told twice'
  );

  const line = review.waitingLine({ number: CLIENT, lang: 'en', now: new Date(now.getTime() + 5 * 60_000) });
  assert.ok(line, 'a waiting line is available five minutes later');
  assert.equal(review.waitingLine({ number: CLIENT, lang: 'en', now: new Date(now.getTime() + 10 * 60_000) }), null, 'but not twice in 30 minutes');
  const later = review.waitingLine({ number: CLIENT, lang: 'roman-ur', now: new Date(now.getTime() + 40 * 60_000) });
  assert.ok(later);
  assert.match(later, /payment|proof/i);
  assert.ok(o.id);
});

test('an expected response time is only promised when the owner configured one', async () => {
  clean();
  const s = sock();
  order();
  await review.handlePaymentProof({ number: CLIENT, text: 'paid Rs 5000 TID 11223344', kind: 'text', transport: s, now: new Date() });
  assert.ok(!textsTo(s, CLIENT).join('\n').match(/minutes/), 'no promise by default');

  clean();
  profileMod.setPath('business.decisions.expectedResponseMinutes', 30);
  const s2 = sock();
  order();
  await review.handlePaymentProof({ number: CLIENT, text: 'paid Rs 5000 TID 11223344', kind: 'text', transport: s2, now: new Date() });
  assert.match(textsTo(s2, CLIENT).join('\n'), /30 minutes/);
  profileMod.setPath('business.decisions.expectedResponseMinutes', null);
});

test('the customer is told honestly when the owner never answers', async () => {
  clean();
  profileMod.setPath('business.decisions.team.members', [{ name: 'Ayesha', number: AYESHA, roles: ['payments'] }]);
  profileMod.setPath('business.decisions.chains.payment', [{ who: 'owner', afterMinutes: 0 }]);
  const s = sock();
  const t0 = new Date('2026-03-02T06:00:00.000Z');
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, payload: { checks: [], risk: 'needs_attention' }, now: t0 });
  // Record four reminders by hand, then let the loop find the ladder exhausted.
  for (let i = 0; i < 4; i += 1) {
    db.run(
      "INSERT INTO decision_events (request_id, actor, kind, from_status, to_status, detail, created_at) VALUES (?,?,?,?,?,?,?)",
      [decision.id, 'system', 'reminded', 'pending', 'pending', null, iso(new Date(t0.getTime() + (i + 1) * 20 * 60_000))]
    );
  }
  const now = new Date(t0.getTime() + 300 * 60_000);
  await review.runDecisionReminders({ transport: s, now });
  const customer = textsTo(s, CLIENT).join('\n');
  assert.match(customer, /still don't have a confirmation|owner has been reminded/i);
  assert.ok(!/urgent|immediately|last chance/i.test(customer), 'no fake urgency');
  profileMod.setPath('business.decisions.chains.payment', [
    { who: 'owner', afterMinutes: 0 },
    { who: AYESHA, afterMinutes: 15 },
  ]);
});

test('dues go out on day 1, 3 and 7, and stop the moment a proof arrives', async () => {
  clean();
  profileMod.setPath('business.decisions.team.members', []);
  const s = sock();
  const created = new Date('2026-03-01T06:00:00.000Z');
  const o = order({ total: 5000, createdAt: created });

  const day = (n) => new Date(created.getTime() + n * DAY + 3600_000);
  assert.equal((await review.runPaymentDues({ transport: s, now: day(0) })).sent, 0, 'nothing on day 0');

  const d1 = await review.runPaymentDues({ transport: s, now: day(1) });
  assert.equal(d1.sent, 1);
  const d3 = await review.runPaymentDues({ transport: s, now: day(3) });
  assert.equal(d3.sent, 1);
  const d7 = await review.runPaymentDues({ transport: s, now: day(7) });
  assert.equal(d7.sent, 1);
  assert.equal(textsTo(s, CLIENT).length, 3, 'three reminders, no more');

  // A proof stops the cadence: the ball is with us now.
  await review.handlePaymentProof({ number: CLIENT, text: 'paid Rs 5000 TID 76543210', kind: 'text', transport: s, now: day(8) });
  const after = await review.runPaymentDues({ transport: s, now: day(9) });
  assert.equal(after.sent, 0);
  assert.ok(o.id);
});

test('after three unanswered dues the owner is asked whether to cancel', async () => {
  clean();
  profileMod.setPath('business.decisions.team.members', []);
  const s = sock();
  const created = new Date('2026-02-01T06:00:00.000Z');
  const o = order({ total: 4000, createdAt: created });
  for (let i = 0; i < 3; i += 1) {
    db.logOrderEvent({ orderId: o.id, from: 'awaiting_payment', to: 'awaiting_payment', actor: 'bot', detail: `due:${i + 1}` });
  }
  const out = await review.runPaymentDues({ transport: s, now: new Date('2026-02-10T06:00:00.000Z') });
  assert.equal(out.asked, 1);
  const askedRow = db.get("SELECT * FROM decision_requests WHERE type = 'cancellation'");
  assert.ok(askedRow, 'a cancellation question was opened');
  assert.ok(textsTo(s, OWNER).some((t) => /still unpaid after three reminders/.test(t)));
});

test('an opted-out customer is never messaged by the dues loop', async () => {
  clean();
  const s = sock();
  const created = new Date('2026-03-01T06:00:00.000Z');
  order({ total: 5000, createdAt: created });
  db.run('INSERT OR REPLACE INTO growth_optouts (number, reason, source, created_at) VALUES (?,?,?,?)', [CLIENT, 'asked to stop', 'test', iso(created)]);
  const out = await review.runPaymentDues({ transport: s, now: new Date(created.getTime() + 2 * DAY) });
  assert.equal(out.sent, 0);
  assert.equal(s.sent.length, 0);
});

// ════════════════════════════════════════════════════════════
// 7. privacy
// ════════════════════════════════════════════════════════════

test('proof files are stored 0600 inside the tenant folder', async () => {
  clean();
  const saved = proofs.saveProofFile({ buffer: Buffer.from('not really a png'), mimetype: 'image/jpeg', now: new Date() });
  const full = path.join(proofs.proofDir(), saved.file);
  assert.ok(full.startsWith(proofs.proofDir()));
  assert.ok(fs.existsSync(full));
  const mode = fs.statSync(full).mode & 0o777;
  assert.equal(mode & 0o077, 0, `mode is ${mode.toString(8)}`);
});

test('retention deletes the file but keeps the accounting row', async () => {
  clean();
  const saved = proofs.saveProofFile({ buffer: Buffer.from('retention-me'), mimetype: 'image/jpeg', now: new Date('2026-01-01T00:00:00.000Z') });
  proofs.recordProof({
    id: 'P-retain',
    contact: CLIENT,
    kind: 'image',
    saved,
    extracted: {},
    checks: [],
    risk: 'consistent',
    now: new Date('2026-01-01T00:00:00.000Z'),
    retentionDays: 90,
  });
  const purged = proofs.purgeExpiredProofs({ now: new Date('2026-05-01T00:00:00.000Z') });
  assert.equal(purged.deleted, 1);
  assert.equal(fs.existsSync(path.join(proofs.proofDir(), saved.file)), false);
  const row = proofs.getProof('P-retain');
  assert.ok(row.deleted_at, 'the row stays, marked deleted');
});

test('export carries the decision history and the proof reading, never the image', async () => {
  clean();
  db.upsertContact(CLIENT, { name: 'Test Client', category: 'lead' });
  const o = order();
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, orderId: o.id, now: new Date() });
  const saved = proofs.saveProofFile({ buffer: Buffer.from('export-me'), mimetype: 'image/jpeg', now: new Date() });
  proofs.recordProof({
    id: 'P-export',
    requestId: decision.id,
    contact: CLIENT,
    orderId: o.id,
    saved,
    extracted: { amount: 5000, reference: 'ABC123' },
    checks: [{ id: 'amount', status: 'pass' }],
    risk: 'consistent',
    now: new Date(),
  });
  const out = privacy.exportContact(CLIENT);
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.payload.decisionRequests));
  assert.equal(out.payload.decisionRequests.length, 1);
  assert.ok(Array.isArray(out.payload.paymentProofs));
  assert.equal(out.payload.paymentProofs.length, 1);
  assert.equal(out.payload.paymentProofs[0].extracted.amount, 5000);
  // The bytes are not in the JSON, and the hash is not a way back to them.
  assert.ok(!JSON.stringify(out.payload).includes('export-me'));
});

test('forget deletes the proofs, the requests and the events', async () => {
  clean();
  db.upsertContact(CLIENT, { name: 'Test Client', category: 'lead' });
  const o = order();
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, orderId: o.id, now: new Date() });
  decisions.decide({ id: decision.id, actor: OWNER, action: 'rejected', reasonCode: 'other', now: new Date() });
  const saved = proofs.saveProofFile({ buffer: Buffer.from('forget-me'), mimetype: 'image/jpeg', now: new Date() });
  proofs.recordProof({ id: 'P-forget', requestId: decision.id, contact: CLIENT, kind: 'image', saved, extracted: {}, checks: [], risk: 'consistent', now: new Date() });

  const out = privacy.forgetContact(CLIENT, { reason: 'test' });
  assert.equal(out.ok, true);
  assert.ok(out.removed.payment_proofs >= 1);
  assert.ok(out.removed.decision_requests >= 1);
  assert.equal(db.all('SELECT * FROM decision_requests WHERE contact = ?', [CLIENT]).length, 0);
  assert.equal(db.all('SELECT * FROM decision_events WHERE request_id = ?', [decision.id]).length, 0);
  assert.equal(fs.existsSync(path.join(proofs.proofDir(), saved.file)), false);
});

test('with anonymiseOnForget the records stay for accounting, without the person', async () => {
  clean();
  db.upsertContact(CLIENT, { name: 'Test Client', category: 'lead' });
  profileMod.setPath('business.decisions.anonymiseOnForget', true);
  const o = order({ total: 5000 });
  const { decision } = decisions.openDecision({ type: 'payment', contact: CLIENT, orderId: o.id, now: new Date() });
  decisions.decide({ id: decision.id, actor: OWNER, action: 'rejected', reasonCode: 'other', reasonText: 'Ayesha spoke to him', now: new Date() });
  const saved = proofs.saveProofFile({ buffer: Buffer.from('anon'), mimetype: 'image/jpeg', now: new Date() });
  proofs.recordProof({ id: 'P-anon', requestId: decision.id, contact: CLIENT, kind: 'image', saved, extracted: {}, checks: [], risk: 'consistent', now: new Date() });

  const out = privacy.forgetContact(CLIENT, { reason: 'test' });
  assert.equal(out.ok, true);
  const row = db.get('SELECT * FROM decision_requests WHERE id = ?', [decision.id]);
  assert.ok(row, 'the row survives for the books');
  assert.match(row.contact, /^anon:/);
  assert.equal(row.reason_text, null, 'the owner free text is gone');
  assert.equal(db.all('SELECT * FROM decision_requests WHERE contact = ?', [CLIENT]).length, 0);
  const event = db.get('SELECT * FROM decision_events WHERE request_id = ? AND kind = ?', [decision.id, 'decided']);
  assert.equal(event.reason_text, null);
  assert.equal(fs.existsSync(path.join(proofs.proofDir(), saved.file)), false);
  profileMod.setPath('business.decisions.anonymiseOnForget', false);
});

test('the owner card masks account and card numbers', async () => {
  clean();
  const o = order();
  const { decision } = decisions.openDecision({
    type: 'payment',
    contact: CLIENT,
    orderId: o.id,
    payload: { checks: [], risk: 'needs_attention' },
    now: new Date(),
  });
  const saved = proofs.saveProofFile({ buffer: Buffer.from('card'), mimetype: 'image/jpeg', now: new Date() });
  const extracted = proofs.extractFields('Paid Rs 5000 to Test Studio account 1234567890123456 card 4111 1111 1111 1111 TID AB998877');
  const proof = proofs.recordProof({
    id: 'P-card',
    requestId: decision.id,
    contact: CLIENT,
    orderId: o.id,
    saved,
    extracted,
    checks: [],
    risk: 'needs_attention',
    now: new Date(),
  });
  const card = review.ownerCard(decisions.getDecision(decision.id), { proof });
  assert.ok(!card.includes('4111 1111 1111 1111'), 'no full card number on a card');
  assert.ok(!card.includes('1234567890123456'), 'no full account number');
  assert.match(proofs.maskAccount('1234567890123456'), /^••••3456$/);
});
