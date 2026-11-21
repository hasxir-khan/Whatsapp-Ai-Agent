// test/61-conversation-control.test.js
// Conversation Control V1, end to end and rule by rule:
//
//   1. decision engine — every action, in English, Roman Urdu and Urdu
//   2. owner settings — defaults, validation, the doctor's risky combinations
//   3. abuse — a boundary, a cool-down, and a threat that is never a chat
//   4. collector — one question, several answers, corrections, askIf
//   5. no guessing — no price data means an owner task, not a number
//   6. the log — content-free, and `.decisions` / `.control` / `.brief`
//   7. the flag — off means the old pipeline, byte for byte
//
// Fake data only: the model is the repo's mock, the numbers are the fixture
// number, and every test owns its temporary data directory.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-conversation-control-'));
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
process.env.DEBOUNCE_MS = '30';
process.env.NOTIFY_NEW_CHATS = 'false';
process.env.QUIET_HOURS = '';
process.env.TYPING_CPS = '2000';
process.env.MIN_DELAY_MS = '1';
process.env.MAX_DELAY_MS = '5';
process.env.VOICE_REPLY_MODE = 'off';

fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
fs.writeFileSync(
  path.join(process.env.CONFIG_DIR, 'owner.json'),
  JSON.stringify({
    owner: { name: 'Test Owner', timezone: 'Asia/Karachi' },
    business: { name: 'Test Studio', type: 'Agency', city: 'Islamabad', currency: 'PKR' },
    features: { businessProfile: true, privacyTools: true, ownerEditing: true, conversationControl: true },
  })
);

const db = await import('../src/utils/db.js');
await db.initDB();

const { mockTransport } = await import('../src/dev/mockLlm.js');
mockTransport();

const profileMod = await import('../src/services/profile.js');
const conversation = await import('../src/services/conversation.js');
const decisionMod = await import('../src/services/decision.js');
const abuse = await import('../src/core/abuse.js');
const scope = await import('../src/core/scope.js');
const collector = await import('../src/services/collector.js');
const briefs = await import('../src/services/brief.js');
const noGuess = await import('../src/services/noGuess.js');
const intake = await import('../src/core/projectIntake.js');
const { handleIncoming, drainBatches } = await import('../src/handlers/messageHandler.js');
const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');

const OWNER = '923001234567';
const OWNER_JID = `${OWNER}@s.whatsapp.net`;
const CLIENT = '923004445566';

const check = (decision, action, reason) => {
  assert.equal(decision.action, action, `action ${decision.action} (${decision.reason}) — expected ${action}`);
  if (reason) assert.equal(decision.reason, reason, `reason ${decision.reason} — expected ${reason}`);
};

function clean() {
  for (const table of db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
    try {
      db.run(`DELETE FROM "${table.name}"`);
    } catch {
      /* virtual tables */
    }
  }
  abuse.resetAbuseState();
  decisionMod.clearDecisionCache();
  // projectIntake keeps a per-contact cache; a row deleted behind its back
  // would otherwise be read back from memory.
  intake.resetState(CLIENT);
  db.run('DELETE FROM intake');
}

function sock() {
  const s = {
    sent: [],
    reactions: [],
    presence: [],
    user: { id: '923001234567:1@s.whatsapp.net', name: 'Test Owner' },
    async sendMessage(jid, payload) {
      s.sent.push({ jid, payload });
      return { key: { id: `SENT-${s.sent.length}` } };
    },
    async sendPresenceUpdate(state, jid) {
      s.presence.push({ state, jid });
    },
    async readMessages() {},
    async sendReaction(jid, key, emoji) {
      s.reactions.push({ jid, key, emoji });
      return { key: { id: `R-${s.reactions.length}` } };
    },
  };
  return s;
}

const incoming = (text, id = `M-${Math.random().toString(36).slice(2)}`, number = CLIENT) => ({
  key: { remoteJid: `${number}@s.whatsapp.net`, fromMe: false, id },
  message: { conversation: text },
  pushName: 'Test Client',
});

const toClient = (s) => s.sent.filter((m) => m.payload?.text && m.jid.startsWith(CLIENT)).map((m) => m.payload.text);
const toOwner = (s) => s.sent.filter((m) => m.payload?.text && m.jid.startsWith(OWNER)).map((m) => m.payload.text);

async function say(s, text, number = CLIENT) {
  await handleIncoming(s, incoming(text, `M-${Math.random().toString(36).slice(2)}`, number));
  await drainBatches({ timeoutMs: 4000 });
}

// A contact with history, so "new contact protection" does not confound a test
// that is about something else.
function knownContact(number = CLIENT, messages = 6) {
  db.upsertContact(number, { jid: `${number}@s.whatsapp.net`, name: 'Test Client', category: 'lead' });
  db.run('UPDATE contacts SET message_count = ? WHERE number = ?', [messages, number]);
}

// ════════════════════════════════════════════════════════════
// 1. the decision engine
// ════════════════════════════════════════════════════════════

