// src/eval/run.js
// One scenario, end to end, in this process.
//
// Between scenarios the database is emptied and the profile is rewritten, so a
// scenario can only ever see its own fixtures. Everything the bot does — the
// handler, the tools, growth, privacy, orders — is the real code: the harness
// only replaces the model and the clock.

import fs from 'node:fs';
import path from 'node:path';
import { evalConfigDir, ownerNumber, defaultCustomer, profilePath } from './evalEnv.js';
import { allowedNumbers } from './fixtures.js';

const TEMPLATE_DIR = new URL('../../config/templates/', import.meta.url);

// Fixed wall clock for anything the harness can control. Conversations that use
// "today" still read the real clock; scenarios that care about dates say so with
// `fixture.dates`.
export const FIXED_NOW = new Date('2026-11-17T08:00:00.000Z'); // 13:00 Karachi
export const NIGHT_NOW = new Date('2026-11-17T18:00:00.000Z'); // 23:00 Karachi

let mods = null;

async function load() {
  if (mods) return mods;
  const [db, env, orders, growth, crm, privacy, booking, intake, toolCalling, reactivation] = await Promise.all([
    import('../utils/db.js'),
    import('../config/env.js'),
    import('../services/orders.js'),
    import('../services/growth.js'),
    import('../services/crm.js'),
    import('../services/privacy.js'),
    import('../services/bookingAgent.js'),
    import('../core/projectIntake.js'),
    import('../core/toolCalling.js'),
    import('../services/reactivationAgent.js'),
  ]);
  await db.initDB();
  mods = { db, env, orders, growth, crm, privacy, booking, intake, toolCalling, reactivation };
  return mods;
}

export async function boot() {
  return load();
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, extra) {
  if (!isPlainObject(base)) return extra;
  if (!isPlainObject(extra)) return extra;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(base[key])) out[key] = deepMerge(base[key], value);
    else out[key] = value;
  }
  return out;
}

function readTemplate(name) {
  const file = new URL(`${name}.json`, TEMPLATE_DIR);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete raw._template;
  return raw;
}

/** The profile this scenario runs against: the tenant template, then overrides. */
export function resolveProfile(scenario) {
  const template = readTemplate(scenario.template);
  const profile = deepMerge(template, {
    owner: { name: 'Eval Owner', number: ownerNumber, timezone: 'Asia/Karachi' },
    business: { name: `Test ${scenario.template}`, city: 'Islamabad', currency: 'PKR' },
  });
  const merged = deepMerge(profile, scenario.profile || {});
  merged.owner = { ...merged.owner, number: ownerNumber };
  return merged;
}

function writeProfile(profile) {
  fs.writeFileSync(profilePath(), JSON.stringify(profile, null, 2));
}

export function resetDatabase(db) {
  const tables = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  for (const row of tables) {
    try {
      db.run(`DELETE FROM "${row.name}"`);
    } catch {
      /* a virtual/shadow table that cannot be emptied is not worth failing over */
    }
  }
  // Rows are gone, but sqlite would keep counting. A scenario that creates an
  // order should see order #1 every time, on every machine.
  try {
    db.run('DELETE FROM sqlite_sequence');
  } catch {
    /* no AUTOINCREMENT table has been used yet */
  }
}

// Only rows a customer or the owner would notice. A pending confirmation and a
// growth draft are internal bookkeeping, not side effects on the world.
const SIDE_EFFECT_TABLES = [
  'orders', 'bookings', 'contact_tags', 'contact_notes', 'review_asks', 'referrals',
  // A source attribution is a write too: the first message adds a row, and a
  // scenario may assert it happened exactly once.
  'contact_sources',
];

function countTable(db, table) {
  try {
    return db.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n || 0;
  } catch {
    return 0;
  }
}

