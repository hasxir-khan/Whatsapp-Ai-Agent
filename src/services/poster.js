// src/services/poster.js
// An A4 poster: "Chat with us on WhatsApp", a QR that carries the source
// marker, the number in a form a human can read out loud, and the opening hours.
//
// The rules, which are the same rules the invoice follows:
//
//   • Every fact on the page comes from the business profile or from the link
//     row. Nothing is invented — no "best in town", no made-up opening hours.
//   • No secrets and no customer data: a poster lives on a wall in public.
//   • Urdu script is either shaped properly or transliterated. It is never
//     printed mirrored or disconnected (see core/script.js).
//   • A broken poster is an error message to the owner, not an exception: the
//     link is still in the database and can be printed by hand.

import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

import { config } from '../config/env.js';
import { business } from './profile.js';
import { printable } from '../core/script.js';
import { readableNumber, sourceLabel, qrPng } from './sourceLinks.js';

const FONT_DIR = new URL('../../assets/fonts/', import.meta.url);
const FONTS = {
  sans: new URL('NotoSans-Regular.ttf', FONT_DIR),
  bold: new URL('NotoSans-Bold.ttf', FONT_DIR),
  naskh: new URL('NotoNaskhArabic-Regular.ttf', FONT_DIR),
};

const INK = '#111111';
const GREY = '#5f6b7a';
const ACCENT = '#1f6f4a';

export function posterEnabled() {
  return true; // the caller gates on features.sourceLinks
}

export function posterDir() {
  return path.join(config.paths.data, 'posters');
}

export function posterFileName(source) {
  const safe = String(source || 'source').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'source';
  return `poster-${safe}.pdf`;
}

