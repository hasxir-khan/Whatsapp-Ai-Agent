// Phase 4 Part 4 — local visual catalogue search.
//
// The model never runs in CI: every test injects a fake embedder, so what is
// actually being tested is the machinery around the model — ranking, thresholds,
// catalogue-only prices, containment, caps, and the promise that a customer's
// photo is never written anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolate } from './helpers.js';

let envModule = null; // set once env.js is imported; writeProfile reloads through it

const dataDir = isolate('visual-search');
const configDir = path.join(dataDir, 'config');
const imagesDir = path.join(configDir, 'menu');
fs.mkdirSync(imagesDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
process.env.ENABLE_WEB = 'false';
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;

// Two fake images, deliberately tiny: the embedder is fake, so bytes do not matter.
const KARAHI = Buffer.from('fake-jpeg-karahi-image');
const ZINGER = Buffer.from('fake-jpeg-zinger-image');
fs.writeFileSync(path.join(imagesDir, 'karahi.jpg'), KARAHI);
fs.writeFileSync(path.join(imagesDir, 'zinger.jpg'), ZINGER);

function writeProfile({ features = {}, items = null, outside = null } = {}) {
  const catalogItems = items || [
    { id: 'karahi', name: 'Chicken Karahi', kind: 'product', price: 1350, stock: 5, image: 'menu/karahi.jpg' },
    { id: 'zinger', name: 'Zinger Burger', kind: 'product', price: 650, stock: 0, image: 'menu/zinger.jpg' },
    ...(outside ? [{ id: 'outside', name: 'Outside Item', price: 100, image: outside }] : []),
  ];
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify(
      {
        owner: { name: 'Test Owner', timezone: 'Asia/Karachi' },
        business: { name: 'Test Cafe', type: 'Cafe', city: 'Islamabad', hours: 'Daily 12:00-23:00', currency: 'PKR' },
        catalog: { items: catalogItems },
        features: { businessProfile: true, catalog: true, visualSearch: true, ...features },
      },
      null,
      2
    )
  );
  envModule?.reloadProfile?.();
}
writeProfile();

const db = await import('../src/utils/db.js');
await db.initDB();
const env = await import('../src/config/env.js');
envModule = env;
env.reloadProfile();
const visual = await import('../src/services/visualSearch.js');
const profile = await import('../src/services/profile.js');

// ── the injected embedder ───────────────────────────────────
// Images are recognised by their content, so "the same photo" is literally the
// same bytes. Unknown bytes get a vector that is close to nothing.
const KNOWN = new Map([
  [visual.hashImage(KARAHI), [1, 0, 0, 0]],
  [visual.hashImage(ZINGER), [0, 1, 0, 0]],
]);
let embedCalls = 0;
let embedMode = 'ok';

visual.setEmbedder(async (buffer) => {
  embedCalls += 1;
  if (embedMode === 'throw') throw new Error('Failed to load model: no network');
  if (embedMode === 'slow') await new Promise((r) => setTimeout(r, 200));
  const hit = KNOWN.get(visual.hashImage(buffer));
  if (hit) return hit;
  // A photo of something we do not sell: near-orthogonal to both.
  return [0.1, 0.1, 0.99, 0.05];
});

const reset = () => {
  visual.clearIndex();
  db.setSetting(`visual_search_calls:${new Date().toISOString().slice(0, 10)}`, 0);
  embedCalls = 0;
  embedMode = 'ok';
};

// ── 1. indexing ─────────────────────────────────────────────
test('the flag is off by default', () => {
  writeProfile({ features: { visualSearch: false } });
  assert.equal(visual.visualSearchEnabled(), false);
  writeProfile();
  assert.equal(visual.visualSearchEnabled(), true);
});

test('indexing embeds catalogue images and stores vectors', async () => {
  reset();
  const summary = await visual.indexCatalogImages();
  assert.equal(summary.seen, 2);
  assert.equal(summary.indexed, 2);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.failed, 0);
  assert.equal(embedCalls, 2);
  const rows = visual.indexedVectors();
  assert.equal(rows.length, 2);
  assert.ok(rows[0].dim === 4);
  assert.ok(rows.every((r) => r.hash && r.image_path));
});