function seedScenario({ db, scenario, number, now, tenant = null }) {
  const seed = scenario.seed || {};
  const jid = `${number}@s.whatsapp.net`;
  const ago = (days) => new Date(now.getTime() - Number(days) * 86_400_000).toISOString();

  db.upsertContact(number, {
    jid,
    name: seed.contact?.name || 'Test Customer',
    push_name: seed.contact?.name || 'Test Customer',
    language: seed.contact?.language || scenario.language,
  });
  // `upsertContact` numbers a brand-new row as 1 message even though nobody has
  // written yet. Zero it here so a scenario that seeds a name (but no history)
  // looks like a genuinely first-time contact — which is what first-touch
  // attribution keys off.
  db.run('UPDATE contacts SET message_count = ? WHERE number = ?', [
    Number(seed.contact?.message_count ?? 0),
    number,
  ]);
  if (seed.contact?.last_seen_days_ago !== undefined) {
    db.run('UPDATE contacts SET last_seen = ? WHERE number = ?', [ago(seed.contact.last_seen_days_ago), number]);
  }
  if (seed.contact?.pausedMinutes) {
    db.setContactPaused(number, new Date(now.getTime() + Number(seed.contact.pausedMinutes) * 60_000).toISOString());
  }

  for (const other of seed.otherNumbers || []) {
    db.upsertContact(String(other).replace(/\D/g, ''), { jid: `${String(other).replace(/\D/g, '')}@s.whatsapp.net`, name: 'Someone Else' });
  }

  for (const msg of seed.messages || []) {
    db.saveMessage(number, msg.role === 'assistant' ? 'assistant' : 'user', String(msg.text || ''));
    if (msg.minutesAgo) {
      db.run('UPDATE messages SET created_at = ? WHERE id = (SELECT MAX(id) FROM messages WHERE number = ?)', [
        new Date(now.getTime() - Number(msg.minutesAgo) * 60_000).toISOString(),
        number,
      ]);
    }
  }

  for (const fact of seed.facts || []) {
    db.run('INSERT INTO facts (number, key, value, updated_at) VALUES (?,?,?,?)', [number, fact.key, fact.value, now.toISOString()]);
  }

  for (const tag of seed.tags || []) {
    db.addContactTag({ number, tag: String(tag).toLowerCase(), source: 'owner' });
  }
  for (const note of seed.notes || []) {
    db.addContactNote({ number, note: String(note) });
  }

  for (const [i, order] of (seed.orders || []).entries()) {
    const created = new Date(now.getTime() - Number(order.hoursAgo || 0) * 3_600_000).toISOString();
    db.run(
      'INSERT INTO orders (chat, items, total, currency, name, status, key, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [
        order.chat ? `${String(order.chat).replace(/\D/g, '')}@s.whatsapp.net` : jid,
        JSON.stringify(order.items || [{ name: 'Item', qty: 1 }]),
        Number(order.total) || 0,
        order.currency || 'PKR',
        order.name || 'Test Customer',
        order.status || 'placed',
        `eval-${scenario.id}-${i}`,
        created,
      ]
    );
  }
  if (seed.orderEvents) {
    const last = db.get('SELECT id FROM orders ORDER BY id DESC LIMIT 1');
    if (last) {
      for (const event of seed.orderEvents) {
        db.logOrderEvent({ orderId: last.id, from: event.from || null, to: event.to || null, actor: event.actor || 'owner', detail: event.detail || null });
      }
    }
  }

  for (const booking of seed.bookings || []) {
    // "Tomorrow" is relative to the real clock, because the booking agent reads
    // the real clock too. A fixed date here would silently never collide.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    db.run('INSERT INTO bookings (chat, service, date, time, name, status) VALUES (?,?,?,?,?,?)', [
      jid,
      booking.service || 'Table',
      booking.date || tomorrow,
      booking.time || '19:00',
      booking.name || 'Test Customer',
      booking.status || 'booked',
    ]);
  }

  // Tracked links the owner already created: a scenario can then send the
  // message the QR would send, marker and all.
  for (const src of seed.sources || []) {
    const name = String(src.source || 'poster').toLowerCase();
    db.run('INSERT OR IGNORE INTO tracked_sources (tenant, source, code, label, message, created_at) VALUES (?,?,?,?,?,?)', [
      tenant,
      name,
      String(src.code || 'ab12c').toLowerCase(),
      src.label || name,
      src.message || `Hi, I saw you on ${name} [s:${String(src.code || 'ab12c').toLowerCase()}]`,
      src.createdAt || now.toISOString(),
    ]);
  }

  if (seed.referralAttributed) {
    db.logEvent('referral_attributed', number, 'REF-XXXX');
  }

  for (const doc of seed.knowledge || []) {
    db.run('INSERT INTO knowledge (source, title, chunk_no, text, hash, created_at) VALUES (?,?,?,?,?,?)', [
      doc.source || `text:${doc.title || 'doc'}`,
      doc.title || 'Document',
      0,
      String(doc.text || ''),
      `eval-${Math.random().toString(36).slice(2)}`,
      now.toISOString(),
    ]);
  }

  if (seed.optout) db.optOut(number, { reason: seed.optout === true ? 'asked to stop' : String(seed.optout) });

  for (const [key, value] of Object.entries(seed.settings || {})) {
    db.setSetting(key, value);
  }

  return { jid };
}

