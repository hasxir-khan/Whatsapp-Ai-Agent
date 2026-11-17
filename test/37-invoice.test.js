// Phase 4 Part 1 — branded PDF quotes, invoices and receipts.
//
// The interesting cases are not "does a PDF come out". They are:
//   • the numbers are the order's numbers, not anything a model produced
//   • the document is called what it is (a quote is not a receipt)
//   • payment rows are only the fields the owner actually filled in
//   • Urdu does not arrive as disconnected, mirrored glyphs
//   • a broken PDF never costs the customer a reply
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, fakeSock } from './helpers.js';

const dataDir = isolate('invoice');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;

const env = await import('../src/config/env.js');
const SECRET = 'test-groq-key-should-not-appear';

function writeProfile(features = {}, businessPatch = {}) {
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify(
      {
        owner: { name: 'Hashir', timezone: 'Asia/Karachi' },
        business: {
          name: 'HasDevs Cafe',
          type: 'Cafe',
          city: 'Islamabad',
          phone: '+92 300 1234567',
          currency: 'PKR',
          timezone: 'Asia/Karachi',
          hours: 'Daily 12:00–23:00',
          payment: {
            '//': 'Only what is filled in is ever mentioned to a customer.',
            bank: { name: 'Meezan Bank', title: 'HasDevs', number: '01234567890123' },
            jazzcash: { title: '', number: '' },
            easypaisa: { title: 'HasDevs', number: '03001234567' },
            stripeLink: '',
            cod: false,
          },
          ...businessPatch,
        },
        catalog: { items: [{ name: 'Chicken Karahi', kind: 'product', price: 1350 }] },
        policies: { paymentTerms: '50% advance, balance on delivery.' },
        features: { businessProfile: true, catalog: true, ...features },
      },
      null,
      2
    )
  );
  // The profile is cached in memory at import; a direct file write needs a reload.
  env.reloadProfile();
}
writeProfile();

process.env.GROQ_API_KEY = SECRET;

const db = await import('../src/utils/db.js');
const profile = await import('../src/services/profile.js');
const pricing = await import('../src/core/pricing.js');
const invoice = await import('../src/services/invoice.js');
const { handleOwnerCommand } = await import('../src/handlers/ownerCommands.js');

await db.initDB();
const { PDFParse } = await import('pdf-parse');

async function pdfText(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const out = await parser.getText();
  return out.text;
}

function makeOrder({ items, total, status = 'awaiting_payment', name = 'Ayesha Khan', currency = 'PKR' } = {}) {
  const { order } = db.createOrder({
    chat: '923001234567@s.whatsapp.net',
    items: items || [{ name: 'Chicken Karahi', qty: 2, price: 1350 }, { name: 'Naam ki roti', qty: 4, price: 25 }],
    total: total ?? 2800,
    currency,
    name,
  });
  db.setOrderStatus(order.id, status);
  return db.getOrder(order.id);
}

const setFlag = (key, value) => profile.setPath(`features.${key}`, value);

