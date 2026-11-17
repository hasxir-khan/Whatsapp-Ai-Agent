// src/services/language.js
// Detects the language *and script* a client is writing in, so replies can
// mirror them exactly. Handles the awkward ones for Pakistani businesses:
// English vs Roman Urdu ("Hinglish"), and Urdu vs Arabic vs Persian script.

const SCRIPTS = {
  arabic: /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/,
  cyrillic: /[\u0400-\u04FF]/,
  devanagari: /[\u0900-\u097F]/,
  bengali: /[\u0980-\u09FF]/,
  han: /[\u4E00-\u9FFF\u3400-\u4DBF]/,
  hangul: /[\uAC00-\uD7AF\u1100-\u11FF]/,
  hiragana: /[\u3040-\u309F\u30A0-\u30FF]/,
  thai: /[\u0E00-\u0E7F]/,
  hebrew: /[\u0590-\u05FF]/,
  greek: /[\u0370-\u03FF]/,
  tamil: /[\u0B80-\u0BFF]/,
  telugu: /[\u0C00-\u0C7F]/,
  gujarati: /[\u0A80-\u0AFF]/,
};

const WORD_SETS = {
  en: ['the', 'is', 'are', 'you', 'your', 'we', 'i', 'need', 'want', 'please', 'thanks', 'thank', 'can', 'could', 'for', 'my', 'and', 'have', 'would', 'with', 'this', 'that', 'how', 'much', 'price', 'website', 'project', 'hello', 'hi'],
  'roman-ur': ['hai', 'hain', 'kya', 'nahi', 'nahin', 'aap', 'tum', 'yaar', 'bhai', 'karo', 'kar', 'chahiye', 'mera', 'meri', 'mujhe', 'acha', 'achha', 'theek', 'thik', 'han', 'haan', 'banao', 'banwana', 'kitna', 'kitne', 'kab', 'kaise', 'kyun', 'salam', 'assalam', 'shukriya', 'batao', 'bata', 'karna', 'hoga', 'ho', 'raha'],
  es: ['el', 'la', 'los', 'las', 'que', 'para', 'con', 'una', 'por', 'como', 'pero', 'estoy', 'necesito', 'quiero', 'gracias', 'hola', 'puedo', 'tiene', 'muy', 'también', 'proyecto', 'precio'],
  fr: ['le', 'la', 'les', 'des', 'que', 'pour', 'avec', 'une', 'et', 'est', 'je', 'vous', 'nous', 'bonjour', 'merci', 'besoin', 'projet', 'prix', 'pouvez', 'très'],
  de: ['der', 'die', 'das', 'und', 'ist', 'ich', 'wir', 'nicht', 'mit', 'für', 'ein', 'eine', 'bitte', 'danke', 'brauche', 'hallo', 'projekt', 'preis', 'können'],
  pt: ['que', 'para', 'com', 'uma', 'não', 'estou', 'preciso', 'obrigado', 'você', 'olá', 'projeto', 'preço', 'muito', 'também'],
  it: ['il', 'che', 'per', 'con', 'una', 'sono', 'non', 'prego', 'grazie', 'vorrei', 'progetto', 'prezzo', 'molto', 'ciao'],
  tr: ['bir', 've', 'bu', 'için', 'ile', 'değil', 'çok', 'nasıl', 'merhaba', 'teşekkür', 'proje', 'fiyat', 'istiyorum'],
  id: ['yang', 'dan', 'untuk', 'dengan', 'saya', 'tidak', 'ini', 'itu', 'bisa', 'terima', 'kasih', 'proyek', 'harga', 'mau'],
  tl: ['ang', 'ng', 'mga', 'para', 'ako', 'hindi', 'salamat', 'kumusta', 'gusto', 'proyekto'],
  nl: ['de', 'het', 'een', 'en', 'ik', 'niet', 'voor', 'met', 'dank', 'hoe', 'project', 'prijs', 'graag'],
  pl: ['nie', 'jest', 'się', 'dla', 'oraz', 'dzień', 'cześć', 'dziękuję', 'projekt', 'cena'],
  sw: ['na', 'ya', 'kwa', 'ni', 'wa', 'hii', 'asante', 'habari', 'nataka', 'bei'],
  ur: ['ہے', 'میں', 'آپ', 'نہیں', 'کیا', 'کی', 'کا', 'ہیں', 'شکریہ', 'سلام', 'بھائی', 'کام', 'کرنا', 'چاہیے', 'مجھے', 'کہاں', 'کتنا'],
  ar: ['أنا', 'أنت', 'هذا', 'هذه', 'كيف', 'شكرا', 'شكراً', 'مرحبا', 'هل', 'لا', 'نعم', 'من', 'على', 'في', 'مشروع', 'سعر', 'أريد'],
  fa: ['است', 'که', 'این', 'را', 'برای', 'با', 'من', 'شما', 'ممنون', 'سلام', 'خوب', 'پروژه', 'قیمت'],
  hi: ['है', 'हैं', 'मैं', 'आप', 'नहीं', 'क्या', 'के', 'का', 'की', 'शुक्रिया', 'नमस्ते', 'चाहिए', 'प्रोजेक्ट'],
  bn: ['আমি', 'আপনি', 'কি', 'না', 'ধন্যবাদ', 'سلام', 'প্রজেক্ট', 'দাম'],
};