test('an unchanged image is not embedded twice', async () => {
  reset();
  await visual.indexCatalogImages();
  const firstRun = embedCalls;
  const second = await visual.indexCatalogImages();
  assert.equal(second.indexed, 0);
  assert.equal(second.skipped, 2);
  assert.equal(embedCalls, firstRun, 'no new embedding work for unchanged files');

  // change one image: only that one is re-embedded
  fs.writeFileSync(path.join(imagesDir, 'zinger.jpg'), Buffer.from('fake-jpeg-zinger-v2'));
  const third = await visual.indexCatalogImages();
  assert.equal(third.indexed, 1);
  assert.equal(third.skipped, 1);
  assert.equal(embedCalls, firstRun + 1);
  // restore for later tests
  fs.writeFileSync(path.join(imagesDir, 'zinger.jpg'), ZINGER);
  await visual.indexCatalogImages();
});

test('indexing reports a missing image instead of inventing one', async () => {
  reset();
  writeProfile({ items: [{ id: 'ghost', name: 'Ghost Item', price: 100, image: 'menu/nope.jpg' }] });
  const summary = await visual.indexCatalogImages();
  assert.equal(summary.seen, 1);
  assert.equal(summary.missing, 1);
  assert.equal(summary.indexed, 0);
  assert.match(summary.errors.join(' '), /not_found/);
  writeProfile();
});

// ── 2. containment ──────────────────────────────────────────
test('a catalogue image outside the tenant folder is never opened', () => {
  // genuinely outside the tenant folder
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-visual-outside-'));
  const outside = path.join(elsewhere, 'secret.png');
  fs.writeFileSync(outside, Buffer.from('not-an-image'));
  const resolved = visual.catalogImagePath(outside);
  assert.equal(resolved.ok, false, 'absolute paths outside the root must not resolve');

  const traversal = visual.catalogImagePath('../../../etc/passwd.jpg');
  assert.equal(traversal.ok, false);

  const inside = visual.catalogImagePath('menu/karahi.jpg');
  assert.equal(inside.ok, true);
  assert.ok(inside.file.startsWith(path.resolve(configDir)) || inside.file.startsWith(path.resolve(process.cwd())));

  // and a profile that tries it is simply skipped during indexing
  writeProfile({ outside });
  const items = visual.catalogImageItems();
  const outsideItem = items.find((i) => i.id === 'outside');
  assert.ok(outsideItem, 'the item is still listed');
  assert.equal(outsideItem.file, null, 'but its file is refused');
  writeProfile();
});

test('only real image files are accepted, by extension', () => {
  fs.writeFileSync(path.join(imagesDir, 'notes.txt'), 'hello');
  assert.equal(visual.catalogImagePath('menu/notes.txt').ok, false);
  assert.equal(visual.catalogImagePath('').ok, false);
  assert.equal(visual.catalogImagePath(null).ok, false);
});

// ── 3. ranking and thresholds ───────────────────────────────
test('cosine similarity behaves, and normalisation is stable', () => {
  assert.equal(visual.cosine([1, 0], [1, 0]), 1);
  assert.equal(visual.cosine([1, 0], [0, 1]), 0);
  assert.equal(visual.cosine([1, 0], [1, 0, 0]), 0, 'different dimensions are not comparable');
  const norm = visual.normalise([3, 4]);
  assert.ok(Math.abs(norm[0] - 0.6) < 1e-9 && Math.abs(norm[1] - 0.8) < 1e-9);
});

test('the same photo ranks first, with a high score', async () => {
  reset();
  await visual.indexCatalogImages();
  const result = await visual.visualLookup({ buffer: KARAHI, number: '923001112233' });
  assert.equal(result.handled, true);
  assert.equal(result.decision, 'match');
  assert.ok(result.score > 0.99);
  assert.equal(result.matches[0].item.name, 'Chicken Karahi');
  assert.equal(result.matches.length, 2);
});

