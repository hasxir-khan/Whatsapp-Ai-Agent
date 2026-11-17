// src/services/spamGuard.js
// Deliberately conservative. The old version blocked anyone who sent a link or
// wrote in caps — which is exactly what a real overseas client does. This one
// only reacts to actual scam patterns (OTP harvesting, fake prizes, "send
// money" stories) and never blocks by default.

import { config } from '../config/env.js';
import { logEvent, getContact, upsertContact, blockContact } from '../utils/db.js';

const SCAM_PATTERNS = [
  { re: /\b(share|send|give)\b.{0,20}\b(otp|one[- ]time password|verification code|pin code)\b/i, weight: 5, reason: 'asks for OTP' },
  { re: /\b(you('ve| have) won|winner|congratulations.{0,30}(prize|lottery|draw))\b/i, weight: 5, reason: 'fake prize' },
  { re: /\b(lottery|jackpot|jackpot winner)\b/i, weight: 4, reason: 'lottery' },
  { re: /\b(invest|invested|investment)\b.{0,40}\b(guaranteed|double|daily profit|100%)\b/i, weight: 5, reason: 'investment scam' },
  { re: /\b(bitcoin|crypto|usdt|binance)\b.{0,40}\b(double|guaranteed|signal|profit)\b/i, weight: 4, reason: 'crypto scam' },
  { re: /\b(account|card)\b.{0,25}\b(suspended|blocked|frozen)\b.{0,40}\b(verify|click|login)\b/i, weight: 4, reason: 'phishing' },
  { re: /\b(i am|i'm|this is)\b.{0,25}\b(from|representing)\b.{0,30}\b(bank|police|court|customs|tax)\b/i, weight: 4, reason: 'impersonation' },
  { re: /\b(send|transfer|wire)\b.{0,20}\b(money|cash|usdt|btc)\b.{0,30}\b(urgent|now|immediately|today)\b/i, weight: 4, reason: 'money request' },
  { re: /\b(work from home|earn \$?\d+ (per|a) (day|hour)|part[- ]time job).{0,60}\b(whatsapp|telegram)\b/i, weight: 3, reason: 'job spam' },
  { re: /\b(seo|digital marketing|website design)\b.{0,40}\b(cheap|guaranteed|first page|rank #?1)\b/i, weight: 2, reason: 'agency spam' },
];

const SHORTENER = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|cutt\.ly|shorturl\.at)\b/i;

// Simple flood detector (in memory is fine — restarts shouldn't punish anyone)
const recent = new Map(); // number -> { count, windowStart, lastText }

function floodCheck(number, text) {
  const now = Date.now();
  const entry = recent.get(number) || { count: 0, windowStart: now, lastText: '', sameCount: 0 };
  if (now - entry.windowStart > 60_000) {
    entry.count = 0;
    entry.windowStart = now;
    entry.sameCount = 0;
  }
  entry.count += 1;
  if (text && text === entry.lastText) entry.sameCount += 1;
  else entry.sameCount = 0;
  entry.lastText = text;
  recent.set(number, entry);
  return entry;
}

/**
 * @returns {{score:number, isScam:boolean, reasons:string[], action:'none'|'warn'|'block'}}
 */
export function analyze(number, text = '') {
  const reasons = [];
  let score = 0;

  for (const { re, weight, reason } of SCAM_PATTERNS) {
    if (re.test(text)) {
      score += weight;
      reasons.push(reason);
    }
  }

  if (SHORTENER.test(text) && /\b(click|verify|claim|urgent)\b/i.test(text)) {
    score += 2;
    reasons.push('shortened link + urgency');
  }

  const flood = floodCheck(number, text);
  if (flood.count >= 12) {
    score += 2;
    reasons.push('message flood');
  }
  if (flood.sameCount >= 4) {
    score += 1;
    reasons.push('repeated identical message');
  }

  const contact = getContact(number);
  const prior = contact?.spam_score || 0;
  const total = prior + score;

  if (score > 0) {
    upsertContact(number, { spam_score: total });
    logEvent('spam_signal', number, { score, reasons });
  }

  let action = 'none';
  if (total >= 4) action = 'warn';
  if (total >= 9) action = config.behavior.autoBlockScam ? 'block' : 'warn';

  return { score, total, isScam: total >= 5, reasons, action };
}

export function applyAction(number, action) {
  if (action === 'block') {
    blockContact(number, true);
    logEvent('contact_blocked', number, 'scam threshold');
  }
}

export const WARN_MESSAGE =
  "I'm going to stop here — this looks like a scam pattern, and I don't share codes or send money. If this is a real project, tell me what you're building and I'll help.";

export default { analyze, applyAction, WARN_MESSAGE };
