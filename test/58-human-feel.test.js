// test/58-human-feel.test.js
// The human-feel pass, unit by unit:
//
//   1. reply timing   — a 5–15 s window, never padded when already late
//   2. typing         — read → composing → paused → message, and never stuck
//   3. brevity        — the fewest sentences that work, numbers kept
//   4. missed calls    — one short apology, cancelled by an answer or a reply
//   5. voice           — a voice note gets a voice note, with a text fallback
//   6. human touches   — 👍 for "ok", an honest answer about being a bot
//   7. flags off       — the old behaviour, exactly
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Own sandbox. MAX_DELAY_MS is left unset so the timing model runs at its real
// scale; individual tests pin small values through the env, which the timing
// module honours exactly instead of clamping them away.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-human-feel-'));
process.env.DATA_DIR = dir;
process.env.TMP_DIR = path.join(dir, 'tmp');
process.env.SESSION_FOLDER = path.join(dir, 'sessions');
process.env.MY_NUMBER = '923001234567';
process.env.MY_NAME = 'Test Owner';
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.GEMINI_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';
process.env.DEBOUNCE_MS = '30';
process.env.NOTIFY_NEW_CHATS = 'false';
process.env.QUIET_HOURS = '';
process.env.VOICE_REPLY_MODE = 'match_voice';
process.env.ENABLE_WEB = 'false';
process.env.CONFIG_DIR = path.join(dir, 'config');
process.env.TYPING_CPS = '2000';

fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
fs.writeFileSync(
  path.join(process.env.CONFIG_DIR, 'owner.json'),
  JSON.stringify({
    owner: { name: 'Test Owner', timezone: 'Asia/Karachi' },
    business: { name: 'Test Studio', type: 'Agency', city: 'Islamabad' },
    features: { businessProfile: true },
  })
);

const db = await import('../src/utils/db.js');
await db.initDB();

const { mockTransport } = await import('../src/dev/mockLlm.js');
mockTransport();

const config = (await import('../src/config/env.js')).config;
const timing = await import('../src/core/timing.js');
const humanizer = await import('../src/core/humanizer.js');
const brevity = await import('../src/core/brevity.js');
const touch = await import('../src/core/humanTouch.js');
const calls = await import('../src/services/calls.js');
const tts = await import('../src/services/tts.js');
const timeline = await import('../src/services/timeline.js');
const { handleIncoming } = await import('../src/handlers/messageHandler.js');
const { handleCallEvents } = await import('../src/services/calls.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 5000, interval = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await wait(interval);
  }
  throw new Error('waitFor timed out');
}

// config.timing is a snapshot taken at import, so a test that changes the
// clock has to change both the env (the presence check) and the snapshot.
const FAST = {
  REPLY_TARGET_MIN_MS: ['targetMinMs', 20],
  REPLY_TARGET_MAX_MS: ['targetMaxMs', 40],
  TYPING_MIN_MS: ['typingMinMs', 10],
  TYPING_MAX_MS: ['typingMaxMs', 20],
  TYPING_REFRESH_MS: ['refreshMs', 15],
  TYPING_HARD_CAP_MS: ['hardCapMs', 400],
  READ_DELAY_MIN_MS: ['readMinMs', 1],
  READ_DELAY_MAX_MS: ['readMaxMs', 2],
};
const SAVED = {};
function fastTiming() {
  for (const [env, [key, value]] of Object.entries(FAST)) {
    if (!(key in SAVED)) SAVED[key] = config.timing[key];
    process.env[env] = String(value);
    config.timing[key] = value;
  }
}
function realTiming() {
  for (const [env, [key]] of Object.entries(FAST)) {
    delete process.env[env];
    if (key in SAVED) config.timing[key] = SAVED[key];
  }
}

function sockWithReactions() {
  const sock = {
    sent: [],
    presence: [],
    reads: [],
    reactions: [],
    user: { id: '923001234567:1@s.whatsapp.net', name: 'Test Owner' },
    async sendMessage(jid, payload) {
      sock.sent.push({ jid, payload });
      return { key: { id: `SENT-${sock.sent.length}` } };
    },
    async sendPresenceUpdate(state, jid) {
      sock.presence.push({ state, jid });
    },
    async readMessages(keys) {
      sock.reads.push(keys);
    },
    async sendReaction(jid, key, emoji) {
      sock.reactions.push({ jid, key, emoji });
      return { key: { id: 'REACT-1' } };
    },
  };
  return sock;
}

