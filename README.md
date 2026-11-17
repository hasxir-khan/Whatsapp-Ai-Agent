# 🤖 WhatsApp Self-Knowledge Assistant

**An assistant that actually knows your business, remembers every client, listens to voice notes, looks at photos and videos, and sounds like a person typing — for ₹0 / $0 per month.**

Built for one specific job: running your client conversations on WhatsApp while you build. Configured for **Hashir (+923169896229)** and the **HasDevs** services, but everything about the business is in one JSON file you can edit.

---

## What it does

| Your requirement | How it's handled |
|---|---|
| **Self-knowledge** | Reads `config/owner.json` — your services, prices, policies, portfolio, availability, FAQs. Answers about you accurately instead of guessing. Knows its own limits too, and says "I can't do that" when it can't. |
| **Manages foreign clients** | Detects the client's country, timezone and currency from their number. Quotes in **GBP / USD / AED / SAR / EUR / PKR**, and schedules follow-ups inside *their* working hours. |
| **Feels like a real human** | Typing indicator, human-paced delays, answers split into 1–3 short bubbles, waits for a burst of messages before replying, read receipts, no "As an AI language model", no menus, no signature. |
| **Hears voice messages** | Whisper (Groq, free) transcribes them with **automatic language detection** — Urdu, English, Arabic, Spanish… no forced language. |
| **Views images** | Gemini vision (free tier) reads screenshots, mockups, designs, error screens, invoices. Falls back to OpenRouter if configured. |
| **Watches videos** | Native video understanding on Gemini (free tier); if that's unavailable it extracts frames with ffmpeg + transcribes the audio and describes both. |
| **Takes project details wisely** | A real discovery flow: one question at a time, never repeats, remembers what was already answered, can ingest a PDF/DOCX brief, scores completeness, and only quotes when the picture is clear. |
| **Sends voice messages** | On request ("send me a voice note"), or matching the client's habit — neural voices in 100+ languages, delivered as a real WhatsApp voice note. |
| **Sees previous chats** | SQLite memory with three layers: last ~16 turns, a rolling summary, and structured facts (company, budget, timeline, preferences). Restarts don't lose anything. |
| **Cannot access groups or channels** | Hard-blocked at the router: groups (`@g.us`), channels (`@newsletter`), broadcasts and status updates never reach the AI. |
| **Friends stay friends** | Numbers in `owner.friends` get a casual, no-sales persona — no discovery questions, no quotes. |

Plus the boring-but-essential bits: scam filtering that doesn't punish normal clients, "delete for everyone" alerts, daily brief to you, lead pipeline, Google Sheets export, and a live dashboard.

---

## The $0 stack

| Piece | Service | Free tier (enough for a solo business) |
|---|---|---|
| Chat brain | **Groq** (`gpt-oss-120b`, `llama-3.3-70b`) | ~1,000 requests/day, very fast |
| Speech-to-text | **Groq Whisper** | ~2,000 requests/day |
| Images + video | **Google Gemini** (AI Studio) | Free tier, generous daily requests |
| Voice replies | **Microsoft Edge neural TTS** | Free, no key |
| WhatsApp | **Baileys** (WhatsApp Web protocol) | Free |
| Memory | **SQLite** (sql.js) | Local file |
| Hosting | Your PC, or Railway/Render/Koyeb free tier | $0 |

You only need **one** key to start (`GROQ_API_KEY`). Add `GEMINI_API_KEY` for images/video.

---

## Quick start (10 minutes)

### 1. Install

```bash
npm install
```

> `ffmpeg-static` is an optional dependency. If it installs, voice replies go out as real voice notes and videos get frame-level analysis. If not, install ffmpeg yourself (`sudo apt install ffmpeg`) or use a host that has it.

### 2. Add your keys

```bash
cp .env.example .env
```

Open `.env` and paste at least:

```env
MY_NUMBER=923169896229
GROQ_API_KEY=gsk_...           # https://console.groq.com/keys  (free)
GEMINI_API_KEY=AQ...           # https://aistudio.google.com/api-keys  (free)
```

Gemini specifics:

```env
# Model used for images, video and (as a fallback) chat.
GEMINI_VISION_MODEL=gemini-4-hydrogen
GEMINI_MODEL=gemini-4-hydrogen
# If Google hands you a key that only works as a bearer token, say so:
# GEMINI_AUTH_STYLE=bearer      (default: key → x-goog-api-key header)
```

New AI Studio keys start with `AQ.` (the legacy `AIza…` format still works). The key always travels in a header, never in the URL. `npm run doctor -- gemini` checks it against the live API and tells you whether the key was rejected, the model is missing, or you hit a free-tier limit.

### 3. Check everything

```bash
npm run doctor
```

