// src/services/language.js
// Language, script and register detection for "any language on earth".
//
// Three layers, cheapest first:
//   1. script detection — a message in Chinese, Hebrew or Thai is identifiable
//      from its Unicode block alone, no guessing;
//   2. word markers — short WhatsApp messages ("kitna?", "cuánto?") are too
//      short for statistical detection, so common words vote;
//   3. franc — used only when the first two are inconclusive and the text is
//      long enough to be trustworthy.
//
// It also detects *register* (formal vs casual), because "aap kaise hain" and
// "kya haal hai bhai" want different replies in the same language.

let franc = null;
try {
  const mod = await import('franc');
  franc = mod.franc || mod.default || null;
} catch {
  // franc is optional — everything still works without it
}

// ── scripts ─────────────────────────────────────────────────
const SCRIPTS = [
  ['arabic', /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/],
  ['hebrew', /[\u0590-\u05FF]/],
  ['cyrillic', /[\u0400-\u04FF\u0500-\u052F]/],
  ['devanagari', /[\u0900-\u097F]/],
  ['bengali', /[\u0980-\u09FF]/],
  ['gurmukhi', /[\u0A00-\u0A7F]/],
  ['gujarati', /[\u0A80-\u0AFF]/],
  ['tamil', /[\u0B80-\u0BFF]/],
  ['telugu', /[\u0C00-\u0C7F]/],
  ['kannada', /[\u0C80-\u0CFF]/],
  ['malayalam', /[\u0D00-\u0D7F]/],
  ['sinhala', /[\u0D80-\u0DFF]/],
  ['thai', /[\u0E00-\u0E7F]/],
  ['lao', /[\u0E80-\u0EFF]/],
  ['tibetan', /[\u0F00-\u0FFF]/],
  ['myanmar', /[\u1000-\u109F]/],
  ['georgian', /[\u10A0-\u10FF]/],
  ['hangul', /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/],
  ['ethiopic', /[\u1200-\u137F]/],
  ['cherokee', /[\u13A0-\u13FF]/],
  ['khmer', /[\u1780-\u17FF]/],
  ['hiragana', /[\u3040-\u309F]/],
  ['katakana', /[\u30A0-\u30FF]/],
  ['han', /[\u4E00-\u9FFF\u3400-\u4DBF]/],
  ['greek', /[\u0370-\u03FF]/],
  ['armenian', /[\u0530-\u058F]/],
];

const RTL_CODES = new Set(['ur', 'ar', 'fa', 'ps', 'sd', 'ug', 'he', 'yi', 'ku']);

const LABELS = {
  en: 'English', 'roman-ur': 'Roman Urdu / Hinglish', ur: 'Urdu', hi: 'Hindi', bn: 'Bengali',
  pa: 'Punjabi', gu: 'Gujarati', mr: 'Marathi', ne: 'Nepali', si: 'Sinhala', ta: 'Tamil',
  te: 'Telugu', kn: 'Kannada', ml: 'Malayalam', ar: 'Arabic', fa: 'Persian', ps: 'Pashto',
  sd: 'Sindhi', he: 'Hebrew', tr: 'Turkish', az: 'Azerbaijani', kk: 'Kazakh', uz: 'Uzbek',
  ky: 'Kyrgyz', tg: 'Tajik', ru: 'Russian', uk: 'Ukrainian', bg: 'Bulgarian', sr: 'Serbian',
  hr: 'Croatian', bs: 'Bosnian', sl: 'Slovenian', mk: 'Macedonian', be: 'Belarusian',
  pl: 'Polish', cs: 'Czech', sk: 'Slovak', hu: 'Hungarian', ro: 'Romanian', el: 'Greek',
  sq: 'Albanian', lt: 'Lithuanian', lv: 'Latvian', et: 'Estonian', fi: 'Finnish',
  sv: 'Swedish', da: 'Danish', no: 'Norwegian', is: 'Icelandic', de: 'German',
  nl: 'Dutch', af: 'Afrikaans', fr: 'French', it: 'Italian', es: 'Spanish', pt: 'Portuguese',
  ca: 'Catalan', gl: 'Galician', eu: 'Basque', vi: 'Vietnamese', id: 'Indonesian',
  ms: 'Malay', tl: 'Filipino', th: 'Thai', lo: 'Lao', km: 'Khmer', my: 'Burmese',
  zh: 'Chinese', 'zh-tw': 'Chinese (Traditional)', ja: 'Japanese', ko: 'Korean',
  am: 'Amharic', so: 'Somali', sw: 'Swahili', ha: 'Hausa', yo: 'Yoruba', ig: 'Igbo',
  zu: 'Zulu', xh: 'Xhosa', st: 'Sesotho', ny: 'Chichewa', ka: 'Georgian', hy: 'Armenian',
  mn: 'Mongolian', bo: 'Tibetan', unknown: 'the client’s language',
};

