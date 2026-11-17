#!/usr/bin/env node
// scripts/session-backup.js
// Prints a single base64 blob containing your whole WhatsApp session.
// Paste it into the WA_SESSION environment variable of your host and the bot
// will restore itself after a redeploy — no QR scan, no re-pairing.
//
//   npm run session

import { backupSession, sessionFiles } from '../src/utils/sessionBackup.js';
import { config } from '../src/config/env.js';

const files = sessionFiles();
if (!files.length) {
  console.log(`\nNo session found in ${config.paths.sessions}.`);
  console.log('Start the bot and scan the QR (or use PAIRING_NUMBER) first.\n');
  process.exit(1);
}

const blob = backupSession();
if (!blob) {
  console.log('Could not build the backup.');
  process.exit(1);
}

console.log(`\n✅ Session backup (${files.length} files, ${(blob.length / 1024).toFixed(1)} KB)\n`);
console.log('Set this as WA_SESSION in your hosting environment:\n');
console.log(blob);
console.log('\nKeep it secret — anyone with this blob can use your WhatsApp account.\n');