It verifies Node, config, both keys (against the live APIs), ffmpeg, the database and the session. Anything red comes with the exact fix.

### 4. Start

```bash
npm start
```

A QR appears in the terminal **and** on the dashboard (`http://localhost:3000`). On WhatsApp: **Linked devices → Link a device → scan**.

Prefer no QR? Put `PAIRING_NUMBER=923169896229` in `.env`, start the bot, and type the 8-digit code WhatsApp gives you.

### 5. Talk to it

Send a message from another phone. Try a voice note, a screenshot and a video. From your own number (message yourself) type:

```
.help
```

---

## First-run checklist

- [ ] `npm run doctor` is green
- [ ] Bot shows **online** on the dashboard
- [ ] A message from another number gets a human-sounding reply
- [ ] A voice note gets transcribed (check the log: `[voice note transcribed]`)
- [ ] An image gets described
- [ ] Typing "how much for a website?" produces a price range, not a guess
- [ ] Your own manual reply pauses the bot in that chat
- [ ] A group message is ignored (dashboard logs `ignored_chat`)

---

## Make it *yours* (this is the "self-knowledge" part)

Everything factual lives in **`config/owner.json`** (it overrides `config/owner.example.json`, which documents every field).

```jsonc
{
  "owner": {
    "name": "Hashir",
    "brand": "HasDevs",
    "role": "Full-stack developer & AI automation engineer",
    "availability": "Mon–Sat, 10:00–22:00 PKT",
    "bio": "I build websites, apps and AI automation...",

    "services": [
      { "id": "ecommerce", "name": "E-commerce store",
        "keywords": ["ecommerce", "store", "shop", "cart"],
        "min": 25000, "max": 75000, "days": "10–20",
        "includes": ["product catalogue", "cart + checkout", "payments"] }
    ],
    "addons":  [ { "id": "payments", "name": "Payment gateway", "min": 8000, "max": 18000, "keywords": ["stripe","jazzcash"] } ],
    "payment": { "terms": "50% advance, 50% on delivery", "methods": ["Bank","JazzCash","Wise","USDT"] },
    "policies": { "revisions": "...", "support": "...", "refund": "..." },
    "portfolio": [ { "name": "...", "desc": "...", "result": "..." } ],
    "faqs": [ { "q": "Do you work with international clients?", "a": "Yes..." } ]
  }
}
```

Rules that keep it safe:

- **Prices come from this file, never from the AI.** The model collects requirements, the code computes the range (`src/core/pricing.js`), the model only phrases it.
- **Add-ons** are added to the quote when their keywords appear in the request.
- **Discounts** are capped by `owner.maxDiscountPercent` (default 10%). Anything beyond that is escalated to you.
- **`escalateTopics`** (`refund`, `legal`, `discount`, `partnership`…) make the bot hand the chat to you instead of negotiating.

**Friends and family** go in the same file — they get a casual persona instead of the client/sales flow:

```jsonc
"friends": [
  { "number": "923001234567", "name": "Ali" }
]
```

Your existing friends from the previous version are already carried over in `config/owner.json`.

Tune the human feel in `.env`:

```env
DEBOUNCE_MS=2200        # how long it waits for the client to finish typing
HANDOFF_MINUTES=45      # after you reply yourself, the bot stays quiet this long
VOICE_REPLY_MODE=on_request   # off | on_request | match_voice | always
```

Language is automatic: the assistant mirrors whatever the client writes — English, Urdu script, Roman Urdu, Arabic, Spanish, Turkish, Hindi… (`src/services/language.js`).

---

## What a real conversation looks like

```
Emma (UK, +44…):  Hi! I saw your GitHub. I need an online store for my jackets brand.
Bot:              Hey 👋 Nice one. Are you selling within the UK only, or international too?

Emma:             UK for now. I need Stripe and a way to see orders without touching code.
Bot:              Got it — store + Stripe + an orders dashboard. Roughly how many products
                  to start, and when do you want it live?

Emma:             [voice note 0:14]  → transcribed: "Six products, six weeks, budget about £3,000."
Bot:              That fits. Let me put the scope and price together.

Bot:  ── quote card ──
      *E-commerce store*
      Sell jackets online in the UK

      *Included*
      • product catalogue
      • cart + checkout
      • payment gateway (Stripe)
      • order dashboard
      • Login / signup & roles

      *Price:* £220 (≈ PKR 61,600) – £430 (≈ PKR 120,400)
      *Timeline:* 10–20 days (a little longer with the extra features)
      *Stack:* Next.js · Node.js · PostgreSQL · Stripe

      Payment: 50% to start, 50% on delivery. Two revision rounds included.

Emma:             [screenshot of a competitor site] Can it look like this?
Bot:              That layout works well. Dark header, product grid of three, sticky cart —
                  all doable. Want me to match it closely or just take the ideas?
```

