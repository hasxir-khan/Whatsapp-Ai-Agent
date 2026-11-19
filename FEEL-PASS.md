# Part 4 — the human-feel pass

*Measure first, then make the chat feel like a person wrote it. No new business
features; every existing test still passes; `npm run eval` grew from 79 to 87
scenarios and stays at 100 %.*

| | |
|---|---|
| Branch | `arena/e323af96-whatsapp-ai-agent` (from `376b8ee`) |
| Unit tests | **939 pass · 0 failures** (935 + 3 red when this pass shipped; all three fixed later — see “Formerly known failures”) |
| Eval | **87 scenarios · 87 pass · 0 warn · 0 fail · 100 %**, ~17 s, deterministic, no network |
| New unit tests | `test/58-human-feel.test.js` — 24 tests |
| New goldens | 8 (`feel-*.json`), Roman Urdu, English and Urdu |
| Existing tests | **untouched by this pass** — no baseline was edited to make anything pass; the flaky `.status` test was later given a fixed clock (§5) |

---

## 1. Where the time went — measured, not guessed

`.debug last` now ends with a per-reply timeline, newest first:

```
⏱️ Reply timeline (newest first)
• +44 7700 900xxx · 7.9s total · read +2.8s · debounce 2.2s · pipeline 0.0s · model 0.0s · hold 5.7s · groq/openai/gpt-oss-120b
• +44 7700 900xxx · 7.7s total · read +1.2s · debounce 2.2s · pipeline 0.0s · model 0.0s · hold 5.5s · groq/openai/gpt-oss-120b
  where the time goes (avg of last 3): debounce 2.2s · model+pipeline 0.0s · hold 5.4s
```

The chat numbers are the fixture range the tests use (UK 07700 900xxx, reserved
for fiction), shown here with the last digits masked.

The stages are `received → read → batch (debounce) → typing → provider_done →
sent`, in seconds. `.debug 92300…` shows the same breakdown per chat, and
`.debug timing` prints the settings actually in force.

### Before / after, same pipeline, same fixture provider

Six real turns through `handleIncoming` with the default configuration
(`/tmp/measure.mjs`, provider latency ≈ 0 ms because the fixtures are recorded):

| | before (old single delay) | after (timing model) |
|---|---|---|
| total, customer message → reply | 6.9 – 11.2 s, avg **8.75 s** | 7.0 – 7.9 s, avg **7.48 s** |
| read receipt | 0 s (instant, on arrival) | 1.2 – 2.8 s, avg **1.9 s** |
| debounce | 2.2 s | 2.2 s (unchanged) |
| model + pipeline | ~0.03 s (fixture) | ~0.03 s (fixture) |
| “typing” hold | one `composing`, no refresh, capped by `MAX_DELAY_MS` (9 s) | **5.25 s**, refreshed every 8 s, capped at 30 s |

The numbers that matter are not the averages — it is *where* the time sits:

* **Old:** read at 0 s, then nothing, then — only once the model had already
  finished — a single `composing` and a sleep of up to 9 s. With a slow provider
  (5 s) the customer saw “typing…” expire *before* the text existed, and the
  total was provider + sleep, which is why it swung between 7 and 11 s.
* **New:** read at 1–3 s, typing starts immediately and is refreshed while the
  model works, and the wait is planned against a **target window** rather than
  added on top of it. A reply that is ready at 12 s goes out at 12 s; one that is
  ready at 21 s goes out immediately (verified by test).

In production the model term is 1–4 s (`groq/llama-3.3-70b-versatile` in the
part-3 traces), so the expected total is 6–10 s with the answer arriving inside
the 5–15 s window by construction.

---

## 2. What changed, item by item

### 1 · Measure first — `src/services/timeline.js` (new), `ownerCommands.js`

In-memory ring of the last 50 replies (mirrored to the `events` table as
`reply_timeline` so `.debug` survives a restart), plus `.debug last`,
`.debug <number>` and `.debug timing`.

### 2 · Reply timing — `src/core/timing.js` (new), `humanizer.js`, `handler`