const LOCALES = {
  en: 'en-US', 'roman-ur': 'en-US', ur: 'ur-PK', hi: 'hi-IN', bn: 'bn-BD', pa: 'pa-IN',
  gu: 'gu-IN', mr: 'mr-IN', ne: 'ne-NP', si: 'si-LK', ta: 'ta-IN', te: 'te-IN', kn: 'kn-IN',
  ml: 'ml-IN', ar: 'ar-SA', fa: 'fa-IR', ps: 'ps-AF', sd: 'sd-PK', he: 'he-IL', tr: 'tr-TR',
  az: 'az-AZ', kk: 'kk-KZ', uz: 'uz-UZ', ky: 'ky-KG', tg: 'tg-TJ', ru: 'ru-RU', uk: 'uk-UA',
  bg: 'bg-BG', sr: 'sr-RS', hr: 'hr-HR', bs: 'bs-BA', sl: 'sl-SI', mk: 'mk-MK', be: 'be-BY',
  pl: 'pl-PL', cs: 'cs-CZ', sk: 'sk-SK', hu: 'hu-HU', ro: 'ro-RO', el: 'el-GR', sq: 'sq-AL',
  lt: 'lt-LT', lv: 'lv-LV', et: 'et-EE', fi: 'fi-FI', sv: 'sv-SE', da: 'da-DK', no: 'nb-NO',
  is: 'is-IS', de: 'de-DE', nl: 'nl-NL', af: 'af-ZA', fr: 'fr-FR', it: 'it-IT', es: 'es-ES',
  pt: 'pt-BR', ca: 'ca-ES', gl: 'gl-ES', eu: 'eu-ES', vi: 'vi-VN', id: 'id-ID', ms: 'ms-MY',
  tl: 'fil-PH', th: 'th-TH', lo: 'lo-LA', km: 'km-KH', my: 'my-MM', zh: 'zh-CN',
  'zh-tw': 'zh-TW', ja: 'ja-JP', ko: 'ko-KR', am: 'am-ET', so: 'so-SO', sw: 'sw-KE',
  ha: 'ha-NG', yo: 'yo-NG', ig: 'ig-NG', zu: 'zu-ZA', xh: 'xh-ZA', st: 'st-ZA', ny: 'ny-MW',
  ka: 'ka-GE', hy: 'hy-AM', mn: 'mn-MN', bo: 'bo-CN', unknown: 'en-US',
};

