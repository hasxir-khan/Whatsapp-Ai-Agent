#!/usr/bin/env node
// scripts/index-images.js
// Embed this tenant's catalogue images so a customer photo can be matched
// against them. Run from a tenant context (the CLI sets it up for you):
//
//   node scripts/tenant.js index-images ayesha-designs
//   node scripts/index-images.js --force        # re-embed everything
//
// Unchanged images are skipped by hash, so running it again is cheap. The
// model is downloaded once (~90 MB) and never leaves the machine afterwards.
import fs from 'node:fs';

const force = process.argv.includes('--force');

const db = await import('../src/utils/db.js');
await db.initDB();

const visual = await import('../src/services/visualSearch.js');

const items = visual.catalogImageItems();
if (!items.length) {
  console.log('\nNo catalogue images found.');
  console.log('Add "image": "config/menu/karahi.jpg" to an item in config/owner.json, then run this again.\n');
  process.exit(0);
}

console.log(`\nIndexing ${items.length} catalogue image(s) for this tenant…`);
console.log(`Model: ${visual.MODEL_ID} (~${visual.MODEL_DOWNLOAD_MB || 90} MB download on first use)\n`);

const summary = await visual.indexCatalogImages({
  force,
  onProgress: ({ item, action }) => {
    const mark = action === 'indexed' ? '✔' : '·';
    console.log(`  ${mark} ${item.name} ${action === 'skipped' ? '(unchanged)' : ''}`);
  },
});

console.log(`\n  indexed ${summary.indexed} · skipped ${summary.skipped} · missing ${summary.missing} · failed ${summary.failed}`);
if (summary.model) console.log(`  model: ${summary.model}`);
if (summary.aborted) {
  console.log('\n  The local model is not available, so nothing was indexed.');
  console.log('  Install it with:  npm install @xenova/transformers');
  console.log('  The bot keeps using its existing vision provider meanwhile.\n');
}
for (const err of summary.errors.slice(0, 8)) console.log(`  ! ${err}`);
console.log('');

// The doctor asks the same question; keep the exit code honest.
process.exit(summary.aborted ? 2 : summary.failed ? 1 : 0);
