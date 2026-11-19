// src/core/brevity.js
// The fewest sentences that work.
//
// A WhatsApp reply that needs a scroll to read is a reply nobody reads. The
// model is told this in the prompt (see `brevityInstruction`), and what it
// still sends too long is trimmed here — locally, without a second model call,
// because asking a second time for "shorter" costs seconds and money and
// sometimes returns something even longer.
//
// The exceptions matter more than the rule:
//   • a quote with a price band, a list the customer asked for, or a set of
//     steps is *information*, not waffle — those are left alone (only compacted);
//   • a sentence that carries a number, a price, a link or a time is never
//     dropped, because that is usually the whole point of the reply;
//   • the language is never changed: trimming removes sentences, it does not
//     rewrite them.

import { config } from '../config/env.js';
import { business, tone as toneProfile } from '../services/profile.js';

export const DEFAULT_MAX_SENTENCES = 2;

const FILLER_OPENERS = [
  /^(sure|sure thing|certainly|of course|absolutely|great question|good question|no problem|happy to help|thanks for reaching out|thank you for reaching out)[!,.\s—-]+/i,
  /^(bilkul|zaroor|zarur|theek hai|theek|ji bilkul|ji zaroor|koi masla nahi|koi baat nahi|shukriya|thanks)[!,.\s—-]+/i,
  /^(بالکل|ضرور|ٹھیک ہے|جی بالکل|شکریہ|کوئی مسئلہ نہیں)[!,۔\s—-]+/i,
];

const DETAIL_HINTS =
  /\b(detail|details|detail(s)? mein|tafseel|tafseel|explain|explanation|breakdown|steps|process|options|list|compare|comparison|quote|estimate|package|packages|invoice|summary|samjha|samjhao|poora|poori|sab kuch)\b|تفصیل|سمجھا|فہرست|اقتباس|تخمینہ/i;

const QUESTION_HINTS = /\b(what|how|which|when|where|who|why|kitna|kitne|kya|kaise|kab|kahan|kaun|kis)\b|کیا|کیسے|کب|کہاں|کتنا/i;

/** True when the customer asked for depth, so brevity would be rude. */
export function wantsDetail(userText = '') {
  return DETAIL_HINTS.test(String(userText || ''));
}

/**
 * Split into sentences without breaking abbreviations, prices ("Rs. 1500") or
 * a decimal. Handles the Urdu full stop (۔) as well as . ! ? …
 */
export function splitSentences(text = '') {
  const body = String(text || '').replace(/\r/g, '').trim();
  if (!body) return [];
  const out = [];
  let buf = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    buf += ch;
    const end = /[.!?۔]/.test(ch) || (ch === '…' && i === body.length - 1);
    if (!end) continue;
    // "Rs. 1500", "3.5k", "e.g." and "Mr." are not sentence ends.
    const next = body[i + 1] || '';
    // "3.5m", "e.g.", "Rs. 1500": a dot inside a token, not the end of one.
    const lastToken = buf.slice(0, -1).split(/\s/).pop() || '';
    const numericToken = /^[₹$]?[\d,]+$/.test(lastToken);
    if (ch === '.' && ((/^\d/.test(next) && numericToken) || /(?:^|\s)(?:rs|mr|mrs|dr|vs|e\.g|i\.e)\.$/i.test(buf))) {
      continue;
    }
    // A closing quote/bracket belongs to the sentence.
    while (i + 1 < body.length && /["'”’)\]]/.test(body[i + 1])) {
      buf += body[i + 1];
      i += 1;
    }
    out.push(buf.trim());
    buf = '';
    // Skip the space after the stop so the next sentence starts clean.
    while (i + 1 < body.length && /\s/.test(body[i + 1])) i += 1;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

/** Lines that are a list, a table or a step-by-step: information, not prose. */
export function isListLike(text = '') {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return false;
  const bullets = lines.filter((l) => /^\s*(?:[-*•·–—]|\d{1,2}[.)]|[a-z][.)])\s+/i.test(l)).length;
  return bullets >= 2;
}

