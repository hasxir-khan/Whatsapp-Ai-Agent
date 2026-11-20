// test/67-session-safety.test.js
// B3 of the fix pass: keep the login safe, and one bad chat from costing a re-link.
//
// Four guards, all of which exist because of one bad week:
//   1. WA_SESSION is applied only when the local login is missing or corrupt.
//      Writing an old blob over a re-linked session swaps the keys underneath
//      the phone — incoming still works, outgoing does not.
//   2. A backup is only taken from a session that has actually connected.
//   3. A second process on one session folder refuses to start; a stale lock
//      from a crash is taken over.
//   4. One contact whose messages will not decrypt can be reset on its own,
//      rate-limited and reversed, instead of re-linking the whole number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-session-'));
process.env.DATA_DIR = dir;
process.env.TMP_DIR = path.join(dir, 'tmp');
process.env.CONFIG_DIR = path.join(dir, 'config');
process.env.SESSION_FOLDER = path.join(dir, 'sessions');
process.env.MY_NUMBER = '923001234567';
process.env.ENABLE_WEB = 'false';
process.env.VOICE_REPLY_MODE = 'off';

const db = await import('../src/utils/db.js');
await db.initDB();
const backup = await import('../src/utils/sessionBackup.js');
const lock = await import('../src/services/instanceLock.js');
const audit = await import('../src/services/transportAudit.js');
const recovery = await import('../src/services/sessionRecovery.js');
const health = await import('../src/services/health.js');
const { config } = await import('../src/config/env.js');

const SESS = config.paths.sessions;
const JID = '923001112223@s.whatsapp.net';

function freshSessions({ creds = { me: { id: '923001234567:1@s.whatsapp.net' }, registrationId: 7, noiseKey: { k: 1 } }, extra = {} } = {}) {
  fs.rmSync(SESS, { recursive: true, force: true });
  fs.mkdirSync(SESS, { recursive: true });
  if (creds !== null) fs.writeFileSync(path.join(SESS, 'creds.json'), typeof creds === 'string' ? creds : JSON.stringify(creds));
  for (const [name, body] of Object.entries(extra)) fs.writeFileSync(path.join(SESS, name), body);
  return SESS;
}

function blobOf(files = { 'creds.json': JSON.stringify({ me: { id: 'OLD@s.whatsapp.net' } }) }) {
  const packed = {};
  for (const [name, body] of Object.entries(files)) packed[name] = Buffer.from(body).toString('base64');
  return zlib.gzipSync(Buffer.from(JSON.stringify(packed), 'utf8')).toString('base64');
}

// ── 1. the restore guard ───────────────────────────────────
test('a healthy local session is never overwritten by WA_SESSION', () => {
  freshSessions();
  const before = fs.readFileSync(path.join(SESS, 'creds.json'), 'utf8');
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const result = backup.restoreSession(blobOf(), { dir: SESS });
    assert.equal(result.restored, false);
    assert.equal(result.reason, 'local_healthy');
    assert.equal(result.source, 'local');
    assert.equal(fs.readFileSync(path.join(SESS, 'creds.json'), 'utf8'), before, 'the local login is untouched');
  } finally {
    console.log = original;
  }
  assert.match(logs.join('\n'), /local login is healthy — WA_SESSION ignored/);
});

test('a missing session is restored from WA_SESSION and says which was used', () => {
  fs.rmSync(SESS, { recursive: true, force: true });
  const result = backup.restoreSession(blobOf(), { dir: SESS });
  assert.equal(result.restored, true);
  assert.equal(result.source, 'backup');
  assert.equal(result.state, 'missing');
  assert.ok(fs.existsSync(path.join(SESS, 'creds.json')));
  // Restored files are unproven until the next successful connection.
  assert.equal(backup.sessionConnectedAt(SESS), null);
});

test('a corrupt creds.json is replaced, and the old one kept as before-restore-*', () => {
  freshSessions({ creds: '{ not json' });
  const result = backup.restoreSession(blobOf(), { dir: SESS });
  assert.equal(result.restored, true);
  assert.equal(result.state, 'corrupt');
  const kept = fs.readdirSync(SESS).filter((n) => n.startsWith('before-restore-'));
  assert.ok(kept.length >= 1, 'a mistaken restore must be one mv away from undone');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(SESS, 'creds.json'), 'utf8')));
});

