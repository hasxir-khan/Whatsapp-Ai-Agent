// test/44-reliability.test.js
// Reliability alerts: one message per incident, a cooldown, and a recovery.
//
// Everything here is fake — a fake transport, a fake clock, a fake disk, a
// webhook that fails on purpose. What is real is the dedupe, the cooldown, the
// recovery message, the SLA rules and the promise that an alert channel that is
// down never costs the bot anything.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fakeSock, isolate } from './helpers.js';

const dataDir = isolate('reliability');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;

let envModule = null;

function writeProfile(patch = {}) {
  const profile = {
    owner: { name: 'T', number: '923001234567', timezone: 'Asia/Karachi' },
    business: { name: 'Test Cafe', type: 'Cafe', city: 'Islamabad', hours: 'Daily 00:00-23:59', currency: 'PKR' },
    features: { businessProfile: true, healthAlerts: true, ...(patch.features || {}) },
  };
  fs.writeFileSync(path.join(configDir, 'owner.json'), JSON.stringify(profile, null, 2));
  envModule?.reloadProfile?.();
}

// No backup folder, a disk with plenty of room, no webhook: the quiet baseline.
process.env.BACKUP_DIR = path.join(dataDir, 'backups');
fs.mkdirSync(process.env.BACKUP_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.BACKUP_DIR, 'default-2026-11-16.json.gz'), 'fake');
delete process.env.ALERT_WEBHOOK_URL;
delete process.env.SLACK_WEBHOOK_URL;
process.env.SLA_ALERT_MINUTES = '15';

writeProfile();

const db = await import('../src/utils/db.js');
await db.initDB();

const env = await import('../src/config/env.js');
envModule = env;
env.reloadProfile();

const { botState } = await import('../src/state.js');
const health = await import('../src/services/health.js');
const { registerTransport, clearTransports } = await import('../src/transport/index.js');

const MIN = 60_000;
const base = new Date('2026-11-16T10:00:00.000Z'); // a Monday, school hours
const at = (minutes) => new Date(base.getTime() + minutes * MIN);

function reset({ status = 'online', profile = {} } = {}) {
  db.run('DELETE FROM incidents');
  db.run('DELETE FROM events');
  db.run('DELETE FROM outbox');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM contacts');
  db.run('DELETE FROM growth_optouts');
  db.run('DELETE FROM usage');
  writeProfile(profile);
  botState.status = status;
  botState.lastError = null;
  clearTransports();
  health.setStatfs(() => ({ bsize: 4096, blocks: 1000, bavail: 500, bfree: 500 })); // ~50% free
  delete process.env.ALERT_WEBHOOK_URL;
  delete globalThis.fetch;
}

/** Register a fake transport so owner alerts have somewhere to land. */
function withOwnerSock() {
  const sock = fakeSock();
  registerTransport({ slug: 'default', kind: 'baileys', status: 'online', sock, isConnected: () => true });
  return sock;
}

const ownerTexts = (sock) => sock.sent.filter((m) => m.jid.startsWith('923001234567')).map((m) => m.payload?.text || '');

// ── the flag ────────────────────────────────────────────────

test('alerts do nothing until the owner turns them on', async () => {
  reset({ status: 'stopped', profile: { features: { healthAlerts: false } } });
  assert.equal(health.alertsEnabled(), false);
  const result = await health.runHealthCheck(base);
  assert.equal(result.opened.length, 0);
  assert.equal(db.recentIncidents(5).length, 0, 'a disabled monitor does not record incidents');
});

// ── one incident, one message ───────────────────────────────

test('a dead transport opens one incident and tells the owner once', async () => {
  reset({ status: 'logged_out' });
  const sock = withOwnerSock();

  const first = await health.runHealthCheck(base);
  assert.equal(first.opened.length, 1);
  assert.equal(first.opened[0].kind, 'transport');
  assert.equal(first.opened[0].severity, 'bad');
  assert.equal(ownerTexts(sock).filter((t) => t.includes('WhatsApp connection')).length, 1);

  // Still broken five minutes later: no second message, no second incident.
  const second = await health.runHealthCheck(at(5));
  assert.equal(second.opened.length, 0);
  assert.equal(second.notified.length, 0);
  assert.equal(db.recentIncidents(10).length, 1);
  assert.equal(ownerTexts(sock).length, 1);
});