// ── word markers (short-message friendly) ───────────────────
const WORDS = {
  en: ['the', 'is', 'are', 'you', 'your', 'we', 'i', 'need', 'want', 'please', 'thanks', 'thank', 'can', 'could', 'for', 'my', 'and', 'have', 'would', 'with', 'this', 'that', 'how', 'much', 'price', 'website', 'project', 'hello', 'hi', 'budget', 'timeline', 'looking'],
  'roman-ur': ['hai', 'hain', 'kya', 'nahi', 'nahin', 'aap', 'tum', 'yaar', 'bhai', 'karo', 'kar', 'chahiye', 'mera', 'meri', 'mujhe', 'acha', 'achha', 'theek', 'thik', 'han', 'haan', 'banao', 'banwana', 'kitna', 'kitne', 'kab', 'kaise', 'kyun', 'salam', 'assalam', 'shukriya', 'batao', 'bata', 'karna', 'hoga', 'ho', 'raha', 'bhaiya', 'acha', 'zaroor', 'bilkul'],
  es: ['el', 'la', 'los', 'las', 'que', 'para', 'con', 'una', 'por', 'como', 'pero', 'estoy', 'necesito', 'quiero', 'gracias', 'hola', 'puedo', 'tiene', 'muy', 'también', 'proyecto', 'precio', 'cuánto', 'cuanto', 'sitio', 'página'],
  fr: ['le', 'la', 'les', 'des', 'que', 'pour', 'avec', 'une', 'et', 'est', 'je', 'vous', 'nous', 'bonjour', 'merci', 'besoin', 'projet', 'prix', 'pouvez', 'très', 'combien', 'site', 'bonsoir', 'salut'],
  de: ['der', 'die', 'das', 'und', 'ist', 'ich', 'wir', 'nicht', 'mit', 'für', 'ein', 'eine', 'bitte', 'danke', 'brauche', 'hallo', 'projekt', 'preis', 'können', 'wie', 'viel', 'website', 'seite'],
  pt: ['que', 'para', 'com', 'uma', 'não', 'estou', 'preciso', 'obrigado', 'você', 'olá', 'projeto', 'preço', 'muito', 'também', 'quanto', 'site', 'olá', 'bom'],
  it: ['il', 'che', 'per', 'con', 'una', 'sono', 'non', 'prego', 'grazie', 'vorrei', 'progetto', 'prezzo', 'molto', 'ciao', 'quanto', 'sito', 'buongiorno'],
  nl: ['de', 'het', 'een', 'en', 'ik', 'niet', 'voor', 'met', 'dank', 'hoe', 'project', 'prijs', 'graag', 'website', 'goed', 'hallo'],
  af: ['die', 'het', 'ek', 'nie', 'vir', 'met', 'dankie', 'hallo', 'projek', 'prys', 'hoeveel', 'baie'],
  pl: ['nie', 'jest', 'się', 'dla', 'oraz', 'dzień', 'cześć', 'dziękuję', 'projekt', 'cena', 'ile', 'strona', 'potrzebuję'],
  cs: ['je', 'se', 'na', 'to', 'že', 'pro', 'jsem', 'není', 'děkuji', 'ahoj', 'projekt', 'cena', 'kolik', 'web'],
  sk: ['je', 'sa', 'na', 'to', 'že', 'pre', 'som', 'nie', 'ďakujem', 'ahoj', 'projekt', 'cena', 'koľko'],
  hu: ['a', 'az', 'és', 'nem', 'van', 'meg', 'kell', 'köszönöm', 'szia', 'projekt', 'ár', 'mennyi'],
  ro: ['și', 'este', 'nu', 'pentru', 'cu', 'o', 'sunt', 'mulțumesc', 'salut', 'proiect', 'preț', 'cât'],
  tr: ['bir', 've', 'bu', 'için', 'ile', 'değil', 'çok', 'nasıl', 'merhaba', 'teşekkür', 'proje', 'fiyat', 'istiyorum', 'ne', 'kadar', 'site'],
  az: ['və', 'bir', 'bu', 'üçün', 'ilə', 'deyil', 'çox', 'necə', 'salam', 'təşəkkür', 'layihə', 'qiymət'],
  id: ['yang', 'dan', 'untuk', 'dengan', 'saya', 'tidak', 'ini', 'itu', 'bisa', 'terima', 'kasih', 'proyek', 'harga', 'mau', 'berapa', 'website'],
  ms: ['yang', 'dan', 'untuk', 'dengan', 'saya', 'tidak', 'ini', 'itu', 'boleh', 'terima', 'kasih', 'projek', 'harga', 'mahu', 'berapa'],
  tl: ['ang', 'ng', 'mga', 'para', 'ako', 'hindi', 'salamat', 'kumusta', 'gusto', 'proyekto', 'presyo', 'magkano'],
  vi: ['và', 'của', 'không', 'cho', 'tôi', 'có', 'được', 'cảm', 'ơn', 'chào', 'dự', 'án', 'giá', 'bao', 'nhiêu'],
  sw: ['na', 'ya', 'kwa', 'ni', 'wa', 'hii', 'asante', 'habari', 'nataka', 'bei', 'tafadhali', 'projekti'],
  ha: ['da', 'na', 'ga', 'ne', 'ba', 'yana', 'nagode', 'sannu', 'aiki', 'farashi', 'ina'],
  yo: ['ati', 'ni', 'ti', 'fun', 'mo', 'ko', 'e', 'se', 'pele', 'oṣe', 'iṣẹ', 'owo'],
  ig: ['na', 'nke', 'maka', 'ya', 'ọ', 'bụ', 'daalụ', 'ndewo', 'ọrụ', 'ego'],
  so: ['iyo', 'waa', 'oo', 'ku', 'la', 'aan', 'mahadsanid', 'salaam', 'mashruuc', 'qiimo'],
  fi: ['ja', 'on', 'ei', 'että', 'se', 'minä', 'kiitos', 'hei', 'projekti', 'hinta', 'paljonko'],
  sv: ['och', 'är', 'det', 'att', 'jag', 'inte', 'för', 'med', 'tack', 'hej', 'projekt', 'pris', 'hur', 'mycket'],
  da: ['og', 'er', 'det', 'at', 'jeg', 'ikke', 'for', 'med', 'tak', 'hej', 'projekt', 'pris', 'hvor'],
  no: ['og', 'er', 'det', 'at', 'jeg', 'ikke', 'for', 'med', 'takk', 'hei', 'prosjekt', 'pris', 'hvor'],
  lt: ['ir', 'yra', 'ne', 'kad', 'su', 'aš', 'ačiū', 'labas', 'projektas', 'kaina'],
  lv: ['un', 'ir', 'nav', 'ka', 'ar', 'es', 'paldies', 'sveiki', 'projekts', 'cena'],
  et: ['ja', 'on', 'ei', 'et', 'see', 'ma', 'aitäh', 'tere', 'projekt', 'hind'],
  sq: ['dhe', 'është', 'nuk', 'për', 'me', 'unë', 'faleminderit', 'përshëndetje', 'projekt', 'çmimi'],
  hr: ['i', 'je', 'nije', 'za', 'sa', 'ja', 'hvala', 'bok', 'projekt', 'cijena', 'koliko'],
  sr: ['и', 'је', 'није', 'за', 'са', 'ја', 'хвала', 'здраво', 'пројекат', 'цена'],
  bg: ['и', 'е', 'не', 'за', 'с', 'аз', 'благодаря', 'здравей', 'проект', 'цена', 'колко'],
  el: ['και', 'είναι', 'δεν', 'για', 'με', 'εγώ', 'ευχαριστώ', 'γεια', 'έργο', 'τιμή', 'πόσο'],
};

