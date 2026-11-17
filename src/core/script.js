// src/core/script.js
// Urdu and Arabic in a PDF, without lying about what we can render.
//
// The situation, measured rather than assumed:
//   • fontkit (which pdfkit draws with) *does* shape Arabic: GSUB picks the
//     initial/medial/final forms, so joined letters come out joined.
//   • Unicode's presentation forms (U+FE70–FEFF) cover only the letters of
//     standard Arabic. Urdu's own letters — ٹ ڈ ڑ ں ھ ہ ے ک گ چ پ — have no
//     isolated/initial/medial/final codepoints, so they can only be shaped by
//     an OpenType engine.
//   • pdfkit has no bidi and no way to place a shaped glyph run in reverse.
//
// So: a string we can shape *and* reorder is drawn properly; anything else is
// transliterated into Roman Urdu. We never print mirrored or disconnected
// Arabic — that is not "support", it is damage that looks like support.

import reshaper from 'arabic-persian-reshaper';

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB8A-\uFBFF\uFE70-\uFEFF]/;
const DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const ARABIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

/** Any Arabic-script characters in here? */
export function hasArabic(text = '') {
  return ARABIC.test(String(text || ''));
}

/** Strip harakat — they change width and a reversed string would misplace them. */
export function stripDiacritics(text = '') {
  return String(text || '').replace(DIACRITICS, '');
}

function normaliseDigits(text = '') {
  return String(text || '').replace(ARABIC_DIGITS, (d) => {
    const cp = d.codePointAt(0);
    return String(cp >= 0x06f0 ? cp - 0x06f0 : cp - 0x0660);
  });
}

/**
 * Shape a string into presentation forms, if — and only if — every letter can
 * be represented that way. Returns `ok:false` the moment a letter survives
 * unshaped, because a half-shaped word looks broken.
 */
export function shapeArabic(text = '') {
  const raw = normaliseDigits(stripDiacritics(text)).trim();
  if (!raw || !hasArabic(raw)) return { ok: false, text: raw, reason: 'not_arabic' };

  let shaped;
  try {
    shaped = reshaper.ArabicShaper.convertArabic(raw);
  } catch {
    return { ok: false, text: raw, reason: 'shaper_failed' };
  }

  // Anything still in the base Arabic block means ascii-shaped leftovers:
  // Urdu's extra letters, or a letter the shaper does not know.
  if (ARABIC.test(shaped.replace(/[\uFE70-\uFEFF]/g, ''))) {
    return { ok: false, text: raw, reason: 'unsupported_letters' };
  }
  return { ok: true, text: shaped };
}

/** Presentation forms in visual order: rightmost letter first, drawn LTR. */
export function visualOrder(shaped = '') {
  return [...String(shaped || '')].reverse().join('');
}

// ── transliteration ───────────────────────────────────────────
// Readable, not scholarly: this exists so an Urdu item name is *legible* in a
// PDF, not so it can be converted back. Digraphs first, longest match wins.
const DIGRAPHS = [
  ['ٹھ', 'th'], ['ڈھ', 'dh'], ['ڑھ', 'rh'], ['چھ', 'chh'], ['کھ', 'kh'],
  ['گھ', 'gh'], ['بھ', 'bh'], ['پھ', 'ph'], ['تھ', 'th'], ['جھ', 'jh'],
  ['دھ', 'dh'], ['سھ', 'sh'], ['شھ', 'sh'], ['لھ', 'lh'], ['مھ', 'mh'],
  ['نھ', 'nh'], ['وھ', 'wh'],
];

const LETTERS = {
  'ا': 'a', 'آ': 'aa', 'أ': 'a', 'إ': 'i', 'ب': 'b', 'پ': 'p', 'ت': 't', 'ٹ': 't',
  'ث': 's', 'ج': 'j', 'چ': 'ch', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ڈ': 'd', 'ذ': 'z',
  'ر': 'r', 'ڑ': 'r', 'ز': 'z', 'ژ': 'zh', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'z',
  'ط': 't', 'ظ': 'z', 'ع': 'a', 'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ک': 'k', 'گ': 'g',
  'ل': 'l', 'م': 'm', 'ن': 'n', 'ں': 'n', 'و': 'o', 'ؤ': 'o', 'ہ': 'h', 'ھ': 'h',
  'ۃ': 'h', 'ة': 'h', 'ی': 'i', 'ي': 'i', 'ئ': 'y', 'ے': 'e', 'ء': '',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

/** Urdu/Arabic script → Roman. Everything we cannot map is dropped, not guessed. */
export function transliterate(text = '') {
  let s = normaliseDigits(stripDiacritics(text)).trim();
  for (const [from, to] of DIGRAPHS) s = s.split(from).join(to);
  let out = '';
  for (const ch of s) {
    if (LETTERS[ch] !== undefined) out += LETTERS[ch];
    else if (ARABIC.test(ch)) out += '';
    else out += ch;
  }
  // Urdu omits short vowels, so letter-by-letter output has none: "qmt",
  // "chkn". One inserted vowel turns those back into words a customer can read
  // ("qmit", "chkin"), without pretending to be a real transliteration scheme.
  const fixWord = (w) => {
    if (!/[a-z]/i.test(w)) return w;
    if (!/[aeiou]/i.test(w) && w.length > 2) return `${w.slice(0, -1)}i${w.slice(-1)}`;
    if (/[bcdfghjklmnpqrstvwxyz]{2}$/i.test(w) && w.length > 3) {
      return `${w.slice(0, -1)}a${w.slice(-1)}`;
    }
    return w;
  };
  return out
    .split(/(\s+)/)
    .map((chunk) => (/^\s+$/.test(chunk) ? chunk : fixWord(chunk)))
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

/**
 * The one function the PDF uses: give me something printable.
 * @returns {{text:string, script:'latin'|'arabic'|'roman', shaped:boolean}}
 */
export function printable(text = '') {
  const raw = String(text ?? '').trim();
  if (!raw) return { text: '', script: 'latin', shaped: false };
  if (!hasArabic(raw)) return { text: raw, script: 'latin', shaped: false };

  const shaped = shapeArabic(raw);
  if (shaped.ok) return { text: visualOrder(shaped.text), script: 'arabic', shaped: true };

  return { text: transliterate(raw), script: 'roman', shaped: false };
}

export default { hasArabic, stripDiacritics, shapeArabic, visualOrder, transliterate, printable };