test('flag: Conversation Control is off by default and on when asked', () => {
  assert.equal(profileMod.FEATURE_KEYS.includes('conversationControl'), true);
  assert.equal(profileMod.FEATURE_DEFAULT_ON.has('conversationControl'), false, 'off unless the owner turns it on');
  assert.equal(conversation.controlEnabled(), true, 'this test profile turns it on');
});

test('decision: counting and jokes are redirected, in all three languages', async () => {
  clean();
  knownContact();
  for (const text of ['count 1 to 100', '1 se 100 tak ginti karo', 'ایک سے سو تک گنو']) {
    const d = await decisionMod.decide({ number: CLIENT, text, lang: 'en' });
    check(d, 'redirect', 'off_topic_redirect');
    assert.ok(d.text && d.text.length > 10, 'a redirect carries the refusal line');
  }
  for (const text of ['tell me a joke', 'koi joke sunao', 'لطیفہ سناؤ']) {
    check(await decisionMod.decide({ number: CLIENT, text, lang: 'en' }), 'redirect', 'off_topic_redirect');
  }
});

test('decision: the scope setting decides whether light chat is allowed', async () => {
  clean();
  knownContact();
  const save = (scope) => profileMod.setPath('business.conversation.scope', scope);

  save('business_only');
  check(await decisionMod.decide({ number: CLIENT, text: 'tell me a joke', lang: 'en' }), 'redirect');

  save('business_plus_light_chat');
  check(await decisionMod.decide({ number: CLIENT, text: 'tell me a joke', lang: 'en' }), 'reply', 'normal');
  // Homework is not light chat, even on the middle setting.
  check(await decisionMod.decide({ number: CLIENT, text: 'write my homework for me', lang: 'en' }), 'redirect');

  save('open');
  assert.equal((await decisionMod.decide({ number: CLIENT, text: 'count 1 to 100', lang: 'en' })).action, 'reply');
  save('business_only');
});

test('decision: an insult gets one boundary line, then a cool-down, then quiet', async () => {
  clean();
  knownContact();
  const first = await decisionMod.decide({ number: CLIENT, text: 'you are stupid', lang: 'en' });
  check(first, 'reply', 'insult');
  assert.match(first.text, /professional|insult/i);
  assert.equal(first.notifyOwner, undefined);

  const second = await decisionMod.decide({ number: CLIENT, text: 'tum bewakoof ho', lang: 'roman-ur' });
  check(second, 'reply', 'insult');
  assert.equal(second.notifyOwner, true, 'the limit is reached: the owner is told');
  assert.match(second.text, /ruk|pause|baat/i);

  const third = await decisionMod.decide({ number: CLIENT, text: 'تم بیوقوف ہو', lang: 'ur' });
  check(third, 'ignore', 'cool_down');
});

test('decision: a threat or self-harm words are an urgent handover, never a chat', async () => {
  clean();
  knownContact();
  const threat = await decisionMod.decide({ number: CLIENT, text: 'I will come to your shop and beat you', lang: 'en' });
  check(threat, 'handover', 'threat');
  assert.equal(threat.urgent, true);

  const harm = await decisionMod.decide({ number: CLIENT, text: 'I want to die, there is no reason to live', lang: 'en' });
  check(harm, 'handover', 'self_harm');
  assert.equal(harm.urgent, true);

  const urdu = await decisionMod.decide({ number: CLIENT, text: 'میں خودکشی کرنا چاہتا ہوں', lang: 'ur' });
  assert.equal(urdu.action, 'handover');
  assert.equal(urdu.urgent, true);
});

test('decision: "I want to speak to a human" hands over immediately, in every language', async () => {
  clean();
  knownContact();
  for (const text of ['I want to speak to a human', 'mujhe insaan se baat karni hai', 'مجھے کسی انسان سے بات کرنی ہے']) {
    const d = await decisionMod.decide({ number: CLIENT, text, lang: 'en' });
    check(d, 'handover', 'human_request');
    assert.equal(d.notifyOwner, true);
  }
});

test('decision: "hi" is a reply, "ok" is a reaction, spam and duplicates are ignored', async () => {
  clean();
  knownContact();
  check(await decisionMod.decide({ number: CLIENT, text: 'hi', lang: 'en' }), 'reply');

  // A reaction needs a conversation where the last assistant line asked nothing.
  db.saveMessage(CLIENT, 'assistant', 'Cool — your order is on the way.');
  check(await decisionMod.decide({ number: CLIENT, text: 'ok', lang: 'en' }), 'react', 'ack');

  const spam = await decisionMod.decide({ number: CLIENT, text: 'share your otp code now to verify', lang: 'en' });
  check(spam, 'ignore', 'spam');

  db.saveMessage(CLIENT, 'user', 'what are your timings');
  const dup = await decisionMod.decide({ number: CLIENT, text: 'what are your timings', lang: 'en' });
  check(dup, 'ignore', 'duplicate');
});

