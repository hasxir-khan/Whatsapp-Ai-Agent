# Fix pass — the eight bugs found in the live chat

No new features. Every fix has a failing golden scenario (and a live-mode
variant where it makes sense) that was written before the fix, plus unit tests.

```
npm test          # 911 pass, 3 pre-existing failures (see "Known failures")
npm run eval      # 79 scenarios · 79 pass · score 100%
npm run eval -- --live    # same scenarios against a real provider (needs a key)
```

---

## 1. Price integrity

**What happened.** The same project was quoted two different ranges in one
chat, one of them in Dutch. `generateReply()` returned the model's text
straight to `sendHuman()`; the only gate was the optional verify pass, which
checked tone and safety, not numbers. Nothing compared a price against the
catalogue, and nothing remembered what had already been said in the chat.

**Root cause (two of them).**

1. No post-generation check on claims at all.
2. `effectiveServices()` returned the *same service twice* — once from the
   catalogue the customer sees and once from a legacy `owner.services` list —
   because the two lists were deduplicated with different keys. The quote engine
   matched whichever entry came first, so "E-commerce store" could be priced
   120,000–350,000 from the catalogue and 25,000–75,000 from the old list. The
   complexity multiplier could also take a quote below the published floor
   (48,000 for a service listed from 120,000).

**Fix.**

* `src/core/replyGuard.js` — `allowedFacts()` builds the set of every number the
  business has published (catalogue, policies, FAQs, owner facts, order totals
  and ids), `checkClaims()` rejects any 3+ digit number that is not in it, and
  `rememberClaims()`/`rangesFor()` store every range sent in a chat so a later
  reply cannot contradict it. Percentages are allowed only when the policy
  contains them.
* `src/services/profile.js` — services dedupe by name, catalogue entry wins.
* `src/core/pricing.js` — the quote is lifted to the published floor and capped
  at the published maximum (+ add-ons), so a quote is always inside the band the
  customer can check it against.
* `src/handlers/messageHandler.js` — every reply passes the gate; a rejection
  regenerates once with the problem spelled out, then sends a safe line and
  notifies the owner.

**Tests.** `test/golden/fix-price-invented-en.json` (invented range → rejected,
repaired, owner told), `fix-price-two-ranges-en.json` (a second, different range
in the same chat → rejected), plus price units in `test/57-fix-pass.test.js`.

---

## 2. Sticky language

**What happened.** An English chat was answered in Roman Urdu after the customer
said "Yes"; a forwarded Dutch PDF moved a chat into Dutch.

**Root cause.** `processBatch` called `detectLanguage()` on *this turn only*,
with a single fallback to `contact.language`. There was no window over the
conversation, and no rule that a short message or a file cannot vote.

**Fix.** `src/services/languageStick.js`: the dominant language over the last 8
customer messages, weighted by message length and kind. Messages under 4 words,
documents, images and stickers never vote; Roman Urdu is weighted up because a
statistical detector keeps calling it English. A clear dominance (≥70%) beats a
single disagreeing message; otherwise the message wins.

**Tests.** `fix-language-short-yes-en.json` ("Yes" in an English chat),
`fix-language-roman-ur-haan` ("haan" in Roman Urdu), a document-does-not-vote
unit test.

---

## 3. One reply per customer message

**What happened.** Two replies for one message, sometimes glued into one bubble.

**Root cause.** `processBatch` is a chain of ~8 independent pipelines, each of
which sends its own reply and returns. One of them was a *second* message by
design: after the answer, `deliverQuote()` sent the quote as a follow-up. A
timed-out reasoning pass also sent a holding line before the real answer. No
per-message lock existed anywhere, and `splitIntoBubbles()` merges tail chunks,
so two texts could land in one bubble.

**Fix.**

* `src/core/replyChannel.js` — one channel per batch. The first `say()` wins;
  every later one is logged as `duplicate_reply_blocked` instead of sent.
  `beginBatch()` refuses a batch that has already been answered (a redelivery,
  a double enqueue).
* Every customer-facing send in `processBatch` now goes through the channel.
* The quote is no longer a second message: when the customer asks for a price it
  *is* the reply; otherwise it is held (`quote_held`) until they ask.
* The reasoning holding line is gone (it would be a second reply).

**Tests.** `fix-one-reply-quote-en.json` (a price question → exactly one reply,
straight from the pricing code), `fix-regression-chat-en.json` (seven turns, all
one-reply), channel unit tests.

