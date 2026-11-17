// src/services/invoice.js
// A quote, an invoice, a receipt — as one A4 PDF.
//
// The rules that matter more than the layout:
//   • every number comes from the orders table or core/pricing.js. The model
//     never contributes a price, and neither does the AI.
//   • payment details come from business.payment, and only the fields the owner
//     actually filled in. An empty IBAN row is worse than no row.
//   • the document is labelled for what it is: a quote is not an invoice, and
//     an unpaid invoice is not a receipt. The label follows order.status.
//   • nothing leaves this module that belongs to another tenant: the file is
//     written inside this tenant's own data directory, and the content is
//     built only from the order passed in and this tenant's profile.
//   • a PDF failure is never allowed to cost the customer a reply. The caller
//     always has the text quote to fall back on.

import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

import { config } from '../config/env.js';
import { business, featureOn, policies } from './profile.js';
import { formatMoney } from './geo.js';
import { printable } from '../core/script.js';
import { getOrder, logEvent } from '../utils/db.js';

// ── fonts ────────────────────────────────────────────────────
// Bundled, subsetted, open (SIL OFL). No system font, no download at runtime:
// a box with no fonts installed still produces the same document.
const FONT_DIR = new URL('../../assets/fonts/', import.meta.url);
const FONTS = {
  sans: new URL('NotoSans-Regular.ttf', FONT_DIR),
  bold: new URL('NotoSans-Bold.ttf', FONT_DIR),
  naskh: new URL('NotoNaskhArabic-Regular.ttf', FONT_DIR),
};

const REGULAR = { font: 'sans' };
const BOLD = { font: 'bold' };

export function pdfInvoicesEnabled() {
  return featureOn('pdfInvoices');
}

// ── file handling ────────────────────────────────────────────
export function invoiceDir() {
  return path.join(config.paths.data, 'invoices');
}

/** Where a given invoice lives. Always inside this tenant's data dir. */
export function invoiceFile(model) {
  const safe = String(model?.invoiceNo || 'invoice').replace(/[^A-Za-z0-9._-]/g, '');
  return path.join(invoiceDir(), `${safe || 'invoice'}.pdf`);
}

/**
 * Old PDFs are not precious — the order row is the truth. Sweep on each write
 * so a busy month cannot fill the disk.
 */
export function sweepInvoices({ days = config.invoice.keepDays, now = new Date() } = {}) {
  const dir = invoiceDir();
  let removed = 0;
  if (!fs.existsSync(dir)) return { removed };
  const cutoff = now.getTime() - Math.max(1, days) * 86400000;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.pdf')) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch {
      /* a file that vanished is not a problem */
    }
  }
  return { removed };
}

// ── numbers ──────────────────────────────────────────────────
function money(amount, currency) {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '';
  return formatMoney(Number(amount), currency || 'PKR');
}

function parseItems(order) {
  let items = order?.items;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch {
      items = null;
    }
  }
  if (!Array.isArray(items)) return [];
  return items.map((i) => ({
    name: String(i?.name || i?.label || 'Item'),
    qty: Number.isFinite(Number(i?.qty)) && Number(i.qty) > 0 ? Number(i.qty) : 1,
    unit: Number(i?.price ?? i?.unit ?? 0) || 0,
  }));
}