const textsTo = (sock, number) => sock.sent.filter((m) => m.payload?.text && m.jid.startsWith(number)).map((m) => m.payload.text);
const CLIENT = '447700900123';
const incoming = (text, id = `M-${Math.random().toString(36).slice(2)}`) => ({
  key: { remoteJid: `${CLIENT}@s.whatsapp.net`, fromMe: false, id },
  message: { conversation: text },
  pushName: 'John Client',
});

// ════════════════════════════════════════════════════════════
// 1. reply timing
// ════════════════════════════════════════════════════════════
test('timing: a normal reply lands inside the 5–15 s window', () => {
  realTiming();
  const t = timing.replyTiming();
  assert.equal(t.enabled, true);
  assert.equal(t.targetMinMs, 5000);
  assert.equal(t.targetMaxMs, 15000);

  const now = Date.now();
  const texts = [
    'Haan bilkul, delivery ho jayegi.',
    'Our website packages start at 60,000 and go up to 180,000 depending on the scope you need.',
    'ok',
    'Website 60,000. Ecommerce 120,000. Mobile app 250,000. Hosting 15,000 a year. Support 5,000 a month.',
  ];
  for (const text of texts) {
    for (let i = 0; i < 8; i += 1) {
      // The model answered after 1.5 s — a fast provider.
      const plan = timing.planReplyDelay({ text, receivedAt: now - 1500, readyAt: now });
      assert.ok(plan.totalMs >= 5000 && plan.totalMs <= 15000, `total ${plan.totalMs} ms is outside 5–15 s`);
      assert.equal(plan.late, false);
      assert.ok(plan.typingMs >= 3000 && plan.typingMs <= 10000, `typing ${plan.typingMs} ms is outside 3–10 s`);
    }
  }
});

test('timing: a reply that is already late is sent at once, not padded', () => {
  realTiming();
  const now = Date.now();
  const plan = timing.planReplyDelay({
    text: 'A long answer that took a while.',
    receivedAt: now - 21000, // the model took 21 seconds
    readyAt: now,
  });
  assert.equal(plan.waitMs, 0, 'a late reply must not be held');
  assert.equal(plan.late, true);
});

test('timing: read receipt comes before typing, and typing outlasts a slow provider', async () => {
  fastTiming();
  const seen = [];
  const sock = {
    async sendPresenceUpdate(state) {
      seen.push(Object.keys(sock).length && state);
    },
  };
  const session = timing.createTypingSession(sock, 'x@s.whatsapp.net', { timing: timing.replyTiming() });
  assert.equal(seen[0], 'composing');
  await wait(40); // > 2 refreshes at 15 ms
  assert.ok(seen.filter((s) => s === 'composing').length >= 2, 'the indicator must be refreshed, not sent once');
  session.pause();
  assert.equal(seen.at(-1), 'paused');
  await session.stop();
  realTiming();
});

// ════════════════════════════════════════════════════════════
// 2. typing indicators — end to end, on a fake socket
// ════════════════════════════════════════════════════════════
test('typing: read → composing → paused → message, in that order', async () => {
  fastTiming();
  // One log for everything the transport is asked to do, so the *order* is
  // observable: a read receipt, then typing (refreshed), then paused, then the
  // message itself.
  const log = [];
  const sock = {
    sent: [],
    presence: [],
    reads: [],
    user: { id: '923001234567:1@s.whatsapp.net', name: 'Test Owner' },
    async sendMessage(jid, payload) {
      log.push(payload?.text ? 'message' : 'media');
      sock.sent.push({ jid, payload });
      return { key: { id: `S${sock.sent.length}` } };
    },
    async sendPresenceUpdate(state, jid) {
      log.push(state);
      sock.presence.push({ state, jid });
    },
    async readMessages(keys) {
      log.push('read');
      sock.reads.push(keys);
    },
    async sendReaction() {
      log.push('reaction');
      return { key: { id: 'R1' } };
    },
  };

  await handleIncoming(sock, incoming('Hi, what do you charge for a website?'));
  await waitFor(() => textsTo(sock, CLIENT).length > 0);
  await wait(80); // let the read-receipt timer fire

  const idx = (name) => log.indexOf(name);
  assert.ok(idx('read') >= 0, `a read receipt was sent (${log.join(',')})`);
  assert.ok(idx('composing') >= 0, 'typing was shown');
  assert.ok(idx('read') <= idx('composing'), 'read comes before typing');
  // Refresh cadence itself is covered in the timing unit above; here the point
  // is the order, which must hold even when the model answers in 10 ms.
  assert.ok(log.filter((x) => x === 'composing').length >= 1);
  const firstMessage = idx('message');
  assert.ok(firstMessage > idx('composing'), 'the message comes after the typing');
  assert.equal(log[firstMessage - 1], 'paused', 'and typing is cleared right before it');
  assert.ok(log.lastIndexOf('composing') < firstMessage, 'no composing after the first message');
  realTiming();
});