const WORD_SETS = Object.fromEntries(
  Object.entries(WORDS).map(([code, list]) => [code, new Set(list)])
);

// Arabic-script languages split by their own letters
const ARABIC_HINTS = {
  ur: { letters: /[ٹڈڑںےۓھ]/, words: ['ہے', 'میں', 'آپ', 'نہیں', 'کیا', 'کی', 'کا', 'ہیں', 'شکریہ', 'سلام', 'بھائی', 'کام', 'کرنا', 'چاہیے', 'مجھے', 'کہاں', 'کتنا', 'ٹھیک'] },
  ar: { letters: /[\u0621\u0622\u0623\u0625\u0624\u0626]/, words: ['أنا', 'أنت', 'هذا', 'هذه', 'كيف', 'شكرا', 'شكراً', 'مرحبا', 'هل', 'لا', 'نعم', 'من', 'على', 'في', 'مشروع', 'سعر', 'أريد', 'كم'] },
  fa: { letters: /[پچژگ]/, words: ['است', 'که', 'این', 'را', 'برای', 'با', 'من', 'شما', 'ممنون', 'سلام', 'خوب', 'پروژه', 'قیمت', 'چقدر'] },
  ps: { letters: /[ځڅډړږښګڼ]/, words: ['زه', 'ته', 'دا', 'نه', 'مننه', 'سلام', 'پروژه', 'بیه'] },
  sd: { letters: /[ڪڳڱڻ]/, words: ['آهي', 'مان', 'توهان', 'نه', 'مهرباني', 'سلام'] },
};

// Devanagari split
const DEVANAGARI_HINTS = {
  hi: ['है', 'हैं', 'मैं', 'आप', 'नहीं', 'क्या', 'के', 'का', 'की', 'शुक्रिया', 'नमस्ते', 'चाहिए', 'प्रोजेक्ट'],
  mr: ['आहे', 'मी', 'तुम्ही', 'नाही', 'काय', 'धन्यवाद', 'नमस्कार', 'प्रकल्प'],
  ne: ['छ', 'म', 'तपाईं', 'छैन', 'के', 'धन्यवाद', 'नमस्ते', 'परियोजना'],
};

const FRANC_MAP = {
  eng: 'en', urd: 'ur', hin: 'hi', ben: 'bn', pan: 'pa', guj: 'gu', mar: 'mr', nep: 'ne',
  sin: 'si', tam: 'ta', tel: 'te', kan: 'kn', mal: 'ml', arb: 'ar', pes: 'fa', prs: 'fa',
  pbu: 'ps', snd: 'sd', heb: 'he', tur: 'tr', aze: 'az', kaz: 'kk', uzb: 'uz', kir: 'ky',
  tgk: 'tg', rus: 'ru', ukr: 'uk', bul: 'bg', srp: 'sr', hrv: 'hr', bos: 'bs', slv: 'sl',
  mkd: 'mk', bel: 'be', pol: 'pl', ces: 'cs', slk: 'sk', hun: 'hu', ron: 'ro', ell: 'el',
  sqi: 'sq', lit: 'lt', lav: 'lv', est: 'et', fin: 'fi', swe: 'sv', dan: 'da', nob: 'no',
  nno: 'no', isl: 'is', deu: 'de', nld: 'nl', afr: 'af', fra: 'fr', ita: 'it', spa: 'es',
  por: 'pt', cat: 'ca', glg: 'gl', eus: 'eu', vie: 'vi', ind: 'id', msa: 'ms', zsm: 'ms',
  tgl: 'tl', fil: 'tl', tha: 'th', lao: 'lo', khm: 'km', mya: 'my', zho: 'zh', cmn: 'zh',
  jpn: 'ja', kor: 'ko', amh: 'am', som: 'so', swa: 'sw', hau: 'ha', yor: 'yo', ibo: 'ig',
  zul: 'zu', xho: 'xh', sot: 'st', nya: 'ny', kat: 'ka', hye: 'hy', mon: 'mn', bod: 'bo',
  ckb: 'ku', kur: 'ku',
};

