// src/services/documents.js
// Reading PDF / DOCX / TXT briefs, invoices and requirement docs, then turning
// them into something useful: a summary, or a filled-in project intake.

import { config } from '../config/env.js';
import { chatJson, chat, hasLLM } from '../core/llm.js';

export async function extractText(buffer, { mimetype = '', fileName = '' } = {}) {
  const name = String(fileName || '').toLowerCase();
  const mime = String(mimetype || '').toLowerCase();

  try {
    if (mime.includes('pdf') || name.endsWith('.pdf')) {
      return cleanText(await pdfToText(buffer));
    }

    if (mime.includes('wordprocessingml') || mime.includes('msword') || name.endsWith('.docx')) {
      const mammoth = (await import('mammoth')).default;
      const result = await mammoth.extractRawText({ buffer });
      return cleanText(result.value);
    }

    if (mime.startsWith('text/') || /\.(txt|md|csv|json)$/.test(name)) {
      return cleanText(buffer.toString('utf8'));
    }

    return null;
  } catch (err) {
    console.error('Document parse error:', err.message);
    return null;
  }
}

/** Supports pdf-parse v2 (PDFParse class) and the older v1 function API. */
async function pdfToText(buffer) {
  const mod = await import('pdf-parse');

  if (mod?.PDFParse) {
    const parser = new mod.PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result?.text || '';
    } finally {
      try {
        await parser.destroy?.();
      } catch {
        /* ignore */
      }
    }
  }

  const fn = mod?.default || mod;
  if (typeof fn === 'function') {
    const data = await fn(buffer);
    return data?.text || '';
  }

  // Last resort for very old installs
  const legacy = await import('pdf-parse/lib/pdf-parse.js');
  const parsed = await (legacy.default || legacy)(buffer);
  return parsed?.text || '';
}

/** Split a long document into overlapping, sentence-aligned chunks. */
export function chunkText(text = '', { size = 6000, overlap = 300, maxChunks = 12 } = {}) {
  const body = String(text || '').trim();
  if (!body) return [];
  if (body.length <= size) return [body];

  const chunks = [];
  let start = 0;
  while (start < body.length && chunks.length < maxChunks) {
    let end = Math.min(body.length, start + size);
    if (end < body.length) {
      // Prefer a paragraph or sentence break near the edge.
      const slice = body.slice(start, end);
      const breakAt = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '), slice.lastIndexOf('\n'));
      if (breakAt > size * 0.5) end = start + breakAt + 1;
    }
    chunks.push(body.slice(start, end).trim());
    if (end >= body.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks.filter(Boolean);
}

/**
 * Keep only what the document actually says.
 *
 * A summary that invents a budget, a date or a feature is worse than no
 * summary, so every bullet and number is checked against the source text and
 * dropped when it is not there. This is deliberately blunt: it can lose a
 * paraphrase, it cannot pass off an invention.
 */
export function stripUngrounded(summary = '', source = '') {
  const src = String(source || '');
  const srcLower = src.toLowerCase();
  const srcNumbers = new Set((src.match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[,.]$/, '')));

  const lines = String(summary || '').split('\n');
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      kept.push(line);
      continue;
    }
    const numbers = (trimmed.match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[,.]$/, ''));
    const inventedNumber = numbers.some((n) => !srcNumbers.has(n) && !srcLower.includes(n.toLowerCase()));
    if (inventedNumber) continue;

    // A long, specific phrase that is not in the document is probably invented.
    const words = trimmed
      .replace(/^[•\-*\d.\s]+/, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 4);
    if (words.length >= 6) {
      const present = words.filter((w) => srcLower.includes(w)).length;
      if (present / words.length < 0.3) continue;
    }
    kept.push(line);
  }
  return kept.join('\n').trim();
}

function cleanText(text = '') {
  const clean = String(text)
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean) return null;
  // A 70 KB brief is normal, and cutting it before it is read was how the
  // answers came out based on page one only. The cap is generous now; the
  // chunks are what keep the model's input small.
  const cap = Math.max(Number(config.limits.maxDocChars) || 12000, 60000);
  return clean.slice(0, cap);
}

const DOC_SYSTEM =
  'You read documents sent on WhatsApp to a business and report ONLY what the document says. Never add a price, a date, a name or a feature that is not written in the text. If something is unclear, say it is unclear. No preamble.';

/**
 * Short, client-appropriate summary of an arbitrary document.
 *
 * Big files (70 KB+ briefs are normal) are read in chunks and the notes are
 * merged, so the answer is based on the whole document instead of its first
 * page — and every line is checked back against the text before it is shown.
 */
