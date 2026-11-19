// src/services/reviewQueue.js
// `.review` — the last few bot replies, thumbs up or down, and what happens to a
// thumbs-down.
//
// The point is a feedback loop that costs the owner one word: a wrong reply
// becomes a *draft* golden scenario instead of a complaint nobody writes down.
//
// Two deliberate limits:
//   • a draft is not a golden. A golden needs recorded model turns (`expect`), so
//     a draft lands in `test/golden-drafts/` — a folder the eval never loads —
//     and says what it still needs. Nothing pretends to be runnable.
//   • the customer's number is replaced with the project's fake number and the
//     message text is kept (it is the test). Names inside the text are NOT
//     scrubbed — that would break the very wording the test exists for. The
//     draft says so in `_scrubbing`.

import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config/env.js';
import { all, get, run } from '../utils/db.js';

/** The number every test and fixture in this repo uses. */
export const FAKE_NUMBER = '923001234567';

const DRAFT_DIR = () => path.join(config.paths.data, 'golden-drafts');

let tableChecked = false;

/**
 * The table lives in the schema (src/utils/db.js). This only covers a database
 * created before this feature existed — and it must NOT call initDB(), which
 * reloads from disk and would throw away rows a test (or a boot) just wrote.
 */
function ensureTable() {
  if (tableChecked) return;
  try {
    run(
      `CREATE TABLE IF NOT EXISTS reply_reviews (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         message_id  INTEGER,
         number      TEXT,
         vote        TEXT,
         note        TEXT,
         created_at  TEXT
       )`
    );
    run('CREATE INDEX IF NOT EXISTS idx_reply_reviews_message ON reply_reviews(message_id)');
    tableChecked = true;
  } catch {
    /* a read-only or not-yet-open database: the caller gets an empty list */
  }
}

/** Replace anything that looks like a phone number with the fake one. */
export function anonymise(text, { number = null, fake = FAKE_NUMBER } = {}) {
  let out = String(text ?? '');
  if (number) out = out.split(number).join(fake);
  out = out.replace(/\+\d[\d\s-]{7,}\d/g, `+${fake}`);
  out = out.replace(/\b\d{10,15}\b/g, fake);
  return out;
}

/** The last `limit` replies the bot sent, newest first, with any vote on them. */
export function recentReplies({ limit = 5 } = {}) {
  ensureTable();
  const n = Math.max(1, Math.min(20, Number(limit) || 5));
  const rows = all(
    `SELECT id, number, content, created_at FROM messages
     WHERE role = 'assistant' AND content IS NOT NULL AND content != ''
     ORDER BY id DESC LIMIT ?`,
    [n]
  );
  return rows.map((row) => {
    const vote = get('SELECT vote, note, created_at FROM reply_reviews WHERE message_id = ? ORDER BY id DESC LIMIT 1', [row.id]);
    return {
      id: row.id,
      number: row.number,
      text: row.content,
      at: row.created_at,
      vote: vote?.vote || null,
    };
  });
}

/** Thumbs. One vote per message: a second vote replaces the first. */
export function recordVote({ messageId, vote, note = null, now = new Date() } = {}) {
  ensureTable();
  const id = Number(messageId);
  if (!Number.isInteger(id)) return { ok: false, error: 'unknown_reply' };
  if (!['up', 'down'].includes(vote)) return { ok: false, error: 'vote_must_be_up_or_down' };

  const row = get('SELECT id, number, content FROM messages WHERE id = ? AND role = ?', [id, 'assistant']);
  if (!row) return { ok: false, error: 'unknown_reply' };

  const existing = get('SELECT id FROM reply_reviews WHERE message_id = ? ORDER BY id DESC LIMIT 1', [id]);
  if (existing) {
    run('UPDATE reply_reviews SET vote = ?, note = ?, created_at = ? WHERE id = ?', [
      vote,
      note,
      now.toISOString(),
      existing.id,
    ]);
  } else {
    run('INSERT INTO reply_reviews (message_id, number, vote, note, created_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      row.number,
      vote,
      note,
      now.toISOString(),
    ]);
  }

  let draft = null;
  if (vote === 'down') draft = writeDraft({ message: row, note, now });
  return { ok: true, vote, draft };
}