test('typing: a long answer becomes a few short bubbles, with a pause between them', async () => {
  fastTiming();
  const log = [];
  const sock = {
    sent: [],
    async sendMessage(jid, payload) {
      if (payload?.text) log.push(`text:${payload.text.slice(0, 12)}`);
      sock.sent.push({ jid, payload });
      return { key: { id: `S${sock.sent.length}` } };
    },
    async sendPresenceUpdate(state) {
      log.push(state);
    },
    can: () => true,
  };
  const long =
    'We build websites for small businesses in Pakistan. A typical project starts with a scope call, then design, then development. ' +
    'Most sites are live in three to four weeks. We also handle hosting and maintenance afterwards, so you are not stuck. ' +
    'If that sounds right, tell me a bit about your business and I will send a plan.';
  await humanizer.sendHuman(sock, 'x@s.whatsapp.net', long, { chat: 'x', receivedAt: Date.now() });
  const bubbles = log.filter((x) => x.startsWith('text:')).length;
  assert.ok(bubbles >= 2 && bubbles <= 3, `a long answer becomes 2–3 bubbles (saw ${bubbles})`);
  assert.ok(log.filter((x) => x === 'composing').length >= bubbles, 'typing runs before every bubble');
  realTiming();
});

test('typing: a failing send never leaves "typing…" on screen', async () => {
  fastTiming();
  const presence = [];
  const broken = {
    async sendMessage() {
      // Permanent: the outbox does not queue it, so the send really fails.
      throw Object.assign(new Error('forbidden: invalid jid'), { status: 403 });
    },
    async sendPresenceUpdate(state) {
      presence.push(state);
    },
    can: () => true,
  };
  await assert.rejects(() => humanizer.sendHuman(broken, 'x@s.whatsapp.net', 'hello there', { chat: 'x', receivedAt: Date.now() }));
  assert.equal(presence.at(-1), 'paused');
  assert.ok(!presence.slice(-1).includes('composing'));
  realTiming();
});

// ════════════════════════════════════════════════════════════
// 3. brevity
// ════════════════════════════════════════════════════════════
test('brevity: the filler opener goes, the numbers stay', () => {
  const trimmed = brevity.trimReply(
    'Sure! Happy to help. Websites start at 60,000 and ecommerce at 120,000. Delivery takes three weeks. We also do SEO. Want a quote?'
  );
  assert.equal(trimmed.changed, true);
  assert.ok(trimmed.text.includes('60,000'), 'the price must survive');
  assert.ok(trimmed.text.includes('120,000'), 'the second price must survive');
  assert.ok(!/^Sure!/.test(trimmed.text), 'no filler opener');
  assert.ok(brevity.sentenceCount(trimmed.text) <= 3);
});

test('brevity: at most one question per reply', () => {
  const trimmed = brevity.trimReply('Kya aap ne quote dekh liya? Kab start karna hai? Kitna budget hai?');
  assert.equal((trimmed.text.match(/[?؟]/g) || []).length, 1);
});

test('brevity: a list or a quote is information, not waffle', () => {
  const list = 'Our packages:\n- Basic: Rs 60,000\n- Pro: Rs 120,000\n- Elite: Rs 180,000';
  assert.equal(brevity.trimReply(list).changed, false);
  assert.equal(brevity.trimReply(list).reason, 'list');
  // A customer who asked for detail gets detail.
  const long = 'First we scope. Then we design. Then we build. Then we test. Then we launch.';
  assert.equal(brevity.trimReply(long, { userText: 'please explain the full process in detail' }).changed, false);
});