function makeTransport({ db, number, now }) {
  const sent = [];
  const jid = `${number}@s.whatsapp.net`;
  const transport = {
    kind: 'baileys',
    sent,
    user: { id: `${ownerNumber}:1@s.whatsapp.net`, name: 'Eval Owner' },
    async sendMessage(to, payload) {
      sent.push({ jid: to, payload, at: now });
      db.saveMessage(String(to).split('@')[0], to.startsWith(ownerNumber) ? 'owner' : 'assistant', payload?.text || '[media]');
      return { key: { id: `eval-${sent.length}-${Math.random().toString(36).slice(2, 8)}` } };
    },
    async sendPresenceUpdate() {},
    async readMessages() {},
    async getMedia() {
      return { buffer: Buffer.from('eval-audio-bytes'), mimetype: 'audio/ogg' };
    },
    can: () => true,
    windowOpen: () => true,
  };
  void jid;
  return transport;
}

/** The fake customer number for a run: the last three digits come from the nonce. */
function customerFor(nonce) {
  const digits = String(nonce).replace(/\D/g, '').slice(-3);
  if (!digits) return defaultCustomer;
  return defaultCustomer.slice(0, -digits.length) + digits.padStart(3, '0').slice(-3);
}

/**
 * The handler remembers message ids in memory, so two runs of the same
 * scenario would silently drop the second one as a redelivery. Every run gets
 * its own tag; nothing else about a run depends on it.
 */