test('after the cooldown, a still-broken thing may say so once more', async () => {
  reset({ status: 'logged_out' });
  const sock = withOwnerSock();

  await health.runHealthCheck(base);
  await health.runHealthCheck(at(5));
  assert.equal(ownerTexts(sock).length, 1);

  // default cooldown is 30 minutes
  const later = await health.runHealthCheck(at(31));
  assert.equal(later.notified.length, 1);
  assert.equal(ownerTexts(sock).length, 2);
  assert.equal(db.recentIncidents(10).length, 1, 'still the same incident, not a new one');
});

test('recovery is announced once, and the incident closes', async () => {
  reset({ status: 'reconnecting' });
  const sock = withOwnerSock();

  await health.runHealthCheck(base);
  botState.status = 'online';

  const recovered = await health.runHealthCheck(at(10));
  assert.equal(recovered.resolved.length, 1);
  assert.match(ownerTexts(sock).at(-1), /back to normal|back online/);

  const again = await health.runHealthCheck(at(20));
  assert.equal(again.resolved.length, 0, 'a closed incident is not closed twice');
  assert.equal(db.openIncidents().length, 0);
});

// ── the other checks ────────────────────────────────────────

test('an outbox backlog that is old enough is an incident; a young one is not', async () => {
  reset();
  db.run(
    "INSERT INTO outbox (jid, payload, kind, tries, status, created_at) VALUES (?,?,?,?,?,?)",
    ['923001112233@s.whatsapp.net', '{"text":"hi"}', 'text', 1, 'pending', new Date(base.getTime() - 2 * MIN).toISOString()]
  );

  const young = await health.runHealthCheck(base);
  assert.equal(young.opened.length, 0, 'two minutes is not a backlog');

  const old = await health.runHealthCheck(at(20));
  assert.equal(old.opened.length, 1);
  assert.equal(old.opened[0].kind, 'outbox');
});

test('an exhausted AI quota is an incident', async () => {
  reset();
  db.run('INSERT INTO usage (day, llm_calls) VALUES (?, ?)', [new Date().toISOString().slice(0, 10), 999999]);
  const result = await health.runHealthCheck(base);
  const llm = result.opened.find((i) => i.kind === 'llm');
  assert.ok(llm, 'a spent quota is not a silent state');
  assert.equal(llm.severity, 'bad');
});

test('a run of provider failures is an incident', async () => {
  reset();
  for (let i = 0; i < 3; i += 1) {
    db.logEvent('llm_rate_limited', null, { provider: 'groq' });
    db.run('UPDATE events SET created_at = ? WHERE id = (SELECT MAX(id) FROM events)', [new Date(base.getTime() - i * MIN).toISOString()]);
  }
  const result = await health.runHealthCheck(base);
  assert.ok(result.opened.some((i) => i.kind === 'llm'));
});

test('a full disk is an incident, and the check reads the numbers it is given', async () => {
  reset();
  health.setStatfs(() => ({ bsize: 4096, blocks: 1000, bavail: 30, bfree: 30 })); // 3% free
  const result = await health.runHealthCheck(base);
  const disk = result.opened.find((i) => i.kind === 'disk');
  assert.ok(disk);
  assert.equal(disk.severity, 'bad');
});

test('a backup older than a week is an incident; a fresh one is not', async () => {
  reset();
  const dir = process.env.BACKUP_DIR;
  for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));

  const none = await health.runHealthCheck(base);
  assert.ok(none.opened.some((i) => i.kind === 'backup'), 'no backup at all is worse than an old one');

  db.run('DELETE FROM incidents');
  const fresh = path.join(dir, 'default-today.json.gz');
  fs.writeFileSync(fresh, 'fake');
  const now = new Date();
  const withFresh = await health.runHealthCheck(now);
  assert.ok(!withFresh.opened.some((i) => i.kind === 'backup'));

  const old = new Date(Date.now() - 9 * 24 * 60 * MIN);
  fs.utimesSync(fresh, old, old);
  const withOld = await health.runHealthCheck(now);
  assert.ok(withOld.opened.some((i) => i.kind === 'backup'));
  fs.unlinkSync(fresh);
});