---

## 4. Scope guard, and nothing cut mid-sentence

**Off-topic:** "say 1 to 100", jokes, homework and code are a business message's
opposite. `src/core/scope.js` refuses them with a short line in the customer's
language and redirects to orders, bookings and prices — no model call, so the
model cannot be talked into doing it anyway. A message that mentions anything
the business sells is never treated as off-topic.

**Mid-list cut ("1, 2, 3, 4, 5, 6,"):** two causes, both fixed.

* `config.llm.maxTokens` was 700 for customer replies. Customer replies now use
  an explicit `LLM_REPLY_MAX_TOKENS` (default 1000), the same for every provider.
* Nothing checked the end of a reply. `endsMidSentence()` now detects a trailing
  comma/semicolon/dash, a dangling conjunction or article, unbalanced brackets or
  quotes, and an empty bullet. `generateReply()` retries once for a finished,
  shorter answer; if the retry is also cut it keeps the whole sentences it has;
  if that fails it returns nothing and the safe line goes out. A cut reply is
  never sent.

**Tests.** `fix-scope-joke-en.json`, `fix-midsentence-retry-en.json` (a cut list
then a complete answer — the customer only ever sees the complete one).

---

## 5. Documents

**Root cause.** `interpretItem()` read the first 12,000 characters, asked for a
summary of the first 6,000, and — if the text looked like a brief — merged the
extracted fields into the intake, which could make the chat "ready to quote" and
send a price the customer never asked for. There was no chunked reading and no
check that a summary was actually supported by the file.

**Fix.**

* `src/services/documents.js` — `chunkText()` (6,000-char, overlapping,
  sentence-aligned chunks), `summarizeDocument()` reads every chunk and merges
  the notes, `stripUngrounded()` drops any line whose numbers or specific words
  are not in the source, and `understoodReply()` produces "Here is what I
  understood from the file: … Is that right?".
* `messageHandler` prepends that understanding verbatim to the single reply, then
  asks one question about what the customer wants next.
* No auto-quote: a document no longer trips the quote path; the price goes out
  only when the customer asks for a price (or confirms the scope).

**Tests.** `fix-document-long-brief-en.json` (a 70 KB brief: read in chunks,
grounded, one reply, no price), `fix-regression-chat-en.json` (a 40 KB brief mid
conversation), chunking and grounding unit tests.

---

## 6. Persona

**Root cause.** The voice was assembled ad hoc from `bot.persona`; nothing said
whether the business speaks as "we" or "I", so a reply could switch mid-message.

**Fix.** `bot.firstPerson` (`"we"` by default, `"i"` for a solo owner) in
`config/owner.example.json` and all eight templates. `systemPrompt()` states the
voice once and forbids mixing; the same prompt is used by every agent and every
provider. `checkPersona()` reports a reply that mixes both, and the eval's
`persona: "strict"` assertion fails one.

*(`bot.voice` already meant the text-to-speech voice — hence `firstPerson`.)*

**Tests.** A prompt assertion and the mixed-voice scanner in
`test/57-fix-pass.test.js`.

---

## 7. Missed call

**What was there.** A 60-second timer per incoming call (`CALL_FALLBACK_SECONDS`,
default 60) that sent a chat rescue. Two gaps: nothing cancelled the timer if
the customer wrote first, and nothing stopped a second rescue for the same call.
There was also no way to see the timeline.

**Fix (`src/services/calls.js`).**

* `handleIncoming()` cancels any pending rescue for that number
  (`cancelCallRescue`) — the customer has already opened the chat.
* `handleMissedCall()` refuses a call that is already `handled`, and refuses
  when the customer's last message is newer than the call row, marking the call
  `cancelled — customer wrote first`.
* `.calls` prints the timeline: when the call came in, when the rescue went out,
  and the gap in seconds.

**Tests.** `fix-missed-call-rescue-en.json` (rescue arrives, one reply, timeline
recorded), plus unit tests for the duplicate refusal, the "customer wrote first"
skip, the timer cancellation, and the 60-second default.

---

## 8. Provider consistency

**Root cause.** The provider chain walked a list per call with a *process-wide*
sticky choice, no cancellation of a late answer, no record of who answered, and
models chosen per provider with no shared output budget. OpenRouter was in the
middle of the chain and its model list was a default, not an allowlist.

**Fix.**