/** Only an image inside the repo, only one pdfkit can embed. */
function logoFile() {
  const raw = business()?.poster?.logo || business()?.logo || null;
  if (!raw) return null;
  try {
    const file = path.resolve(config.root, String(raw));
    if (!file.startsWith(path.resolve(config.root))) return null;
    if (!/\.(png|jpe?g)$/i.test(file)) return null;
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/** Opening hours, whether the profile stores them as one line or per day. */
export function posterHours() {
  const hours = business()?.hours;
  if (!hours) return '';
  if (typeof hours === 'string') return hours.replace(/\s+/g, ' ').trim();
  if (typeof hours === 'object') {
    return Object.entries(hours)
      .filter(([, value]) => value)
      .map(([day, value]) => `${day} ${value}`)
      .join(' · ');
  }
  return '';
}

/** Everything the poster will say, in one object. Content only, no drawing. */
export function posterModel({ link }) {
  const b = business() || {};
  const poster = b.poster || {};
  const number = readableNumber();
  return {
    business: b.name || config.owner.name || 'Our business',
    city: b.city || '',
    address: b.address || '',
    hours: posterHours(),
    number,
    headline: poster.headline || 'Chat with us on WhatsApp',
    subline: poster.subline || 'Scan the code to start a chat',
    footer: poster.footer || '',
    source: link?.source || '',
    sourceLabel: sourceLabel(link?.source || ''),
    url: link?.url || '',
  };
}

function registerFonts(doc) {
  for (const [name, file] of Object.entries(FONTS)) {
    doc.registerFont(name, fs.readFileSync(file));
  }
}

/** Draw one string in whatever script it is really in. */
function write(doc, text, { font = 'sans', size = 12, color = INK, align = 'left', x = null, y = null, width = null, lineGap = 0 } = {}) {
  const value = String(text ?? '');
  if (!value.trim()) return doc;
  const p = printable(value);
  const face = p.script === 'arabic' ? 'naskh' : font;
  doc.font(face).fontSize(p.script === 'arabic' ? size + 1 : size).fillColor(color);
  const opts = { align, lineGap, characterSpacing: 0 };
  if (width !== null) opts.width = width;
  if (x !== null && y !== null) doc.text(p.text, x, y, opts);
  else doc.text(p.text, opts);
  return doc;
}

/**
 * Render the poster.
 *
 * @param {{link:{source:string,url:string,message:string}, qr?:Buffer, now?:Date}} input
 * @returns {Promise<Buffer>}
 */
export function renderPosterPDF({ link, qr, now = new Date() } = {}) {
  const model = posterModel({ link });
  if (!qr?.length) throw new Error('no QR image');

  return new Promise((resolve, reject) => {
    let doc;
    try {
      doc = new PDFDocument({
        size: 'A4',
        margin: 48,
        // A poster is a document with one job; the metadata says so.
        info: {
          Title: `${model.headline} — ${model.business}`,
          Author: model.business,
          Subject: `QR poster (${model.source || 'source'})`,
          Creator: 'WhatsApp assistant',
          CreationDate: now,
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

      // ── header: who this is ───────────────────────────────
      const logo = logoFile();
      let headerWidth = width;
      if (logo) {
        try {
          doc.image(logo, right - 70, 44, { fit: [70, 70] });
          headerWidth = width - 86;
        } catch {
          /* an unreadable logo must not cost the owner a poster */
        }
      }

      write(doc, model.business, { font: 'bold', size: 26, width: headerWidth });
      doc.moveDown(0.25);
      const where = [model.address, model.city].filter(Boolean).join(' · ');
      if (where) write(doc, where, { size: 11, color: GREY, width: headerWidth });

      // ── the one sentence that matters ─────────────────────
      doc.y = 200;
      doc.moveTo(left, doc.y - 26).lineTo(right, doc.y - 26).lineWidth(1).strokeColor('#e2e6ea').stroke();
      write(doc, model.headline, { font: 'bold', size: 30, color: ACCENT, width });
      doc.moveDown(0.3);
      write(doc, model.subline, { size: 13, color: GREY, width });

      // ── the QR ────────────────────────────────────────────
      const qrSize = 300;
      const qrX = left + (width - qrSize) / 2;
      const qrY = 300;
      // A white plate and a quiet zone: the scanner needs contrast, not style.
      doc.roundedRect(qrX - 18, qrY - 18, qrSize + 36, qrSize + 36, 12).fillAndStroke('#ffffff', '#e2e6ea');
      doc.image(qr, qrX, qrY, { width: qrSize, height: qrSize });

      // ── the number, readable ──────────────────────────────
      doc.y = qrY + qrSize + 46;
      write(doc, model.number || '—', { font: 'bold', size: 24, align: 'center', width });
      doc.moveDown(0.2);
      write(doc, 'WhatsApp', { size: 11, color: GREY, align: 'center', width, });

      // ── hours ─────────────────────────────────────────────
      if (model.hours) {
        doc.moveDown(1.6);
        write(doc, model.hours, { size: 12, color: INK, align: 'center', width });
      }

      // ── footer ────────────────────────────────────────────
      const footerY = doc.page.height - doc.page.margins.bottom - 24;
      if (model.footer) {
        write(doc, model.footer, { size: 9, color: GREY, x: left, y: footerY - 14, width });
      }
      if (model.sourceLabel) {
        // Which poster this is, so a box of them can be told apart when printed.
        write(doc, `Source: ${model.sourceLabel}`, { size: 9, color: GREY, x: left, y: footerY + 2, width, align: 'right' });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Build (and cache) the poster for one source.
 * @returns {Promise<{ok:boolean, buffer?:Buffer, file?:string, fileName?:string, model?:object, reason?:string}>}
 */
export async function buildPoster({ link, now = new Date() } = {}) {
  if (!link?.url) return { ok: false, reason: 'no_link' };
  try {
    const qr = await qrPng(link.url, { width: 900, margin: 1 });
    const buffer = await renderPosterPDF({ link, qr, now });
    const fileName = posterFileName(link.source);

    let file = null;
    try {
      fs.mkdirSync(posterDir(), { recursive: true });
      file = path.join(posterDir(), fileName);
      fs.writeFileSync(file, buffer);
    } catch {
      /* not being able to cache it is not a reason to withhold it */
    }

    return { ok: true, buffer, file, fileName, model: posterModel({ link }) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export default { buildPoster, renderPosterPDF, posterModel, posterHours, posterDir, posterFileName, posterEnabled };
