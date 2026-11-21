# Media Intelligence: audit and verification

This report records the original opt-in rollout. The subsequent [safety pass](safety-pass.md) made transport limits, duration enforcement, voice delivery and local clip extraction unconditional. The language and private-reply features are still **off by default**. See [Voice and video](../README.md#voice-and-video) for current behaviour.

## Step 0 findings (before changes)

These are findings from the read-only audit at `79dc53c`, **not** claims about current live providers.

| Path | What the audit established |
|---|---|
| Arrival | Baileys and Cloud normalized 1:1 messages, ran early guards and debounced; interpretation considered the first five batch items. The Baileys precheck missed nested media lengths, then buffered and checked bytes (48 MiB video, 25 MiB audio). Cloud read the download into an unbounded array buffer. A declared duration was not a verified duration. |
| Voice → text → language | Groq Whisper tried `whisper-large-v3-turbo`, then `whisper-large-v3`, up to 120 s per model; over 24 MiB it attempted ffmpeg compression. `MAX_AUDIO_SECONDS` was not enforced there. Two letters counted as meaningful. A synthetic short “haan” could look like Roman Urdu in a fresh chat; English history could preserve English. The generic sticky detector weighted recent customer turns. `business.languages` informed the prompt, not an output allowlist. |
| Text → voice | The configured path was Edge (two hosts, 30 s each) or Groq Orpheus (45 s, English/Arabic); the length cap was an estimate. In an isolated mock, the builder returned a payload, but the sender tested `voice.buffer` and sent **text only**. No handset was involved. |
| Video → reply | Gemini native video was tried first: inline up to 15 MiB, otherwise Files upload/poll/best-effort delete, with a 90 s generation deadline. Fallback used evenly spaced JPEGs and an extracted soundtrack, and could try the original video as STT input. Visual prose and transcribed speech could influence the same language decision. There was no verified clip-duration limit, structured safety handoff, tenant video admission or monthly video entitlement. |
| Lifecycle and evidence | Typing refreshed but stopped at the ordinary 30 s cap; the holding line came after the answer was ready. A temp sweep existed, but caption recovery, memory, failed sends and Cloud holds could retain content. Existing voice goldens used recorded text and placeholder bytes. No tracked real-media corpus or live WhatsApp/provider evidence was found. |

## What changed

| Area | Files |
|---|---|
| Opt-ins, controls, language, voice and delivery | `config/owner.example.json`, `.env.example`, `src/config/env.js`; `src/handlers/{messageHandler,mediaTurn,ownerCommands}.js`; `src/services/{profile,language,languageStick,voicePolicy,mediaReplies,transcription,tts,edgeTts}.js`; `src/core/{brain,humanizer,timing,injection,replyChannel}.js` |
| Clip work, safety, privacy and accounting | `src/services/{video,vision,ffmpeg,media,documents,paymentReview,mediaLimits,mediaUsage,health,ephemeralMedia,outboundStore,outbox}.js`, `src/transport/{baileys,cloud}.js`, `src/utils/db.js` |
| Managed worker, usage page and doctor | `platform/{schema,plans,keys,dashboard,reportMetrics,reportView}.js`, `src/services/{reportContract,tenantReports}.js`, `scripts/doctor.js` |
| Reproducible checks and operator documentation | `scripts/eval.js`, `src/eval/{model,media}.js`, [media behaviour tests](../test/78-media-intelligence.test.js), [report/doctor/budget tests](../test/79-media-report.test.js), [fixture sources, manifest and recordings](../test/fixtures/media/README.md), `README.md`, this report |

## Verification after implementation

- **`npm test`: 1,317/1,317** on Node 22 with local ffmpeg. No failures or skips; existing test files were not edited. The **31 new tests** cover both feature switches, policy precedence/script, real Opus duration from a stub provider, text fallback, bounded reads, scene selection, handoffs, temp cleanup, storage and tenant quotas. Actual inbound handler tests exercise protected and legacy dispatch, a slow vision call with one holding line, and paused, deferred and opted-out paths. A fake Cloud window expiring during owner notification queued **only** the chat pointer.
- **`npm run eval`: 110/110 chat + 18/18 media** offline. The ten voice cases delivered both note and text through a fake transport. Six videos yielded a reading (including two owner reviews); the 62 s clip was refused and the corrupt clip requested a resend. Recorded media used **27 HTTP/model turns + 10 TTS replays**, not paid calls.
- **Without ffmpeg:** `npm run eval -- --media` passed **18/18**, explicitly using recorded extraction and no TTS replays. The two new test files passed **26**, skipped **5** requiring a real binary. This is evidence of fallback, not decoding.
- **Budget and failure:** the no-key live command refused before starting. With simulated network I/O, the real live-runner code sent extracted JPEGs rather than a video; a cap of zero made zero wire calls, a one-call cap stopped a vision-model retry, and a three-call cap allowed STT, chat and one failed Edge handshake but not the second handshake. A delivered language inconsistent with the expected case produced a hard eval failure. Timeout/breaker, daily/monthly rollover and tenant isolation also have offline tests.
- **Dashboard and plans:** worker facts → importer → scoped usage page showed the seeded 75% (3/4), 3 processed / 1 refused, 400 ms average and 2 provider errors; other-tenant counts were excluded. In a separate disposable provisioning check, the Starter 30 and Free 0 limits reached the isolated child environment and the child enforced the monthly gate. The existing Chromium dashboard smoke passed at **390 × 844**, including the Usage page. It is a browser check, not WhatsApp playback.
- **Checks:** doctor identified missing ffmpeg, a missing vision key and a missing language-specific voice in the isolated readiness fixture. Dashboard definitions and diff whitespace checks passed. Staged and current-tree secret scans passed; the history-wide scan still reports three inherited findings at `6d6116f` (one old private-profile path and two key-shaped test entries). No values, exceptions or history rewrites were added.

### Recorded scorecard

One local `npm run eval` run, in milliseconds. Quality is computed from transcript text and available confidence; it is not a human transcription grade. Gist was **1.0 in every case**: for unusable inputs it scores the requested clarification/refusal, not recognition of missing content. `—` means no STT was attempted. Latency includes local processing with simulated providers and shortened eval timing; it is **not** a production latency measurement.

| Voice fixture | Delivered language / script | Quality | ms | Video fixture | Delivered language | Quality | ms |
|---|---|---:|---:|---|---|---:|---:|
| Clear Urdu | Urdu | 1 | 196 | Product demo | English | 1 | 116 |
| Spoken Urdu, Roman text | Roman Urdu | 1 | 108 | Complaint → review | English | 1 | 116 |
| English | English | 1 | 97 | Shop/location | English | 1 | 146 |
| Punjabi-influenced mix | Urdu | 1 | 97 | Overlength → shorter clip | English | — | 26 |
| Noisy → clarify | Urdu | .18 | 107 | Silent → frames only | English | — | 118 |
| Short “haan” → clarify | English | .33 | 71 | Injected overlay → review | English | — | 73 |
| Long (57.66 s) | English | 1 | 83 | Audio-only → transcript only | English | 1 | 79 |
| Code-switched | English | 1 | 79 | Corrupt → resend | English | — | 20 |
| Injected wrong detector code | English | 1 | 80 | | | | |
| Spoken instruction → clarify | English | 1 | 68 | | | | |

### Reproduce or extend the evidence

```sh
npm run doctor -- media
node --test test/78-media-intelligence.test.js test/79-media-report.test.js
npm test
npm run eval
npm run eval -- --media --only wrong-detector
npm run eval -- --live --media --max-calls 40   # opt-in only; may incur charges
```

**Not verified live:** Whisper's recognition of real Urdu/Punjabi and mixed dialects; actual voice availability, pronunciation and intelligibility; provider model availability, quotas, bills and end-to-end latency; or presence, playback, media download and delivery on a WhatsApp handset. The private-worker cleanup and persistence checks cannot establish what external providers, WhatsApp or the recipient retain. Use consented recordings, an explicit call budget and a test number before enabling either flag for customers.