test('the guard can be forced off, and --force still wins per call', () => {
  freshSessions();
  process.env.SESSION_RESTORE_GUARD = '0';
  try {
    assert.equal(backup.restoreSession(blobOf(), { dir: SESS }).restored, true);
  } finally {
    delete process.env.SESSION_RESTORE_GUARD;
  }
  freshSessions();
  assert.equal(backup.restoreSession(blobOf(), { dir: SESS, force: true }).restored, true);
});

test('a broken blob never damages the local session', () => {
  freshSessions();
  const before = fs.readFileSync(path.join(SESS, 'creds.json'), 'utf8');
  const result = backup.restoreSession('not-a-real-blob', { dir: SESS, force: true });
  assert.equal(result.restored, false);
  assert.match(result.reason, /bad_blob/);
  assert.equal(fs.readFileSync(path.join(SESS, 'creds.json'), 'utf8'), before);
});

test('no WA_SESSION at all is a no-op, not a wipe', () => {
  freshSessions();
  const result = backup.restoreSession('', { dir: SESS });
  assert.equal(result.restored, false);
  assert.equal(result.reason, 'no_blob');
  assert.ok(fs.existsSync(path.join(SESS, 'creds.json')));
});

test('session health classifies missing, corrupt and healthy', () => {
  fs.rmSync(SESS, { recursive: true, force: true });
  assert.equal(backup.sessionHealth(SESS).state, 'missing');
  freshSessions({ creds: '' });
  assert.equal(backup.sessionHealth(SESS).state, 'corrupt');
  freshSessions({ creds: JSON.stringify({ hello: 1 }) });
  assert.equal(backup.sessionHealth(SESS).state, 'corrupt');
  freshSessions();
  assert.equal(backup.sessionHealth(SESS).state, 'healthy');
  assert.match(backup.sessionSummary(SESS).line, /Session: healthy/);
});

// ── 2. a backup only from a session that worked ────────────
test('no backup until the session has actually connected', () => {
  freshSessions();
  assert.equal(backup.backupSession({ requireConnected: true, dir: SESS }), null);
  assert.equal(backup.sessionVerified(SESS).verified, false);

  // The order that happens in real life: files written, then a successful open.
  backup.markSessionConnected(SESS, { at: new Date(), user: '923001234567' });
  const blob = backup.backupSession({ requireConnected: true, dir: SESS });
  assert.ok(blob, 'a connected session produces a blob');
  const restoredFiles = JSON.parse(zlib.gunzipSync(Buffer.from(blob, 'base64')).toString('utf8'));
  assert.ok(restoredFiles['creds.json']);
  assert.ok(!Object.keys(restoredFiles).some((n) => n.includes('connected.marker')), 'the marker is local, not part of the login');
});

test('keys written after the last successful connection are not backed up', () => {
  freshSessions();
  backup.markSessionConnected(SESS, { at: new Date(Date.now() - 5000) });
  // A key rotation that was never proven by a connection.
  fs.writeFileSync(path.join(SESS, 'pre-key-1.json'), '{"rotated":true}');
  const check = backup.sessionVerified(SESS);
  assert.equal(check.verified, false);
  assert.match(check.reason, /changed after the last connection/);
  assert.equal(backup.backupSession({ requireConnected: true, dir: SESS }), null);
});

test('an unverified session can still be backed up deliberately', () => {
  freshSessions();
  assert.ok(backup.backupSession({ requireConnected: false, dir: SESS }));
});

// ── 3. one process per session folder ──────────────────────
test('a second process is refused, and told which pid holds the lock', () => {
  freshSessions();
  // A lock held by a process that is unmistakably alive: pid 1.
  const record = { pid: 1, host: os.hostname(), startedAt: new Date().toISOString() };
  fs.mkdirSync(SESS, { recursive: true });
  fs.writeFileSync(lock.lockPath(SESS), JSON.stringify(record));
  const refused = lock.acquireSessionLock({ dir: SESS, pid: process.pid + 1 });
  if (!lock.pidAlive(1)) return; // a container without init: nothing to assert

  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'in_use');
  assert.equal(refused.holder.pid, 1);
  const message = lock.lockRefusalMessage(refused.holder, refused.path);
  assert.match(message, /pid 1/);
  assert.match(message, /Waiting for this message/);
  assert.match(message, /delete the file above/i);
  assert.match(message, /pm2 list|systemctl status/);
});