/** A price band, a quote table or a set of numbers the customer must see. */
export function isNumberHeavy(text = '') {
  const body = String(text || '');
  const numbers = body.match(/\d[\d,.]*\s*(?:k|K|lakh|lac|%|rs|pkr|\/-)?/g) || [];
  const currency = (body.match(/\b(?:rs\.?|pkr|aed|usd|sar)\b/gi) || []).length + (body.match(/₹|\$|روپے/g) || []).length;
  // A price band ("60,000 – 120,000") or a table of numbers is a quote; a single
  // price mentioned in passing is not.
  const range = /\d[\d,]*\s*(?:-|–|to|se)\s*\d[\d,]*/i.test(body);
  return range || numbers.length >= 3 || (currency >= 2 && numbers.length >= 2);
}

/** Does this sentence carry something that must never be dropped? */
export function carriesFacts(sentence = '') {
  const s = String(sentence || '');
  return /https?:\/\/|www\.|\d|@/.test(s) || /\b(?:rs|pkr|aed|usd|\$|₹)\b/i.test(s) || /روپے|قیمت/.test(s);
}

const countQuestions = (text) => (String(text || '').match(/[?؟]/g) || []).length;

/** How many sentences actually say something? */
export function sentenceCount(text = '') {
  return splitSentences(text).length;
}