Meanwhile the owner gets:

```
🆕 New chat: Emma Clarke
+447700900123 · United Kingdom · GBP
“Hi! I saw your GitHub. I need an online store…”

💰 Quote sent to Emma Clarke
E-commerce store — £220 – £430
Goal: sell jackets online in the UK
Follow-up scheduled in 20h.
```

---

## Commands (type in your own WhatsApp chat)

| Command | What it does |
|---|---|
| `.help` | list everything |
| `.chats` | recent conversations with local time |
| `.leads [status]` | pipeline view |
| `.lead 92300…` | full dossier: memory, facts, project, quote, follow-up |
| `.pause 92300… 60` | bot goes quiet in that chat for 60 min (works inside the chat too) |
| `.resume 92300…` | hand the chat back to the bot |
| `.block` / `.unblock` | spam control |
| `.reset 92300…` | clear the project intake |
| `.quote 92300…` | rebuild and send a quote |
| `.report` | today's brief right now |
| `.usage` | free-tier usage today |
| `.status` | providers, memory, ffmpeg, pending follow-ups |
| `.voice off\|request\|match\|always` | change voice-reply behaviour live |
| `.ai on\|off` | global kill switch |
| `.export` | JSON backup of contacts + leads sent to you |
| `.sync` | push leads to Google Sheets |
| `.id` | chat JID (debugging) |

Commands typed inside a client's chat are deleted right after they run, so the client never sees them. Anything more sensitive than `.pause` is refused outside your self-chat.

---

## How it's built

```
WhatsApp ──▶ src/index.js (connection, reconnect, session)
                │
                ▼
        src/handlers/messageHandler.js
        ├── guards: groups / channels / status / owner / paused / spam
        ├── debounce burst → one turn
        ├── media pipeline
        │     ├── voice → services/transcription.js (Whisper, auto-language)
        │     ├── image → services/vision.js (Gemini → OpenRouter → Groq)
        │     ├── video → services/video.js (native → frames+audio → audio)
        │     └── doc   → services/documents.js (PDF/DOCX/TXT → brief)
        ├── core/projectIntake.js  (what we know, what to ask next)
        ├── core/pricing.js        (deterministic quote, multi-currency)
        ├── core/brain.js          (self-knowledge + memory + language mirroring)
        └── core/humanizer.js      (typing, delays, bubbles, quiet hours)
                │
                ▼
        utils/db.js  (SQLite: contacts, messages, facts, summaries,
                      intake, leads, follow-ups, usage, events)
```

Supporting services: follow-ups (`services/followUps.js`), daily brief (`services/report.js`), deleted-message watchdog (`services/deletedMessages.js`), Google Sheets (`services/sheets.js`), dashboard (`server.js`).

---

## Dashboard