test('a lock left by a dead process is taken over', () => {
  freshSessions();
  const deadPid = 2 ** 22 - 1; // out of range on purpose: no such process
  assert.equal(lock.pidAlive(deadPid), false);
  fs.writeFileSync(lock.lockPath(SESS), JSON.stringify({ pid: deadPid, host: os.hostname(), startedAt: new Date(Date.now() - 3600_000).toISOString() }));
  const result = lock.acquireSessionLock({ dir: SESS, pid: process.pid });
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(lock.readLock(SESS).pid, process.pid);
});

test('only the holder releases the lock', () => {
  freshSessions();
  lock.acquireSessionLock({ dir: SESS, pid: process.pid });
  assert.equal(lock.releaseSessionLock({ dir: SESS, pid: process.pid + 7 }), false, 'someone else cannot free our lock');
  assert.ok(lock.readLock(SESS));
  assert.equal(lock.releaseSessionLock({ dir: SESS, pid: process.pid }), true);
  assert.equal(lock.readLock(SESS), null);
});

test('SESSION_LOCK=0 skips the lock entirely', () => {
  process.env.SESSION_LOCK = '0';
  try {
    const res = lock.acquireSessionLock({ dir: SESS, pid: process.pid });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, true);
  } finally {
    delete process.env.SESSION_LOCK;
  }
});

// ── 4. per-contact recovery ────────────────────────────────
function fakeSock() {
  const cleared = [];
  const sent = [];
  return {
    cleared,
    sent,
    sock: {
      authState: {
        keys: {
          async set(patch) {
            cleared.push(patch);
          },
        },
      },
      async sendMessage(jid, payload) {
        sent.push({ jid, payload });
        return { key: { id: 'x' } };
      },
    },
  };
}

test('one or two failures are not enough to touch a session', async () => {
  const { sock, cleared } = fakeSock();
  audit.resetAudit();
  audit.noteDecrypt('badMac', { chat: JID });
  audit.noteDecrypt('absentMessage', { chat: JID });
  const res = await recovery.maybeRecoverContact({ sock, chat: JID });
  assert.equal(res.recovered, false);
  assert.equal(res.reason, 'below_threshold');
  assert.equal(cleared.length, 0);
});

test('three failures inside the window clear that contact only', async () => {
  const { sock, cleared, sent } = fakeSock();
  audit.resetAudit();
  recovery.clearRecoveryHistory();
  for (let i = 0; i < 3; i += 1) audit.noteDecrypt('badMac', { chat: JID });

  const res = await recovery.maybeRecoverContact({ sock, chat: JID });
  assert.equal(res.recovered, true);
  assert.equal(cleared.length, 1);
  assert.deepEqual(cleared[0], { session: { [JID]: null } }, 'exactly one address is dropped, nobody else');
  assert.ok(!JSON.stringify(cleared[0]).includes('923009998887'));
  assert.equal(sent.length, 1, 'the owner is told');
  assert.match(sent[0].payload.text, /Session reset for \+923001112223/);
  assert.match(sent[0].payload.text, /only/);
});

test('a second reset inside the cooldown does nothing and sends nothing', async () => {
  const { sock, cleared, sent } = fakeSock();
  audit.resetAudit();
  recovery.clearRecoveryHistory();
  for (let i = 0; i < 3; i += 1) audit.noteDecrypt('badMac', { chat: JID });
  await recovery.maybeRecoverContact({ sock, chat: JID });
  for (let i = 0; i < 3; i += 1) audit.noteDecrypt('badMac', { chat: JID });

  const again = await recovery.maybeRecoverContact({ sock, chat: JID });
  assert.equal(again.recovered, false);
  assert.equal(again.reason, 'cooldown');
  assert.equal(cleared.length, 1);
  assert.equal(sent.length, 1);
});

test('after the cooldown it may act again', async () => {
  const { sock, cleared } = fakeSock();
  audit.resetAudit();
  recovery.clearRecoveryHistory();
  for (let i = 0; i < 3; i += 1) audit.noteDecrypt('badMac', { chat: JID });
  await recovery.maybeRecoverContact({ sock, chat: JID, now: new Date() });

  const later = new Date(Date.now() + 31 * 60_000);
  for (let i = 0; i < 3; i += 1) audit.noteDecrypt('badMac', { chat: JID, at: later.getTime() });
  const res = await recovery.maybeRecoverContact({ sock, chat: JID, now: later });
  assert.equal(res.recovered, true);
  assert.equal(cleared.length, 2);
});