test('between low and high it shows the top three and asks', async () => {
  reset();
  await visual.indexCatalogImages();
  const { low, high } = visual.thresholds();
  const ambiguous = visual.decide([{ score: (low + high) / 2, item: { name: 'X' } }, { score: low - 0.01 }]);
  assert.equal(ambiguous.decision, 'ambiguous');

  const reply = visual.composeReply(ambiguous, [
    { item: { name: 'Chicken Karahi', price: 1350, currency: 'PKR' }, score: (low + high) / 2 },
    { item: { name: 'Zinger Burger', price: 650, currency: 'PKR' }, score: low + 0.01 },
  ]);
  assert.match(reply, /Which one/i);
  assert.match(reply, /Chicken Karahi/);
  assert.match(reply, /Zinger Burger/);
});

test('below low it says it is not sure and never guesses a product', async () => {
  reset();
  await visual.indexCatalogImages();
  const result = await visual.visualLookup({ buffer: Buffer.from('a photo of a bicycle'), number: '923001112233' });
  assert.equal(result.decision, 'none');
  assert.match(result.reply, /not sure|won't guess/i);
  assert.doesNotMatch(result.reply, /Chicken Karahi|Zinger Burger/);
  assert.doesNotMatch(result.reply, /1,?350|650/);
});

test('thresholds are configurable, and high can never fall below low', () => {
  const before = visual.thresholds();
  assert.equal(before.high, 0.88);
  assert.equal(before.low, 0.78);

  process.env.VISUAL_HIGH_THRESHOLD = '0.95';
  process.env.VISUAL_LOW_THRESHOLD = '0.9';
  assert.deepEqual(visual.thresholds(), { high: 0.95, low: 0.9 });

  // nonsense input is ignored rather than trusted
  process.env.VISUAL_HIGH_THRESHOLD = '0.4';
  process.env.VISUAL_LOW_THRESHOLD = '0.9';
  const swapped = visual.thresholds();
  assert.ok(swapped.high >= swapped.low, 'high is never below low');

  delete process.env.VISUAL_HIGH_THRESHOLD;
  delete process.env.VISUAL_LOW_THRESHOLD;
});

// ── 4. the reply is the catalogue's ─────────────────────────
test('prices and stock come from the catalogue, not from anywhere else', async () => {
  reset();
  await visual.indexCatalogImages();
  const karahi = await visual.visualLookup({ buffer: KARAHI, number: '923001112233' });
  assert.match(karahi.reply, /Chicken Karahi/);
  assert.match(karahi.reply, /1,?350/);
  assert.match(karahi.reply, /5 in stock/);

  const zinger = await visual.visualLookup({ buffer: ZINGER, number: '923001112233' });
  assert.match(zinger.reply, /Zinger Burger/);
  assert.match(zinger.reply, /650/);
  assert.match(zinger.reply, /out of stock/i);
});

test('changing the price in the profile changes the answer', async () => {
  reset();
  writeProfile({
    items: [{ id: 'karahi', name: 'Chicken Karahi', kind: 'product', price: 1500, stock: 2, image: 'menu/karahi.jpg' }],
  });
  await visual.indexCatalogImages();
  const result = await visual.visualLookup({ buffer: KARAHI, number: '923001112233' });
  assert.match(result.reply, /1,?500/);
  assert.match(result.reply, /2 in stock/);
  assert.doesNotMatch(result.reply, /1,?350/);
  writeProfile();
  reset();
  await visual.indexCatalogImages();
});

test('the roman-urdu reply exists for the customers who type that way', () => {
  const match = { decision: 'match', score: 0.99 };
  const matches = [{ item: { name: 'Chicken Karahi', price: 1350, currency: 'PKR' }, score: 0.99 }];
  const roman = visual.composeReply(match, matches, { lang: 'roman-ur' });
  assert.match(roman, /Chicken Karahi/);
  assert.match(roman, /lag raha hai/);
});

// ── 5. caps and limits ──────────────────────────────────────
test('the daily cap stops lookups without breaking anything', async () => {
  reset();
  await visual.indexCatalogImages();
  const saved = process.env.VISUAL_SEARCH_DAILY_CAP;
  process.env.VISUAL_SEARCH_DAILY_CAP = '2';
  try {
    assert.equal(visual.withinCap(), true);
    const one = await visual.visualLookup({ buffer: KARAHI, number: '923001112233' });
    const two = await visual.visualLookup({ buffer: ZINGER, number: '923001112233' });
    assert.equal(one.handled, true);
    assert.equal(two.handled, true);
    const three = await visual.visualLookup({ buffer: KARAHI, number: '923001112233' });
    assert.equal(three.handled, false);
    assert.equal(three.reason, 'daily_cap');
    assert.equal(visual.callsToday(), 2);
  } finally {
    if (saved === undefined) delete process.env.VISUAL_SEARCH_DAILY_CAP;
    else process.env.VISUAL_SEARCH_DAILY_CAP = saved;
    reset();
    await visual.indexCatalogImages();
  }
});

test('an oversized image is refused before the model sees it', async () => {
  reset();
  const huge = Buffer.alloc(visual.MAX_IMAGE_BYTES + 10, 1);
  const result = await visual.embedImage(huge);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'image_too_large');
  assert.equal(embedCalls, 0);

  const empty = await visual.embedImage(Buffer.alloc(0));
  assert.equal(empty.ok, false);
});