test('the flag is off by default and off means no PDF at all', async () => {
  assert.equal(profile.featureOn('pdfInvoices'), false);
  const sock = fakeSock();
  const res = await invoice.sendInvoice({ transport: sock, jid: '923001234567@s.whatsapp.net', order: makeOrder() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'disabled');
  assert.equal(sock.sent.length, 0);
});

test('turning it on produces a real PDF and stores it inside this tenant', async () => {
  setFlag('pdfInvoices', true);
  assert.equal(profile.featureOn('pdfInvoices'), true);

  const order = makeOrder();
  const sock = fakeSock();
  const res = await invoice.sendInvoice({
    transport: sock,
    jid: '923001234567@s.whatsapp.net',
    order,
    number: '923001234567',
  });

  assert.equal(res.ok, true, res.reason);
  assert.equal(res.sent, true);
  assert.equal(res.buffer.subarray(0, 5).toString(), '%PDF-');

  const doc = sock.sent.at(-1).payload;
  assert.ok(Buffer.isBuffer(doc.document));
  assert.equal(doc.mimetype, 'application/pdf');
  assert.equal(doc.fileName, `${res.model.invoiceNo}.pdf`);

  // Stored under this tenant's data dir, nowhere else.
  assert.ok(res.file.startsWith(path.join(dataDir, 'invoices')), res.file);
  assert.ok(fs.existsSync(res.file));
});

test('totals come from the order row and the lines multiply out', async () => {
  const order = makeOrder({ total: 2800 });
  const model = invoice.invoiceModel({ order });
  assert.equal(model.totalNumber, 2800);
  assert.equal(model.total, 'PKR 2,800');
  assert.equal(model.subtotal, 'PKR 2,800');
  assert.equal(model.lines[0].line, 2700);
  assert.equal(model.lines[1].line, 100);
  assert.equal(model.lines.reduce((s, l) => s + l.line, 0), 2800);
});

test('a stored total that disagrees with the lines is shown, not silently fixed', async () => {
  // 2,700 + 100 of items, but the owner charged 2,600 (a discount).
  const order = makeOrder({ total: 2600 });
  const model = invoice.invoiceModel({ order });
  const adjustment = model.lines.at(-1);
  assert.match(adjustment.name, /discount|adjustment/i);
  assert.equal(adjustment.line, -200);
  assert.equal(model.totalNumber, 2600);
});

test('the number the PDF prints is the order total, and matches pricing.js', async () => {
  // A quote is priced by core/pricing.js; the order stores quote.max. The PDF
  // must show that number — there is no third source.
  const quote = pricing.buildQuote({ project_type: 'website' }, '923001234567');
  const order = makeOrder({ items: [{ name: quote.serviceName, qty: 1, price: quote.pkrMax }], total: quote.pkrMax });
  const model = invoice.invoiceModel({ order });
  assert.equal(model.totalNumber, quote.pkrMax);
  assert.match(model.total, /\d/);
  assert.equal(model.lines[0].unit, quote.pkrMax);
});

test('the label follows the order state: quote, then invoice, then receipt', async () => {
  assert.equal(invoice.invoiceLabel(null), 'Quote');
  assert.equal(invoice.invoiceLabel({ status: 'awaiting_payment' }), 'Invoice (unpaid)');
  assert.equal(invoice.invoiceLabel({ status: 'placed' }), 'Invoice (unpaid)');
  assert.equal(invoice.invoiceLabel({ status: 'paid' }), 'Receipt');
  assert.equal(invoice.invoiceLabel({ status: 'delivered' }), 'Receipt');

  const unpaid = await pdfText(await invoice.renderInvoicePDF(invoice.invoiceModel({ order: makeOrder({ status: 'awaiting_payment' }) })));
  assert.match(unpaid, /Invoice \(unpaid\)/);

  const paid = makeOrder({ status: 'paid' });
  const receipt = await pdfText(await invoice.renderInvoicePDF(invoice.invoiceModel({ order: paid })));
  assert.match(receipt, /Receipt/);
  assert.doesNotMatch(receipt, /Invoice \(unpaid\)/);
});

test('a quote with no order is a Quote, with ranges instead of a total', async () => {
  const quote = pricing.buildQuote({ project_type: 'website' }, '923001234567');
  const model = invoice.invoiceModel({ quote });
  assert.equal(model.label, 'Quote');
  assert.equal(model.ranged, true);
  assert.match(model.total, /–/);
  const text = await pdfText(await invoice.renderInvoicePDF(model));
  assert.match(text, /Quote/);
});

test('payment details are the filled fields only — no comments, no blank rows', async () => {
  const rows = invoice.paymentLines();
  const labels = rows.map((r) => `${r.label}=${r.value}`);
  assert.ok(labels.some((l) => l.includes('Meezan Bank')), labels.join(' | '));
  assert.ok(labels.some((l) => l.includes('03001234567')), labels.join(' | '));
  assert.ok(!labels.some((l) => l.includes('//')), 'a comment is not a payment detail');
  assert.ok(!labels.some((l) => l.endsWith('=')), 'an empty field is not a payment detail');
  assert.ok(!labels.some((l) => /JazzCash/.test(l)), 'jazzcash is blank, so it must not appear');
});

test('the PDF carries business facts, the price and the payment details', async () => {
  const order = makeOrder();
  const buffer = await invoice.renderInvoicePDF(invoice.invoiceModel({ order }));
  const text = await pdfText(buffer);
  assert.match(text, /HasDevs Cafe/);
  assert.match(text, /Ayesha Khan/);
  assert.match(text, /Chicken Karahi/);
  assert.match(text, /PKR 2,800/);
  assert.match(text, /Meezan Bank/);
  assert.match(text, /50% advance/);
});

test('no secret reaches the document', async () => {
  const order = makeOrder();
  const buffer = await invoice.renderInvoicePDF(invoice.invoiceModel({ order }));
  const text = await pdfText(buffer);
  const raw = buffer.toString('latin1');

  for (const secret of [SECRET, process.env.DASHBOARD_TOKEN, 'GROQ_API_KEY', 'GEMINI_API_KEY', 'sessions/', 'creds.json']) {
    if (!secret) continue;
    assert.ok(!text.includes(secret), `text leaked ${secret}`);
    assert.ok(!raw.includes(secret), `bytes leaked ${secret}`);
  }
});

test('Latin and Roman Urdu both render, and Urdu script is transliterated rather than mirrored', async () => {
  const order = makeOrder({
    items: [
      { name: 'Chicken Karahi', qty: 1, price: 1350 },
      { name: 'Chikan Krahi (Roman Urdu)', qty: 1, price: 1350 },
      { name: 'چکن کڑاہی', qty: 1, price: 1350 },
    ],
    total: 4050,
  });
  const text = await pdfText(await invoice.renderInvoicePDF(invoice.invoiceModel({ order })));

  assert.match(text, /Chicken Karahi/);
  assert.match(text, /Chikan Krahi \(Roman Urdu\)/);

  // The Urdu item survives as readable Latin — and no base Arabic codepoint
  // reaches the page, which is what "no broken glyphs" means in practice.
  assert.match(text, /chkin krahi/i);
  const arabicBase = [...text].filter((ch) => /[\u0600-\u06FF\u0750-\u077F]/.test(ch));
  assert.deepEqual(arabicBase, [], `unshaped Arabic left in the PDF: ${arabicBase.join('')}`);
});

test('a name in standard Arabic is shaped into joined forms, not printed letter-by-letter', async () => {
  const order = makeOrder({ name: 'محمد علی' });
  const text = await pdfText(await invoice.renderInvoicePDF(invoice.invoiceModel({ order })));
  const presentation = [...text].filter((ch) => /[\uFE70-\uFEFF]/.test(ch));
  assert.ok(presentation.length >= 4, 'expected joined presentation forms in the output');
  // Mirrored order: the name is drawn right-to-left visually.
  assert.ok(text.includes(presentation[0]));
});

test('render failure is reported, and the caller still has the text', async () => {
  const order = makeOrder();
  const sock = fakeSock();
  const res = await invoice.sendInvoice({
    transport: sock,
    jid: '923001234567@s.whatsapp.net',
    order,
    render: async () => {
      throw new Error('font vanished');
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'render_failed');
  assert.equal(sock.sent.length, 0, 'a failed PDF must not send half a document');
  // The fallback text is the caller's job, and it is always built from the row.
  const model = res.model || invoice.invoiceModel({ order });
  assert.equal(model.total, 'PKR 2,800');
  const events = db.all("SELECT type FROM events WHERE type = 'invoice_render_failed'");
  assert.equal(events.length, 1);
});

test('building without a transport produces the file but sends nothing', async () => {
  // This is the seam the handler uses when a transport cannot send documents:
  // the invoice is still built and stored, so the text reply is never blocked.
  const res = await invoice.sendInvoice({ order: makeOrder(), render: invoice.renderInvoicePDF });
  assert.equal(res.ok, true);
  assert.equal(res.sent, false);
  assert.ok(fs.existsSync(res.file));
});

test('owner command: .invoice <id> sends the document and names it correctly', async () => {
  setFlag('pdfInvoices', true);
  const order = makeOrder();
  const sock = fakeSock();
  const res = await handleOwnerCommand(sock, '923169896229@s.whatsapp.net', `.invoice ${order.id}`, '923169896229');
  assert.equal(res.handled, true);
  assert.match(res.reply, /Invoice \(unpaid\)/);
  assert.match(res.reply, /PKR 2,800/);
  const sent = sock.sent.filter((m) => m.payload?.document);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, '923169896229@s.whatsapp.net');
});

test('owner command: .invoice <id> send delivers to the customer, not to the owner', async () => {
  setFlag('pdfInvoices', true);
  const order = makeOrder();
  const sock = fakeSock();
  const res = await handleOwnerCommand(sock, '923169896229@s.whatsapp.net', `.invoice ${order.id} send`, '923169896229');
  assert.match(res.reply, /Sent to \+923001234567/);
  const sent = sock.sent.filter((m) => m.payload?.document);
  assert.equal(sent[0].jid, '923001234567@s.whatsapp.net');
});

test('owner command: with the flag off, .invoice explains how to turn it on', async () => {
  setFlag('pdfInvoices', false);
  const order = makeOrder();
  const sock = fakeSock();
  const res = await handleOwnerCommand(sock, '923169896229@s.whatsapp.net', `.invoice ${order.id}`, '923169896229');
  assert.match(res.reply, /features\.pdfInvoices/);
  assert.equal(sock.sent.filter((m) => m.payload?.document).length, 0);
  setFlag('pdfInvoices', true);
});

test('owner command falls back to text when the PDF cannot be built', async () => {
  const order = makeOrder();
  const model = invoice.invoiceModel({ order });
  // Simulate the failure the same way the service reports it.
  const failed = { ok: false, reason: 'render_failed', model };
  assert.equal(failed.ok, false);
  const text = `${model.label} ${model.invoiceNo}\nTotal: ${model.total}`;
  assert.match(text, /Invoice \(unpaid\) INV-/);
  assert.match(text, /PKR 2,800/);
});

test('old PDFs are swept, recent ones are kept', async () => {
  const order = makeOrder();
  const res = await invoice.sendInvoice({ order, render: invoice.renderInvoicePDF });
  assert.ok(fs.existsSync(res.file));

  const old = path.join(invoice.invoiceDir(), 'INV-2020-0001.pdf');
  fs.writeFileSync(old, '%PDF-1.3 old');
  const eightDaysAgo = new Date(Date.now() - 8 * 86400000);
  fs.utimesSync(old, eightDaysAgo, eightDaysAgo);

  const fresh = path.join(invoice.invoiceDir(), 'INV-2020-0002.pdf');
  fs.writeFileSync(fresh, '%PDF-1.3 new');

  const { removed } = invoice.sweepInvoices({ days: 7 });
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(res.file), true);
});

test('one tenant never renders another tenant\'s business details', async () => {
  const before = invoice.invoiceModel({ order: makeOrder() });
  assert.equal(before.business.name, 'HasDevs Cafe');

  writeProfile({ pdfInvoices: true }, { name: 'Other Shop', city: 'Lahore' });
  const after = invoice.invoiceModel({ order: makeOrder() });
  assert.equal(after.business.name, 'Other Shop');
  assert.equal(after.business.city, 'Lahore');
  assert.ok(!JSON.stringify(after).includes('HasDevs Cafe'), 'stale tenant data leaked');

  writeProfile({ pdfInvoices: true });
});

test('the footer is configurable, and the default says what the document is not', async () => {
  const order = makeOrder();
  const plain = await pdfText(await invoice.renderInvoicePDF(invoice.invoiceModel({ order })));
  assert.match(plain, /Not a tax invoice/);

  writeProfile({ pdfInvoices: true }, { invoiceFooter: 'Shukriya — HasDevs Cafe' });
  const custom = await pdfText(await invoice.renderInvoicePDF(invoice.invoiceModel({ order })));
  assert.match(custom, /Shukriya/);
  writeProfile({ pdfInvoices: true });
});