/** Date in the business's timezone, not the server's. */
export function businessDate(now = new Date()) {
  const tz = business().timezone || config.timezone || 'Asia/Karachi';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, day: '2-digit', month: 'short', year: 'numeric',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Document settings, tolerant of both shapes the profile may use:
 *   business.invoice = { logo, prefix, footer }   (what owner.example.json shows)
 *   business.logo / business.invoiceFooter        (flat, older profiles)
 */
export function invoiceSettings() {
  const b = business() || {};
  const nested = b.invoice && typeof b.invoice === 'object' ? b.invoice : {};
  return {
    logo: nested.logo || b.logo || '',
    prefix: nested.prefix || b.invoicePrefix || 'INV',
    footer: nested.footer || b.invoiceFooter || '',
  };
}

export function invoiceNumber(order = null, now = new Date()) {
  const prefix = String(invoiceSettings().prefix || 'INV').replace(/[^A-Za-z0-9-]/g, '').toUpperCase() || 'INV';
  const year = new Date(now).getUTCFullYear();
  const id = Number(order?.id);
  return id ? `${prefix}-${year}-${String(id).padStart(4, '0')}` : `${prefix}-${year}-DRAFT`;
}

/**
 * What is this document *called*? A quote becomes an invoice when money is
 * expected, and an invoice becomes a receipt only when the owner confirmed the
 * money arrived. Nothing in between is called a receipt.
 */
export function invoiceLabel(order = null) {
  if (!order) return 'Quote';
  const status = String(order.status || '').toLowerCase();
  if (['paid', 'delivered'].includes(status)) return 'Receipt';
  return 'Invoice (unpaid)';
}

// The profile's own shape: payment.bank = { name, title, number }, and the
// wallet equivalents. Unknown keys still print — the owner knows what they meant.
const PAYMENT_LABELS = {
  bank: 'Bank',
  bankName: 'Bank',
  accountTitle: 'Account title',
  accountNumber: 'Account number',
  iban: 'IBAN',
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
  upi: 'UPI',
  wise: 'Wise',
  paypal: 'PayPal',
  stripeLink: 'Payment link',
};

const SUB_LABELS = {
  name: 'name',
  title: 'account title',
  number: 'account number',
  link: 'link',
};

/**
 * Only the fields the owner filled in. Blank is not a payment detail, and a
 * `//` key is a comment in the profile file, not a bank.
 */
export function paymentLines() {
  const payment = business().payment;
  if (!payment || typeof payment !== 'object' || Array.isArray(payment)) return [];

  const rows = [];
  const push = (label, value) => {
    if (typeof value === 'string' && value.trim()) rows.push({ label, value: value.trim() });
  };

  for (const [key, value] of Object.entries(payment)) {
    if (key.startsWith('//') || key.startsWith('_')) continue;
    if (typeof value === 'string') {
      push(PAYMENT_LABELS[key] || key, value);
    } else if (value === true && key === 'cod') {
      rows.push({ label: 'Cash on delivery', value: 'Available' });
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const head = PAYMENT_LABELS[key] || key;
      for (const [sub, subValue] of Object.entries(value)) {
        if (sub.startsWith('//') || sub.startsWith('_')) continue;
        if (typeof subValue !== 'string' || !subValue.trim()) continue;
        rows.push({ label: `${head} · ${SUB_LABELS[sub] || sub}`, value: subValue.trim() });
      }
    }
  }
  return rows;
}

export function defaultFooter() {
  return 'Not a tax invoice. Thank you for your business.';
}

/**
 * Everything the renderer needs, derived from real rows only.
 *
 * @param {{order?:object|null, quote?:object|null, number?:string|null, now?:Date}} opts
 */
export function invoiceModel({ order = null, quote = null, number = null, now = new Date() } = {}) {
  const b = business() || {};
  const currency = order?.currency || quote?.ownerCurrency || b.currency || 'PKR';
  const label = invoiceLabel(order);

  let lines = [];
  let subtotal = 0;
  let total = 0;
  let ranged = false;

  if (order) {
    lines = parseItems(order).map((i) => ({ ...i, line: Math.round(i.qty * i.unit), text: null }));
    subtotal = lines.reduce((sum, l) => sum + l.line, 0);
    const stored = Number(order.total);
    total = Number.isFinite(stored) && stored > 0 ? stored : subtotal;

    // If the stored total disagrees with the lines, show the gap instead of
    // quietly rewriting either one. (A discount, a delivery fee, a rounding.)
    const adjustment = total - subtotal;
    if (adjustment !== 0) lines.push({ name: adjustment < 0 ? 'Discount / adjustment' : 'Delivery / adjustment', qty: 1, unit: adjustment, line: adjustment, text: null });
  } else if (quote) {
    ranged = true;
    lines = (quote.breakdown || []).map((row) => ({
      name: row.label || row.name || 'Item',
      qty: 1,
      unit: null,
      line: null,
      text: `${money(row.pkrMin, currency)} – ${money(row.pkrMax, currency)}`,
    }));
    total = null;
  }

  const clientName = order?.name || null;
  const clientNumber = order?.phone || number || String(order?.chat || '').split('@')[0] || null;

  return {
    label,
    invoiceNo: invoiceNumber(order, now),
    date: businessDate(now),
    ranged,
    currency,
    business: {
      name: b.name || 'Business',
      address: b.address || null,
      city: b.city || null,
      phone: b.phone || null,
      email: b.email || null,
      logoPath: invoiceSettings().logo || null,
    },
    client: {
      name: clientName,
      number: clientNumber ? `+${String(clientNumber).replace(/\D/g, '')}` : null,
      address: order?.address || null,
    },
    lines,
    subtotal: ranged ? null : money(subtotal, currency),
    total: ranged ? `${money(quote?.pkrMin, currency)} – ${money(quote?.pkrMax, currency)}` : money(total, currency),
    rangedTotal: ranged,
    totalNumber: ranged ? null : total,
    payment: paymentLines(),
    terms: policies().paymentTerms || b.paymentTerms || null,
    footer: invoiceSettings().footer || defaultFooter(),
    notes: ranged ? 'Prices are an estimate until the scope is confirmed.' : null,
  };
}

// ── rendering ────────────────────────────────────────────────
function safeLogo(model) {
  const raw = model?.business?.logoPath;
  if (!raw) return null;
  try {
    const file = path.resolve(config.root, String(raw));
    // Only ever read a file inside the repo/tenant folder, only an image
    // pdfkit can actually embed.
    if (!file.startsWith(path.resolve(config.root))) return null;
    if (!/\.(png|jpe?g)$/i.test(file)) return null;
    if (!fs.existsSync(file)) return null;
    return file;
  } catch {
    return null;
  }
}

/** Draw one string in the right script and font. */
function write(doc, text, { font = 'sans', size = 10, color = '#111111', align = 'left', x = null, y = null, width = null, lineGap = 0 } = {}) {
  const value = String(text ?? '');
  if (!value.trim()) return doc;
  const p = printable(value);
  const face = p.script === 'arabic' ? 'naskh' : font;
  doc.font(face).fontSize(p.script === 'arabic' ? size + 1 : size).fillColor(color);
  const opts = { align, lineGap };
  if (width !== null) opts.width = width;
  if (x !== null && y !== null) doc.text(p.text, x, y, opts);
  else doc.text(p.text, opts);
  return doc;
}

function registerFonts(doc) {
  for (const [name, file] of Object.entries(FONTS)) {
    doc.registerFont(name, fs.readFileSync(file));
  }
}

const GREY = '#666666';
const LIGHT = '#e5e5e5';

/**
 * @returns {Promise<Buffer>} the PDF
 */
export function renderInvoicePDF(model) {
  return new Promise((resolve, reject) => {
    let doc;
    try {
      doc = new PDFDocument({
        size: 'A4',
        margin: 44,
        info: {
          Title: `${model.label} ${model.invoiceNo}`.trim(),
          Author: model.business.name,
          Subject: `${model.label} — ${model.business.name}`,
          Creator: 'WhatsApp assistant',
        },
      });
    } catch (err) {
      return reject(err);
    }

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      registerFonts(doc);
      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const width = right - left;

      // ── header ────────────────────────────────────────────
      const logo = safeLogo(model);
      let headerWidth = width;
      if (logo) {
        try {
          doc.image(logo, right - 64, 44, { fit: [64, 64] });
          headerWidth = width - 80;
        } catch {
          /* an unreadable logo must not stop the document */
        }
      }

      write(doc, model.business.name, { ...BOLD, size: 18, width: headerWidth });
      doc.moveDown(0.2);
      const contact = [model.business.address, model.business.city, model.business.phone, model.business.email]
        .filter(Boolean)
        .join(' · ');
      if (contact) write(doc, contact, { size: 8.5, color: GREY, width: headerWidth });

      doc.moveDown(0.8);

      // ── label + reference ─────────────────────────────────
      const labelY = doc.y;
      write(doc, model.label, { ...BOLD, size: 15, width: width * 0.6, x: left, y: labelY });
      doc.font('sans').fontSize(9).fillColor(GREY);
      doc.text(`No. ${model.invoiceNo}`, left, labelY, { width, align: 'right' });
      doc.text(`Date: ${model.date}`, left, labelY + 12, { width, align: 'right' });
      doc.y = labelY + 34;

      doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.8).strokeColor(LIGHT).stroke();
      doc.moveDown(0.8);

      // ── client ────────────────────────────────────────────
      const clientY = doc.y;
      write(doc, 'Billed to', { size: 8.5, color: GREY, x: left, y: clientY, width: width * 0.5 });
      doc.y = clientY + 12;
      write(doc, model.client.name || 'Customer', { ...BOLD, size: 11, width: width * 0.5 });
      if (model.client.number) write(doc, model.client.number, { size: 9.5, color: GREY, width: width * 0.5 });
      if (model.client.address) write(doc, model.client.address, { size: 9, color: GREY, width: width * 0.5 });
      doc.moveDown(0.9);

      // ── table ─────────────────────────────────────────────
      const cols = { idx: left, name: left + 22, qty: right - 215, unit: right - 185, line: right };
      const rowTop = () => {
        doc.rect(left, doc.y, width, 18).fill('#f4f4f4');
        doc.fillColor('#111111');
        const y = doc.y + 4;
        write(doc, '#', { size: 8.5, color: GREY, x: cols.idx + 4, y });
        write(doc, 'Item', { size: 8.5, color: GREY, x: cols.name, y });
        write(doc, 'Qty', { size: 8.5, color: GREY, x: cols.qty, y, width: 25, align: 'right' });
        write(doc, 'Unit', { size: 8.5, color: GREY, x: cols.unit, y, width: 75, align: 'right' });
        write(doc, 'Amount', { size: 8.5, color: GREY, x: cols.line - 105, y, width: 105, align: 'right' });
        doc.y = y + 16;
      };
      rowTop();

      const ensureSpace = (needed = 30) => {
        if (doc.y + needed > doc.page.height - doc.page.margins.bottom - 90) {
          doc.addPage();
          rowTop();
        }
      };

      model.lines.forEach((line, index) => {
        ensureSpace(26);
        const y = doc.y;
        write(doc, String(index + 1), { size: 8.5, color: GREY, x: cols.idx + 4, y });
        write(doc, line.name, { size: 10, x: cols.name, y, width: cols.qty - cols.name - 8 });
        write(doc, String(line.qty ?? 1), { size: 9.5, x: cols.qty, y, width: 25, align: 'right' });
        write(doc, line.text ? '' : money(line.unit, model.currency), { size: 9, x: cols.unit, y, width: 75, align: 'right' });
        write(doc, line.text || money(line.line, model.currency), { size: 9, x: cols.line - 105, y, width: 105, align: 'right' });
        doc.y = y + 20;
        doc.moveTo(left, doc.y - 4).lineTo(right, doc.y - 4).lineWidth(0.4).strokeColor('#f0f0f0').stroke();
      });

      doc.moveDown(0.6);

      // ── totals ────────────────────────────────────────────
      ensureSpace(70);
      if (!model.ranged && model.subtotal) {
        const y = doc.y;
        write(doc, 'Subtotal', { size: 9.5, color: GREY, x: right - 220, y, width: 120, align: 'right' });
        write(doc, model.subtotal, { size: 9.5, x: right - 90, y, width: 90, align: 'right' });
        doc.y = y + 16;
      }
      const totalY = doc.y + 2;
      write(doc, 'Total', { ...BOLD, size: 12, x: right - 220, y: totalY, width: 120, align: 'right' });
      write(doc, model.total || '—', { ...BOLD, size: 12, x: right - 110, y: totalY, width: 110, align: 'right' });
      doc.y = totalY + 26;

      // ── payment ───────────────────────────────────────────
      if (model.payment.length) {
        ensureSpace(40 + model.payment.length * 14);
        write(doc, 'Payment details', { ...BOLD, size: 10.5 });
        doc.moveDown(0.3);
        for (const row of model.payment) {
          const y = doc.y;
          write(doc, row.label, { size: 9, color: GREY, x: left, y, width: 130 });
          write(doc, row.value, { size: 9.5, x: left + 135, y, width: width - 135 });
          doc.y = y + 14;
        }
        doc.moveDown(0.5);
      } else if (model.label !== 'Receipt') {
        write(doc, 'Payment details will be shared separately.', { size: 9, color: GREY });
        doc.moveDown(0.5);
      }

      if (model.terms) {
        write(doc, `Terms: ${model.terms}`, { size: 9, color: GREY });
        doc.moveDown(0.4);
      }
      if (model.notes) {
        write(doc, model.notes, { size: 9, color: GREY });
        doc.moveDown(0.4);
      }

      // ── footer ────────────────────────────────────────────
      const footY = doc.page.height - doc.page.margins.bottom - 24;
      doc.moveTo(left, footY).lineTo(right, footY).lineWidth(0.8).strokeColor(LIGHT).stroke();
      write(doc, model.footer, { size: 8.5, color: GREY, x: left, y: footY + 6, width });
      write(doc, model.invoiceNo, { size: 8, color: '#999999', x: left, y: footY + 6, width, align: 'right' });

      doc.end();
    } catch (err) {
      try {
        doc.end();
      } catch {
        /* already broken */
      }
      reject(err);
    }
  });
}