test('a reconnect loop is caught by counting, not by vibes', async () => {
  reset();
  for (let i = 0; i < 3; i += 1) {
    db.logEvent('connection_lost', null, { attempt: i + 1 });
    db.run('UPDATE events SET created_at = ? WHERE id = (SELECT MAX(id) FROM events)', [
      new Date(base.getTime() - i * MIN).toISOString(),
    ]);
  }
  const result = await health.runHealthCheck(base);
  assert.ok(result.opened.some((i) => i.kind === 'reconnects'));
});

// ── the SLA ─────────────────────────────────────────────────

function seedWaitingCustomer({ minutesAgo = 20, paused = false, answered = false, number = '923001112233' } = {}) {
  db.upsertContact(number, { jid: `${number}@s.whatsapp.net`, name: 'Ayesha' });
  const when = new Date(base.getTime() - minutesAgo * MIN).toISOString();
  db.run('INSERT INTO messages (number, role, kind, content, created_at) VALUES (?,?,?,?,?)', [
    number, 'user', 'text', 'are you open?', when,
  ]);
  if (answered) {
    db.run('INSERT INTO messages (number, role, kind, content, created_at) VALUES (?,?,?,?,?)', [
      number, 'assistant', 'text', 'yes we are', new Date(base.getTime() - (minutesAgo - 1) * MIN).toISOString(),
    ]);
  }
  if (paused) db.setContactPaused(number, new Date(base.getTime() + 60 * MIN).toISOString());
  return number;
}

test('an unanswered chat becomes one owner ping, without the message text', async () => {
  reset();
  const sock = withOwnerSock();
  seedWaitingCustomer({ minutesAgo: 20 });

  const result = await health.runHealthCheck(base);
  const sla = result.opened.filter((i) => i.kind === 'sla');
  assert.equal(sla.length, 1);
  assert.match(sla[0].detail, /waiting 20 min/);
  assert.doesNotMatch(sla[0].detail, /are you open\?/, 'no customer words in the alert');
  assert.doesNotMatch(ownerTexts(sock).join('\n'), /are you open/);

  const again = await health.runHealthCheck(at(1));
  assert.equal(again.notified.length, 0, 'one ping, not one per minute');
});

test('a paused chat is not an SLA miss — silence there is on purpose', async () => {
  reset();
  seedWaitingCustomer({ minutesAgo: 40, paused: true });
  const result = await health.runHealthCheck(base);
  assert.equal(result.opened.filter((i) => i.kind === 'sla').length, 0);
});

test('a chat that was answered is not an SLA miss', async () => {
  reset();
  seedWaitingCustomer({ minutesAgo: 40, answered: true });
  const result = await health.runHealthCheck(base);
  assert.equal(result.opened.filter((i) => i.kind === 'sla').length, 0);
});

test('the SLA only counts messages that arrived while the business was open', async () => {
  reset();
  seedWaitingCustomer({ minutesAgo: 30 });
  // Closed all day: the message waited, but the shop was shut.
  writeProfile();
  const profile = JSON.parse(fs.readFileSync(path.join(configDir, 'owner.json'), 'utf8'));
  profile.business.hours = 'Daily 00:00-00:01';
  fs.writeFileSync(path.join(configDir, 'owner.json'), JSON.stringify(profile, null, 2));
  env.reloadProfile();

  const result = await health.runHealthCheck(base);
  assert.equal(result.opened.filter((i) => i.kind === 'sla').length, 0);
});

test('ALERT_INCLUDE_CONTENT opts in to naming the chat', async () => {
  reset();
  process.env.ALERT_INCLUDE_CONTENT = 'true';
  try {
    seedWaitingCustomer({ minutesAgo: 20 });
    const result = await health.runHealthCheck(base);
    const sla = result.opened.filter((i) => i.kind === 'sla');
    assert.match(sla[0].detail, /Ayesha/);
  } finally {
    delete process.env.ALERT_INCLUDE_CONTENT;
  }
});