const LABELS = {
  en: { label: 'English', locale: 'en-US', rtl: false },
  'roman-ur': { label: 'Roman Urdu / Hinglish', locale: 'en-US', rtl: false },
  ur: { label: 'Urdu', locale: 'ur-PK', rtl: true },
  ar: { label: 'Arabic', locale: 'ar-SA', rtl: true },
  fa: { label: 'Persian', locale: 'fa-IR', rtl: true },
  hi: { label: 'Hindi', locale: 'hi-IN', rtl: false },
  bn: { label: 'Bengali', locale: 'bn-BD', rtl: false },
  es: { label: 'Spanish', locale: 'es-ES', rtl: false },
  fr: { label: 'French', locale: 'fr-FR', rtl: false },
  de: { label: 'German', locale: 'de-DE', rtl: false },
  pt: { label: 'Portuguese', locale: 'pt-BR', rtl: false },
  it: { label: 'Italian', locale: 'it-IT', rtl: false },
  tr: { label: 'Turkish', locale: 'tr-TR', rtl: false },
  id: { label: 'Indonesian', locale: 'id-ID', rtl: false },
  tl: { label: 'Filipino', locale: 'fil-PH', rtl: false },
  nl: { label: 'Dutch', locale: 'nl-NL', rtl: false },
  pl: { label: 'Polish', locale: 'pl-PL', rtl: false },
  sw: { label: 'Swahili', locale: 'sw-KE', rtl: false },
  ru: { label: 'Russian', locale: 'ru-RU', rtl: false },
  uk: { label: 'Ukrainian', locale: 'uk-UA', rtl: false },
  el: { label: 'Greek', locale: 'el-GR', rtl: false },
  he: { label: 'Hebrew', locale: 'he-IL', rtl: true },
  zh: { label: 'Chinese', locale: 'zh-CN', rtl: false },
  ja: { label: 'Japanese', locale: 'ja-JP', rtl: false },
  ko: { label: 'Korean', locale: 'ko-KR', rtl: false },
  th: { label: 'Thai', locale: 'th-TH', rtl: false },
  ta: { label: 'Tamil', locale: 'ta-IN', rtl: false },
  te: { label: 'Telugu', locale: 'te-IN', rtl: false },
  gu: { label: 'Gujarati', locale: 'gu-IN', rtl: false },
  unknown: { label: 'the client’s language', locale: 'en-US', rtl: false },
};

function scriptOf(text) {
  for (const [name, re] of Object.entries(SCRIPTS)) {
    if (re.test(text)) return name;
  }
  return 'latin';
}

function countWords(tokens, set) {
  if (!set) return 0;
  return tokens.filter((t) => set.includes(t)).length;
}

/**
 * @param {string} text
 * @returns {{code:string,label:string,locale:string,rtl:boolean,script:string,confidence:number}}
 */