test('decision: opt-out and privacy are never ignored, whatever the settings say', async () => {
  clean();
  knownContact();
  profileMod.setPath('business.conversation.offTopic', 'ignore');
  profileMod.setPath('business.conversation.scope', 'business_only');

  check(await decisionMod.decide({ number: CLIENT, text: 'stop messaging me', lang: 'en' }), 'reply', 'opt_out');
  check(await decisionMod.decide({ number: CLIENT, text: 'please delete my data', lang: 'en' }), 'reply', 'privacy');
  check(await decisionMod.decide({ number: CLIENT, text: 'مجھے میسج بند کرو', lang: 'ur' }), 'reply', 'opt_out');

  profileMod.setPath('business.conversation.offTopic', 'redirect');
});

test('decision: a new contact is answered even when the rule would ignore', async () => {
  clean();
  profileMod.setPath('business.conversation.offTopic', 'ignore');
  const fresh = db.upsertContact(CLIENT, { jid: `${CLIENT}@s.whatsapp.net`, name: 'New Client', category: 'new' });
  db.run('UPDATE contacts SET message_count = 2 WHERE number = ?', [CLIENT]);

  const d = await decisionMod.decide({ number: CLIENT, text: 'tell me a joke', lang: 'en', contact: fresh });
  check(d, 'reply', 'new_contact_protected');

  // Clearly spam is still spam, even on message one.
  db.run('UPDATE contacts SET message_count = 1 WHERE number = ?', [CLIENT]);
  const spam = await decisionMod.decide({
    number: CLIENT,
    text: 'congratulations you have won the lottery, share your otp',
    lang: 'en',
    contact: { message_count: 1 },
  });
  check(spam, 'ignore', 'spam');
  profileMod.setPath('business.conversation.offTopic', 'redirect');
});

test('decision: an active order is never ignored', async () => {
  clean();
  profileMod.setPath('business.conversation.offTopic', 'ignore');
  knownContact();
  db.run(
    'INSERT INTO orders (chat, items, total, currency, name, status, key, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [`${CLIENT}@s.whatsapp.net`, '[]', 2500, 'PKR', 'Test Client', 'placed', 'k-cc-1', new Date().toISOString()]
  );
  const d = await decisionMod.decide({ number: CLIENT, text: 'tell me a joke', lang: 'en', contact: { message_count: 9 } });
  check(d, 'reply', 'active_commitment');
  profileMod.setPath('business.conversation.offTopic', 'redirect');
});

test('decision: at most two ignores in a row, then a reply and an owner ping', async () => {
  clean();
  knownContact();
  db.saveMessage(CLIENT, 'assistant', 'Anything else?');
  const now = new Date().toISOString();
  for (const action of ['ignore', 'ignore']) {
    db.run("INSERT INTO decisions (number, action, reason, confidence, source, rationale, created_at) VALUES (?,?,?,?,?,?,?)", [
      CLIENT,
      action,
      'off_topic_ignore',
      0.8,
      'rules',
      'off-topic',
      now,
    ]);
  }
  assert.equal(decisionMod.consecutiveIgnores(CLIENT), 2);
  profileMod.setPath('business.conversation.offTopic', 'ignore');
  const d = await decisionMod.decide({ number: CLIENT, text: 'tell me a joke', lang: 'en', contact: { message_count: 9 } });
  profileMod.setPath('business.conversation.offTopic', 'redirect');
  check(d, 'reply', 'ignore_limit');
  assert.equal(d.notifyOwner, true);
  assert.ok(d.text, 'the customer gets words, not a third silence');
});

test('decision: the off-topic modes behave as three different settings', async () => {
  clean();
  knownContact();
  const decide = (text) => decisionMod.decide({ number: CLIENT, text, lang: 'en' });

  profileMod.setPath('business.conversation.offTopic', 'redirect');
  const redirected = await decide('tell me a joke');
  check(redirected, 'redirect', 'off_topic_redirect');

  profileMod.setPath('business.conversation.offTopic', 'warn_then_stop');
  const warned = await decide('tell me a joke');
  check(warned, 'redirect', 'off_topic_warn');
  decisionMod.recordDecision(CLIENT, warned, { lang: 'en' });
  // One warning is configured, so the second off-topic message is silence.
  const warnedAgain = await decide('tell me a joke again');
  check(warnedAgain, 'ignore', 'off_topic_ignore');

  profileMod.setPath('business.conversation.offTopic', 'ignore');
  check(await decide('write me python code'), 'ignore', 'off_topic_ignore');

  profileMod.setPath('business.conversation.offTopic', 'redirect');
  clean();
});