/** The scenario a thumbs-down produces. Written to data/, never to test/. */
export function writeDraft({ message, note = null, now = new Date() }) {
  const id = `review-${message.id}`;
  const customer = message.number || FAKE_NUMBER;
  // The customer's last message is the turn the scenario replays.
  const lastUser = get(
    `SELECT content FROM messages WHERE number = ? AND role = 'user' AND id < ? ORDER BY id DESC LIMIT 1`,
    [customer, message.id]
  );
  const draft = {
    _draft: true,
    _needs: 'recorded model turns (expect.script) before this can join test/golden/',
    _source: {
      messageId: message.id,
      vote: 'down',
      note: note || null,
      createdAt: now.toISOString(),
    },
    _scrubbing: {
      phoneNumbers: `replaced with ${FAKE_NUMBER}`,
      names: 'left as written — they are the wording the test is about',
    },
    id,
    title: `Review: a reply the owner marked wrong (#${message.id})`,
    template: 'generic',
    category: 'persona',
    language: 'en',
    profile: {},
    turns: [
      {
        user: anonymise(lastUser?.content || '(the customer message was not kept)', { number: customer }),
      },
    ],
    assert: {
      language: 'same',
      oneReplyPerTurn: true,
      noMidSentence: true,
    },
    notes: [
      'Draft from .review — a thumbs-down, not a written test.',
      `The reply that was wrong: ${anonymise(String(message.content || '').slice(0, 300), { number: customer })}`,
      note ? `Owner note: ${note}` : 'No owner note was given.',
    ],
  };

  const dir = DRAFT_DIR();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
  return { id, file, draft };
}

export function listDrafts() {
  const dir = DRAFT_DIR();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const file = path.join(dir, f);
      try {
        const draft = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { id: draft.id || f.replace(/\.json$/, ''), file, draft };
      } catch {
        return { id: f.replace(/\.json$/, ''), file, draft: null };
      }
    });
}

/**
 * Move an approved draft into `test/golden-drafts/`, which the eval does not
 * load (`test/golden/*.json` only). It stays a draft until someone records the
 * model turns, and the reply says exactly that.
 */
export function approveDraft(id, { root = process.cwd() } = {}) {
  const found = listDrafts().find((d) => d.id === id);
  if (!found) return { ok: false, error: 'no_such_draft', known: listDrafts().map((d) => d.id) };
  const outDir = path.join(root, 'test', 'golden-drafts');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${found.id}.json`);
  fs.copyFileSync(found.file, out);
  fs.unlinkSync(found.file);
  return {
    ok: true,
    file: path.relative(root, out),
    next: 'It is still a draft: the eval only loads test/golden/*.json and needs recorded turns. Record them, then move it into test/golden/.',
  };
}

/** The text `.review` sends back. */
export function reviewText({ limit = 5 } = {}) {
  const replies = recentReplies({ limit });
  if (!replies.length) {
    return 'No bot replies yet. `.review` needs at least one assistant message in the database.';
  }
  const lines = [`*Review the last ${replies.length} replies*`];
  replies.forEach((r, i) => {
    const mark = r.vote === 'up' ? ' 👍' : r.vote === 'down' ? ' 👎' : '';
    const one = String(r.text || '').replace(/\s+/g, ' ').slice(0, 160);
    lines.push(`${i + 1}.${mark} ${one}${String(r.text || '').length > 160 ? '…' : ''}`);
  });
  const drafts = listDrafts();
  if (drafts.length) lines.push('', `Drafts waiting: ${drafts.map((d) => d.id).join(', ')}`);
  lines.push('', '`.review up <n>` / `.review down <n> [note]` — a thumbs-down becomes a draft scenario. `.review approve <draft id>`.');
  return lines.join('\n');
}

export default {
  FAKE_NUMBER,
  anonymise,
  approveDraft,
  listDrafts,
  recentReplies,
  recordVote,
  reviewText,
  writeDraft,
};
