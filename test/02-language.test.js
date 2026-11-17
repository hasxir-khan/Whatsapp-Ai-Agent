import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('language');

const { detectLanguage, mirrorInstruction, voiceForLanguage } = await import('../src/services/language.js');

test('detects English', () => {
  const lang = detectLanguage('Hi, I need a website for my business. What is the price?');
  assert.equal(lang.code, 'en');
  assert.match(mirrorInstruction(lang), /English/);
});

test('detects Roman Urdu / Hinglish', () => {
  const lang = detectLanguage('bhai mujhe website banwani hai, kitna charge karo ge?');
  assert.equal(lang.code, 'roman-ur');
  assert.match(mirrorInstruction(lang), /Roman Urdu/);
});

test('detects Urdu script', () => {
  const lang = detectLanguage('السلام علیکم، مجھے ایک ویbsite چاہیے، کتنی قیمت ہوگی؟');
  assert.equal(lang.code, 'ur');
  assert.equal(lang.rtl, true);
});

test('distinguishes Arabic from Urdu script', () => {
  const arabic = detectLanguage('مرحبا، أنا أريد موقع إلكتروني، كم السعر؟');
  assert.equal(arabic.code, 'ar');
});

test('detects Spanish, French and Turkish', () => {
  assert.equal(detectLanguage('Hola, necesito una página web para mi proyecto, cuánto cuesta?').code, 'es');
  assert.equal(detectLanguage('Bonjour, je voudrais un site web pour mon projet, combien ça coûte ?').code, 'fr');
  assert.equal(detectLanguage('Merhaba, proje için bir web sitesi istiyorum, fiyat nedir?').code, 'tr');
});

test('detects non-latin scripts', () => {
  assert.equal(detectLanguage('नमस्ते, मुझे एक वेबसाइट चाहिए').code, 'hi');
  assert.equal(detectLanguage('Здравствуйте, мне нужен сайт').code, 'ru');
  assert.equal(detectLanguage('你好，我需要一个网站').code, 'zh');
});

test('picks a matching voice', () => {
  assert.equal(voiceForLanguage({ code: 'en', locale: 'en-US' }, {}), 'en-US-AriaNeural');
  assert.equal(voiceForLanguage({ code: 'ur', locale: 'ur-PK' }, {}), 'ur-PK-UzmaNeural');
  assert.equal(voiceForLanguage({ code: 'roman-ur', locale: 'en-US' }, { ur: 'ur-PK-AsadNeural' }), 'ur-PK-AsadNeural');
});

test('empty input is handled', () => {
  assert.equal(detectLanguage('').code, 'unknown');
});