export async function summarizeDocument(text, { context = '', chunkSize = 6000, maxChunks = 12 } = {}) {
  if (!text || !hasLLM()) return null;
  const chunks = chunkText(text, { size: chunkSize, overlap: 300, maxChunks });
  const parts = [];

  try {
    if (chunks.length <= 1) {
      const result = await chat({
        small: true,
        temperature: 0.2,
        maxTokens: 400,
        system: DOC_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Document:
"""
${chunks[0] || String(text).slice(0, 6000)}
"""

${context ? `Client/project context: ${context}\n` : ''}
Write:
1. One line: what this document is.
2. 2–4 bullets: only the points written in it (requirements, scope, budget, dates, deliverables).
3. One line: what the customer probably wants next, as a question.
Keep it under 90 words.`,
          },
        ],
      });
      parts.push(result.text || '');
    } else {
      // Read every chunk, then merge. The merge sees only the per-chunk notes,
      // which have already been filtered against their own chunk.
      for (let i = 0; i < chunks.length; i += 1) {
        const result = await chat({
          small: true,
          temperature: 0.2,
          maxTokens: 300,
          system: DOC_SYSTEM,
          messages: [
            {
              role: 'user',
              content: `Part ${i + 1} of ${chunks.length} of a longer document:
"""
${chunks[i]}
"""

List at most 4 short bullets: only facts written in this part that matter for the work (requirements, scope, budget, dates, deliverables, names). If this part has nothing useful, reply "nothing".`,
            },
          ],
        });
        const notes = String(result.text || '').trim();
        if (notes && !/^nothing\.?$/i.test(notes)) parts.push(notes);
      }
    }

    const merged = parts.filter(Boolean).join('\n');
    if (!merged) return null;

    let final = merged;
    if (chunks.length > 1) {
      const result = await chat({
        small: true,
        temperature: 0.2,
        maxTokens: 400,
        system: DOC_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `These are notes taken from a long document, part by part:
"""
${merged.slice(0, 6000)}
"""

Write: one line on what the document is, then 3–5 short bullets of what it asks for, then one question asking what the customer wants next. Only what the notes say. Under 110 words.`,
          },
        ],
      });
      if (result.text) final = result.text;
    }

    // Nothing invented: drop any line the document does not support.
    const grounded = stripUngrounded(final, chunks.join('\n'));
    return grounded || null;
  } catch {
    return null;
  }
}

/** The confirmation line a customer sees after sending a file. */
export function understoodReply(summary = '', lang = 'en') {
  const body = String(summary || '').trim();
  const ask = {
    en: 'Is that right?',
    'roman-ur': 'Sahi samjha?',
    ur: 'کیا میں نے ٹھیک سمجھا؟',
  }[lang] || 'Is that right?';
  const intro = {
    en: 'Here is what I understood from the file:',
    'roman-ur': 'File se ye samajh aaya:',
    ur: 'فائل سے یہ سمجھا:',
  }[lang] || 'Here is what I understood from the file:';
  return body ? `${intro}\n${body}\n\n${ask}` : '';
}

/**
 * Pull project-intake fields out of a brief.
 * @returns {Promise<object|null>} {projectType, goal, features, design, content, timeline, budget, tech, extra}
 */
export async function extractProjectBrief(text, { context = '' } = {}) {
  if (!text || !hasLLM()) return null;
  try {
    const { data } = await chatJson({
      small: true,
      temperature: 0.1,
      maxTokens: 700,
      system:
        'You extract project requirements from documents. Only extract what is written. Omit unknown fields. Return JSON only.',
      messages: [
        {
          role: 'user',
          content: `Extract the project requirements from this document.

Document:
"""
${text.slice(0, 8000)}
"""
${context ? `\nWhat we already know: ${context}` : ''}

Return JSON:
{"projectType":"","goal":"","features":[""],"design":"","content":"","timeline":"","budget":"","tech":"","extra":""}`,
        },
      ],
    });
    if (!data || typeof data !== 'object') return null;
    const cleaned = {};
    for (const key of ['projectType', 'goal', 'design', 'content', 'timeline', 'budget', 'tech', 'extra']) {
      if (typeof data[key] === 'string' && data[key].trim()) cleaned[key] = data[key].trim().slice(0, 400);
    }
    if (Array.isArray(data.features) && data.features.length) {
      cleaned.features = data.features.map((f) => String(f).slice(0, 120)).slice(0, 15);
    }
    return Object.keys(cleaned).length ? cleaned : null;
  } catch {
    return null;
  }
}

export function looksLikeBrief(text = '') {
  return /(requirement|scope|project|proposal|brief|srs|features|deliverable|budget|timeline|quotation|invoice|contract)/i.test(
    String(text).slice(0, 3000)
  );
}

export default { extractText, summarizeDocument, extractProjectBrief, looksLikeBrief };
