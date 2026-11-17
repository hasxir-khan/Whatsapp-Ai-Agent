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

function cleanText(text = '') {
  const clean = String(text)
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean) return null;
  return clean.slice(0, config.limits.maxDocChars);
}

/** Short, client-appropriate summary of an arbitrary document. */
export async function summarizeDocument(text, { context = '' } = {}) {
  if (!text || !hasLLM()) return null;
  try {
    const result = await chat({
      small: true,
      temperature: 0.3,
      maxTokens: 500,
      system:
        'You summarise documents sent on WhatsApp to a freelance developer. Be brief, factual and useful. No preamble.',
      messages: [
        {
          role: 'user',
          content: `Document:
"""
${text.slice(0, 6000)}
"""

${context ? `Client/project context: ${context}\n` : ''}
Write:
1. One line: what this document is.
2. 2–4 bullets: the points that matter for a software project (requirements, scope, budget, dates, deliverables).
3. One line: the obvious next step.
Keep it under 90 words.`,
        },
      ],
    });
    return result.text || null;
  } catch {
    return null;
  }
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