// ── the whole thing ──────────────────────────────────────────
export function invoiceCaption(model) {
  const lines = [
    `${model.label}: ${model.invoiceNo}`,
    model.business.name,
    `Total: ${model.total || '—'}`,
  ];
  if (model.label === 'Invoice (unpaid)' && model.payment.length) {
    lines.push('', 'Payment details are in the PDF.');
  }
  return lines.join('\n');
}

/**
 * Build, render, store and send. Never throws: the caller is usually a customer
 * waiting for their quote, and a broken font must not become a broken promise.
 *
 * @returns {Promise<{ok:boolean, reason?:string, model?:object, buffer?:Buffer, file?:string, sent?:boolean}>}
 */
export async function sendInvoice({ transport = null, jid = null, order = null, orderId = null, quote = null, number = null, now = new Date(), caption = null, render = renderInvoicePDF } = {}) {
  if (!pdfInvoicesEnabled()) return { ok: false, reason: 'disabled' };

  let target = order;
  if (!target && orderId) {
    try {
      target = getOrder(Number(orderId));
    } catch (err) {
      logEvent('invoice_lookup_failed', number, err.message);
    }
    if (!target) return { ok: false, reason: 'no_order' };
  }

  let model;
  try {
    model = invoiceModel({ order: target, quote, number: number || String(target?.chat || '').split('@')[0] || null, now });
  } catch (err) {
    logEvent('invoice_model_failed', number, err.message);
    return { ok: false, reason: 'model_failed', error: err.message };
  }

  let buffer;
  try {
    buffer = await (render || renderInvoicePDF)(model);
  } catch (err) {
    logEvent('invoice_render_failed', number, err.message);
    return { ok: false, reason: 'render_failed', error: err.message, model };
  }

  let file = null;
  try {
    fs.mkdirSync(invoiceDir(), { recursive: true });
    file = invoiceFile(model);
    fs.writeFileSync(file, buffer);
    sweepInvoices({ now });
  } catch (err) {
    // Not being able to cache the file is not a reason to withhold it.
    logEvent('invoice_write_failed', number, err.message);
  }

  if (!transport || !jid) return { ok: true, model, buffer, file, sent: false };

  try {
    await transport.sendMessage(jid, {
      document: buffer,
      mimetype: 'application/pdf',
      fileName: `${model.invoiceNo}.pdf`,
      caption: caption || invoiceCaption(model),
    });
    logEvent('invoice_sent', number, { invoice: model.invoiceNo, label: model.label, bytes: buffer.length });
    return { ok: true, model, buffer, file, sent: true };
  } catch (err) {
    logEvent('invoice_send_failed', number, err.message);
    return { ok: false, reason: 'send_failed', error: err.message, model, buffer, file };
  }
}

export default {
  pdfInvoicesEnabled,
  invoiceModel,
  invoiceLabel,
  invoiceNumber,
  invoiceCaption,
  renderInvoicePDF,
  sendInvoice,
  sweepInvoices,
  invoiceDir,
  invoiceFile,
  paymentLines,
  businessDate,
  invoiceSettings,
};
