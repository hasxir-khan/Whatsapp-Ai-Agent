import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('guards');

const media = await import('../src/services/media.js');
const spam = await import('../src/services/spamGuard.js');
const db = await import('../src/utils/db.js');
await db.initDB();

test('chat types are classified correctly', () => {
  assert.equal(media.chatKind('923001112223@s.whatsapp.net'), 'private');
  assert.equal(media.chatKind('120363012345678901@g.us'), 'group');
  assert.equal(media.chatKind('120363012345678901@newsletter'), 'newsletter');
  assert.equal(media.chatKind('status@broadcast'), 'status');
  assert.equal(media.chatKind('12345@broadcast'), '#broadcast');
});

test('only private chats are allowed', () => {
  assert.equal(media.isAllowedChat('923001112223@s.whatsapp.net'), true);
  assert.equal(media.isAllowedChat('120363012345678901@g.us'), false);
  assert.equal(media.isAllowedChat('120363012345678901@newsletter'), false);
  assert.equal(media.isAllowedChat('status@broadcast'), false);
});

test('numbers are extracted from jids safely', () => {
  assert.equal(media.jidToNumber('923001112223:12@s.whatsapp.net'), '923001112223');
  assert.equal(media.jidToNumber('923001112223@s.whatsapp.net'), '923001112223');
});

test('message kinds are detected', () => {
  const text = media.describeMessage({ message: { conversation: 'hello' } });
  assert.equal(text.kind, 'text');
  assert.equal(text.text, 'hello');

  const image = media.describeMessage({ message: { imageMessage: { caption: 'look', mimetype: 'image/jpeg' } } });
  assert.equal(image.kind, 'image');
  assert.equal(image.caption, 'look');

  const voice = media.describeMessage({ message: { audioMessage: { ptt: true, seconds: 12, mimetype: 'audio/ogg; codecs=opus' } } });
  assert.equal(voice.kind, 'voice');
  assert.equal(voice.isVoice, true);
  assert.equal(voice.seconds, 12);

  const video = media.describeMessage({ message: { videoMessage: { seconds: 30, mimetype: 'video/mp4', caption: 'demo' } } });
  assert.equal(video.kind, 'video');
  assert.equal(video.caption, 'demo');

  const doc = media.describeMessage({ message: { documentMessage: { fileName: 'brief.pdf', mimetype: 'application/pdf' } } });
  assert.equal(doc.kind, 'document');
  assert.equal(doc.fileName, 'brief.pdf');
});

test('wrapped (view-once / ephemeral) messages are unwrapped', () => {
  const msg = {
    message: {
      viewOnceMessageV2: {
        message: { imageMessage: { mimetype: 'image/jpeg', viewOnce: true } },
      },
    },
  };
  const info = media.describeMessage(msg);
  assert.equal(info.kind, 'image');
  assert.equal(info.isViewOnce, true);
});

test('normal clients with links and caps are not flagged', () => {
  const result = spam.analyze('447700900123', 'HERE IS MY WEBSITE https://northwind.co.uk please take a look');
  assert.equal(result.isScam, false);
  assert.equal(result.action, 'none');
});

test('scam patterns are caught', () => {
  const otp = spam.analyze('447700900124', 'Please share the OTP code you just received so we can verify your account');
  assert.equal(otp.isScam, true);
  assert.ok(otp.reasons.some((r) => /OTP/i.test(r)));

  const prize = spam.analyze('447700900125', 'Congratulations! You have won a lottery prize, claim now');
  assert.equal(prize.isScam, true);
});

test('spam does not auto-block unless enabled', () => {
  const result = spam.analyze('447700900126', 'Send money urgent wire transfer now');
  assert.equal(result.action, 'warn');
});
