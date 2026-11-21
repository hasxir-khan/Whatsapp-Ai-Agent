// test/60-accuracy-review.test.js
// `.accuracy` (metrics from the event log, nothing invented) and `.review`
// (thumbs on real replies → a draft golden scenario).
//
// No network, no model: every row here is written directly to the database and
// every number is an assertion about what the event log can and cannot say.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isolate } from './helpers.js';

const dataDir = isolate('accuracy-review');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
process.env.DATA_DIR = path.join(dataDir, 'data');
process.env.ENABLE_WEB = 'false';

const db = await import('../src/utils/db.js');
await db.initDB();
const A = await import('../src/services/accuracy.js');
const R = await import('../src/services/reviewQueue.js');
const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');

const OWNER = '923001234567';
const OWNER_JID = `${OWNER}@s.whatsapp.net`;
const CUSTOMER = '923008887776';

function clean() {
  for (const t of ['events', 'messages', 'contacts', 'reply_reviews']) {
    try {
      db.run(`DELETE FROM ${t}`);
    } catch {
      /* reply_reviews may not exist yet */
    }
  }
  // Drafts live on disk, so a test that forgets them would leak into the next.
  fs.rmSync(path.join(process.env.DATA_DIR, 'golden-drafts'), { recursive: true, force: true });
}

function guardRejected(problems) {
  db.logEvent('reply_guard_rejected', CUSTOMER, { problems });
}

// ── .accuracy ───────────────────────────────────────────────
test('.accuracy counts only what the event log actually recorded', async () => {
  clean();
  const empty = A.accuracyReport({ days: 7 });
  assert.equal(empty.metrics.find((m) => m.key === 'priceMismatch').count, 0);
  assert.equal(empty.notInstrumented, 2, 'owner edits and owner corrections have no source yet');

  // One price/number problem, one language problem, one cut.
  guardRejected(['price range changed from 25000–75000 to 12000–35000']);
  guardRejected(['language: expected roman-ur, got en']);
  guardRejected(['cut off: ends on a comma']);
  db.logEvent('duplicate_reply_blocked', CUSTOMER, { label: 'reply' });
  db.logEvent('handoff', CUSTOMER, { minutes: 30 });
  db.logEvent('bot_disclosure', CUSTOMER, { lang: 'en' });
  db.logEvent('inbox_reply', CUSTOMER, { chars: 42, handoff: null });
  db.logEvent('reply_cut_detected', CUSTOMER, { reason: 'comma', provider: 'groq', model: 'gpt-oss-120b' });

  const report = A.accuracyReport({ days: 7 });
  const m = Object.fromEntries(report.metrics.map((x) => [x.key, x]));
  assert.equal(m.priceMismatch.count, 1);
  assert.equal(m.priceMismatch.target, 0);
  assert.equal(m.priceMismatch.red, true, 'anything above zero is red');
  assert.equal(m.wrongLanguage.count, 1);
  assert.equal(m.midSentenceCuts.count, 2, 'the guard problem and the timeline event both count');
  assert.equal(m.doubleRepliesBlocked.count, 1);
  assert.equal(m.handoffs.count, 1);
  assert.equal(m.botHonesty.count, 1);
  assert.equal(m.ownerReplies.count, 1);
  assert.equal(m.ownerEdits.status, 'not_instrumented');
  assert.equal(m.ownerEdits.count, 0, 'unknown is not a number measured as zero');
});

test('.accuracy: a clean week is green, and the text says so', async () => {
  clean();
  db.logEvent('reply_sent', CUSTOMER, { label: 'reply' });
  const report = A.accuracyReport({ days: 7 });
  assert.equal(report.metrics.some((m) => m.red), false);
  const text = A.accuracyText(report);
  assert.match(text, /Nothing above its target/);
  assert.match(text, /not instrumented yet/);
  assert.match(text, /target 0/, 'the zero targets are named');
});

test('.accuracy: per-provider breakdown comes from reply_timeline', async () => {
  clean();
  db.logEvent('reply_timeline', CUSTOMER, { totalMs: 7400, provider: 'groq/openai/gpt-oss-120b', model: 'gpt-oss-120b' });
  db.logEvent('reply_timeline', CUSTOMER, { totalMs: 8600, provider: 'groq/openai/gpt-oss-120b', model: 'gpt-oss-120b' });
  db.logEvent('reply_timeline', CUSTOMER, { totalMs: 5000, provider: 'gemini/gemini-2.0-flash' });

  const report = A.accuracyReport({ days: 7 });
  assert.equal(report.providers.length, 2);
  assert.equal(report.providers[0].provider, 'groq/openai/gpt-oss-120b');
  assert.equal(report.providers[0].replies, 2);
  assert.equal(report.providers[0].avgSeconds, 8);
});

test('.accuracy: the weekly trend buckets by ISO week', async () => {
  clean();
  const now = new Date('2026-11-17T12:00:00.000Z');
  const weeks = [now, new Date(now.getTime() - 7 * 86400000)];
  for (const when of weeks) {
    db.run("INSERT INTO events (type, number, detail, created_at) VALUES ('reply_sent', ?, '{}', ?)", [CUSTOMER, when.toISOString()]);
    db.run("INSERT INTO events (type, number, detail, created_at) VALUES ('handoff', ?, '{}', ?)", [CUSTOMER, when.toISOString()]);
  }
  const report = A.accuracyReport({ days: 30, now, weeks: 4 });
  assert.equal(report.weekly.length, 2, 'two distinct weeks');
  assert.ok(report.weekly.every((w) => /^\d{4}-W\d{2}$/.test(w.week)));
  assert.ok(report.weekly.every((w) => w.replies === 1 && w.handoffs === 1));
});