test('one slow job does not become ten slow jobs', async () => {
  reset();
  embedMode = 'slow';
  const started = Date.now();
  const results = await Promise.all([visual.embedImage(KARAHI), visual.embedImage(ZINGER), visual.embedImage(KARAHI)]);
  const elapsed = Date.now() - started;
  assert.equal(results.filter((r) => r.ok).length, 3);
  // serialised: 3 × ~200 ms, not overlapping
  assert.ok(elapsed >= 550, `expected serialised work, took ${elapsed}ms`);
  embedMode = 'ok';
});

test('no index means the caller keeps its own path, not a guess', async () => {
  reset();
  const result = await visual.visualLookup({ buffer: KARAHI, number: '923001112233' });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'no_index');
});

// ── 6. degradation ──────────────────────────────────────────
test('when the model cannot load, the feature steps aside quietly', async () => {
  reset();
  await visual.indexCatalogImages();
  embedMode = 'throw';
  const result = await visual.visualLookup({ buffer: KARAHI, number: '923001112233' });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'model_unavailable');
  assert.match(result.error, /no network/);

  const events = db.all("SELECT type, detail FROM events WHERE type = 'visual_model_unavailable' ORDER BY id DESC LIMIT 1");
  assert.ok(events.length, 'the reason is logged, not swallowed');
  assert.match(String(events[0].detail), /no network/);
  embedMode = 'ok';
});

test('a missing package is reported, not thrown', async () => {
  visual.resetEmbedderCache();
  visual.setEmbedder(null);
  // In this sandbox @xenova/transformers is not installed, so this is the real
  // "npm install was skipped" path.
  const probe = await visual.probeEmbedder();
  if (probe.ok) {
    assert.equal(probe.downloadMb, 90);
    assert.equal(probe.ramMb, 800);
  } else {
    assert.match(String(probe.reason), /Cannot find package|ERR_MODULE_NOT_FOUND|not installed/i);
  }
  visual.setEmbedder(async () => [1, 0, 0, 0]);
});

// ── 7. nothing leaves a trace ───────────────────────────────
test('a customer photo is never written down', async () => {
  reset();
  await visual.indexCatalogImages();
  const before = new Map();
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) walk(file);
      else before.set(file, stat.size);
    }
  };
  walk(dataDir);
  const customerPhoto = Buffer.from('photo-of-a-customer-kitchen-2026');
  await visual.visualLookup({ buffer: customerPhoto, number: '923001112233' });
  const added = [];
  const walk2 = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) walk2(file);
      else if (!before.has(file) && !file.endsWith('.db')) added.push(file);
    }
  };
  walk2(dataDir);
  assert.deepEqual(added, [], 'no file was created for the customer image');
  // and no vector was stored for it either: only the two catalogue images
  assert.equal(visual.indexedVectors().length, 2);
});

