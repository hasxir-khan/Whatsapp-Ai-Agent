// src/core/abuse.js
// Insults, threats, and someone in trouble.
//
// Three different events, three different answers:
//
//   • an insult is met with one calm boundary line, in the customer's language,
//     from a fixed string. No model is asked, because a model that is being
//     insulted will either grovel or escalate, and both are worse.
//   • the same person insulting again after the limit gets silence for a
//     cool-down, and the owner hears about it once.
//   • a threat or self-harm words are never a conversation: they pause the bot,
//     hand the chat to the owner with an urgent flag, and say the one thing a
//     business can honestly say (that a person is coming).
//
// Nothing here stores what was said. The counters live in memory (a restart is
// a clean slate, which is the humane default) and only counts are logged.

// "you are stupid", "tum bewakoof ho", "تم بیوقوف ہو" — and the usual cousins.
const INSULT_PATTERNS = [
  /\b(stupid|idiot|dumb|moron|imbecile|retard(ed)?|useless|worthless|pathetic|shut up|screw you|f+u+c+k+ (you|off)|go to hell|nonsense bot|dumb bot|worst (bot|service|company))\b/i,
  /\b(tu|tum|aap|ye|yeh)\b[^.\n]{0,20}\b(bewakoof|bewaqoof|bewaqoof|bakwaas|bakwas|faltu|fazool|ghatiya|nalayak|ullu|kutta|pagal|ahmaq|behuda)\b/i,
  /\b(bewakoof|bewaqoof|bakwaas|bakwas|faltu|fazool|ghatiya|nalayak|ullu ke patthe|pagal|ahmaq)\b/i,
  /(بیوقوف|بکواس|فضول|گھٹیا|نالائق|پاگل|احمق|بے وقوف|چپ رہو|چپ کر)/,
];

// A threat, not an insult: someone saying what they will do.
const THREAT_PATTERNS = [
  /\b(i('ll| will)|we('ll| will)|going to|gonna)\b[^.\n]{0,30}\b(kill|hurt|beat|destroy|ruin|expose|sue|report you|find you|come to (your|the) (shop|office|store))\b/i,
  /\b(i will sue|i'?ll sue|lawyer|police complaint|consumer court|report (you|this) to|defame|social media expose)\b/i,
  /\b(maar|maarun|maar dunga|dekh lunga|tujhe|tumhe|dhama?ki|case kar dunga|police bulata|badnaam)\b/i,
  /(مار|ماروں|گا|دھمکی|کیس کر|پولیس|بدنام)/,
];

// Self-harm, in the words people actually use. Deliberately broad: a false
// positive here costs one message from a human.
const SELF_HARM_PATTERNS = [
  /\b(kill|hurt|harm) (my|him|her|them)?self\b/i,
  /\bsuicide|suicidal|end (it|my life)|no reason to live|better off dead|want to die\b/i,
  /\b(khudkushi|khud kushi|jaan dena|marna chahta|marni chahti|mar jana|zindagi khatam|khatam kar (doon|dunga|loon))\b/i,
  /(خودکشی|مار ڈالوں|مرنا چاہتا|زندگی ختم|جان دے)/,
];

const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

export function detectInsult(text = '') {
  const t = norm(text);
  if (!t) return null;
  for (const re of INSULT_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0].slice(0, 40);
  }
  return null;
}

export function detectThreat(text = '') {
  const t = norm(text);
  if (!t) return null;
  for (const re of THREAT_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0].slice(0, 40);
  }
  return null;
}

export function detectSelfHarm(text = '') {
  const t = norm(text);
  if (!t) return null;
  for (const re of SELF_HARM_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0].slice(0, 40);
  }
  return null;
}

/** One call: what kind of hostility, if any. */
export function detectAbuse(text = '') {
  const selfHarm = detectSelfHarm(text);
  const threat = selfHarm ? null : detectThreat(text);
  const insult = selfHarm || threat ? null : detectInsult(text);
  return {
    insult: Boolean(insult),
    threat: Boolean(threat),
    selfHarm: Boolean(selfHarm),
    hit: insult || threat || selfHarm || null,
    any: Boolean(insult || threat || selfHarm),
  };
}

// ── per-contact state (counts only, memory only) ────────────
const state = new Map(); // number -> { insults, warnedAt, coolDownUntil }

function entry(number) {
  const key = String(number || '');
  if (!state.has(key)) state.set(key, { insults: 0, warnedAt: null, coolDownUntil: 0 });
  return state.get(key);
}

export function insultCount(number) {
  return entry(number).insults;
}

export function inCoolDown(number, now = Date.now()) {
  return entry(number).coolDownUntil > now;
}