`http://localhost:3000` (or your host's URL):

- connection status, QR / pairing code
- contacts, messages, leads, pending follow-ups
- **client pipeline** with quotes
- today's AI / vision / voice quota
- capability chips (chat, vision, voice in/out, video, ffmpeg)
- recent activity feed

Endpoints: `/health`, `/api/status`, `/qr.png`.

Want to see it with sample data before connecting WhatsApp?

```bash
npm run demo     # seeds ./data/demo and opens the dashboard in dry-run
```

---

## Testing without WhatsApp

```bash
npm run chat           # talk to the brain from your terminal
npm run chat -- --mock # no API keys needed at all
```

Inside the simulator: `/image photo.jpg`, `/voice note.ogg`, `/video demo.mp4`, `/doc brief.pdf`, `/state`, `/leads`, `/reset`.

```bash
npm test               # 95 tests: language, memory, intake, pricing, guards, router
npm run doctor         # environment + live API checks
```

---

## Deploy for free

### Option A — your own PC (most reliable, $0)

```bash
npm start
```

Keep the terminal open (or run it as a service). Your session lives in `./sessions`.

### Option B — Railway / Render / Koyeb free tier

1. Push this repo to GitHub, create a **Web Service**.
2. Build: `npm install` · Start: `node src/index.js` (the `Procfile` already says this).
3. Add environment variables: `MY_NUMBER`, `GROQ_API_KEY`, `GEMINI_API_KEY`, and optionally `PAIRING_NUMBER` + `PORT`.
4. If the host has no persistent disk, add `WA_SESSION` so you never re-pair:

   ```bash
   npm run session      # locally, after you're logged in → prints a blob
   ```

   Paste the blob as `WA_SESSION`. On boot the bot restores the session before connecting.

   ⚠️ That blob is full access to your WhatsApp account. Treat it like a password.

### Option C — anything with Node 20+

A Raspberry Pi, an old laptop, a $0 VPS. It only needs outbound HTTPS.

### Hosting notes

- Free tiers **sleep**. Use `PAIRING_NUMBER` + `WA_SESSION` so restarts are painless.
- Set `ENABLE_WEB=true` if the host requires an open port (most do).
- `data/assistant.db` is your memory. On hosts without a disk, add `.export` to your weekly routine.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| QR keeps appearing | Another WhatsApp Web session took over; delete `./sessions` and re-link one device only. |
| Connection loop / `405` right after scanning | WhatsApp changed its protocol. Update the client: `npm i @whiskeysockets/baileys@latest` (the code works with 6.x and the 7.x release candidates). |
| "Connection closed (401)" | Logged out. Delete `./sessions`, restart, scan again. |
| Replies but no images described | `GEMINI_API_KEY` missing or the model name is retired → `npm run doctor -- gemini`, then set `GEMINI_VISION_MODEL`. |
| "Gemini rejected the API key" | The key was refused, not the model: revoked, deleted, restricted to other APIs, or its project has no Gemini API enabled. Mint a fresh `AQ.…` key at https://aistudio.google.com/api-keys. |
| Gemini says model not found | Your key doesn't have that model. `npm run doctor -- gemini` lists what it does have; put one of those in `GEMINI_VISION_MODELS`. |
| Voice notes not understood | `GROQ_API_KEY` missing, or the note is longer than `MAX_AUDIO_SECONDS`. |
| Voice reply arrives as a file, not a voice note | No ffmpeg → install it, or `npm i ffmpeg-static`. |
| Bot talks over me | It shouldn't: your manual reply pauses it for `HANDOFF_MINUTES`. Check `.resume` wasn't needed. |
| Quotes look wrong | Edit prices in `config/owner.json`; the AI never invents numbers. |
| Everything is rate-limited | Free tiers reset daily; raise `DAILY_LLM_CALLS` only if your provider allows it. |
| Group chatter | It is blocked by design — check `/api/status` → `ignored_chat` events are expected. |

---

## Honest limitations

- **Baileys is an unofficial WhatsApp client.** Automating a personal account can get it banned. For anything business-critical, use a spare number or the official WhatsApp Cloud API. This project uses Baileys because it's the only $0 option.
- **AI can be wrong.** Prices, dates and policies are injected from config so the boring facts stay correct, but free models occasionally phrase things clumsily. Read the chats for the first week.
- **Free-tier data:** Google's free Gemini tier and Groq may use your inputs to improve their services. Don't paste anything confidential into a chat.
- **Edge TTS is an unofficial endpoint.** If Microsoft changes it, voice output fails gracefully to text.
- **Groups/channels are impossible by design**, not a bug.
- **Not a legal contract.** Quotes are ranges marked as estimates; final scope should be confirmed by you.

---

## Privacy

- All conversations, facts and leads live in `data/assistant.db` on your machine.
- Media is downloaded to `./tmp` only while processing and swept every 30 minutes.
- Nothing is sent anywhere except your chosen AI providers (Groq / Google / OpenRouter).
- `.env`, `sessions/`, `data/` and `config/owner.local.json` are gitignored.

---

## Project structure

```
config/
  owner.json            your business knowledge (edit this)
  owner.example.json    full schema + defaults
  countries.json        phone prefix → country / timezone / currency
src/
  index.js              boot, WhatsApp connection, reconnect, session restore
  server.js             dashboard + /qr.png + /api/status
  state.js              shared runtime state
  config/env.js         validated configuration
  handlers/
    messageHandler.js   router: guards, media, intake, reply, quote, escalation
    ownerCommands.js    .help .leads .pause .quote .report …
  core/
    llm.js              Groq / Gemini / OpenRouter with model + quota fallback
    brain.js            self-knowledge prompt, mood, escalation rules
    projectIntake.js    discovery state machine (persisted)
    pricing.js          deterministic multi-currency quotes
    humanizer.js        typing, delays, bubbles, quiet hours
  services/
    transcription.js  vision.js  video.js  documents.js
    tts.js  edgeTts.js  ffmpeg.js  media.js
    memory.js  followUps.js  report.js  sheets.js
    spamGuard.js  deletedMessages.js  geo.js  language.js
  utils/
    db.js  sessionBackup.js
  dev/mockLlm.js        offline fake provider for demos and tests
scripts/
  doctor.js  simulate.js  seed-demo.js  session-backup.js
test/                   95 tests (node:test, no dependencies)
```

---

## License

MIT. Do what you want — but use it on people who know a bot may be answering.

Built for Hashir / HasDevs. Powered by free tiers and a lot of patience with WhatsApp's protocol.