* `planReplyDelay()` — a *target window*: total ∈ [5 s, 15 s]; the wait is
  `clamp(max(typing time, window floor − elapsed), 0, window ceiling − elapsed)`.
  Once the reply is already late (`elapsed ≥ targetMax`) the wait is **0**.
* Read receipt after **1–3 s**, not on arrival (`scheduleRead`), so the customer
  sees someone pick the phone up rather than a webhook firing.
* Typing right after the read, duration = `chars / cps` clamped to **3–10 s**
  with jitter, refreshed every **8 s**, hard-capped at **30 s**.
* Past 30 s one short holding line, in the chat’s language, then the reply.
* A slow provider keeps the indicator alive because the session is owned by the
  batch (`processBatch` → `runBatch`), not by the send call.
* Debounce is unchanged (2.2 s default) and clamped to ≤ 3 s by the timing model.
* Owner takeover, opt-out and quiet hours are untouched.

### 3 · Typing indicators — `timing.js`, `humanizer.js`, `cloud.js`, `base.js`

* Baileys: `composing` → (refresh) → `paused` → message, per bubble; `available`
  is left to the transport. Verified by an ordering test on a fake socket.
* Cloud API: the documented shape is a **read receipt with a typing indicator**:
  `POST /{phone_id}/messages {messaging_product, status:"read", message_id,
  typing_indicator:{type:"text"}}` [(Meta docs, via infiq/Cloud API guides)](https://www.infiq.in/glossary/typing-indicator).
  It lasts 25 s and is dropped by the next message, so it is re-sent on the same
  8 s cadence. Implemented as `CloudTransport.sendTypingIndicator(messageId)` and
  declared as a capability (`typingIndicator: true`, `typingMaxSeconds: 25`);
  failures are logged and swallowed, never sent as a broken reply.
* Nothing can leave “typing…” on screen: `processBatch` stops the session in a
  `finally`, and `sendHuman` clears it on the error path and after a voice note.

### 4 · Short replies — `src/core/brevity.js` (new), `brain.js`, `handler`

* One shared prompt rule (`brevityInstruction`) for every agent and language:
  fewest sentences that work, default **2** (~30 words), no filler openers, never
  repeat the question, **at most one question**, mirror the customer’s length.
* Post-generation trim (`trimReply`) — local, no second model call: drops a
  filler opener that is its own sentence, keeps one question, cuts to the cap but
  never drops a sentence carrying a number/price/link, and folds such a sentence
  back in before a closing question. Lists and price tables are exempt; a
  customer who asks for detail gets detail.
* `business.tone.maxSentences` (default 2) or `REPLY_MAX_SENTENCES`.
* Long answers become 2–3 bubbles with typing between them (existing splitter,
  now paced by the same clock).

### 5 · Missed calls — `src/services/calls.js`, `db.js`, `env.js`

* Ring window **60–90 s, random per call** (`CALL_DELAY_MIN/MAX_SECONDS`;
  `CALL_FALLBACK_SECONDS` still pins a fixed value for existing installs).
* Owner accepts → the window and any pending apology are cancelled and **nothing
  is sent**; a customer who writes first → no apology; a paused/taken-over chat
  or an opt-out → no apology.
* Caller hangs up (`reject`/`timeout`) → **one short apology 5–15 s later**, typed,
  in the contact’s language, e.g. *“Sorry, abhi call attend nahi kar sakay.
  Yahin likh dein, foran jawab dete hain.”* Optional voice via
  `CALL_APOLOGY_VOICE`; the text always goes too.
* **One apology per contact per 30 min** (`CALL_APOLOGY_WINDOW_MIN`).
* `calls` gained `ended_at` / `apologized_at` (migrated forward), and `.calls`
  now prints ring start → ended → apology.

### 6 · Voice messages — `src/services/tts.js`, `handler`, `humanizer.js`

* `VOICE_REPLY_MODE` default is now **`match_voice`** (`match` is accepted as a
  spelling): a voice note gets a voice note, a written request gets one, and a
  typed question gets text.
* Spoken part capped at **~20 s** (`TTS_MAX_SECONDS`) at a sentence boundary; the
  full text is still sent, so nothing is lost.
* If the voice note fails or is refused, the same words go out as text
  (sentence-level fallback, tested).
* A number-heavy quote is **never voice-only**: all bubbles as text, then the
  note.
* Optional voice for the missed-call apology and the first greeting
  (`TTS_GREET_VOICE`, off by default).

### 7 · Human touches — `src/core/humanTouch.js` (new)

* `ok` / `thanks` / `shukriya` / 👍, when there is no open question, gets a
  **reaction** (🙏 for thanks, 👍 otherwise) and **no text**; if the transport
  cannot react (Cloud API) it gets **silence**, not “You’re welcome! 😊”.
* No robotic self-descriptions: the prompt forbids them.
* **“Are you a bot?”** is answered honestly and briefly from a fixed line in the
  customer’s language — English, Roman Urdu and Urdu — and the owner is told. It
  is checked before any feature flag, so **`PRETEND_HUMAN`, `HUMAN_TOUCH=off` and
  every other switch leave it intact**. There is no code path that skips it.
* The bot does not talk over the owner: if the owner writes in the chat while a
  reply is being composed, the reply is dropped (`shouldSend` guard), and the
  takeover pause still stops the whole batch.

### Flags — everything defaults **on**, and off means the old behaviour

| Flag | Default | Off |
|---|---|---|
| `REPLY_TIMING` | on | the old single `humanDelay` + one `composing` (tested) |
| `HUMAN_TOUCH` | on | “ok” gets words again (tested) |
| `VOICE_REPLY_MODE` | `match_voice` | `on_request` / `off` behave as before |
| `CALLS_ENABLED`, `CALL_*` | as before | as before |
| the honest bot answer | **always on** | no switch exists |

**One deliberate correction:** part 1 shipped the claim “the Cloud API has no
typing indicator”. That was wrong — Meta documents the read-receipt form. The
capability is now declared (`typingIndicator`, 25 s) *without* pretending Cloud
has Baileys presence, so `capabilities.presence` stays `false` for Cloud and the
existing transport tests still pass unchanged.

---

## 3. How to tune it

Everything is settable three ways, in this order of precedence: **env → profile
(`tone.replyTiming`) → defaults**.

```bash
# .env — the whole feel of the chat
REPLY_TIMING=true
REPLY_TARGET_MIN_MS=5000     # customer message → reply, floor
REPLY_TARGET_MAX_MS=15000    # …and ceiling; past this the reply goes at once
READ_DELAY_MIN_MS=1000       # blue ticks
READ_DELAY_MAX_MS=3000
TYPING_MIN_MS=3000           # how long "typing…" is shown, floor
TYPING_MAX_MS=10000          # …and ceiling
TYPING_CPS=11                # characters per second the indicator "types"
TYPING_REFRESH_MS=8000       # re-send the indicator so it never expires
TYPING_HARD_CAP_MS=30000     # stop pretending to type
HOLDING_AFTER_MS=30000       # past this, one short "one sec" line
REPLY_MAX_SENTENCES=2        # quotes, lists and "explain in detail" exempt
HUMAN_TOUCH=on
CALL_DELAY_MIN_SECONDS=60    # the missed-call window
CALL_DELAY_MAX_SECONDS=90
CALL_APOLOGY_WINDOW_MIN=30
CALL_APOLOGY_VOICE=false
TTS_MAX_SECONDS=20
TTS_GREET_VOICE=false
```

Per-business, in `config/owner.json`:

```json
"tone": {
  "maxSentences": 2,
  "humanTouch": true,
  "replyTiming": { "targetMinMs": 5000, "targetMaxMs": 15000, "typingMinMs": 3000, "typingMaxMs": 10000 }
}
```

Practical notes:

* Faster and snappier: `REPLY_TARGET_MIN_MS=3000 REPLY_TARGET_MAX_MS=8000
  TYPING_MIN_MS=2000 TYPING_MAX_MS=6000`.
* More deliberate (a slower, older-school business): raise both target bounds and
  `READ_DELAY_MAX_MS` together — the window, not one number, is what feels human.
* Tests and scripts that set the *old* `MIN_DELAY_MS` / `MAX_DELAY_MS` still work:
  when `MAX_DELAY_MS` is below 15 s the whole model is scaled into that envelope,
  so a 40 ms test harness gets 40 ms replies, not 15-second ones.
* `TYPING_CPS` is the single biggest lever on felt speed: it is the only number
  that makes a long answer take longer than a short one.

---

## 4. Tests added (existing tests untouched)

`test/58-human-feel.test.js` — 24 tests:

1. timing: total inside 5–15 s for four reply shapes, typing inside 3–10 s;
2. timing: a 21-second reply is sent immediately, not padded;
3. timing: the indicator is refreshed, then paused;
4. typing: `read → composing → paused → message` order on a fake socket;
5. typing: a long answer becomes 2–3 bubbles with typing before each;
6. typing: a permanent send failure leaves no “typing…”;
7. brevity: filler dropped, both prices kept;
8. brevity: one question max;
9. brevity: lists and “explain in detail” exempt;
10. brevity: the shared prompt rule is in every system prompt;
11. missed call: owner answers → nothing sent, `ended_at` recorded;
12. missed call: hang-up → exactly one apology ≤ 2 sentences, typed, on the
    timeline, and the 30-minute cap holds;
13. missed call: customer writes first → no apology;
14. voice: default mode answers a voice note with a voice note; `match` alias;
15. voice: spoken part ≤ 20 s and keeps the numbers;
16. voice: a refused voice note falls back to the same text;
17. voice: a price quote is never voice-only;
18. human touch: “ok thanks” → 🙏 reaction, no text, `ack_reaction` logged;
19. human touch: “are you a bot?” answered honestly **with `HUMAN_TOUCH=off`**;
20. human touch: the answer exists in en / roman-ur / ur;
21. human touch: no reply on top of the owner’s message;
22. timeline: `.debug last` carries total, read and the “where the time goes” line;
23. `REPLY_TIMING=false` → the old single-delay send;
24. `HUMAN_TOUCH=off` → “ok” gets words again.

Eight new goldens (now 87 scenarios):

| Scenario | What it pins down |
|---|---|
| `feel-short-answer-en` | filler opener and extra sentences trimmed, ≤ 2 sentences |
| `feel-short-answer-roman-ur` | Roman Urdu answer stays Roman Urdu and short |
| `feel-short-answer-ur` | Urdu answer trimmed but keeps the closing time |
| `feel-trim-quote-en` | 120,000 and 350,000 survive the cut, “Of course! Happy to help” does not |
| `feel-ack-reaction-en` | “thanks!” → one reaction, zero text |
| `feel-bot-question-roman-ur` | honest answer + `bot_disclosure` event, even with no business profile |
| `feel-missed-call-apology-ur` | one short Urdu apology, `call_fallback`, one reply |
| `feel-voice-match-en` | a voice question is answered (match_voice default) |

Two assertion types were added for these (`maxSentences`, `reactionOnly`) and the
eval harness now records reactions separately from text replies, so “a reaction
and nothing else” is checkable rather than inferred from events.

---

## 5. Formerly known failures — all three fixed since

These three were red when this pass shipped. None was caused by the work here,
and none was fixed by making the assertion weaker: the fix went into the thing
the test was exercising.

| Test | Why it was red | Fix |
|---|---|---|
| `.status <id> <state> moves an order and notifies the customer` | it read the wall clock, so it went red whenever the suite ran inside the profile’s Karachi quiet hours (21:00 → 09:00) and the customer message was correctly deferred | `handleOwnerCommand` takes an optional clock (`{ now }`); the test passes a fixed 13:00 Karachi, and a new test pins 23:00: the order moves, nothing is sent, the reply says `quiet_hours`. The eval harness passes the scenario clock too. |
| `the demo folder and the owner profile stay out of git` | `config/owner.json` was tracked despite `.gitignore` — a private profile in a public repo | untracked (`git rm --cached`); index and tree clean, the file stays ignored |
| `this repository is clean, and its own scanner is allowed to contain patterns` | the same tracked `config/owner.json` — the scanner treats that file as a private owner profile and fails the tree | untracking it fixed this one as well; the work is committed, so tree and index agree |

`npm test` today: **939 pass, 0 failures**.

---

## 6. What could not be tested without a real phone

1. **How it actually feels.** “5–15 s” is a proxy. Whether 7 s reads as attentive
   or slow depends on the business and the customer; only real chats answer that.
   `TYPING_CPS` and the target window are the two knobs to turn first.
2. **Baileys presence semantics.** The fake socket proves the *order* of
   `composing` / `paused`; whether WhatsApp's servers keep the label alive for the
   full 8 s between refreshes depends on the linked device, and can only be seen
   on a handset. The 8 s refresh is deliberately conservative against the
   documented 25 s Cloud window.
3. **The Cloud typing indicator.** The payload is the documented one, but it needs
   a real WABA, an approved phone number and a customer handset to confirm the
   bubble appears and disappears as expected. The capability flag degrades rather
   than throwing if Meta rejects the call (version, permissions).
4. **The 25 s Cloud ceiling.** Our hard cap is 30 s; on Cloud the label dies at
   25 s and is only re-raised by another read-receipt call. With the 8 s refresh
   this is inside the window, but the exact behaviour at the boundary is a
   server-side detail.
5. **Real call events.** `offer` / `reject` / `timeout` were driven through the
   handler, not through a real ringing phone. Whether Baileys always emits an end
   event, and how long WhatsApp keeps ringing before `timeout`, can only be
   measured live — hence the 60–90 s fallback timer that fires even if no end
   event ever arrives.
6. **Voice quality.** TTS synthesis needs network providers (Edge/Groq) and a
   listening ear: the tests cover the decision, the 20 s cap, the fallback and
   “never voice-only for a quote”, not whether the Urdu voice sounds right.
   `ffmpeg` presence decides PTT vs. a plain audio file.
7. **Reactions on a real client.** That a 👍 on “thanks!” feels right, and that
   Cloud API users get silence instead, is a product judgement; the code path is
   tested, the taste is not.
8. **The owner-typing race.** The guard is tested by inserting the owner’s message
   while the bot composes. On a real phone the owner’s *typing* (before they send)
   is not visible to the bot at all — only their sent messages and the takeover
   pause.

---

## 7. Files

New:

```
src/core/timing.js          the window, the indicator session, the holding line
src/services/timeline.js    per-reply stages + `.debug last`
src/core/brevity.js         shared prompt rule + local trim
src/core/humanTouch.js      reactions, no self-description, the honest answer
test/58-human-feel.test.js  24 unit tests
test/golden/feel-*.json     8 scenarios
```

Changed:

```
src/core/humanizer.js       timed send, delayed read, reactions, voice+text, gaps
src/core/brain.js           brevity + touch rules in every system prompt
src/handlers/messageHandler.js  batch-owned typing session, timeline marks, trim,
                            ack reaction, honest answer, owner guard, voice cap
src/handlers/ownerCommands.js   .debug last / .debug timing / .calls timeline
src/services/calls.js       60–90 s window, cancel-on-answer, 30-min cap, short apology
src/services/tts.js         match_voice default, 20 s speech cap, mode aliasing
src/transport/cloud.js      sendTypingIndicator (read receipt + typing_indicator)
src/transport/base.js       typingIndicator capability
src/config/env.js           timing / calls / tts knobs
src/utils/db.js             calls.ended_at, calls.apologized_at
src/eval/run.js             reactions recorded separately from replies
src/eval/assertions.js      maxSentences, reactionOnly
src/eval/scenarioSchema.js  the two new assertion keys
.env.example                every new knob, with the reasoning next to it
config/owner.example.json   tone.maxSentences, tone.humanTouch, tone.replyTiming
```