test('classifier: a 3 s timeout falls back to a normal reply, and the cache is used', async () => {
  clean();
  knownContact();
  const llm = await import('../src/core/llm.js');
  // A provider that never answers: the classifier must not hold the reply.
  const restore = () => llm.__setFetch(null);
  llm.__setFetch(() => new Promise(() => {}));
  const started = Date.now();
  const d = await decisionMod.decide({
    number: CLIENT,
    text: 'I was thinking about whether you might be able to help with something maybe',
    lang: 'en',
    classifierTimeoutMs: 120,
  });
  const elapsed = Date.now() - started;
  restore();
  check(d, 'reply', 'classifier_fallback');
  assert.equal(d.source, 'fallback');
  assert.ok(elapsed < 2000, `fell back quickly (${elapsed} ms)`);

  // The same text twice with a working classifier: one call, then a cache hit.
  clean();
  let calls = 0;
  llm.__setFetch(async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"action":"redirect","confidence":0.9,"reason":"off_topic"}' } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  });
  const text = 'please explain the plot of a film I watched last year sometime';
  const first = await decisionMod.decide({ number: CLIENT, text, lang: 'en' });
  const second = await decisionMod.decide({ number: CLIENT, text, lang: 'en' });
  restore();
  assert.equal(calls, 1, 'one classifier call, then cached');
  assert.equal(first.action, 'redirect');
  assert.equal(second.source, 'cache');
  mockTransport();
});

// ════════════════════════════════════════════════════════════
// 2. owner settings
// ════════════════════════════════════════════════════════════

test('settings: safe defaults, and the enums refuse nonsense', () => {
  clean();
  const raw = profileMod.readOverrides();
  if (raw.business) delete raw.business.conversation;
  fs.writeFileSync(path.join(process.env.CONFIG_DIR, 'owner.json'), JSON.stringify(raw));
  profileMod.reloadProfile();

  const s = conversation.conversationSettings();
  assert.equal(s.scope, 'business_only');
  assert.equal(s.offTopic, 'redirect');
  assert.equal(s.maxSentences, 3);
  assert.equal(s.languageMatching, true);
  assert.equal(s.coolDownMinutes, 120);
  assert.equal(s.maxBotTurnsBeforeHuman, 12);
  assert.equal(s.notifyOwner, true);

  const bad = conversation.validateConversation({ scope: 'anything', offTopic: 'shout', coolDownMinutes: 2 });
  assert.equal(bad.errors.length, 3, bad.errors.join(' | '));
  assert.ok(bad.errors.some((e) => /scope/.test(e)));
  assert.ok(bad.errors.some((e) => /offTopic/.test(e)));
  assert.ok(bad.errors.some((e) => /coolDownMinutes/.test(e)));

  // profile.js validates every write, so .set cannot save a broken enum.
  const viaProfile = profileMod.validateProfile({
    business: { conversation: { maxSentences: 99 } },
  });
  assert.ok(viaProfile.errors.some((e) => /maxSentences/.test(e)));

  profileMod.setPath('business.conversation.scope', 'business_only');
});