// ── register (formal vs casual) ─────────────────────────────
const FORMAL = {
  any: /\b(sir|madam|ma'?am|mr\.?|mrs\.?|miss|kindly|respectfully|dear)\b/i,
  ur: /(جناب|صاحب|آپ|حضرت|محترم)/,
  'roman-ur': /\b(aap|aapko|ap|janab|sahib|bhai sahib|kindly)\b/i,
  hi: /(आप|श्रीमान|महोदय)/,
  ar: /(حضرتك|سيادتك|أستاذ)/,
  fr: /\b(vous|votre|madame|monsieur|bonjour)\b/i,
  de: /\b(sie|ihnen|guten tag)\b/i,
  es: /\b(usted|ustedes|señor|señora|buenos días)\b/i,
  pt: /\b(senhor|senhora|prezado|bom dia)\b/i,
  tr: /\b(siz|efendim|merhabalar)\b/i,
  id: /\b(anda|bapak|ibu)\b/i,
  ms: /\b(anda|tuan|puan)\b/i,
  ru: /\b(вы|вас|здравствуйте)\b/i,
  uk: /\b(ви|вас)\b/i,
  pl: /\b(pan|pani|dzień dobry)\b/i,
  it: /\b(lei|gentile|buongiorno)\b/i,
  nl: /\b(u|meneer|mevrouw)\b/i,
  fa: /(شما|جناب|خانم)/,
  he: /(אתה|אתם|אדוני|גברת)/,
};

const INFORMAL = {
  any: /\b(hey|hiya|yo|bro|bruh|dude|mate|bhai|yaar|dost|sis|buddy)\b/i,
  ur: /(تم|تیرا|تیری)/,
  'roman-ur': /\b(tu|tum|tumhe|tujhe|yaar|bro|bhai)\b/i,
  hi: /(तू|तुम|यार)/,
  ar: /(يا زلمة|حبibi|حبيبي)/i,
  fr: /\b(tu|toi|ton|ta|coucou|salut)\b/i,
  de: /\b(du|dir|dich|hallo|hi)\b/i,
  es: /\b(tú|vos|che|hola)\b/i,
  pt: /\b(você|tu|oi|e aí)\b/i,
  tr: /\b(sen|senin|naber)\b/i,
  id: /\b(kamu|kau|lo)\b/i,
  ms: /\b(awak|kau)\b/i,
  ru: /\b(ты|тебя|привет)\b/i,
  uk: /\b(ти|тебе)\b/i,
  pl: /\b(ty|ciebie|cześć)\b/i,
  it: /\b(tu|ciao)\b/i,
  nl: /\b(jij|je|hoi)\b/i,
  fa: /(تو|توو|سلام)/,
  he: /(אתה|אתם|היי)/,
};

// ── helpers ─────────────────────────────────────────────────
function scriptOf(text) {
  for (const [name, re] of SCRIPTS) if (re.test(text)) return name;
  return 'latin';
}

const tokensOf = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'’-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 160);

function scoreWords(tokens, code) {
  const set = WORD_SETS[code];
  if (!set) return 0;
  let n = 0;
  for (const t of tokens) if (set.has(t)) n += 1;
  return n;
}

const topEntry = (scores) =>
  Object.entries(scores).sort((a, b) => b[1] - a[1])[0] || null;

function info(code, script, confidence, detectedBy) {
  return {
    code,
    label: LABELS[code] || code,
    locale: LOCALES[code] || 'en-US',
    rtl: RTL_CODES.has(code),
    script,
    confidence,
    detectedBy,
  };
}

// ── detection ───────────────────────────────────────────────
/**
 * @param {string} text
 * @returns {{code:string,label:string,locale:string,rtl:boolean,script:string,confidence:number,detectedBy:string}}
 */
export function detectLanguage(text = '') {
  const clean = String(text || '').trim();
  if (!clean) return info('unknown', 'latin', 0, 'empty');

  const script = scriptOf(clean);
  const tokens = tokensOf(clean);

  // 1. Scripts that map to one language with certainty
  const solid = {
    hebrew: 'he', thai: 'th', lao: 'lo', myanmar: 'my', khmer: 'km', georgian: 'ka',
    armenian: 'hy', sinhala: 'si', tamil: 'ta', telugu: 'te', kannada: 'kn',
    malayalam: 'ml', gujarati: 'gu', gurmukhi: 'pa', ethiopic: 'am', tibetan: 'bo',
    bengali: 'bn',
    cherokee: 'en',
  };
  if (solid[script]) return info(solid[script], script, 0.95, 'script');

  if (script === 'hangul') return info('ko', script, 0.95, 'script');
  if (script === 'hiragana' || script === 'katakana') return info('ja', script, 0.95, 'script');
  if (script === 'han') {
    // Japanese often mixes kana in; traditional vs simplified is a nicety
    return info(/[。、]/.test(clean) ? 'ja' : 'zh', script, 0.85, 'script');
  }
  if (script === 'greek') return info('el', script, 0.95, 'script');

  // 2. Arabic script: Urdu / Arabic / Persian / Pashto / Sindhi
  if (script === 'arabic') {
    const scores = {};
    for (const [code, hint] of Object.entries(ARABIC_HINTS)) {
      let n = 0;
      for (const w of hint.words) if (clean.includes(w)) n += 2;
      if (hint.letters.test(clean)) n += 3;
      if (n) scores[code] = n;
    }
    if (/[ےںٹڈڑ]/.test(clean)) scores.ur = (scores.ur || 0) + 4;
    if (/[ي]/.test(clean) && !/[ےںٹڈڑ]/.test(clean)) scores.ar = (scores.ar || 0) + 1;
    const best = topEntry(scores);
    if (best) return info(best[0], script, Math.min(0.95, 0.6 + best[1] / 12), 'markers');
    return info('ar', script, 0.45, 'script-default');
  }

  // 3. Cyrillic: special letters first, then common words
  if (script === 'cyrillic') {
    if (/[іїєґ]/i.test(clean)) return info('uk', script, 0.9, 'letters');
    if (/[јћџљњ]/i.test(clean)) return info('sr', script, 0.9, 'letters');
    if (/[ыэё]/.test(clean)) return info('ru', script, 0.9, 'letters');
    if (/[ъ]/.test(clean)) return info('bg', script, 0.85, 'letters');

    const cyr = {
      ru: ['мне', 'нужен', 'сайт', 'сколько', 'стоит', 'привет', 'спасибо', 'проект', 'цена', 'хочу', 'можно', 'добрый'],
      uk: ['мені', 'потрібен', 'скільки', 'коштує', 'привіт', 'дякую', 'проєкт', 'ціна', 'хочу', 'можна'],
      bg: ['колко', 'струва', 'здравей', 'благодаря', 'проект', 'цена', 'искам', 'мога'],
      sr: ['мени', 'треба', 'сајт', 'колико', 'здраво', 'хвала', 'пројекат', 'цена', 'желим'],
    };
    const scores = {};
    for (const [code, words] of Object.entries(cyr)) {
      const n = words.filter((w) => clean.toLowerCase().includes(w)).length;
      if (n) scores[code] = n * 2;
    }
    const best = topEntry(scores);
    if (best) return info(best[0], script, 0.85, 'markers');
    return info('ru', script, 0.55, 'script-default');
  }

  // 4. Devanagari: Hindi / Marathi / Nepali
  if (script === 'devanagari') {
    const scores = {};
    for (const [code, words] of Object.entries(DEVANAGARI_HINTS)) {
      scores[code] = words.filter((w) => clean.includes(w)).length * 2;
    }
    const best = topEntry(scores);
    if (best && best[1] > 0) return info(best[0], script, 0.8, 'markers');
    return info('hi', script, 0.55, 'script-default');
  }

  // 5. Latin (and anything else): word vote
  const scores = {};
  for (const code of Object.keys(WORD_SETS)) {
    const n = scoreWords(tokens, code);
    if (n > 0) scores[code] = n;
  }

  // Latin-script tells. Only letters that are *rare* in other languages vote;
  // á/é/í are shared by half of Europe and would misfire constantly.
  if (/[ăâîșț]/i.test(clean)) scores.ro = (scores.ro || 0) + 4;
  if (/[ąćęłńśźż]/i.test(clean)) scores.pl = (scores.pl || 0) + 4;
  if (/[ěščřžů]/i.test(clean)) scores.cs = (scores.cs || 0) + 4;
  if (/[đ]/i.test(clean)) scores.hr = (scores.hr || 0) + 2;
  if (/[ğışİ]/.test(clean)) scores.tr = (scores.tr || 0) + 4;
  if (/[ơưđ]|[ấầẩẫậắằẳẵặếềểễệốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(clean)) scores.vi = (scores.vi || 0) + 5;
  if (/[ß]/.test(clean)) scores.de = (scores.de || 0) + 3;
  if (/[ñ¿¡]/i.test(clean)) scores.es = (scores.es || 0) + 3;
  if (/[ãõ]/i.test(clean)) scores.pt = (scores.pt || 0) + 3;
  if (/[åäö]/i.test(clean) && !/[ß]/.test(clean)) {
    scores.sv = (scores.sv || 0) + 2;
    scores.fi = (scores.fi || 0) + 1;
  }
  if (/[øæ]/i.test(clean)) {
    scores.da = (scores.da || 0) + 3;
    scores.no = (scores.no || 0) + 2;
  }

  // Roman Urdu / Hinglish is the one Latin case that needs guarding, because
  // it borrows English tech words constantly.
  if (/\b(hai|hain|kya|nahi|nahin|aap|yaar|bhai|chahiye|karo|mujhe|kitna|theek|acha|bilkul|zaroor)\b/i.test(clean)) {
    scores['roman-ur'] = (scores['roman-ur'] || 0) + 3;
  }

  let best = topEntry(scores);
  let confidence = best ? Math.min(0.92, 0.4 + best[1] * 0.08) : 0;

  // 6. franc as a tie-breaker for longer text
  if (franc && tokens.length >= 12 && (!best || confidence < 0.6) && script === 'latin') {
    try {
      const guess = franc(clean.slice(0, 600), { minLength: 3 });
      const mapped = FRANC_MAP[guess];
      if (mapped && mapped !== 'unknown') {
        return info(mapped, script, 0.6, 'franc');
      }
    } catch {
      /* ignore */
    }
  }

  if (!best) {
    // Very short Latin messages are greetings, names or "ok" — English is the
    // safe default, but the prompt still tells the model to mirror the client.
    return info(tokens.length <= 2 ? 'unknown' : 'en', script, 0.2, 'fallback');
  }

  const code = best[0];
  const englishScore = scores.en || 0;
  const romanScore = scores['roman-ur'] || 0;
  let final = code;
  if (romanScore > 0 && romanScore >= englishScore) final = 'roman-ur';
  if (romanScore > 0 && englishScore > romanScore * 2) final = 'en';

  return info(final, script, confidence, 'markers');
}

/**
 * Register: is the client being formal (aap / vous / Sie / usted) or casual
 * (tu / yaar / bhai)?
 * @returns {{tone:'formal'|'casual'|'neutral', confidence:number, evidence:string}}
 */
export function detectTone(text = '', langCode = 'en') {
  const clean = String(text || '');
  if (!clean.trim()) return { tone: 'neutral', confidence: 0, evidence: '' };

  let formal = 0;
  let casual = 0;

  const fAny = clean.match(FORMAL.any);
  if (fAny) formal += 2;
  const cAny = clean.match(INFORMAL.any);
  if (cAny) casual += 2;

  const f = FORMAL[langCode] || FORMAL[String(langCode).split('-')[0]];
  const c = INFORMAL[langCode] || INFORMAL[String(langCode).split('-')[0]];
  const fHit = f ? clean.match(f) : null;
  const cHit = c ? clean.match(c) : null;
  if (fHit) formal += 3;
  if (cHit) casual += 3;

  // Exclamation marks and emoji lean casual, long polite sentences lean formal
  if (/[😂😅🤣😊❤️🙏]/.test(clean)) casual += 1;
  if (/\b(kindly|please|would you|request|appreciate)\b/i.test(clean)) formal += 1;

  const tone = formal === casual ? 'neutral' : formal > casual ? 'formal' : 'casual';
  const confidence = Math.min(0.95, Math.abs(formal - casual) / 6);
  const evidence = (fHit?.[0] || cHit?.[0] || fAny?.[0] || cAny?.[0] || '').slice(0, 24);
  return { tone, confidence, evidence };
}

/** Prompt fragment that tells the model exactly how to answer. */
export function mirrorInstruction(langInfo) {
  const code = langInfo?.code || 'unknown';
  const label = langInfo?.label || 'the client’s language';

  const base =
    code === 'unknown'
      ? 'Reply in whatever language the client is using — infer it from their words, names and script. Never default to English just because it is easier.'
      : `The client is writing in ${label}. Reply in ${label}, same script, natural and conversational.`;

  const scriptRule = langInfo?.rtl
    ? ' Their script is right-to-left: write it right-to-left, and keep names/numbers readable.'
    : '';

  return (
    `${base}${scriptRule} ` +
    'Never switch the client to English unless they do. Keep product names, code and brand names in their original form. ' +
    'If they mix two languages, mirror the same mix. If you genuinely cannot tell the language, reply in simple English and offer to switch.'
  );
}

/** Register instruction for the prompt. */
export function toneInstruction({ tone = 'neutral', formality = 'auto' } = {}) {
  if (formality === 'formal') {
    return 'Register: FORMAL. Be polite and precise, use the formal “you” of that language (aap / آپ / vous / Sie / usted / anda / siz). No slang.';
  }
  if (formality === 'casual') {
    return 'Register: CASUAL. Talk like a friendly human: tum/yaar/bhai in Urdu-Hindi, tu/toi in French, du in German, tú in Spanish, sen in Turkish. Warm, short, no corporate tone.';
  }
  if (tone === 'formal') {
    return 'Register: the client is being formal (aap / vous / Sie / usted). Mirror that politeness — do not get over-familiar, no slang, no “bhai”.';
  }
  if (tone === 'casual') {
    return 'Register: the client is casual (tum / yaar / bhai / hola). Match the vibe — be relaxed and human, not stiff or corporate.';
  }
  return 'Register: neutral. Read their last few messages and match their level of formality; if unsure, be warm and simple.';
}

/** Voice suitable for this language (Edge neural voices). */
export function voiceForLanguage(langInfo, voiceMap = {}) {
  if (!langInfo) return voiceMap.en || 'en-US-AriaNeural';
  const locale = String(langInfo.locale || '');
  if (voiceMap[locale]) return voiceMap[locale];
  const short = locale.split('-')[0];
  if (voiceMap[short]) return voiceMap[short];
  if (langInfo.code === 'roman-ur') return voiceMap.ur || voiceMap['roman-ur'] || 'ur-PK-UzmaNeural';

  const byCode = {
    en: 'en-US-AriaNeural', ur: 'ur-PK-UzmaNeural', hi: 'hi-IN-SwaraNeural', bn: 'bn-BD-NabanitaNeural',
    pa: 'pa-IN-OjasNeural', gu: 'gu-IN-DhwaniNeural', mr: 'mr-IN-AarohiNeural', ne: 'ne-NP-HemkalaNeural',
    si: 'si-LK-ThiliniNeural', ta: 'ta-IN-PallaviNeural', te: 'te-IN-ShrutiNeural', kn: 'kn-IN-SapnaNeural',
    ml: 'ml-IN-SobhanaNeural', ar: 'ar-SA-ZariyahNeural', fa: 'fa-IR-DilaraNeural', ps: 'ps-AF-LatifaNeural',
    he: 'he-IL-HilaNeural', tr: 'tr-TR-EmelNeural', az: 'az-AZ-BanuNeural', kk: 'kk-KZ-AigulNeural',
    uz: 'uz-UZ-MadinaNeural', ru: 'ru-RU-SvetlanaNeural', uk: 'uk-UA-PolinaNeural', bg: 'bg-BG-KalinaNeural',
    sr: 'sr-RS-SophieNeural', hr: 'hr-HR-GabrijelaNeural', pl: 'pl-PL-ZofiaNeural', cs: 'cs-CZ-VlastaNeural',
    sk: 'sk-SK-ViktoriaNeural', hu: 'hu-HU-NoemiNeural', ro: 'ro-RO-AlinaNeural', el: 'el-GR-AthinaNeural',
    sq: 'sq-AL-AnilaNeural', fi: 'fi-FI-NooraNeural', sv: 'sv-SE-SofieNeural', da: 'da-DK-ChristelNeural',
    no: 'nb-NO-PernilleNeural', de: 'de-DE-KatjaNeural', nl: 'nl-NL-ColetteNeural', af: 'af-ZA-AdriNeural',
    fr: 'fr-FR-DeniseNeural', it: 'it-IT-ElsaNeural', es: 'es-ES-ElviraNeural', pt: 'pt-BR-FranciscaNeural',
    vi: 'vi-VN-HoaiMyNeural', id: 'id-ID-GadisNeural', ms: 'ms-MY-YasminNeural', tl: 'fil-PH-BlessicaNeural',
    th: 'th-TH-PremwadeeNeural', km: 'km-KH-SreymomNeural', my: 'my-MM-NilarNeural', zh: 'zh-CN-XiaoxiaoNeural',
    'zh-tw': 'zh-TW-HsiaoChenNeural', ja: 'ja-JP-NanamiNeural', ko: 'ko-KR-SunHiNeural', am: 'am-ET-MekdesNeural',
    so: 'so-SO-UbaxNeural', sw: 'sw-KE-ZuriNeural', ka: 'ka-GE-EkaNeural', hy: 'hy-AM-AnahitNeural',
  };
  return byCode[langInfo.code] || voiceMap.en || 'en-US-AriaNeural';
}

export const SUPPORTED_LANGUAGES = Object.keys(LABELS).length;

/** Codes Whisper reports → our codes (used when a voice note is transcribed). */
export function fromWhisperLanguage(name = '') {
  const key = String(name).toLowerCase().trim();
  if (!key) return null;
  const direct = {
    english: 'en', urdu: 'ur', hindi: 'hi', bengali: 'bn', arabic: 'ar', persian: 'fa',
    farsi: 'fa', pashto: 'ps', sindhi: 'sd', hebrew: 'he', turkish: 'tr', azerbaijani: 'az',
    kazakh: 'kk', uzbek: 'uz', russian: 'ru', ukrainian: 'uk', bulgarian: 'bg', serbian: 'sr',
    croatian: 'hr', polish: 'pl', czech: 'cs', slovak: 'sk', hungarian: 'hu', romanian: 'ro',
    greek: 'el', albanian: 'sq', lithuanian: 'lt', latvian: 'lv', estonian: 'et',
    finnish: 'fi', swedish: 'sv', danish: 'da', norwegian: 'no', german: 'de', dutch: 'nl',
    afrikaans: 'af', french: 'fr', italian: 'it', spanish: 'es', portuguese: 'pt',
    catalan: 'ca', vietnamese: 'vi', indonesian: 'id', malay: 'ms', tagalog: 'tl',
    filipino: 'tl', thai: 'th', lao: 'lo', khmer: 'km', burmese: 'my', chinese: 'zh',
    japanese: 'ja', korean: 'ko', amharic: 'am', somali: 'so', swahili: 'sw', hausa: 'ha',
    yoruba: 'yo', igbo: 'ig', zulu: 'zu', xhosa: 'xh', georgian: 'ka', armenian: 'hy',
    mongolian: 'mn', tibetan: 'bo', nepali: 'ne', sinhala: 'si', tamil: 'ta', telugu: 'te',
    kannada: 'kn', malayalam: 'ml', gujarati: 'gu', punjabi: 'pa', marathi: 'mr',
  };
  if (direct[key]) return info(direct[key], 'latin', 0.9, 'whisper');
  for (const [name2, code] of Object.entries(direct)) {
    if (key.includes(name2)) return info(code, 'latin', 0.8, 'whisper');
  }
  return null;
}

export default {
  detectLanguage,
  detectTone,
  mirrorInstruction,
  toneInstruction,
  voiceForLanguage,
  fromWhisperLanguage,
  SUPPORTED_LANGUAGES,
};