test('.accuracy is an owner command and the card renders the same numbers', async () => {
  clean();
  guardRejected(['number "9999" is not in the catalogue, policies, orders or this chat']);
  const res = await handleOwnerCommand(null, OWNER_JID, '.accuracy');
  assert.equal(res.handled, true);
  assert.match(res.reply, /Accuracy — last 7 days/);
  assert.match(res.reply, /Price \/ number claims the guard caught: \*1\*/);
  assert.match(res.reply, /🔴/);

  const report = A.accuracyReport({ days: 7 });
  const html = A.accuracySection(report);
  assert.match(html, /<h2>Accuracy<\/h2>/);
  assert.match(html, /c0392b/, 'the red line is red in the card too');
  assert.match(html, /not instrumented yet/);
});

// ── .review ─────────────────────────────────────────────────
function seedReplies(n = 3) {
  clean();
  db.upsertContact(CUSTOMER, { jid: `${CUSTOMER}@s.whatsapp.net`, name: 'Ayesha' });
  db.saveMessage(CUSTOMER, 'user', 'Do you deliver to F-11?');
  for (let i = 1; i <= n; i += 1) {
    db.saveMessage(CUSTOMER, 'assistant', `Reply number ${i}: we deliver within 5 km.`);
  }
  return R.recentReplies({ limit: n });
}

test('.review lists the last replies, newest first', async () => {
  const replies = seedReplies(3);
  assert.equal(replies.length, 3);
  assert.match(replies[0].text, /Reply number 3/, 'newest first');
  assert.equal(replies[0].vote, null);

  const res = await handleOwnerCommand(null, OWNER_JID, '.review');
  assert.match(res.reply, /Review the last 3 replies/);
  assert.match(res.reply, /Reply number 3/);
  assert.match(res.reply, /\.review up <n>/);
  assert.doesNotMatch(res.reply, new RegExp(CUSTOMER), 'the list does not print phone numbers');
});

test('.review up records a vote and makes no draft', async () => {
  const replies = seedReplies(3);
  const res = await handleOwnerCommand(null, OWNER_JID, '.review up 1');
  assert.match(res.reply, /👍 Reply #1 marked good/);
  const after = R.recentReplies({ limit: 3 });
  assert.equal(after.find((r) => r.id === replies[0].id).vote, 'up');
  assert.equal(R.listDrafts().length, 0);
});

test('.review down writes an anonymised draft, never a golden', async () => {
  seedReplies(2);
  const res = await handleOwnerCommand(null, OWNER_JID, '.review down 1 the price was wrong');
  assert.match(res.reply, /👎 Reply #1 marked wrong/);
  assert.match(res.reply, /It is a draft, not a golden/);

  const drafts = R.listDrafts();
  assert.equal(drafts.length, 1);
  const draft = drafts[0].draft;
  assert.equal(draft._draft, true);
  assert.match(draft._needs, /recorded model turns/);
  assert.equal(draft.turns[0].user, 'Do you deliver to F-11?');
  assert.equal(draft.assert.oneReplyPerTurn, true);
  assert.equal(draft.assert.noMidSentence, true);

  // The number is replaced; the wording is not.
  assert.doesNotMatch(JSON.stringify(draft), new RegExp(CUSTOMER));
  assert.match(draft.notes.join(' '), /price was wrong/);

  // It is written under data/, so the eval (test/golden/*.json) cannot see it.
  assert.ok(drafts[0].file.includes(path.join('data', 'golden-drafts')), drafts[0].file);
  assert.ok(!drafts[0].file.includes(path.join('test', 'golden')), 'never inside the golden directory');
});

test('.review approve moves the draft out of data/ and says what is still missing', async () => {
  seedReplies(1);
  await handleOwnerCommand(null, OWNER_JID, '.review down 1');
  const id = R.listDrafts()[0].id;

  const root = fs.mkdtempSync(path.join(dataDir, 'approve-'));
  const ok = R.approveDraft(id, { root });
  assert.equal(ok.ok, true);
  assert.equal(ok.file, path.join('test', 'golden-drafts', `${id}.json`));
  assert.match(ok.next, /still a draft/);
  assert.ok(fs.existsSync(path.join(root, ok.file)));

  const approved = JSON.parse(fs.readFileSync(path.join(root, ok.file), 'utf8'));
  assert.equal(approved._draft, true, 'approval keeps the draft marker until turns are recorded');
  assert.equal(R.listDrafts().length, 0, 'the data/ copy is gone');

  const missing = R.approveDraft('review-nope', { root });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'no_such_draft');
});

test('anonymise() replaces numbers and leaves the sentence alone', () => {
  const text = `Call me on ${CUSTOMER} or +92 300 888 7776 — the karahi was cold.`;
  const out = R.anonymise(text, { number: CUSTOMER });
  assert.doesNotMatch(out, new RegExp(CUSTOMER));
  assert.doesNotMatch(out, /\+92 300 888 7776/);
  assert.match(out, /karahi was cold/);
  assert.ok(out.includes(R.FAKE_NUMBER));
});