/** Records one insult and decides what it means. */
export function noteInsult(number, { limit = 2, coolDownMinutes = 120, now = Date.now() } = {}) {
  const e = entry(number);
  e.insults += 1;
  if (e.insults >= limit) {
    e.coolDownUntil = now + coolDownMinutes * 60_000;
    return { count: e.insults, coolDown: true, coolDownUntil: e.coolDownUntil };
  }
  return { count: e.insults, coolDown: false, coolDownUntil: 0 };
}

/** The owner answered, or a new conversation began: the slate is clean. */
export function forgive(number) {
  state.delete(String(number || ''));
}

export function resetAbuseState() {
  state.clear();
}

// ── the lines ───────────────────────────────────────────────
const L = (en, roman, ur) => ({ en, 'roman-ur': roman, ur });

const BOUNDARY = L(
  "I'll keep this professional — I'm not going to trade insults. Tell me what you need and I'll sort it.",
  'Main baat professionalism par rakhta hoon — izzat se baat karein to main aap ka kaam kar dunga.',
  'میں بات پیشہ ورانہ رکھوں گا — عزت سے بات کریں تو میں آپ کا کام کر دوں گا۔'
);

const COOL_DOWN_CUSTOMER = L(
  "I'll pause here for a while. When you're ready to talk about the order, message me and we'll pick it up.",
  'Main kuch der ke liye yahan ruk raha hoon. Jab order ki baat karni ho to message kar dein, wahin se shuru karenge.',
  'میں کچھ دیر کے لیے یہاں رک جاتا ہوں۔ جب آرڈر کی بات کرنی ہو تو پیغام بھیجیں، وہیں سے شروع کریں گے۔'
);

const THREAT_CUSTOMER = L(
  "I'm passing this chat to the owner right now — a person will reply to you here.",
  'Main yeh chat abhi owner ko de raha hoon — yahan par koi insaan aap se baat karega.',
  'میں یہ چیٹ ابھی مالک کو دے رہا ہوں — یہاں کوئی انسان آپ سے بات کرے گا۔'
);

const URGENT_CUSTOMER = L(
  "I'm getting a person to talk to you now. If this is a medical emergency, please call your local emergency number straight away.",
  'Main abhi kisi insaan ko bula raha hoon. Agar yeh medical emergency hai to foran apne mulk ka emergency number call karein.',
  'میں ابھی کسی انسان کو بلا رہا ہوں۔ اگر یہ طبی ایمرجنسی ہے تو فوراً اپنے ملک کا ایمرجنسی نمبر کال کریں۔'
);

const CLARIFY = L(
  "I want to get this right — could you tell me in one line what you need?",
  'Main yeh theek se samajhna chahta hoon — ek line mein bata dein aap ko kya chahiye?',
  'میں یہ ٹھیک سے سمجھنا چاہتا ہوں — ایک سطر میں بتا دیں کہ آپ کو کیا چاہیے؟'
);

const HANDOVER = L(
  "I'm handing this to the owner — they'll reply to you here.",
  'Main yeh owner ko de raha hoon — wo yahan aap ko reply karenge.',
  'میں یہ مالک کو دے رہا ہوں — وہ یہاں آپ کو جواب دیں گے۔'
);

const IGNORE_LIMIT_CUSTOMER = L(
  "I'm still here if you need something — tell me what you're after and I'll help.",
  'Main yahan hoon agar kuch chahiye ho — bata dein kya chahiye, main madad karunga.',
  'میں یہاں ہوں اگر کچھ چاہیے ہو — بتا دیں کیا چاہیے، میں مدد کروں گا۔'
);

const pick = (line, lang) => line[lang] || line.en;

export const boundaryLine = (lang = 'en') => pick(BOUNDARY, lang);
export const coolDownLine = (lang = 'en') => pick(COOL_DOWN_CUSTOMER, lang);
export const threatLine = (lang = 'en') => pick(THREAT_CUSTOMER, lang);
export const urgentLine = (lang = 'en') => pick(URGENT_CUSTOMER, lang);
export const clarifyLine = (lang = 'en') => pick(CLARIFY, lang);
export const handoverLine = (lang = 'en') => pick(HANDOVER, lang);
export const ignoreLimitLine = (lang = 'en') => pick(IGNORE_LIMIT_CUSTOMER, lang);

export default {
  boundaryLine,
  clarifyLine,
  coolDownLine,
  detectAbuse,
  detectInsult,
  detectSelfHarm,
  detectThreat,
  forgive,
  handoverLine,
  ignoreLimitLine,
  inCoolDown,
  insultCount,
  noteInsult,
  resetAbuseState,
  threatLine,
  urgentLine,
};