function runTag(nonce) {
  return `${nonce}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function messageFor({ scenario, turn, number, index, nonce, tag }) {
  const jid = `${number}@s.whatsapp.net`;
  const base = { key: { remoteJid: jid, fromMe: false, id: `${scenario.id}-${tag}-${index}` }, pushName: 'Test Customer' };

  if (turn.voice) {
    return {
      ...base,
      message: { audioMessage: { mimetype: 'audio/ogg', seconds: 6, ptt: true } },
      // The transcript itself is stubbed at the network layer (see model.js).
    };
  }
  if (turn.image) {
    return { ...base, message: { imageMessage: { mimetype: 'image/jpeg', caption: turn.caption || '' } } };
  }
  return { ...base, message: { conversation: String(turn.user || '') } };
}

function fixedDate(turn) {
  const raw = turn.now || '';
  if (/^night$/i.test(raw)) return NIGHT_NOW;
  if (raw) return new Date(raw);
  return FIXED_NOW;
}

async function runAction({ turn, transport, m, scenario, number }) {
  const now = fixedDate(turn);
  if (turn.action === 'payment_reminder') {
    return m.orders.runPaymentReminders({ transport, now });
  }
  if (turn.action === 'notify_customer') {
    const id = Number(turn.orderId) || m.db.get('SELECT id FROM orders ORDER BY id DESC LIMIT 1')?.id;
    const order = id ? m.db.getOrder(id) : null;
    if (!order) return { ok: false, reason: 'no_order' };
    return m.orders.notifyCustomer(transport, order, turn.state || order.status, { now });
  }
  if (turn.action === 'transition') {
    const id = Number(turn.orderId) || m.db.get('SELECT id FROM orders ORDER BY id DESC LIMIT 1')?.id;
    const res = await m.orders.transitionOrder(id, turn.to, { actor: turn.actor || 'owner', now, override: Boolean(turn.override) });
    if (res.ok && turn.notify) await m.orders.notifyCustomer(transport, res.order, res.to, { now });
    return res;
  }
  if (turn.action === 'reactivation_send') {
    return m.reactivation.startCampaign({ now, tag: turn.tag || null });
  }
  return { ok: false, reason: 'unknown_action' };
}

/**
 * Run one scenario.
 * @param {object} scenario validated scenario object
 * @param {{mode?:string, model:object, nonce?:string}} opts
 */
export async function runScenario(scenario, { mode = 'deterministic', model, nonce = 'r1' } = {}) {
  const m = await load();
  const { db, env } = m;

  resetDatabase(db);
  m.booking.clearOffers?.();
  m.toolCalling.resetNativeSupport?.();

  const profile = resolveProfile(scenario);
  writeProfile(profile);
  env.reloadProfile();
  m.intake.resetState?.(scenario.number || defaultCustomer);

  // Every scenario gets its own fake customer. Real code keeps per-customer
  // state in memory (repeat discounts, spam scores, booking offers), so one
  // scenario's history must not be able to change another's result.
  const number = String(scenario.number || customerFor(nonce)).replace(/\D/g, '');
  const { jid } = seedScenario({ db, scenario, number, now: FIXED_NOW, tenant: env.config?.tenant?.slug || null });
  const transport = makeTransport({ db, number, now: FIXED_NOW });
  transport.jid = jid;

  model.reset?.();
  model.install?.();
  const tag = runTag(nonce);

  const { handleIncoming, drainBatches } = await import('../handlers/messageHandler.js');
  const { handleOwnerCommand } = await import('../handlers/ownerCommands.js');

  const run = {
    id: scenario.id,
    mode,
    profile,
    turns: [],
    replies: [],
    ownerMessages: [],
    sideEffects: [],
    confirmationAsked: 0,
    modelCalls: 0,
    exhausted: 0,
    seedEcho: { ...(scenario.seed || {}), numbers: scenario.fixture?.numbers || [] },
    extraNumbers: [],
  };

  // Dates the bot itself computes (a booking for "tomorrow") are allowed only
  // where a scenario asks for them — otherwise an invented "10" would slip past
  // the price check.
  if (scenario.fixture?.dates) {
    for (let d = 0; d < 21; d += 1) {
      const day = new Date(FIXED_NOW.getTime() + d * 86_400_000);
      run.extraNumbers.push(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), day.toISOString().slice(0, 10));
    }
    for (let h = 0; h < 24; h += 1) run.extraNumbers.push(`${String(h).padStart(2, '0')}:00`, `${String(h).padStart(2, '0')}:30`);
  }

  const closure = await import('./model.js');

  for (const [index, turn] of scenario.turns.entries()) {
    const before = Object.fromEntries(SIDE_EFFECT_TABLES.map((t) => [t, countTable(db, t)]));
    const pendingBefore = Boolean(db.getPendingConfirmation(transport.jid));
    const sentStart = transport.sent.length;

    const steps = Array.isArray(turn.model) ? turn.model : [];
    if (steps.length) model.beginTurn(steps);

    let restoreFetch = null;
    if (turn.voice && mode === 'deterministic') {
      restoreFetch = closure.installTranscriptStub(turn.voiceTranscript || 'Salam, table book karni hai');
    }

    try {
      if (turn.user !== undefined) {
        await handleIncoming(transport, messageFor({ scenario, turn, number, index, nonce, tag }));
      } else if (turn.owner !== undefined) {
        const res = await handleOwnerCommand(transport, `${ownerNumber}@s.whatsapp.net`, turn.owner, ownerNumber);
        if (res?.reply) transport.sent.push({ jid: `${ownerNumber}@s.whatsapp.net`, payload: { text: res.reply }, at: FIXED_NOW });
      } else if (turn.action) {
        await runAction({ turn, transport, m, scenario, number });
      }
    } catch (err) {
      db.logEvent('eval_turn_error', number, { turn: index, error: String(err.message).slice(0, 200) });
    }

    // The handler queues the reply (debounce), so wait for the queue to empty —
    // otherwise the harness would judge a conversation that has not happened yet.
    // The transcript stub has to stay installed until the batch has actually run.
    const drained = await drainBatches({ timeoutMs: 5000 });
    if (restoreFetch) restoreFetch();
    if (!drained) db.logEvent('eval_drain_timeout', number, { turn: index });
    // And let the last bits of fire-and-forget work (summaries) settle.
    await new Promise((r) => setTimeout(r, 10));

    const leftover = steps.length ? model.endTurn() : 0;

    const sent = transport.sent.slice(sentStart);
    const replies = sent.filter((s) => s.jid === transport.jid).map((s) => String(s.payload?.text || ''));
    const owner = sent.filter((s) => s.jid.startsWith(ownerNumber)).map((s) => String(s.payload?.text || ''));

    for (const text of replies) run.replies.push({ turn: index, text, kind: 'customer' });
    for (const text of owner) run.ownerMessages.push({ turn: index, text, kind: 'owner' });

    for (const table of SIDE_EFFECT_TABLES) {
      const after = countTable(db, table);
      if (after > before[table]) run.sideEffects.push({ turn: index, table, delta: after - before[table], pendingBefore });
    }

    const pendingAfter = Boolean(db.getPendingConfirmation(transport.jid));
    if (!pendingBefore && pendingAfter) run.confirmationAsked += 1;

    run.turns.push({ index, kind: turn.user !== undefined ? 'user' : turn.owner !== undefined ? 'owner' : 'action', leftover, pendingBefore, pendingAfter, replies: replies.length });
  }

  run.modelCalls = model.calls?.length || 0;
  run.exhausted = model.exhausted || 0;

  const events = db.recentEvents(500).reverse().map((e) => ({
    type: e.type,
    number: e.number || null,
    detail: e.detail || '',
  }));
  run.events = events;
  // Order ids are facts from the database, so quoting one back is not invention.
  run.orderIds = db.all('SELECT id FROM orders').map((r) => r.id);
  run.optouts = db.all('SELECT number FROM growth_optouts');
  run.growth = db.all('SELECT agent, number, reason, result, detail FROM growth_sends');
  run.contact = db.getContact(number) || null;

  // Numbers a scenario legitimately lets through (dates it asked for, ids it
  // quotes back in a required pattern).
  run.allowed = allowedNumbers({ profile, scenario, seeds: [run.seedEcho], extra: run.extraNumbers });

  return run;
}

export default { runScenario, resolveProfile, resetDatabase, deepMerge, boot, FIXED_NOW, NIGHT_NOW };
