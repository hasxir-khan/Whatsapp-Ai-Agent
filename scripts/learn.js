#!/usr/bin/env node
// scripts/learn.js
// Ingest a document into one tenant's knowledge base.
//
// Normally you do not run this directly — scripts/tenant.js sets the tenant's
// environment and runs it for you:
//
//   node scripts/tenant.js learn ayesha-designs ./menu.pdf
//   node scripts/tenant.js learn ayesha-designs https://example.com/services
//
// Phase 1 stores clean, chunked text. Phase 2 will embed these same rows.

import { initDB } from '../src/utils/db.js';
import { ingest, stats, listSources } from '../src/services/knowledge.js';

const argv = process.argv.slice(2);
let title = null;
const rest = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--name') title = argv[i + 1] || null;
  else rest.push(argv[i]);
}
const target = rest[0];

if (!target) {
  console.error('Usage: node scripts/learn.js <file|url> [--name "Document title"]');
  process.exit(1);
}

await initDB();

try {
  const result = await ingest(target, { title });
  const totals = stats();
  console.log(`\n✔ Learned ${result.source}`);
  console.log(`  ${result.chunks} chunks · ${result.chars.toLocaleString()} characters`);
  console.log(`  Knowledge base: ${totals.sources} sources, ${totals.chunks} chunks\n`);
  const sources = listSources();
  if (process.env.VERBOSE) {
    for (const s of sources) console.log(`  • ${s.source} (${s.chunks})`);
  }
} catch (err) {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
}