// ── the second channel ──────────────────────────────────────

test('a webhook receives the incident; a broken webhook costs nothing', async () => {
  reset({ status: 'logged_out' });
  const posted = [];
  globalThis.fetch = async (url, options) => {
    posted.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 204 };
  };
  process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.test/alerts';

  const result = await health.runHealthCheck(base);
  assert.ok(result.opened.length >= 1);
  assert.ok(posted.some((p) => p.body.type === 'incident' && p.body.kind === 'transport'));
  assert.equal(posted[0].body.tenant, 'default');

  // Now the webhook itself is broken.
  globalThis.fetch = async () => {
    throw new Error('ENOTFOUND');
  };
  db.run('DELETE FROM incidents');
  const survived = await health.runHealthCheck(at(60));
  assert.ok(survived.opened.length >= 1, 'the check still ran');
  assert.ok(survived.notified.length >= 1, 'the owner was still told in-app');
  delete process.env.ALERT_WEBHOOK_URL;
});

test('without a transport, an incident is still recorded and still webhooked', async () => {
  reset({ status: 'logged_out' });
  const posted = [];
  globalThis.fetch = async (url, options) => {
    posted.push(JSON.parse(options.body));
    return { ok: true, status: 200 };
  };
  process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.test/alerts';

  const result = await health.runHealthCheck(base);
  assert.equal(result.notified[0].viaWhatsApp, false, 'no socket, no WhatsApp alert — and no crash');
  assert.ok(posted.length > 0, 'the webhook is the second channel, so it must still fire');
  assert.ok(db.openIncidents().length > 0, 'and the state is visible to /api/status and .health');
  delete process.env.ALERT_WEBHOOK_URL;
});

test('postWebhook reports failure instead of throwing', async () => {
  globalThis.fetch = async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  const result = await health.postWebhook({ type: 'incident' }, { url: 'https://x.test' });
  assert.equal(result.ok, false);
  const none = await health.postWebhook({ type: 'incident' }, { url: '' });
  assert.equal(none.reason, 'not_configured');
});

// ── what the owner sees ─────────────────────────────────────

test('the health snapshot says what is wrong, in the same words the dashboard uses', async () => {
  reset({ status: 'stopped' });
  await health.runHealthCheck(base);
  const snap = health.healthSnapshot(base);
  assert.equal(snap.status, 'down');
  assert.ok(snap.failing.some((f) => f.kind === 'transport'));
  assert.ok(snap.open.length >= 1, 'the open incidents are in the snapshot');
  assert.ok(snap.open.some((i) => i.kind === 'transport'));
  assert.equal(typeof snap.incidents.open, 'number');
});

test('.health and .incidents work from WhatsApp', async () => {
  reset({ status: 'logged_out' });
  await health.runHealthCheck(base);

  const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');
  const sock = withOwnerSock();
  const healthReply = await handleOwnerCommand(sock, '923001234567@s.whatsapp.net', '.health', '923001234567');
  assert.match(healthReply.reply, /Health/i);
  assert.match(healthReply.reply, /transport/);

  const incidents = await handleOwnerCommand(sock, '923001234567@s.whatsapp.net', '.incidents', '923001234567');
  assert.match(incidents.reply, /transport/);
  assert.match(incidents.reply, /OPEN/);
});

test('the monitor loop starts only when the flag is on, and stops cleanly', () => {
  reset({ profile: { features: { healthAlerts: false } } });
  assert.equal(health.startHealthMonitor({ intervalMs: 10_000 }), null);
  health.stopHealthMonitor();

  reset();
  const timer = health.startHealthMonitor({ intervalMs: 10_000 });
  assert.ok(timer, 'the flag is on, so there is a timer');
  health.stopHealthMonitor();
  assert.equal(health.startHealthMonitor({ intervalMs: 10_000 }) && true, true);
  health.stopHealthMonitor();
});
