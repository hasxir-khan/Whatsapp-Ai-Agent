#!/usr/bin/env node
// scripts/session-backup.js
// Prints a single base64 blob containing your whole WhatsApp session.
// Paste it into the WA_SESSION environment variable of your host and the bot
// will restore itself after a redeploy — no QR scan, no re-pairing.
//
//   npm run session

import { backupSession, sessionFiles, sessionVerified } from '../src/utils/sessionBackup.js';
import { config } from '../src/config/env.js';

const files = sessionFiles();
if (!files.length) {
  console.log(`\nNo session found in ${config.paths.sessions}.`);
  console.log('Start the bot and scan the QR (or use PAIRING_NUMBER) first.\n');
  process.exit(1);
}

// Only a session that has actually connected is worth backing up: a blob taken
// from keys that were never proven is how a "restore" ends up rolling the bot
// back to a session the phone no longer recognises.
const verified = sessionVerified();
if (!verified.verified && String(process.env.SESSION_BACKUP_FORCE || '') !== '1') {
  console.log(`\n⚠️  This session has not had a successful connection: ${verified.reason}.`);
  console.log('   Start the bot until it shows "connected", then run this again.');
  console.log('   Deliberately backing up an unproven session? SESSION_BACKUP_FORCE=1 npm run session\n');
  process.exit(1);
}

const blob = backupSession({ requireConnected: true });
if (!blob) {
  console.log('Could not build the backup.');
  process.exit(1);
}

console.log(`\n✅ Session backup (${files.length} files, ${(blob.length / 1024).toFixed(1)} KB)\n`);
console.log('Set this as WA_SESSION in your hosting environment:\n');
console.log(blob);
console.log('\nKeep it secret — anyone with this blob can use your WhatsApp account.\n');
