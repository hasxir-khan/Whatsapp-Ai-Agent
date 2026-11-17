// Phase 1 — the knowledge base: chunking, ingesting documents and keeping the
// stored text honest. Retrieval with embeddings is Phase 2; the rows are ready.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate } from './helpers.js';

const dataDir = isolate('knowledge');
process.env.CONFIG_DIR = path.join(dataDir, 'config');

const K = await import('../src/services/knowledge.js');
const db = await import('../src/utils/db.js');
await db.initDB();

const LONG = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: we deliver fresh food within five kilometres of the branch.`).join('\n\n');

test('chunking keeps every chunk within the size limit', () => {
  const chunks = K.chunkText(LONG, { size: 500, overlap: 60 });
  assert.ok(chunks.length > 1, 'long text splits');
  for (const chunk of chunks) assert.ok(chunk.length <= 600, `chunk too long: ${chunk.length}`);
});

test('short text stays as a single chunk', () => {
  assert.equal(K.chunkText('We open at 12pm and close at 11pm.').length, 1);
});

test('empty or whitespace-only text produces no chunks', () => {
  assert.deepEqual(K.chunkText('   \n\n  '), []);
  assert.throws(() => K.ingestText('   ', { source: 'text:blank' }), /no readable text/i);
});

test('htmlToText strips markup and keeps the readable words', () => {
  const html = '<html><head><style>.a{color:red}</style><script>alert(1)</script></head><body><h1>Menu</h1><p>Karahi &amp; naan</p><li>Biryani 550</li></body></html>';
  const text = K.htmlToText(html);
  assert.match(text, /Menu/);
  assert.match(text, /Karahi & naan/);
  assert.match(text, /Biryani 550/);
  assert.doesNotMatch(text, /alert|color:red/);
});

test('ingesting text stores chunks with a stable source name', () => {
  const result = K.ingestText('Chicken Karahi 1450 PKR. Delivery free over 2000 PKR.', { source: 'file:menu.txt', title: 'Menu' });
  assert.equal(result.source, 'file:menu.txt');
  assert.ok(result.chunks >= 1);

  const sources = K.listSources();
  const menu = sources.find((s) => s.source === 'file:menu.txt');
  assert.ok(menu, 'source is listed');
  assert.equal(menu.chunks, result.chunks);
  assert.equal(menu.embedded, 0, 'nothing is embedded in phase 1');
});

test('re-ingesting the same file replaces instead of duplicating', () => {
  const before = K.stats().chunks;
  K.ingestText('Completely new menu text for the same source file.', { source: 'file:menu.txt' });
  const after = K.stats().chunks;
  assert.ok(after <= before + 1);
  const rows = db.knowledgeChunks('file:menu.txt');
  assert.equal(rows.length, 1, 'one chunk per new version');
  assert.match(rows[0].text, /Completely new menu text/);
});

test('ingesting a local text file works end to end', async () => {
  const file = path.join(dataDir, 'policies.txt');
  fs.writeFileSync(file, 'Refund policy: full refund within 24 hours.\n\nDelivery: 45 minutes.');
  const result = await K.ingestFile(file);
  assert.equal(result.source, 'file:policies.txt');
  assert.ok(K.listSources().some((s) => s.source === 'file:policies.txt'));
});

test('a missing file fails with a clear message', async () => {
  await assert.rejects(() => K.ingestFile(path.join(dataDir, 'nope.pdf')), /File not found/);
});

test('a folder is refused instead of hanging', async () => {
  await assert.rejects(() => K.ingestFile(dataDir), /folder/);
});

test('a bad URL is refused before any network call', async () => {
  await assert.rejects(() => K.ingestUrl('not-a-url'), /does not look like a URL/);
});

test('ingest() picks file vs URL automatically', async () => {
  assert.equal(K.isUrl('https://example.com/menu'), true);
  assert.equal(K.isUrl('./menu.pdf'), false);
});

test('the phase-1 preview search finds stored text', () => {
  const hits = K.preview('refund', 3);
  assert.ok(hits.length >= 1);
  assert.match(hits[0].text, /refund/i);
});

test('deleting a source removes exactly that source', () => {
  const before = K.stats().sources;
  K.remove('file:policies.txt');
  const after = K.stats();
  assert.equal(after.sources, before - 1);
  assert.ok(!K.listSources().some((s) => s.source === 'file:policies.txt'));
});

test('stats report sources, chunks and bytes', () => {
  const stats = K.stats();
  assert.equal(typeof stats.sources, 'number');
  assert.equal(typeof stats.chunks, 'number');
  assert.ok(stats.bytes > 0);
});