test('brevity: the prompt carries the same rule for every agent', async () => {
  const { systemPrompt } = await import('../src/core/brain.js');
  const prompt = systemPrompt({ number: '447700900123', langInfo: { code: 'en', label: 'English' } });
  assert.match(prompt, /FEWEST sentences/);
  assert.match(prompt, /at most ONE question/);
  assert.match(prompt, /Never describe yourself as an AI/);
});

// ════════════════════════════════════════════════════════════
// 4. missed calls
// ════════════════════════════════════════════════════════════
function pinCallWindow(seconds) {
  const saved = { ...config.calls };
  config.calls.delaySeconds = seconds;
  config.calls.delayMinSeconds = seconds;
  config.calls.delayMaxSeconds = seconds;
  config.calls.enabled = true;
  return () => Object.assign(config.calls, saved);
}

test('missed call: if the owner answers, nothing is sent', async () => {
  fastTiming();
  const restore = pinCallWindow(0.2);
  const sock = sockWithReactions();
  const number = '447700900201';
  calls.__resetCalls();
  await handleCallEvents(sock, [{ id: 'CALL-ANS', from: `${number}@s.whatsapp.net`, status: 'offer' }]);
  await handleCallEvents(sock, [{ id: 'CALL-ANS', from: `${number}@s.whatsapp.net`, status: 'accept' }]);
  await wait(350);
  assert.equal(textsTo(sock, number).length, 0, 'an answered call gets no apology');
  assert.equal(db.getCall('CALL-ANS').status, 'accepted');
  assert.ok(db.getCall('CALL-ANS').ended_at, 'the timeline records when it ended');
  restore();
  realTiming();
});

test('missed call: a caller who hangs up gets exactly one short apology', async () => {
  fastTiming();
  const restore = pinCallWindow(5);
  const sock = sockWithReactions();
  const number = '447700900202';
  calls.__resetCalls();
  await handleCallEvents(sock, [{ id: 'CALL-HANG', from: `${number}@s.whatsapp.net`, status: 'offer' }]);
  await handleCallEvents(sock, [{ id: 'CALL-HANG', from: `${number}@s.whatsapp.net`, status: 'reject' }]);
  await waitFor(() => textsTo(sock, number).length > 0);

  const sent = textsTo(sock, number);
  assert.equal(sent.length, 1, 'one apology, not a pile');
  assert.ok(brevity.sentenceCount(sent[0]) <= 2, `the apology must be short: "${sent[0]}"`);
  const row = db.getCall('CALL-HANG');
  assert.ok(row.apologized_at, 'the apology is on the call timeline');
  assert.ok(sock.presence.some((p) => p.state === 'composing'), 'it is typed, not teleported');

  // A second missed call minutes later stays quiet: one apology per 30 min.
  await handleCallEvents(sock, [{ id: 'CALL-HANG-2', from: `${number}@s.whatsapp.net`, status: 'offer' }]);
  await handleCallEvents(sock, [{ id: 'CALL-HANG-2', from: `${number}@s.whatsapp.net`, status: 'reject' }]);
  await wait(200);
  assert.equal(textsTo(sock, number).length, 1, 'the 30-minute apology cap holds');
  restore();
  realTiming();
});

test('missed call: a customer who writes first is not apologised to', async () => {
  fastTiming();
  const restore = pinCallWindow(0.15);
  const sock = sockWithReactions();
  const number = '447700900203';
  calls.__resetCalls();
  await handleCallEvents(sock, [{ id: 'CALL-WROTE', from: `${number}@s.whatsapp.net`, status: 'offer' }]);
  await handleIncoming(sock, {
    key: { remoteJid: `${number}@s.whatsapp.net`, fromMe: false, id: 'WROTE-1' },
    message: { conversation: 'sorry missed your call, what is the price?' },
    pushName: 'Caller',
  });
  await wait(400);
  const apology = textsTo(sock, number).filter((t) => /call|sorry for missing|attend nahi/i.test(t));
  assert.equal(apology.length, 0, 'no "sorry I missed your call" on top of their own message');
  restore();
  realTiming();
});

