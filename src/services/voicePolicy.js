// No model call here. History, words and the acoustic detector are three
// different witnesses. Only the owner's languages are possible outcomes.
import { config } from '../config/env.js';
import { detectLanguage, languageCode, languageInfo } from './language.js';
import { dominantLanguage, writtenUrduStyle } from './languageStick.js';

const spoken = (code) => (code === 'roman-ur' ? 'ur' : code);
const regional = new Set(['pa', 'ps', 'sd', 'skr']);
export function allowedSpeech(business) {
  return [
    ...new Set(
      (Array.isArray(business?.languages) ? business.languages : [])
        .map(languageCode)
        .map(spoken)
        .filter((c) => c !== 'unknown')
    ),
  ];
}
export function transcriptQuality(text, { confidence = null } = {}) {
  const clean = String(text || '')
    .normalize('NFKC')
    .toLowerCase();
  const words = clean.match(/[\p{L}\p{M}]+/gu) || [];
  const letters = words.join('').length;
  const unique = new Set(words).size;
  const density = letters / Math.max(1, clean.replace(/\s/g, '').length);
  const noisy = /\[(?:music|noise|silence|inaudible|applause)\]|\((?:music|noise|inaudible)\)/i.test(clean);
  const repetition = words.length >= 4 && (unique <= 2 || unique / words.length < 0.24);
  const score = Math.max(
    0,
    Math.min(
      1,
      letters / 12,
      words.length / 3,
      density / 0.72,
      repetition || noisy || /(.)\1{5,}/u.test(clean) ? 0.18 : 1,
      confidence != null && Number.isFinite(+confidence) ? +confidence : 1
    )
  );
  return { score: +score.toFixed(2), low: score < 0.55 };
}

// Regional words in Shahmukhi/Latin are often labelled Urdu (or English)
// by general language detectors. Do not override a clear English majority.
export function speechSignal(text = '') {
  const words =
    String(text)
      .toLowerCase()
      .match(/[\p{L}\p{M}]+/gu) || [];
  const count = (re) => words.filter((w) => re.test(w)).length;
  const en = count(
    /^(?:i|we|my|our|the|this|that|am|is|are|you|have|please|can|need|for|want|do|and|to|with|how|could|would|when|what|will|it|your|where)$/
  );
  const ur = count(
    /^(?:mujhe|aap|hai|hain|kya|chahiye|ka|ki|ke|kar|kab|nahi|bata|batao|mera|meri|hum|tak|yeh|ye|liye|ہمارا|میں|کو|کیا|ہے|کی|کا|آپ|یہ|چاہیے|مجھے|ہیں|کے)$/
  );
  if (en >= 3 && en > ur * 1.4) return { code: 'en', confidence: 0.9 };
  if (/(?:میڈی|تساں|میڈا)|\b(?:meku|meda|mekoon)\b/iu.test(text)) return { code: 'skr', confidence: 0.8 };
  if (/(?:مینوں|تسی|ورتوں)|\b(?:mainu|menu|tusi|tussi|tuhanu|chahida|chahidi)\b/iu.test(text))
    return { code: 'pa', confidence: 0.8 };
  if (ur >= 2 && ur >= en) return { code: /\p{Script=Arabic}/u.test(text) ? 'ur' : 'roman-ur', confidence: 0.9 };
  return detectLanguage(text);
}

export function chooseVoiceLanguage({
  number,
  text = '',
  seconds = 0,
  detector,
  confidence,
  written = '',
  contact = {},
  business = config.owner.profile?.business || {},
  history,
  style,
} = {}) {
  const allowed = allowedSpeech(business);
  const pk =
    /^(?:pk|pakistan)$/i.test(business.country || '') ||
    (!business.country &&
      /pakistan|karachi/i.test(
        business.timezone ||
          [config.owner.profile?.owner?.timezone, config.owner.profile?.owner?.location, config.timezone].join(' ')
      ));
  function permit(raw) {
    let c = spoken(languageCode(raw));
    if (pk && (c === 'hi' || (regional.has(c) && !allowed.includes(c)))) c = 'ur';
    return allowed.includes(c) ? c : null;
  }
  const past = history ?? (number ? dominantLanguage(number) : {});
  const sticky = (past.sample && past.confidence >= 0.7 && permit(past.code)) || permit(contact?.language);
  const quality = transcriptQuality(text, { confidence });
  const short = !(seconds >= 3);
  const signal = speechSignal(text),
    audio = languageCode(detector);
  const words = signal.confidence >= 0.4 && signal.detectedBy !== 'fallback' ? permit(signal.code) : null;
  const typedSignal = written.trim() && speechSignal(written);
  const typed =
    typedSignal && typedSignal.detectedBy !== 'fallback' && typedSignal.confidence >= 0.4
      ? permit(typedSignal.code)
      : null;
  let decision, language;
  if (sticky) {
    language = sticky;
    decision = 'history';
  } else if (typed) {
    language = typed;
    decision = 'written';
  } else if (!short && !quality.low && words) {
    language = words;
    decision = 'transcript';
  } else if (!short && !quality.low && permit(audio)) {
    language = permit(audio);
    decision = 'audio';
  } else {
    language = (quality.low || short ? words || permit(audio) : null) || allowed[0];
    decision = short ? 'short' : quality.low ? 'unclear' : 'allowlist';
  }
  const clarify = !typed && (short || quality.low || decision === 'allowlist');
  const preference = style ?? writtenUrduStyle(number, written);
  const roman = /^(roman(?:[-_ ]?ur(?:du)?)?|latin|ur-latn)$/i.test(business.voice?.textScript || '');
  const code = language === 'ur' ? preference || (roman ? 'roman-ur' : 'ur') : language;
  return {
    ...languageInfo(code || 'unknown', code === 'ur' ? 'arabic' : 'latin', quality.score, 'policy'),
    language: language || null,
    decision,
    transcriptLang: languageCode(signal.code),
    detector: audio,
    quality: quality.score,
    clarify,
    established: !!sticky,
    mayUpdate: !!language && !short && !quality.low && !clarify,
  };
}

export function matchesVoiceLanguage(text, policy) {
  if (!policy?.language || !String(text || '').trim()) return false;
  const signal = speechSignal(text);
  if (signal.detectedBy === 'fallback' || signal.confidence < 0.4) return false;
  const got = signal.code;
  if (policy.code === 'roman-ur') return got === 'roman-ur' && !/\p{Script=Arabic}/u.test(text);
  if (policy.code === 'ur') return got === 'ur' && /\p{Script=Arabic}/u.test(text);
  return got === policy.code;
}
