// src/services/knowledge.js
// The business's own documents — menus, price sheets, policies, catalogues,
// anything the owner can point at.
//
// Phase 1 (this file): read the document, pull the text out, split it into
// chunks and store them in SQLite with a stable source name. Phase 2 adds
// embeddings to the same rows and retrieves top-k chunks per message.
//
// No network except when the owner explicitly passes a URL.

import fs from 'node:fs';
import path from 'node:path';
import { extractText } from './documents.js';
import {
  replaceKnowledgeSource,
  knowledgeSources,
  knowledgeStats,
  searchKnowledge,
  deleteKnowledgeSource,
} from '../utils/db.js';

const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 120;

/** Split text into overlapping chunks on paragraph boundaries where possible. */
export function chunkText(text, { size = CHUNK_SIZE, overlap = CHUNK_OVERLAP } = {}) {
  const clean = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const paragraphs = clean.split(/\n\n+/);
  const chunks = [];
  let current = '';

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    // start the next chunk with a tail of the previous one for continuity
    current = current.length > overlap ? current.slice(-overlap) : '';
  };

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length <= size) {
      current = current ? `${current}\n\n${para}` : para;
      continue;
    }
    if (current) flush();
    if (para.length <= size) {
      current = current ? `${current}\n\n${para}` : para;
      continue;
    }
    // a single huge paragraph: hard-split it
    let rest = para;
    while (rest.length > size) {
      chunks.push(rest.slice(0, size).trim());
      rest = rest.slice(size - overlap);
    }
    current = rest;
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.filter((c) => c.length > 20);
}

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&mdash;': '—',
  '&ndash;': '–',
};

/** Readable text from an HTML page — good enough for price lists and menus. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchWithTimeout(url, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'WhatsApp-AI-Agent/9 (+business knowledge import)' },
    });
  } finally {
    clearTimeout(timer);
  }
}

export function isUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

/** Ingest raw text under a named source. */
export function ingestText(text, { source = 'text:untitled', title = null } = {}) {
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error('That document had no readable text.');
  const count = replaceKnowledgeSource(source, chunks, { title, rules: { chunkSize: CHUNK_SIZE, overlap: CHUNK_OVERLAP } });
  return { source, title, chunks: count, chars: String(text).length };
}

/** Ingest a local file: .txt/.md/.json/.csv/.pdf/.docx (whatever documents.js can read). */
export async function ingestFile(filePath, { title = null } = {}) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${filePath}`);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw new Error(`${filePath} is a folder — point me at a file`);
  if (stat.size > 25 * 1024 * 1024) throw new Error('That file is bigger than 25 MB. Split it, or paste the important part.');
  const buffer = fs.readFileSync(abs);
  const name = path.basename(abs);
  const text = await extractText(buffer, { fileName: name, mimetype: '' });
  if (!text || !String(text).trim()) {
    throw new Error(`Could not read any text from ${name}. If it is a scan, export it as text or PDF first.`);
  }
  const source = `file:${name}`;
  return ingestText(text, { source, title: title || name });
}

/** Ingest a web page (menu, services page, policy page). */
export async function ingestUrl(url, { title = null } = {}) {
  const clean = String(url || '').trim();
  if (!isUrl(clean)) throw new Error('That does not look like a URL (needs http:// or https://).');
  const res = await fetchWithTimeout(clean);
  if (!res.ok) throw new Error(`Could not fetch ${clean} (HTTP ${res.status}).`);
  const type = res.headers.get('content-type') || '';
  const body = await res.arrayBuffer();
  let text;
  if (type.includes('pdf')) {
    text = await extractText(Buffer.from(body), { fileName: 'page.pdf', mimetype: 'application/pdf' });
  } else {
    const html = Buffer.from(body).toString('utf8');
    text = htmlToText(html);
  }
  if (!text || !text.trim()) throw new Error('That page had no readable text (it may need JavaScript).');
  const source = `url:${clean}`;
  return ingestText(text, { source, title: title || new URL(clean).hostname });
}

/** One entry point: URL or file, decided by the string. */
export async function ingest(target, options = {}) {
  return isUrl(target) ? ingestUrl(target, options) : ingestFile(target, options);
}

export function listSources() {
  return knowledgeSources();
}

export function stats() {
  return knowledgeStats();
}

export function remove(source) {
  return deleteKnowledgeSource(source);
}

/** Phase-1 preview: substring search (Phase 2 swaps in vectors). */
export function preview(query, limit = 3) {
  return searchKnowledge(query, limit);
}

export default { ingest, ingestText, ingestFile, ingestUrl, chunkText, htmlToText, listSources, stats, remove, preview, isUrl };