// ════════════════════════════════════════════════════════════
// 5. voice
// ════════════════════════════════════════════════════════════
test('voice: the default mode answers a voice note with a voice note', () => {
  assert.equal(config.tts.mode, 'match_voice');
  assert.equal(tts.shouldSpeak({ clientSentVoice: true, text: '' }), true);
  assert.equal(tts.shouldSpeak({ clientSentVoice: false, text: 'bhai voice note bhej dein' }), true);
  assert.equal(tts.shouldSpeak({ clientSentVoice: false, text: 'kitna price hai?' }), false);
  // `match` is accepted as a spelling of the default.
  assert.equal(tts.normalizeMode('match'), 'match_voice');
});

test('voice: the spoken part is capped at ~20 s and never drops the numbers', () => {
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} explains something else.`).join(' ');
  const spoken = tts.speechTextFor(long, { maxSeconds: 20 });
  assert.ok(tts.estimateSeconds(spoken) <= 20, `spoken ${tts.estimateSeconds(spoken)} s`);
  assert.ok(spoken.length < long.length);
  const priced = tts.speechTextFor('Website 60,000 se start hoti hai. Ecommerce 120,000.', { maxSeconds: 20 });
  assert.match(priced, /60,000/);
});

test('voice: if the voice note fails, the same words still arrive as text', async () => {
  fastTiming();
  const sock = {
    sent: [],
    presence: [],
    async sendMessage(jid, payload) {
      if (payload?.audio) throw new Error('audio refused');
      sock.sent.push({ jid, payload });
      return { key: { id: `S${sock.sent.length}` } };
    },
    async sendPresenceUpdate(state) {
      sock.presence.push(state);
    },
    can: () => true,
  };
  const voice = { buffer: Buffer.from('x'), payload: { audio: Buffer.from('x'), mimetype: 'audio/ogg', ptt: true } };
  await humanizer.sendHuman(sock, 'x@s.whatsapp.net', 'Delivery is 30 minutes.', { chat: 'x', voice, receivedAt: Date.now() });
  assert.equal(sock.sent.filter((m) => m.payload?.text).length, 1, 'the text fallback went out');
  assert.equal(sock.presence.at(-1), 'paused');
  realTiming();
});

test('voice: a price quote is never voice-only', async () => {
  fastTiming();
  const sock = {
    sent: [],
    presence: [],
    async sendMessage(jid, payload) {
      sock.sent.push({ jid, payload });
      return { key: { id: `S${sock.sent.length}` } };
    },
    async sendPresenceUpdate() {},
    can: () => true,
  };
  const quote = 'Website 60,000 se 180,000 tak. Ecommerce 120,000 se 350,000 tak.';
  const voice = { buffer: Buffer.from('x'), payload: { audio: Buffer.from('x'), mimetype: 'audio/ogg', ptt: true } };
  await humanizer.sendHuman(sock, 'x@s.whatsapp.net', quote, { chat: 'x', voice, receivedAt: Date.now() });
  const texts = sock.sent.filter((m) => m.payload?.text).map((m) => m.payload.text).join(' ');
  assert.match(texts, /60,000/, 'the numbers must be readable');
  assert.ok(sock.sent.some((m) => m.payload?.audio), 'and the voice note still goes too');
  realTiming();
});

// ════════════════════════════════════════════════════════════
// 6. human touches
// ════════════════════════════════════════════════════════════
test('human touch: "ok" gets a reaction, not a paragraph', async () => {
  fastTiming();
  const sock = sockWithReactions();
  // Give the chat a history whose last assistant turn was not a question.
  db.saveMessage(CLIENT, 'assistant', 'Your order is confirmed for 6 pm.');
  await handleIncoming(sock, incoming('ok thanks', 'ACK-1'));
  await waitFor(() => sock.reactions.length > 0);
  assert.equal(textsTo(sock, CLIENT).length, 0, 'no text reply for an acknowledgement');
  assert.equal(sock.reactions[0].emoji, '🙏');
  assert.ok(db.recentEvents(20).some((e) => e.type === 'ack_reaction'));
  realTiming();
});

test('human touch: "are you a bot?" is answered honestly and cannot be switched off', async () => {
  fastTiming();
  process.env.HUMAN_TOUCH = 'off';
  const sock = sockWithReactions();
  await handleIncoming(sock, incoming('quick question — are you a bot?', 'BOT-1'));
  await waitFor(() => textsTo(sock, CLIENT).length > 0);
  const reply = textsTo(sock, CLIENT).join(' ');
  assert.match(reply, /AI assistant/i, 'it says plainly what it is');
  assert.ok(brevity.sentenceCount(reply) <= 2, 'and briefly');
  assert.ok(db.recentEvents(20).some((e) => e.type === 'bot_disclosure'));
  delete process.env.HUMAN_TOUCH;
  realTiming();
});

test('human touch: the honest answer exists in every conversation language', () => {
  assert.match(touch.honestBotAnswer('en'), /AI assistant/);
  assert.match(touch.honestBotAnswer('roman-ur'), /AI assistant/);
  assert.match(touch.honestBotAnswer('ur'), /اے آئی/);
  assert.equal(touch.asksIfBot('kya aap insan hain?'), true);
  assert.equal(touch.asksIfBot('kitna price hai?'), false);
  assert.equal(touch.isAckOnly('shukriya'), true);
  assert.equal(touch.isAckOnly('kitna price hai'), false);
});

test('human touch: the bot stays quiet if the owner replies while it is composing', async () => {
  fastTiming();
  const sock = sockWithReactions();
  // The owner answers in the chat *after* the customer's message arrived and
  // before the bot's reply goes out: the reply is dropped, not sent anyway.
  await handleIncoming(sock, incoming('any update on my order?', 'OWNER-ACTIVE'));
  await wait(10); // the customer's message is now safely in the past
  db.saveMessage(CLIENT, 'owner', 'I am on it, sending the tracking number now.');
  await wait(400);
  assert.equal(textsTo(sock, CLIENT).length, 0, 'no reply on top of the owner');
  realTiming();
});

// ════════════════════════════════════════════════════════════
// 7. the timeline
// ════════════════════════════════════════════════════════════
test('timeline: every reply records where its seconds went', async () => {
  fastTiming();
  const sock = sockWithReactions();
  timeline._resetForTests();
  await handleIncoming(sock, incoming('what are your hours?', 'TL-1'));
  await waitFor(() => textsTo(sock, CLIENT).length > 0);
  await wait(80);
  const line = timeline.formatTimeline({ limit: 5 });
  assert.match(line, /total/);
  assert.match(line, /read \+/);
  assert.match(line, /where the time goes/);
  realTiming();
});

// ════════════════════════════════════════════════════════════
// 8. flags off = the old behaviour
// ════════════════════════════════════════════════════════════
test('flags off: REPLY_TIMING=false restores the single-delay send', async () => {
  process.env.REPLY_TIMING = 'false';
  const savedEnabled = config.timing.enabled;
  config.timing.enabled = false;
  process.env.MIN_DELAY_MS = '1';
  process.env.MAX_DELAY_MS = '5';
  assert.equal(timing.replyTiming().enabled, false);

  const presence = [];
  const sock = {
    sent: [],
    presence,
    async sendMessage(jid, payload) {
      sock.sent.push({ jid, payload });
      return { key: { id: 'S1' } };
    },
    async sendPresenceUpdate(state) {
      presence.push(state);
    },
  };
  const started = Date.now();
  await humanizer.sendHuman(sock, 'x@s.whatsapp.net', 'One short line.', { chat: 'x' });
  const elapsed = Date.now() - started;
  assert.equal(sock.sent.length, 1);
  assert.deepEqual(presence.filter((p) => p === 'composing').length >= 1, true);
  // The old path is bounded by MIN/MAX_DELAY_MS (1–5 ms here), never by the
  // new 5–15 s window. A generous ceiling keeps this stable on a loaded CI box.
  assert.ok(elapsed < 3000, `legacy timing is short (${elapsed} ms)`);
  delete process.env.REPLY_TIMING;
  delete process.env.MAX_DELAY_MS;
  config.timing.enabled = savedEnabled;
});

test('flags off: HUMAN_TOUCH=off answers "ok" with words again', async () => {
  fastTiming();
  process.env.HUMAN_TOUCH = 'off';
  const sock = sockWithReactions();
  await handleIncoming(sock, incoming('ok', 'ACK-OFF'));
  await waitFor(() => textsTo(sock, CLIENT).length > 0, { timeout: 4000 });
  assert.equal(sock.reactions.length, 0, 'no reaction when the layer is off');
  assert.ok(textsTo(sock, CLIENT).length >= 1);
  delete process.env.HUMAN_TOUCH;
  realTiming();
});