* `src/core/llm.js` — stickiness is per conversation (`chatKey`); a new chat
  starts at the top of the chain. The chain only moves on error/429/timeout, and
  then keeps the new provider for that chat. `singleFlight` gives every request a
  sequence number: an answer that arrives after a newer request started is
  discarded (`StaleResponseError`) instead of being sent. Every provider gets the
  same explicit `maxTokens`. OpenRouter is last by policy and only answers with a
  model from `OPENROUTER_ALLOWED_MODELS`; with no allowed model it is dropped
  from the chain.
* `src/services/providerTrace.js` — one row per reply: provider, model, latency,
  tokens, fallback provider and reason. `.debug last` shows the last five;
  `.debug <number>` shows the last five for one chat. The eval report carries the
  same data per scenario.
* The post-generation gate lives in the pipeline, after the model, so it applies
  to every provider identically.
* If the whole chain fails, the customer gets the short "I'll come back to you"
  line and the owner is notified (`brain_no_provider`).

**Tests.** `fix-provider-timeout-fallback-en.json` (the primary times out, the
fallback answers once, in the same language), and unit tests for per-chat
stickiness, a fresh chat starting at the top, the OpenRouter allowlist and its
position, the discarded late answer, the shared output budget, and `.debug last`.

---

## The regression chat

`test/golden/fix-regression-chat-en.json` replays the conversation from the
screenshots in one run — services → a logo photo → a 40 KB brief → "project like
this" → "how much" → "Yes" → a missed call — with hard assertions on 1–7:
one reply per turn, no mid-sentence cut, one price range, the conversation's
language, the document understood, the missed call rescued once.

It is marked `"mode": "both"`, so `npm run eval -- --live` replays it against a
real provider and the report prints provider, model, latency and tokens per
scenario.

The live-mode version of every fix scenario is the same file: `"mode": "both"`
means the deterministic recording is used in a normal run and the real provider
in a `--live` run. In live mode the fixture-strict checks (numbers, language,
length) become warnings, as they always have in this harness, while the
behavioural ones — one reply, no mid-sentence cut, one price range, no duplicate
rescue, the document grounded — stay hard, because those are not a matter of the
model's phrasing.

---

## What could not be tested here

* **Live mode was not run.** This environment has no real provider keys, so
  `npm run eval -- --live` was not executed and no live latency numbers exist.
  The command above is the one to run; `EVAL_REAL_KEY` or a real
  `GROQ_API_KEY`/`GEMINI_API_KEY`/`OPENROUTER_API_KEY` is required.
* **Cross-provider fallback is proven with a fake transport, not two live
  providers.** The unit tests answer Groq/Gemini/OpenRouter URLs themselves; the
  golden proves the fallback inside one provider's model list (a real timeout).
* **A real 70 KB PDF** is not in the repo; the golden uses a 70 KB text file,
  which exercises the same chunking and grounding paths. PDF extraction itself is
  unchanged.
* **Voice notes / vision** are unchanged by this pass and were not re-tested
  live.

## Known failures in `npm test` (all pre-existing, none caused by this pass)

| test | why |
|---|---|
| `.status <id> <state> … notifies the customer` | the sandbox clock is inside the Karachi quiet-hours window, so the customer message is deferred instead of sent |
| `the demo folder and the owner profile stay out of git` | `config/owner.json` is tracked in git (committed before this branch) even though it is in `.gitignore`; `git check-ignore` does not report tracked files. Worth fixing separately — a private profile should not be in the repo. |
| `this repository is clean, and its own scanner …` | the working tree is intentionally dirty: this whole phase is uncommitted, per instruction |

## Files changed in this pass

New: `src/core/replyGuard.js`, `src/core/scope.js`, `src/core/replyChannel.js`,
`src/services/languageStick.js`, `src/services/providerTrace.js`,
`test/57-fix-pass.test.js`, eleven golden scenarios under `test/golden/fix-*`.

Changed: `src/core/{llm,brain,toolCalling,pricing}.js`,
`src/services/{profile,documents,calls}.js`,
`src/handlers/{messageHandler,ownerCommands}.js`, `src/config/env.js`,
`src/eval/{run,model,assertions,index,report,scenarioSchema}.js`,
`config/owner.example.json` + the eight templates (`bot.firstPerson`),
`.env.example`.

Note: the eight templates and `owner.example.json` were re-serialised by the
edit (same data, expanded formatting), so their diff looks larger than the one
added key.
