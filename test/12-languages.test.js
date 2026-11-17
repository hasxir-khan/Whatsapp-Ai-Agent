// Languages: the assistant has to hold a conversation in whatever the client
// speaks, and match their register.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('languages');

const {
  detectLanguage, detectTone, mirrorInstruction, toneInstruction,
  voiceForLanguage, fromWhisperLanguage, SUPPORTED_LANGUAGES,
} = await import('../src/services/language.js');

const cases = [
  // [text, expected code, why]
  ['میں آپ سے بات کرنا چاہتا ہوں', 'ur', 'Urdu script'],
  ['أريد موقعاً إلكترونياً لمتجري', 'ar', 'Arabic script'],
  ['سلام، پروژه من چیست؟', 'fa', 'Persian letters'],
  ['אני צריך אתר לאינטרנט', 'he', 'Hebrew script'],
  ['मुझे एक वेबसाइट चाहिए', 'hi', 'Devanagari'],
  ['আমার একটি ওয়েবসাইট দরকার', 'bn', 'Bengali'],
  ['Мне нужен сайт для магазина', 'ru', 'Cyrillic'],
  ['Мені потрібен сайт для магазину', 'uk', 'Ukrainian letters'],
  ['Χρειάζομαι έναν ιστότοπο', 'el', 'Greek'],
  ['我需要一个网站', 'zh', 'Han'],
  ['サイトを作りたいのですが', 'ja', 'Kana'],
  ['웹사이트가 필요해요', 'ko', 'Hangul'],
  ['ฉันต้องการเว็บไซต์', 'th', 'Thai'],
  ['Quiero una página web para mi tienda', 'es', 'Spanish'],
  ['Je voudrais un site pour mon magasin', 'fr', 'French'],
  ['Ich brauche eine Webseite für meinen Laden', 'de', 'German'],
  ['Preciso de um site para minha loja', 'pt', 'Portuguese'],
  ['Vorrei un sito per il mio negozio', 'it', 'Italian'],
  ['Dükkanım için bir web sitesi istiyorum', 'tr', 'Turkish'],
  ['Saya butuh website untuk toko saya', 'id', 'Indonesian'],
  ['Tôi cần một trang web cho cửa hàng', 'vi', 'Vietnamese'],
  ['Chcę stronę internetową dla sklepu', 'pl', 'Polish'],
  ['Ik heb een website nodig voor mijn winkel', 'nl', 'Dutch'],
  ['Jag behöver en hemsida för min butik', 'sv', 'Swedish'],
  ['Nahitaji tovuti kwa duka langu', 'sw', 'Swahili'],
  ['mujhe website banwani hai bhai', 'roman-ur', 'Roman Urdu'],
  ['I need an online store with Stripe payments', 'en', 'English'],
];

test('detects languages across scripts', () => {
  for (const [text, expected, why] of cases) {
    const got = detectLanguage(text);
    assert.equal(got.code, expected, `${why}: "${text}" → ${got.code} (${got.label})`);
  }
});

test('language metadata is usable for replies and voices', () => {
  const ur = detectLanguage('آپ کیسے ہیں بھائی');
  assert.equal(ur.rtl, true);
  assert.equal(ur.locale, 'ur-PK');
  assert.match(voiceForLanguage(ur), /^ur-/);

  const de = detectLanguage('Guten Tag, ich brauche eine Webseite');
  assert.equal(de.rtl, false);
  assert.match(voiceForLanguage(de), /^de-/);

  assert.ok(SUPPORTED_LANGUAGES >= 60, `supports ${SUPPORTED_LANGUAGES} languages`);
});

test('mirror instruction tells the model to stay in the client language', () => {
  const ur = mirrorInstruction(detectLanguage('مجھے ویب سائٹ چاہیے'));
  assert.match(ur, /Urdu/);
  assert.match(ur, /right-to-left/);

  const en = mirrorInstruction(detectLanguage('hi there, need a website'));
  assert.match(en, /English/);
  assert.match(en, /Never switch/);
});

test('register: formal vs casual, across languages', () => {
  assert.equal(detectTone('Assalam o alaikum sir, kindly share the price', 'roman-ur').tone, 'formal');
  assert.equal(detectTone('aap kaise hain? mujhe website chahiye', 'roman-ur').tone, 'formal');
  assert.equal(detectTone('yaar kya haal hai bhai, price batao', 'roman-ur').tone, 'casual');
  assert.equal(detectTone('Bonjour madame, pourriez-vous me donner le prix', 'fr').tone, 'formal');
  assert.equal(detectTone('salut, tu peux me dire le prix ?', 'fr').tone, 'casual');
  assert.equal(detectTone('Guten Tag, könnten Sie mir den Preis nennen', 'de').tone, 'formal');
  assert.equal(detectTone('hey, du, was kostet das?', 'de').tone, 'casual');

  assert.match(toneInstruction({ tone: 'formal' }), /formal/i);
  assert.match(toneInstruction({ tone: 'casual' }), /casual/i);
  assert.match(toneInstruction({ formality: 'formal' }), /FORMAL/);
  assert.match(toneInstruction({ tone: 'neutral' }), /neutral/i);
});

test('voice-note language tags are understood', () => {
  assert.equal(fromWhisperLanguage('urdu').code, 'ur');
  assert.equal(fromWhisperLanguage('english').code, 'en');
  assert.equal(fromWhisperLanguage('spanish').code, 'es');
  assert.equal(fromWhisperLanguage('klingon'), null);
});

test('very short or ambiguous text does not pretend to be certain', () => {
  const short = detectLanguage('ok');
  assert.ok(['unknown', 'en'].includes(short.code));
  assert.ok(short.confidence < 0.5);
});
