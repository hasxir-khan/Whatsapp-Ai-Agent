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
import { indexPending, reindex, ragStatus } from '../src/services/rag.js';
import { embeddingsAvailable } from '../src/services/embeddings.js';

const argv = process.argv.slice(2);
let title = null;
let mode = 'ingest';
let force = false;
const rest = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--name') title = argv[i + 1] || null;
  else if (argv[i] === '--reindex') mode = 'reindex';
  else if (argv[i] === '--force') force = true;
  else rest.push(argv[i]);
}
const target = rest[0];

if (!target && mode !== 'reindex') {
  console.error('Usage: node scripts/learn.js <file|url> [--name "Document title"] [--reindex]');
  process.exit(1);
}

await initDB();

function reportIndex(result) {
  const stats = ragStatus();
  if (result.embedding === undefined) return;
  if (result.embedding?.embedded) {
    console.log(`  Embedded ${result.embedding.embedded} chunk(s) with ${result.embedding.model || 'Gemini'}`);
  } else if (result.embedding?.reason) {
    console.log(`  Vectors: ${result.embedding.reason} — keyword search answers until then`);
  }
  if (!result.embedding?.embedded) {
    console.log(`  Progress: ${stats.embedded}/${stats.chunks} chunks embedded (${stats.pending} pending)`);
  }
}

try {
  if (mode === 'reindex') {
    const result = force ? await reindex({}) : await indexPending({ limit: 5000 });
    const stats = ragStatus();
    console.log(`\n✔ Reindexed`);
    console.log(`  Embedded : ${result.embedded}`);
    console.log(`  Skipped  : ${result.skipped ?? 0}${result.reason ? ` (${result.reason})` : ''}`);
    console.log(`  Model    : ${result.model || '—'}`);
    console.log(`  Total    : ${stats.embedded}/${stats.chunks} chunks\n`);
    process.exit(0);
  }

  const result = await ingest(target, { title });
  const totals = stats();
  console.log(`\n✔ Learned ${result.source}`);
  console.log(`  ${result.chunks} chunks · ${result.chars.toLocaleString()} characters`);
  console.log(`  Knowledge base: ${totals.sources} sources, ${totals.chunks} chunks`);

  // Embed right away when a key exists, so the next customer message can use it.
  let embedding;
  if (embeddingsAvailable()) {
    embedding = await indexPending({ limit: 200 });
  } else {
    embedding = { embedded: 0, reason: 'no Gemini key' };
  }
  result.embedding = embedding;
  reportIndex(result);
  console.log('');

  const sources = listSources();
  if (process.env.VERBOSE) {
    for (const s of sources) console.log(`  • ${s.source} (${s.chunks})`);
  }
} catch (err) {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
}