test('the sweep clears anything left in the visual temp folder', () => {
  const dir = path.join(process.env.TMP_DIR || '', 'visual');
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'leftover.jpg');
  fs.writeFileSync(old, 'x');
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(old, past, past);
  const result = visual.sweepVisualTmp();
  assert.ok(result.removed >= 1);
  assert.equal(fs.existsSync(old), false);
});

// ── 8. the feature is wired, not just present ───────────────
test('a customer photo becomes a catalogue answer, with no model in the loop', async () => {
  // End to end through the real handler: fake WhatsApp socket, fake media
  // download, injected embedder — the reply that goes out must be the
  // catalogue's words, not a language model's.
  reset();
  writeProfile();
  await visual.indexCatalogImages();

  const { fakeSock } = await import('./helpers.js');
  const { handleIncoming } = await import('../src/handlers/messageHandler.js');

  const sock = fakeSock();
  sock.getMedia = async () => ({ buffer: KARAHI, mimetype: 'image/jpeg' });
  sock.can = () => true;

  // not a team member: the example profile ships a demo team, and a teammate
  // messaging the bot is an operator, not a customer (a separate test covers that)
  const jid = '923007771122@s.whatsapp.net';
  await handleIncoming(sock, {
    key: { remoteJid: jid, fromMe: false, id: 'VISUAL-1' },
    message: { imageMessage: { mimetype: 'image/jpeg', fileLength: KARAHI.length } },
    pushName: 'Test Client',
  });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !sock.sent.some((m) => m.payload?.text)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const texts = sock.sent.map((m) => m.payload?.text).filter(Boolean).join('\n');
  assert.match(texts, /Chicken Karahi/);
  assert.match(texts, /1,?350/);
  assert.match(texts, /5 in stock/);
  // the one thing that must never happen: a fuzzy "looks like a dish" from the LLM
  assert.doesNotMatch(texts, /Makes sense — tell me a bit more/);
});

test('the flag is registered and documented where flags live', async () => {
  assert.ok(profile.FEATURE_KEYS.includes('visualSearch'));
  assert.equal(profile.FEATURE_ALIASES.visual, 'visualSearch');
  const example = JSON.parse(fs.readFileSync('config/owner.example.json', 'utf8'));
  assert.equal(example.features.visualSearch, false);
  for (const name of fs.readdirSync('config/templates')) {
    const tpl = JSON.parse(fs.readFileSync(path.join('config/templates', name), 'utf8'));
    assert.equal(tpl.features.visualSearch, false, `${name} must ship with it off`);
  }
});

test('the handler asks visual search before it asks the vision model', () => {
  const src = fs.readFileSync('src/handlers/messageHandler.js', 'utf8');
  const imageCase = src.slice(src.indexOf("case 'image':"));
  const visualAt = imageCase.indexOf('visualLookup');
  const visionAt = imageCase.indexOf('visionEnabled()');
  assert.ok(visualAt > -1, 'visual search must be called from the image path');
  assert.ok(visionAt > -1, 'the Gemini fallback must still exist');
  assert.ok(visualAt < visionAt, 'visual search runs first, the paid path is the fallback');
});

test('the status block tells the truth about what is ready', () => {
  const status = visual.visualStatus();
  assert.equal(status.model, 'Xenova/clip-vit-base-patch32');
  assert.equal(status.downloadMb, 90);
  assert.equal(status.estimatedRamMb, 800);
  assert.deepEqual(Object.keys(status.thresholds).sort(), ['high', 'low']);
  assert.equal(typeof status.indexed, 'number');
  assert.equal(typeof status.catalogImages, 'number');
});