export function detectLanguage(text = '') {
  const clean = String(text || '').trim();
  if (!clean) return { code: 'unknown', ...LABELS.unknown, script: 'latin', confidence: 0 };

  const script = scriptOf(clean);
  const tokens = clean
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'’-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 120);

  const scores = {};
  const add = (code, n) => {
    if (n > 0) scores[code] = (scores[code] || 0) + n;
  };

  // Script-first detection — unambiguous winners
  const scriptMap = {
    arabic: null, // decided by words below
    cyrillic: 'ru',
    devanagari: 'hi',
    bengali: 'bn',
    han: 'zh',
    hangul: 'ko',
    hiragana: 'ja',
    thai: 'th',
    hebrew: 'he',
    greek: 'el',
    tamil: 'ta',
    telugu: 'te',
    gujarati: 'gu',
  };

  if (scriptMap[script]) {
    const code = scriptMap[script];
    return { code, ...LABELS[code], script, confidence: 0.95 };
  }

  if (script === 'arabic') {
    for (const code of ['ur', 'ar', 'fa']) add(code, countWords(tokens, WORD_SETS[code]));
    // Urdu-only letters that Arabic doesn't use
    if (/[ٹڈڑںےۓ]/.test(clean)) add('ur', 3);
    if (/[پچژگک]/.test(clean) && !/[ٹڈڑںےۓ]/.test(clean)) {
      add('fa', 1);
      add('ur', 1);
    }
    const best = top(scores) || 'ur';
    return { code: best, ...LABELS[best], script, confidence: 0.7 };
  }

  // Latin script → word-frequency vote
  for (const [code, set] of Object.entries(WORD_SETS)) {
    if (['ur', 'ar', 'fa', 'hi', 'bn'].includes(code)) continue; // non-latin sets
    add(code, countWords(tokens, set));
  }

  // A couple of strong Roman-Urdu tells
  if (/\b(hai|hain|kya|nahi|nahin|aap|yaar|bhai|chahiye|karo|mujhe|kitna|theek)\b/i.test(clean)) add('roman-ur', 2);

  const englishScore = scores.en || 0;
  const romanScore = scores['roman-ur'] || 0;

  let best = top(scores);
  if (!best) {
    // No signal: very short Latin messages are usually a greeting or a name
    best = tokens.length <= 3 ? 'en' : 'en';
  }

  // English vs Roman Urdu is genuinely ambiguous; Urdu wins on ties because a
  // Pakistani client writing "hai/kya" is not writing formal English.
  if (romanScore > 0 && romanScore >= englishScore) best = 'roman-ur';
  if (romanScore > 0 && englishScore > romanScore * 2) best = 'en';

  const confidence = Math.min(0.95, 0.35 + 0.1 * (scores[best] || 1));
  return { code: best, ...LABELS[best], script, confidence };
}

function top(scores) {
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] || null;
}

/** Prompt fragment that tells the model exactly how to answer. */
export function mirrorInstruction(langInfo) {
  if (!langInfo || langInfo.code === 'unknown') {
    return 'Reply in the same language and script the client used. If unsure, use simple English.';
  }
  if (langInfo.code === 'roman-ur') {
    return 'The client writes Roman Urdu / Hinglish (Urdu in English letters). Reply in the SAME style: Roman Urdu mixed with English tech words. Never switch to Urdu script or formal English.';
  }
  if (langInfo.code === 'ur') {
    return 'The client writes in Urdu script. Reply in Urdu script (اردو), natural and conversational — not literary Urdu.';
  }
  if (langInfo.code === 'en') {
    return 'The client writes in English. Reply in natural English (simple, friendly business English — not corporate).';
  }
  return `The client writes in ${langInfo.label}. Reply in ${langInfo.label}, same script, natural and conversational.`;
}

/** Voice suitable for this language, from the owner profile. */
export function voiceForLanguage(langInfo, voiceMap = {}) {
  if (!langInfo) return voiceMap.en;
  if (voiceMap[langInfo.locale]) return voiceMap[langInfo.locale];
  const short = String(langInfo.locale || '').split('-')[0];
  if (voiceMap[short]) return voiceMap[short];
  if (langInfo.code === 'roman-ur') return voiceMap.ur || voiceMap.en;
  const byCode = {
    en: 'en-US-AriaNeural', ur: 'ur-PK-UzmaNeural', hi: 'hi-IN-SwaraNeural',
    ar: 'ar-SA-ZariyahNeural', es: 'es-ES-ElviraNeural', fr: 'fr-FR-DeniseNeural',
    de: 'de-DE-KatjaNeural', pt: 'pt-BR-FranciscaNeural', id: 'id-ID-GadisNeural',
    tr: 'tr-TR-EmelNeural', ru: 'ru-RU-SvetlanaNeural', zh: 'zh-CN-XiaoxiaoNeural',
    ja: 'ja-JP-NanamiNeural', ko: 'ko-KR-SunHiNeural', bn: 'bn-BD-NabanitaNeural',
    fa: 'fa-IR-DilaraNeural', sw: 'sw-KE-ZuriNeural',
  };
  return byCode[langInfo.code] || voiceMap.en || 'en-US-AriaNeural';
}

export default { detectLanguage, mirrorInstruction, voiceForLanguage };
