// src/core/scope.js
// "Say 1 to 100", "tell me a joke", "write my homework": not a customer request,
// and answering it burns a reply that should have been about the business.
//
// The guard is a short list of rules, not a model call. It only fires on
// requests that have nothing to do with the business — a customer asking for a
// price, a booking, a stock check or a complaint always gets through, even if
// they happen to say "write" or "number".

import { business, profile } from '../services/profile.js';

const RULES = [
  { kind: 'counting', re: /\b(say|count|list|recite|print|write)\b[^.\n]{0,20}\b(\d{1,3})\s*(to|-|–|through)\s*(\d{1,4})\b/i },
  { kind: 'counting', re: /\bcount(ing)?\s+(from\s+)?(one|1|\d{1,3})\s+(to|up\s+to)\b/i },
  { kind: 'counting', re: /\b1\s*(to|-|–)\s*100\b/i },
  { kind: 'joke', re: /\b(tell|say|write)\b[^.\n]{0,20}\b(joke|funny story|riddle|pun)\b/i },
  { kind: 'story', re: /\b(tell|write)\b[^.\n]{0,20}\b(story|poem|song|rap|essay|paragraph)\b/i },
  { kind: 'code', re: /\b(write|generate|give me|show me|debug|fix)\b[^.\n]{0,30}\b(code|script|function|program|python|javascript|html|css|sql|regex)\b/i },
  { kind: 'code', re: /```|^\s*(import|from|def|class|function|const|let|var)\s+\w+[^\n]*\(/m },
  { kind: 'homework', re: /\b(homework|assignment|exam question|solve (this|these)|math problem|equation)\b/i },
  { kind: 'trivia', re: /\b(who is|who was|what is) (the )?(president|prime minister|capital of|weather|score|stock price)\b/i },
  { kind: 'game', re: /\b(play a game|let'?s play|truth or dare|never have i ever|tick tack|ta?c toe)\b/i },
  { kind: 'translate', re: /\btranslate (this|the following)\b(?!\s*(order|message|receipt|address))/i },
  // Roman Urdu and Urdu, for the same three requests. A customer testing the bot
  // does not switch to English to test it.
  { kind: 'counting', re: /\b(ginti|gino|gin)\b[^.\n]{0,20}\b\d{1,3}\b/i },
  { kind: 'counting', re: /\b(\d{1,3}|aik|ek|ایک)\s*(se|to|-|–|تک)\s*(\d{1,4}|so|سو)\b/i },
  { kind: 'counting', re: /(گنتی|گنو|گن کر|ایک سے سو)/ },
  { kind: 'joke', re: /\b(joke|latifa|chutkula)\b[^.\n]{0,20}\b(sunao|suna|batao|bata|do|dein)\b/i },
  { kind: 'joke', re: /\b(koi|ek)\s+(joke|latifa)\b/i },
  { kind: 'joke', re: /(جوك|جھوک|لطیفہ)\s*(سناؤ|سنا|بتاؤ|بتا)/ },
  { kind: 'story', re: /(kahani|kahaniyan|nazm|shayari|ghazal)\s+(sunao|suna|likho|likh)/i },
  { kind: 'story', re: /(کہانی|نظم|شاعری|غزل)\s*(سناؤ|سنا|لکھو)/ },
  { kind: 'code', re: /\b(code|program|script)\b[^.\n]{0,20}\b(likho|likh|banao|bana|de|do)\b/i },
];

// Words that make a message a business message no matter what else is in it.
const BUSINESS_WORDS =
  /\b(price|prices|pricing|cost|charge|rate|quote|order|booking|book|table|appointment|menu|stock|delivery|deliver|discount|payment|pay|invoice|refund|complain|complaint|address|timing|hours|open|closed|available|reserve|service|services|product|products|item|items|parcel|repair|consultation|fee|fees)\b/i;

const URDU_BUSINESS = /(قیمت|ریٹ|آرڈر|بکنگ|مینو|ڈیلیوری|ادائیگی|بل|شکایت|دستیاب|وقت|پتہ)/;

/** Is this request about something other than the business? */
export function classifyScope(text = '') {
  const body = String(text || '').trim();
  if (!body) return { offTopic: false, kind: null };
  if (BUSINESS_WORDS.test(body) || URDU_BUSINESS.test(body)) return { offTopic: false, kind: null };
  for (const rule of RULES) {
    if (rule.re.test(body)) return { offTopic: true, kind: rule.kind };
  }
  return { offTopic: false, kind: null };
}

/** The polite refusal, in the customer's language, in the tenant's voice. */
export function scopeRefusal(lang = 'en') {
  const name = String(business()?.name || profile()?.owner?.name || '').trim();
  const here = name ? `here at ${name}` : 'here';
  const lines = {
    en: `Ha — that's a bit outside what we do ${here}. We're here for orders, bookings, prices and anything about what we offer. Anything on that?`,
    'roman-ur': `Haha — ye ${name ? `${name} ` : ''}ke kaam se thora bahar hai. Hum orders, bookings, prices aur hamari services ke bare mein help karte hain. Kuch us bare mein?`,
    ur: `${name ? `${name} ` : ''}میں ہم اس طرح کے کام نہیں کرتے۔ ہم آرڈر، بکنگ، قیمتوں اور اپنی خدمات کے بارے میں مدد کرتے ہیں۔ اس بارے میں کچھ پوچھنا ہے؟`,
  };
  return lines[lang] || lines.en;
}

/** One call for the pipeline: refuse here, or answer normally. */
export function scopeGuard(text = '', langInfo = null) {
  const verdict = classifyScope(text);
  if (!verdict.offTopic) return { handled: false };
  const lang = langInfo?.code === 'ur' ? 'ur' : langInfo?.code === 'roman-ur' ? 'roman-ur' : 'en';
  return { handled: true, kind: verdict.kind, reply: scopeRefusal(lang) };
}

export default { classifyScope, scopeRefusal, scopeGuard };