/** The instruction every agent gets, in every language. */
export function brevityInstruction({ maxSentences = DEFAULT_MAX_SENTENCES, lang = null } = {}) {
  const n = Math.max(1, Math.min(6, Number(maxSentences) || DEFAULT_MAX_SENTENCES));
  return [
    `Brevity: use the FEWEST sentences that answer the question — default at most ${n} short sentences (~30 words).`,
    'Go longer ONLY when they asked for detail, a breakdown, a list, a quote or an estimate.',
    'No filler openers ("Sure!", "Great question", "Bilkul!"). Never repeat their question back to them.',
    'At most ONE question per reply, at the end, and only if it moves things forward.',
    "Mirror the customer's length and language — a two-word message gets a short reply.",
    lang ? 'Keep the reply in the conversation’s language no matter how short it is.' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** The effective sentence cap: profile first, then env. */
export function maxSentences() {
  const fromBusiness = business()?.tone?.maxSentences;
  const fromTone = toneProfile()?.maxSentences;
  const fromEnv = Number(process.env.REPLY_MAX_SENTENCES);
  const value = [fromBusiness, fromTone, Number.isFinite(fromEnv) ? fromEnv : null].find((v) => Number.isFinite(Number(v)) && v !== null && v !== undefined);
  const n = Math.max(1, Math.min(6, Number(value) || DEFAULT_MAX_SENTENCES));
  return n;
}

/**
 * Trim a reply that is over the limit.
 *
 * @param {string} text
 * @param {{userText?:string, maxSentences?:number, lang?:string, keepQuestions?:boolean}} opts
 * @returns {{text:string, changed:boolean, dropped:string[], reason:string|null}}
 */
export function trimReply(text, { userText = '', maxSentences: cap = null, lang = null } = {}) {
  const body = String(text || '').trim();
  const result = { text: body, changed: false, dropped: [], reason: null };
  if (!body) return result;

  // Exempt: lists, tables, quotes and anything the customer explicitly wanted
  // in detail. They may be long; they are not waffle.
  if (isListLike(body)) return { ...result, reason: 'list' };
  if (wantsDetail(userText)) return { ...result, reason: 'asked for detail' };
  if (isNumberHeavy(body) && countQuestions(body) === 0) return { ...result, reason: 'quote/numbers' };

  const limit = Math.max(1, Math.min(6, Number(cap) || maxSentences()));

  // 1. Filler opener — always noise, even in a two-sentence reply.
  let working = body;
  // Only a filler that is its *own sentence* is noise. "Theek hai, address
  // bata dein…" — the greeting and the request are one thought, and cutting it
  // in half changes the speaker, not the length.
  const multiSentence = splitSentences(body).length >= 2;
  for (let pass = 0; multiSentence && pass < 3; pass += 1) {
    let hit = false;
    for (const re of FILLER_OPENERS) {
      if (re.test(working)) {
        const stripped = working.replace(re, '').trim();
        const removed = working.slice(0, working.length - stripped.length).trim();
        const standaloneSentence = /[.!?۔…]$/.test(removed);
        if (!standaloneSentence) break;
        if (splitted(stripped)) {
          result.dropped.push(working.slice(0, working.length - stripped.length).trim());
          working = stripped;
          hit = true;
        }
        break;
      }
    }
    if (!hit) break;
  }

  let sentences = splitSentences(working);

  // 2. More than one question: keep the last one, drop the earlier question
  //    sentences (a reply that interrogates is not a conversation).
  if (countQuestions(working) > 1) {
    let seenQuestion = false;
    const kept = [];
    for (let i = sentences.length - 1; i >= 0; i -= 1) {
      const isQ = /[?؟]/.test(sentences[i]);
      if (isQ && seenQuestion) {
        result.dropped.push(sentences[i]);
        continue;
      }
      if (isQ) seenQuestion = true;
      kept.unshift(sentences[i]);
    }
    sentences = kept;
  }

  // 3. Over the sentence cap: drop from the end, but never drop a sentence
  //    whose facts the customer needs (a price, a time, a link).
  if (sentences.length > limit) {
    // A closing question is the part that keeps the conversation moving, so it
    // survives the cut in place of the sentence before it.
    const endsWithQuestion = limit >= 2 && /[?؟]/.test(sentences[sentences.length - 1] || '');
    const keep = endsWithQuestion
      ? [...sentences.slice(0, limit - 1), sentences[sentences.length - 1]]
      : sentences.slice(0, limit);
    const extra = endsWithQuestion ? sentences.slice(limit - 1, -1) : sentences.slice(limit);
    const factual = extra.filter(carriesFacts);
    if (factual.length) {
      // Fold the numbers in as one compact sentence instead of dropping them —
      // but before a closing question, never after it.
      const facts = factual
        .map((x) => x.replace(/\s+/g, ' ').replace(/^[-•*]\s*/, '').trim())
        .join(' ');
      if (facts && !keep.some((x) => x.includes(facts.slice(0, 12)))) {
        const tailIsQuestion = /[?؟]\s*$/.test(keep[keep.length - 1] || '');
        if (tailIsQuestion) keep.splice(keep.length - 1, 0, facts);
        else keep.push(facts);
      }
      // The fold can push the reply one sentence over the cap again. Drop in
      // this order: a non-factual sentence from the end, then a non-factual
      // opener, and only then a factual sentence — never the closing question.
      while (keep.length > limit) {
        const tailIsQuestion = /[?؟]\s*$/.test(keep[keep.length - 1] || '');
        const lastIdx = tailIsQuestion ? keep.length - 2 : keep.length - 1;
        let victim = -1;
        for (let i = lastIdx; i >= 1; i -= 1) {
          if (!carriesFacts(keep[i])) {
            victim = i;
            break;
          }
        }
        if (victim === -1 && lastIdx >= 1 && !carriesFacts(keep[0])) victim = 0;
        if (victim === -1 && lastIdx >= 1) victim = 1;
        if (victim === -1) break;
        const [removed] = keep.splice(victim, 1);
        if (removed) result.dropped.push(removed);
      }
      result.dropped.push(...extra.filter((x) => !factual.includes(x)));
    } else {
      result.dropped.push(...extra);
    }
    sentences = keep;
  }

  let out = sentences.join(' ').replace(/\s+/g, ' ').trim();
  // Never leave a dangling comma or a half-written clause behind.
  out = out.replace(/[,;:–-]\s*$/, '').trim();
  if (!out || out.length < 2) return result;
  if (out === body) return result;
  return { text: out, changed: true, dropped: result.dropped, reason: 'trimmed' };
}

function splitted(text) {
  return splitSentences(text).length > 0;
}

export default {
  DEFAULT_MAX_SENTENCES,
  brevityInstruction,
  maxSentences,
  trimReply,
  splitSentences,
  sentenceCount,
  isListLike,
  isNumberHeavy,
  carriesFacts,
  wantsDetail,
};