test('settings: .set writes a value that takes effect on the next message', async () => {
  clean();
  const res = await handleOwnerCommand(null, OWNER_JID, '.set business.conversation.maxSentences 2');
  assert.match(res.reply, /Saved business\.conversation\.maxSentences = 2/);
  assert.equal(conversation.conversationSettings().maxSentences, 2);

  // A value the rules cannot run with is refused at the write, not saved.
  const bad = await handleOwnerCommand(null, OWNER_JID, '.set business.conversation.scope nonsense');
  assert.match(bad.reply, /Couldn't set that: business\.conversation\.scope must be one of/);
  assert.equal(conversation.conversationSettings().scope, 'business_only', 'the old value is still in force');
  profileMod.setPath('business.conversation.scope', 'business_only');
  profileMod.setPath('business.conversation.maxSentences', 3);
});

test('settings: the doctor names the risky combinations', () => {
  const base = { features: { conversationControl: true }, business: { type: 'Agency' } };

  const ignoreQuiet = conversation.conversationWarnings({
    ...base,
    business: { ...base.business, conversation: { offTopic: 'ignore', notifyOwner: false } },
  });
  assert.ok(ignoreQuiet.some((w) => /ignore.*notifyOwner/.test(w)), ignoreQuiet.join(' | '));

  const openClinic = conversation.conversationWarnings({
    features: { conversationControl: true },
    business: { type: 'Clinic', conversation: { scope: 'open' } },
  });
  assert.ok(openClinic.some((w) => /open.*clinic/i.test(w)), openClinic.join(' | '));

  const zeroWarnings = conversation.conversationWarnings({
    features: { conversationControl: true },
    business: { type: 'Agency', conversation: { offTopic: 'warn_then_stop', warningsBeforeStop: 0 } },
  });
  assert.ok(zeroWarnings.some((w) => /warningsBeforeStop/.test(w)));

  // With the flag off nothing is reported: the settings do nothing.
  assert.deepEqual(conversation.conversationWarnings({ features: {}, business: { conversation: { scope: 'open' } } }), []);
});

test('settings: a sensitive action needs the owner, when the owner asked for that', async () => {
  clean();
  knownContact();
  profileMod.setPath('business.conversation.approvalRequired', ['refund']);
  const d = await decisionMod.decide({ number: CLIENT, text: 'I want a refund for the second payment', lang: 'en' });
  check(d, 'handover', 'approval_required');
  assert.equal(d.notifyOwner, true);

  profileMod.setPath('business.conversation.approvalRequired', []);
  const free = await decisionMod.decide({ number: CLIENT, text: 'I want a refund for the second payment', lang: 'en' });
  assert.notEqual(free.reason, 'approval_required');
  profileMod.setPath('business.conversation.approvalRequired', ['refund']);
});

test('settings: the daily cap and the turn limit hand over to a person', async () => {
  clean();
  knownContact();
  const now = new Date();
  for (let i = 0; i < 40; i += 1) {
    db.run("INSERT INTO messages (number, role, content, created_at) VALUES (?,?,?,?)", [
      CLIENT,
      'assistant',
      `reply ${i}`,
      now.toISOString(),
    ]);
  }
  const capped = await decisionMod.decide({ number: CLIENT, text: 'and the price?', lang: 'en', now });
  check(capped, 'handover', 'daily_cap');
  assert.equal(capped.notifyOwner, true);

  // Under the cap but past the turn limit: a human is offered instead.
  clean();
  knownContact();
  for (let i = 0; i < 12; i += 1) {
    db.run("INSERT INTO messages (number, role, content, created_at) VALUES (?,?,?,?)", [
      CLIENT,
      'assistant',
      `old reply ${i}`,
      new Date(now.getTime() - 30 * 24 * 3600_000).toISOString(),
    ]);
  }
  const turned = await decisionMod.decide({ number: CLIENT, text: 'ok and the timing?', lang: 'en', now });
  check(turned, 'handover', 'turn_limit');
});

// ════════════════════════════════════════════════════════════
// 3. abuse, and the boundary is not an argument
// ════════════════════════════════════════════════════════════

test('abuse: three languages, three different kinds of hostile', () => {
  assert.equal(abuse.detectAbuse('you are stupid').insult, true);
  assert.equal(abuse.detectAbuse('tum bewakoof ho').insult, true);
  assert.equal(abuse.detectAbuse('تم بیوقوف ہو').insult, true);
  assert.equal(abuse.detectAbuse('I will sue you').threat, true);
  assert.equal(abuse.detectAbuse('I want to kill myself').selfHarm, true);
  // A complaint is not abuse: it must still reach the model.
  assert.equal(abuse.detectAbuse('the order was cold and late').any, false);
});

test('abuse: the boundary line is fixed, short and not a retort', () => {
  for (const lang of ['en', 'roman-ur', 'ur']) {
    const line = abuse.boundaryLine(lang);
    assert.ok(line.length > 20 && line.length < 200, `${lang}: ${line}`);
    assert.doesNotMatch(line, /stupid|bewakoof|بیوقوف/i, 'no retaliation');
  }
});

// ════════════════════════════════════════════════════════════
// 4. the requirement collector (extends projectIntake.js)
// ════════════════════════════════════════════════════════════

test('collector: one question per turn, starting with what is missing', () => {
  clean();
  profileMod.setPath('business.intake', { fields: [], required: [] });
  const state = intake.getState(CLIENT);
  const next = intake.nextField(state);
  assert.equal(next, 'projectType', 'the first missing required field');

  db.saveIntake(CLIENT, { stage: 'discovering', fields: { projectType: 'web app' }, asked: ['projectType'], quote: null, quoted_at: null });
  intake.resetState(CLIENT);
  intake.mergeExternalFields(CLIENT, { projectType: 'web app' });
  assert.equal(intake.nextField(intake.getState(CLIENT)), 'goal', 'skips what is already answered');
});

test('collector: several answers in one message are read back once', () => {
  clean();
  const turn = collector.collectorTurn({
    updates: { projectType: 'web app', features: 'login, payments' },
    previous: {},
    lang: 'en',
    text: 'I need a web app with login and payments',
  });
  assert.equal(turn.kind, 'confirm');
  assert.match(turn.reply, /Here is what I understood/);
  assert.match(turn.reply, /Project type: web app/);
  assert.match(turn.reply, /Is that right\?$/);
  assert.equal((turn.reply.match(/\?/g) || []).length, 1, 'exactly one question');

  // One answer is not a receipt.
  assert.equal(collector.collectorTurn({ updates: { features: 'login' }, previous: {}, lang: 'en' }), null);
});

test('collector: a correction replaces the earlier answer and says what changed', () => {
  clean();
  const turn = collector.collectorTurn({
    updates: { budget: '80k' },
    previous: { budget: '50k' },
    lang: 'en',
    text: 'actually the budget is 80k not 50k',
  });
  assert.equal(turn.kind, 'correct');
  assert.match(turn.reply, /Updated:/);
  assert.match(turn.reply, /Budget: 80k/);
  assert.doesNotMatch(turn.reply, /50k/, 'the old value is not repeated as an answer');
  assert.equal(collector.isCorrection('actually, 3 months'), true);
  assert.equal(collector.isCorrection('galat bataya, budget 80000 hai'), true);
  assert.equal(collector.isCorrection('درست، بجٹ 80000'), true);
});

test('collector: owner-defined fields, askIf, and the 12-field limit', () => {
  clean();
  const fields = [
    { id: 'need', label: 'Need', ask: 'what you need', type: 'text', required: true },
    { id: 'budget', label: 'Budget', ask: 'your budget', type: 'number' },
    { id: 'catering', label: 'Catering', ask: 'how many guests', type: 'number', askIf: { field: 'need', includes: 'catering' } },
  ];
  profileMod.setPath('business.intake', { fields, required: ['need'] });
  const spec = intake.intakeSpec();
  assert.equal(spec.ids.join(','), 'need,budget,catering');
  assert.equal(spec.source, 'business.intake');

  intake.resetState(CLIENT);
  intake.mergeExternalFields(CLIENT, { need: 'a birthday cake' });
  assert.equal(intake.nextField(intake.getState(CLIENT)), 'budget', 'askIf hides catering');
  intake.mergeExternalFields(CLIENT, { need: 'catering for 40 guests' });
  assert.equal(intake.nextField(intake.getState(CLIENT)), 'budget', 'budget still comes first');

  const tooMany = { fields: Array.from({ length: 13 }, (_, i) => ({ id: `f${i}`, label: `F${i}` })) };
  assert.equal(intake.validateIntake(tooMany).errors.some((e) => /maximum is 12/.test(e)), true);
  const badType = intake.validateIntake({ fields: [{ id: 'a', type: 'colour' }] }).errors;
  assert.ok(badType.some((e) => /type/.test(e)));

  profileMod.setPath('business.intake', { fields: [], required: [] });
  intake.resetState(CLIENT);
});

test('collector: the agency flow is unchanged — same fields, same order', () => {
  const spec = intake.intakeSpec();
  assert.ok(spec.ids.includes('projectType'));
  assert.ok(spec.ids.includes('goal'));
  assert.ok(spec.ids.includes('features'));
  assert.deepEqual(spec.required, ['projectType', 'goal', 'features']);
});

// ════════════════════════════════════════════════════════════
// 5. no guessing
// ════════════════════════════════════════════════════════════

test('no guessing: no published price means no number is invented', () => {
  clean();
  profileMod.setPath('catalog', { items: [] });
  profileMod.setPath('owner.services', []);
  assert.equal(noGuess.hasPublishedPrices(), false, 'this profile publishes no prices');
  profileMod.setPath('catalog', { items: [{ id: 'web', name: 'Website', min: 60000, max: 180000 }] });
  assert.deepEqual(noGuess.publishedPrices(), [60000], 'the band comes from the catalog');
  assert.equal(noGuess.hasPublishedPrices(), true);
  profileMod.setPath('catalog', { items: [] });
});

test('no guessing: an unwritten policy is a question for the owner', () => {
  clean();
  profileMod.setPath('policies', {});
  assert.equal(noGuess.unansweredPolicy('can I get a refund?'), 'refund');
  assert.equal(noGuess.unansweredPolicy('how long is delivery in F-11?'), 'delivery');
  profileMod.setPath('policies', { refund: 'Within 7 days, unopened.' });
  assert.equal(noGuess.unansweredPolicy('can I get a refund?'), null);
  profileMod.setPath('policies', {});
});

// ════════════════════════════════════════════════════════════
// 6. the pipeline (fake transport, mock model)
// ════════════════════════════════════════════════════════════

test('pipeline: "I want to speak to a human" hands over, pauses the bot and tells the owner', async () => {
  clean();
  knownContact();
  const s = sock();
  await say(s, 'I want to speak to a human');

  const client = toClient(s);
  assert.equal(client.length, 1);
  assert.match(client[0], /owner|person/i);
  assert.ok(toOwner(s).some((t) => /asked for a human/.test(t)), toOwner(s).join(' | '));
  assert.ok(db.getContact(CLIENT).bot_paused_until, 'the chat is paused for the owner');
  const logged = db.recentEvents(30).find((e) => e.type === 'decision');
  assert.ok(logged, 'the decision was logged');
  assert.match(logged.detail, /human_request/);
});

test('pipeline: an insult is answered once, calmly, and never with the model', async () => {
  clean();
  knownContact();
  const s = sock();
  await say(s, 'you are stupid');
  const client = toClient(s);
  assert.equal(client.length, 1);
  assert.match(client[0], /professional|insult/i);
  assert.ok(!/\bstupid\b/i.test(client[0]), 'the insult is not repeated back');
});

test('pipeline: a repeated insult starts a cool-down and pings the owner once', async () => {
  clean();
  knownContact();
  const s = sock();
  await say(s, 'you are stupid');
  await say(s, 'tum bewakoof ho');
  assert.ok(toOwner(s).some((t) => /cool-down|insulted/.test(t)), toOwner(s).join(' | '));
  assert.ok(db.recentEvents(30).some((e) => e.type === 'decision' && /insult/.test(e.detail)));
});

test('pipeline: off-topic is ignored when you tell it to, and the reason is logged', async () => {
  clean();
  knownContact();
  profileMod.setPath('business.conversation.offTopic', 'ignore');
  const s = sock();
  await say(s, 'count 1 to 100');
  assert.equal(toClient(s).length, 0, 'no reply, no reaction, no typing');
  const logged = db.recentEvents(40).find((e) => e.type === 'decision');
  assert.match(logged.detail, /off_topic_ignore/);
  profileMod.setPath('business.conversation.offTopic', 'redirect');
});

test('pipeline: a price question with no published data becomes an owner task', async () => {
  clean();
  knownContact();
  profileMod.setPath('catalog', { items: [] });
  profileMod.setPath('owner.services', []);
  profileMod.setPath('policies', {});
  for (const table of ['intake', 'events', 'decisions']) db.run(`DELETE FROM ${table}`);

  const s = sock();
  await say(s, 'what is your price for a website');
  const client = toClient(s);
  assert.equal(client.length, 1);
  assert.match(client[0], /confirm|owner/i);
  assert.doesNotMatch(client[0], /\d{4,}/, 'no number was invented');
  assert.ok(toOwner(s).some((t) => /asked about price/.test(t)), 'the owner gets the exact question');
  assert.ok(db.recentEvents(60).some((e) => e.type === 'owner_task_created'), 'the task is logged');
});

test('pipeline: with published prices the same question is not sent to the owner', async () => {
  clean();
  knownContact();
  profileMod.setPath('owner.services', []);
  profileMod.setPath('catalog', { items: [{ id: 'web', name: 'Website', min: 60000, max: 180000, keywords: ['website'] }] });
  const s = sock();
  await say(s, 'what is your price for a website');
  assert.equal(toOwner(s).some((t) => /asked about price/.test(t)), false, 'nothing to ask: it is published');
  assert.ok(toClient(s).length >= 1, 'the customer is answered');
  profileMod.setPath('catalog', { items: [] });
});

test('pipeline: opt-out is still answered instantly, with the decision logged', async () => {
  clean();
  knownContact();
  const s = sock();
  await say(s, 'stop messaging me');
  const client = toClient(s);
  assert.equal(client.length, 1);
  assert.match(client[0], /no more reminders|stop|band|بند/i);
});

test('pipeline: "build me an app" starts the collector and asks one question', async () => {
  clean();
  knownContact();
  const s = sock();
  await say(s, 'I want to build me an app for my bakery');
  const row = db.getIntake(CLIENT);
  assert.ok(row, 'an intake row was written');
  assert.ok(Object.keys(row.fields || {}).length >= 1, `fields: ${JSON.stringify(row.fields)}`);
  assert.ok(toClient(s).length >= 1, 'the client is asked something');
});

test('pipeline: several answers at once are read back, and the question count stays at one', async () => {
  clean();
  knownContact();
  const s = sock();
  await say(s, 'we need a web app with login and payments, budget 200000, launch in March');
  const client = toClient(s);
  assert.equal(client.length, 1, 'one message, not a form');
  assert.ok(/\?/.test(client[0]), 'it asks exactly one thing');
  assert.ok((client[0].match(/\?/g) || []).length === 1, client[0]);
});

test('pipeline: a brief is generated from what was collected, with the gaps named', () => {
  clean();
  db.saveIntake(CLIENT, {
    stage: 'discovering',
    fields: { projectType: 'web app', features: 'login, payments' },
    asked: ['projectType', 'features'],
    quote: null,
    quoted_at: null,
  });
  intake.refreshState(CLIENT);
  const md = briefs.briefMarkdown(CLIENT, { businessType: 'Agency' });

  assert.match(md, /^# Agency brief/);
  assert.match(md, /## Collected/);
  assert.match(md, /Project type\*\*: web app/);
  assert.match(md, /## Missing information/);
  assert.match(md, /Goal & audience/);
  assert.match(md, /## Open questions/);
  assert.match(md, /Next question:/);

  const brief = briefs.briefFor(CLIENT);
  assert.ok(brief.percent > 0 && brief.percent < 100);
  assert.equal(brief.complete, false);
});

test('pipeline: a stalled brief is due; a complete one is due for a better reason', () => {
  clean();
  const old = new Date(Date.now() - 9 * 3600_000).toISOString();
  db.run('INSERT INTO intake (number, stage, fields, asked, updated_at) VALUES (?,?,?,?,?)', [
    CLIENT,
    'discovering',
    JSON.stringify({ projectType: 'web app' }),
    JSON.stringify(['projectType']),
    old,
  ]);
  intake.refreshState(CLIENT);
  const stale = briefs.briefDue(CLIENT);
  assert.equal(stale.due, true);
  assert.equal(stale.because, 'stalled');
  assert.match(briefs.briefSummaryLine(CLIENT), /Brief ready/);
});

// ════════════════════════════════════════════════════════════
// 7. the log, and the commands
// ════════════════════════════════════════════════════════════

test('log: a decision row never contains the customer\'s words', async () => {
  clean();
  knownContact();
  const secret = 'my name is Ayesha and my number is 03001234567';
  const d = await decisionMod.decide({ number: CLIENT, text: secret, lang: 'en' });
  decisionMod.recordDecision(CLIENT, d, { lang: 'en' });

  const rows = db.all('SELECT * FROM decisions');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(!String(row.rationale).includes('Ayesha'));
  assert.ok(!/\d{5,}/.test(String(row.rationale)), row.rationale);
  assert.ok(String(row.rationale).length <= 200);
  assert.equal(row.action, d.action);

  // And an insult is logged as a reason code, not as the insult.
  const insult = await decisionMod.decide({ number: CLIENT, text: 'you are stupid', lang: 'en' });
  decisionMod.recordDecision(CLIENT, insult, { lang: 'en' });
  const latest = db.all('SELECT * FROM decisions ORDER BY id DESC LIMIT 1')[0];
  assert.ok(!/stupid/i.test(String(latest.rationale)), latest.rationale);
});

test('.decisions lists the actions and reasons, and says nothing was stored', async () => {
  clean();
  knownContact();
  const d = await decisionMod.decide({ number: CLIENT, text: 'I want to speak to a human', lang: 'en' });
  decisionMod.recordDecision(CLIENT, d, { lang: 'en' });

  const res = await handleOwnerCommand(null, OWNER_JID, '.decisions');
  assert.match(res.reply, /Last 1 decisions/);
  assert.match(res.reply, /handover · human_request/);
  assert.match(res.reply, /No message text is stored/);

  clean();
  const empty = await handleOwnerCommand(null, OWNER_JID, '.decisions');
  assert.match(empty.reply, /No decisions logged yet/);
});

test('.control prints the settings in force, or how to turn it on', async () => {
  const on = await handleOwnerCommand(null, OWNER_JID, '.control');
  assert.match(on.reply, /Conversation Control/);
  assert.match(on.reply, /Scope: business_only/);
  assert.match(on.reply, /Never ignored: opt-out/);

  profileMod.setPath('features.conversationControl', false);
  const off = await handleOwnerCommand(null, OWNER_JID, '.control');
  assert.match(off.reply, /Conversation Control is off/);
  profileMod.setPath('features.conversationControl', true);
});

test('.brief <number> prints the markdown, and refuses politely when empty', async () => {
  clean();
  const empty = await handleOwnerCommand(null, OWNER_JID, `.brief ${CLIENT}`);
  assert.match(empty.reply, /Nothing collected/);

  db.saveIntake(CLIENT, { stage: 'discovering', fields: { projectType: 'web app' }, asked: [], quote: null, quoted_at: null });
  intake.refreshState(CLIENT);
  const res = await handleOwnerCommand(null, OWNER_JID, `.brief ${CLIENT}`);
  assert.match(res.reply, /# Agency brief/);
  assert.match(res.reply, /Project type/);
});

test('.accuracy reports the decisions, and .impact mentions them', async () => {
  clean();
  const { accuracyReport, accuracyText } = await import('../src/services/accuracy.js');
  const now = new Date();
  for (const action of ['reply', 'ignore', 'handover']) {
    db.run('INSERT INTO decisions (number, action, reason, confidence, source, rationale, created_at) VALUES (?,?,?,?,?,?,?)', [
      CLIENT,
      action,
      'test',
      0.8,
      'rules',
      'test',
      now.toISOString(),
    ]);
  }
  const report = accuracyReport({ days: 7, now });
  assert.deepEqual(
    report.decisions.reduce((acc, d) => ({ ...acc, [d.action]: d.count }), {}),
    { reply: 1, ignore: 1, handover: 1 }
  );
  assert.match(accuracyText(report), /\*Decisions\*/);
});

// ════════════════════════════════════════════════════════════
// 8. the flag, off
// ════════════════════════════════════════════════════════════

test('flag off: no decisions, no intake fields, the old pipeline exactly', async () => {
  clean();
  profileMod.setPath('features.conversationControl', false);
  knownContact();
  const s = sock();
  await say(s, 'tell me a joke');

  // The old scope guard still refuses it: that behaviour predates the flag.
  assert.equal(toClient(s).length, 1);
  assert.match(toClient(s)[0], /outside|ke kaam se|نہیں کرتے/i);
  assert.equal(db.all('SELECT * FROM decisions').length, 0, 'nothing is decided or logged');
  assert.equal(db.recentEvents(30).some((e) => e.type === 'decision'), false);

  profileMod.setPath('features.conversationControl', true);
});

test('flag off: an insult reaches the model, unchanged from before', async () => {
  clean();
  profileMod.setPath('features.conversationControl', false);
  knownContact();
  const s = sock();
  await say(s, 'you are stupid');
  const client = toClient(s);
  assert.equal(client.length, 1);
  // The boundary line is a Conversation Control behaviour; without the flag the
  // model answers, and it does not repeat the insult.
  assert.doesNotMatch(client[0], /not going to trade insults/);
  assert.equal(db.all('SELECT * FROM decisions').length, 0);
  profileMod.setPath('features.conversationControl', true);
});

test('flag off: the settings are inert — a strict profile behaves like a default one', async () => {
  clean();
  profileMod.setPath('features.conversationControl', false);
  profileMod.setPath('business.conversation.offTopic', 'ignore');
  knownContact();
  const s = sock();
  await say(s, 'count 1 to 100');
  assert.equal(toClient(s).length, 1, 'the old scope refusal still goes out');
  profileMod.setPath('business.conversation.offTopic', 'redirect');
  profileMod.setPath('features.conversationControl', true);
});