test('SESSION_RECOVERY=0 disables it', async () => {
  const { sock, cleared } = fakeSock();
  audit.resetAudit();
  for (let i = 0; i < 5; i += 1) audit.noteDecrypt('badMac', { chat: JID });
  process.env.SESSION_RECOVERY = '0';
  try {
    const res = await recovery.maybeRecoverContact({ sock, chat: JID });
    assert.equal(res.recovered, false);
    assert.equal(res.reason, 'disabled');
    assert.equal(cleared.length, 0);
  } finally {
    delete process.env.SESSION_RECOVERY;
  }
});

test('a transport that cannot reset says so instead of pretending', async () => {
  audit.resetAudit();
  recovery.clearRecoveryHistory();
  for (let i = 0; i < 5; i += 1) audit.noteDecrypt('badMac', { chat: JID });
  const res = await recovery.maybeRecoverContact({ sock: { sendMessage() {} }, chat: JID });
  assert.equal(res.recovered, false);
  assert.equal(res.reason, 'transport_cannot_reset');
});

test('the reset is written to the event log, without content', async () => {
  const { sock } = fakeSock();
  audit.resetAudit();
  recovery.clearRecoveryHistory();
  for (let i = 0; i < 3; i += 1) audit.noteDecrypt('badMac', { chat: JID });
  await recovery.maybeRecoverContact({ sock, chat: JID });
  const rows = db.all("SELECT type, number, detail FROM events WHERE type = 'session_recovery'");
  assert.ok(rows.length >= 1);
  assert.equal(rows.at(-1).number, '923001112223');
  assert.doesNotMatch(String(rows.at(-1).detail || ''), /[a-z]{20,}/i, 'counts and a window, not a message');
});

// ── 5. the alerts ──────────────────────────────────────────
test('decrypt failures raise a health check with plain advice', () => {
  audit.resetAudit();
  for (let i = 0; i < 3; i += 1) audit.noteDecrypt('badMac', { chat: JID });
  const snap = health.healthSnapshot(new Date());
  const check = snap.checks.find((c) => c.kind === 'decrypt');
  assert.ok(check);
  assert.equal(check.ok, false);
  assert.match(check.detail, /3 message\(s\) failed to decrypt/);
  assert.match(check.detail, /ONE bot process per number/);
  assert.ok(snap.failing.some((f) => f.kind === 'decrypt'));
});

test('a couple of unacknowledged messages raise the delivery check', () => {
  audit.resetAudit();
  audit.noteOutbound({ id: 'U1', jid: JID, at: Date.now() - 90_000 });
  audit.noteOutbound({ id: 'U2', jid: JID, at: Date.now() - 90_000 });
  const snap = health.healthSnapshot(new Date());
  const check = snap.checks.find((c) => c.kind === 'delivery');
  assert.ok(check);
  assert.equal(check.ok, false);
  assert.match(check.detail, /2 outgoing message\(s\) not acknowledged/);
  assert.match(check.detail, /one process/);
});

test('when everything is fine, both checks are quiet', () => {
  audit.resetAudit();
  const snap = health.healthSnapshot(new Date());
  for (const kind of ['decrypt', 'delivery']) {
    const check = snap.checks.find((c) => c.kind === kind);
    assert.equal(check.ok, true, `${kind} must not cry wolf`);
  }
});

test('an incident is opened once per kind, with the advice in it', async () => {
  audit.resetAudit();
  for (let i = 0; i < 3; i += 1) audit.noteDecrypt('badMac', { chat: JID });
  const { setPath } = await import('../src/services/profile.js');
  setPath('features.healthAlerts', true);
  const result = await health.runHealthCheck(new Date(), { notify: false });
  const opened = result.opened.filter((i) => i.kind === 'decrypt');
  assert.ok(opened.length <= 1, 'one incident, not one per failure');
  const again = await health.runHealthCheck(new Date(), { notify: false });
  assert.equal(again.opened.filter((i) => i.kind === 'decrypt').length, 0, 'deduped by key');
});
