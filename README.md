# 🤖 WhatsApp AI Assistant — multi-user edition

**A WhatsApp assistant that knows your business, remembers every client, hears voice notes, watches videos, scores leads, answers missed calls in chat, and survives bad internet. For $0/month — and one install can serve many different people, each with their own keys.**

Configured for **Hashir (+923169896229)** and **HasDevs** out of the box, but built so **anyone can be a user**: their own API keys, their own business profile, their own WhatsApp number, their own clients — fully isolated from everyone else's.

---

## Contents

1. [What it does](#what-it-does)
2. [Enable the bot — step by step](#enable-the-bot--step-by-step)
3. [Add your own API keys](#add-your-own-api-keys)
4. [Run it for several users (multi-user)](#run-it-for-several-users-multi-user)
5. [Make it *your* business](#make-it-your-business)
6. [Lead intelligence](#lead-intelligence)
7. [Languages](#languages)
8. [Missed calls](#missed-calls)
9. [Offline & bad internet](#offline--bad-internet)
10. [Team (several people, one inbox)](#team-several-people-one-inbox)
11. [Commands](#commands)
12. [Dashboard](#dashboard)
13. [Deploy for free](#deploy-for-free)
14. [Troubleshooting](#troubleshooting)
15. [Honest limitations](#honest-limitations)

---

## What it does

| Capability | How it works |
|---|---|
| **Self-knowledge** | Reads `config/owner.json` — services, prices, policies, portfolio, availability, FAQs, team. Answers about the business accurately and knows its own limits. |
| **Feels like a human** | Typing indicator, human pauses, 1–3 short bubbles, waits for a burst before replying, read receipts, no menus, no signatures, no "as an AI language model". |
| **86 languages** | Urdu, Hindi, Arabic, Persian, Bengali, Turkish, Russian, Chinese, Japanese, Spanish, French, German, Vietnamese, Swahili… detected from script + vocabulary, with register matching (formal vs casual). |
| **Hears voice messages** | Whisper transcribes with automatic language detection. |
| **Sees images and video** | Gemini vision for screenshots, mockups, invoices; native video understanding (or frames + audio track via ffmpeg). |
| **Takes project details** | A real discovery flow — one question at a time, never repeats, ingests PDF/DOCX briefs, scores completeness. |
| **Talks back** | Neural voice replies in the client's language on request, or when they use voice notes. |
| **Remembers everything** | SQLite: recent turns, rolling summary, structured facts, project state, quotes. Survives restarts. |
| **Scores leads** | 0–100 with reasons and a *next action* — who to call, who needs a budget question, who has gone cold. |
| **Catches missed calls** | Call rings out → after 60s the assistant answers **in chat**, in their language, by voice note or text. |
| **Never loses a reply** | Every outgoing message goes through an outbox: if the connection drops, it is queued and delivered when the line is back. |
| **Multi-user** | One install can run many businesses side by side — separate keys, config, sessions, databases, dashboards. |
| **Blocks groups & channels** | Hard rule in the router: groups, channels, broadcasts, status updates never reach the AI. |

---

## Enable the bot — step by step

This is the "just me" path: one business, one WhatsApp number, about 10 minutes.

### 0. What you need

- A computer that can stay on (laptop, PC, Raspberry Pi, or a free host later)
- **Node.js 20 or newer** — check with `node -v`
- A WhatsApp number for the bot (your own is fine; a spare number is safer)
- Free API keys ([next section](#add-your-own-api-keys))

### 1. Install

```bash
git clone https://github.com/hasxir-khan/Whatsapp-Ai-Agent.git
cd Whatsapp-Ai-Agent
git checkout arena/7e3e34a9-whatsapp-ai-agent   # or main, once merged
npm install
```

> `ffmpeg-static` is optional. If it installs, voice replies go out as real voice notes and videos get frame extraction. If not, install ffmpeg yourself (`sudo apt install ffmpeg`, `brew install ffmpeg`, or `winget install ffmpeg` on Windows).

### 2. Create your secrets file

```bash
cp .env.example .env      # Windows: copy .env.example .env
```

Open `.env` and set **at minimum**:

```env
MY_NUMBER=923169896229          # your WhatsApp number, international, no +
MY_NAME=Hashir
MY_BRAND=HasDevs
GROQ_API_KEY=gsk_...            # free — chat + voice transcription
GEMINI_API_KEY=AQ...            # free — images + video
```

### 3. Describe your business

Open **`config/owner.json`** and fill in your services, price ranges, payment terms, policies and FAQs. This file *is* the assistant's knowledge — the more real it is, the better every reply gets. ([details](#make-it-your-business))

### 4. Check everything

```bash
npm run doctor
```

Green ticks = ready. It verifies the config, your keys (live API calls), ffmpeg, the database and the session, and prints exactly what to fix.

### 5. Start it

```bash
npm start
```

- A QR code appears in the terminal **and** at `http://localhost:3000`
- On your phone: **WhatsApp → Settings → Linked devices → Link a device → scan**
- Prefer a code? Put `PAIRING_NUMBER=923169896229` in `.env`, restart, and type the 8-digit code WhatsApp shows

### 6. Try it

From another phone, send a normal message, a voice note, a screenshot, then *"how much for a store?"*.

From your own chat (message yourself): `.help`

### 7. Keep it running

- Leave the terminal open, or run it as a service:
  ```bash
  npm i -g pm2 && pm2 start src/index.js --name assistant && pm2 save
  ```
- Free hosts that wipe the disk: run `npm run session`, paste the output as `WA_SESSION`
- **Only ever run one copy per WhatsApp number** — two instances fight over the session and you get a QR loop

---

## Add your own API keys

Every user brings their own keys. Nothing is shared, nothing is billed, all three providers have free tiers.

| Key | What it powers | Where to get it (free) | Required? |
|---|---|---|---|
| `GROQ_API_KEY` | Chat brain + **voice-note transcription** | https://console.groq.com/keys | **Yes** — without it, voice notes can't be read and chat falls back to a placeholder |
| `GEMINI_API_KEY` | **Images, video, PDFs**, and chat fallback | https://aistudio.google.com/api-keys | Strongly recommended — without it the bot can't *see* |
| `OPENROUTER_API_KEY` | Backup vision models | https://openrouter.ai/keys | Optional |

How to add them:

1. Open `.env` in the project root.
2. Paste each key after the `=`, no quotes, no spaces.
3. Run `npm run doctor` — it calls each API and tells you if the key works, is rejected, or the model is missing.
4. Restart the bot (`Ctrl+C`, then `npm start`).

Model names (optional):

```env
GEMINI_MODEL=gemini-4-hydrogen            # images/video model chain starts here
GEMINI_VISION_MODEL=gemini-4-hydrogen
# GEMINI_AUTH_STYLE=bearer                # only if Google gives you a bearer-style key
```

Google now issues keys starting with `AQ.`; older `AIza…` keys still work. The key is always sent in a header, never in a URL.

> **Never commit `.env`.** It is gitignored. If you paste a key anywhere public, rotate it.

---

## Run it for several users (multi-user)

This is the part that makes the bot a *product*: one installation, many users. Each user gets their own folder with their own keys, business profile, WhatsApp session and database — they never see each other's clients.

### Create a user

```bash
node scripts/tenant.js new "Ayesha Designs" --number 923001112233
```

That creates:

```
tenants/ayesha-designs/
  .env                ← that user's API keys + number (private, gitignored)
  tenant.json         ← name, port, enabled flag
  config/owner.json   ← their services, prices, policies (starter file)
  data/               ← their database: clients, leads, memory
  sessions/           ← their WhatsApp login
  tmp/                ← media scratch
```

### Add their keys

```bash
node scripts/tenant.js keys ayesha-designs GROQ_API_KEY=gsk_...
node scripts/tenant.js keys ayesha-designs GEMINI_API_KEY=AQ...
node scripts/tenant.js keys ayesha-designs            # show what's set (masked)
```

Or edit `tenants/ayesha-designs/.env` directly — same result.

### Edit their business knowledge

`tenants/ayesha-designs/config/owner.json` — same schema as the main `config/owner.json`. The starter file ships with three example services; replace them with their real ones. **Prices the bot quotes come only from this file.**

### Start one user

```bash
node scripts/tenant.js show ayesha-designs          # status, paths, keys
node scripts/tenant.js show ayesha-designs --start  # start and scan the QR
```

### Start everybody at once

```bash
node scripts/run-all.js
```

- Each user runs in its own process, on its own dashboard port (`3001`, `3002`, …)
- Output is prefixed with the user's slug so logs stay readable
- One user crashing or being logged out does **not** touch the others — each restarts independently with backoff

### Manage users

```bash
node scripts/tenant.js list                 # who exists, keys, session, port
npm run users                               # same thing
node scripts/tenant.js show <slug>
node scripts/tenant.js rm <slug> --yes      # deletes their clients + session too
```

### Things worth knowing

- **One WhatsApp number per user.** Two installs on one number will disconnect each other.
- `tenants/` is gitignored — keys, sessions and client data never reach the repository.
- Each user has their own daily quota (`DAILY_LLM_CALLS`), their own outbox, their own follow-ups and their own daily brief.
- Running 5 users on one 1 GB box is fine; memory per process is mostly sql.js (~60–100 MB).
- To move a user to another machine: copy their `tenants/<slug>` folder (it contains everything, including the session).

---

## Make it *your* business

Everything factual lives in **`config/owner.json`** (per user: `tenants/<slug>/config/owner.json`). The schema — with every option documented — is `config/owner.example.json`.

```jsonc
{
  "owner": {
    "name": "Ayesha",
    "brand": "Ayesha Designs",
    "role": "Brand designer",
    "timezone": "Asia/Karachi",
    "bio": "I design and build online stores for clothing brands.",
    "availability": "Mon–Sat, 11:00–20:00",
    "services": [
      { "id": "store", "name": "Online store",
        "keywords": ["store", "shop", "ecommerce"],
        "min": 40000, "max": 120000, "days": "14–25",
        "includes": ["catalogue", "cart + checkout", "payments"] }
    ],
    "addons":      [ { "id": "seo", "name": "SEO setup", "min": 8000, "max": 15000, "keywords": ["seo"] } ],
    "payment":     { "terms": "50% advance, 50% on delivery", "methods": ["Bank", "JazzCash"] },
    "policies":    { "revisions": "2 rounds", "support": "30 days" },
    "portfolio":   [ { "name": "…", "desc": "…", "result": "…" } ],
    "faqs":        [ { "q": "Do you work internationally?", "a": "Yes…" } ],
    "escalateTopics": ["refund", "legal", "discount"],
    "friends":     [ { "number": "923001234567", "name": "Ali" } ],
    "team":        [ { "number": "923004445566", "name": "Bilal", "role": "support" } ]
  },
  "bot": {
    "name": "Ayesha's Assistant",
    "formality": "auto",          // auto | formal | casual
    "persona": "Warm, sharp, slightly informal…"
  },
  "currency": { "base": "PKR", "fxToPkr": { "USD": 280, "GBP": 355, "EUR": 305 } }
}
```

Rules that keep it safe:

- **The AI never invents a price.** It collects requirements; `src/core/pricing.js` computes the range from this file.
- **Add-ons** are attached when their keywords appear in the request.
- **Discounts** are capped by `maxDiscountPercent` (default 10%) — beyond that the chat is escalated to a human.
- **`escalateTopics`** hands the conversation to you instead of negotiating.
- **`friends`** get a casual, no-sales persona.
- **`team`** gets role-based access (see [Team](#team-several-people-one-inbox)).

---

## Lead intelligence

Every lead gets a **0–100 score**, the reasons behind it, and **one next action**.

What it measures:

| Signal | Weight | Why |
|---|---|---|
| Scope completeness | up to 30 | project type, goal, features, timeline, design, content |
| Budget stated + fits your range | up to 25 | the single best predictor of a real deal |
| Engagement | up to 10 | message count — do they actually talk? |
| Commitment | up to 14 | quote sent, negotiating, closed |
| Recency | +7 … −12 | silence is the biggest killer |
| Context | up to 3 | country/company known |

Bands: 🔥 **hot** ≥ 65 · 🌤️ **warm** 35–64 · ❄️ **cold** < 35.

The *next action* is deliberately concrete — not "follow up":

```
🔥 78 Emma Clarke — E-commerce Store · £220–£430 · quoted
    → Lock the start date and take the advance

🌤️ 52 Omar Al-Farsi — Mobile app · AED 8,000–15,000
    → Ask for a budget range

❄️ 21 Cold Guy — website
    → Nudge with one useful idea (no pitch)
```

Where it shows up:

- `.leads` — ranked, with scores and next actions
- `.lead 92300…` — full breakdown (what's good, what's risky)
- `.report` — "Do these today" list
- Dashboard — score and next action per lead
- Quote notifications — the score is attached the moment a quote goes out

---

## Languages

Detection is three-layered: Unicode script first (a Thai or Hebrew message is certain), then common-word voting (short WhatsApp messages are too short for statistics), then `franc` for long ambiguous text.

**86 language profiles**, each with a neural voice for replies:

- **South Asia** — Urdu, Hindi, Bengali, Punjabi, Gujarati, Marathi, Nepali, Sinhala, Tamil, Telugu, Kannada, Malayalam, Sindhi
- **Middle East / Central Asia** — Arabic, Persian, Pashto, Hebrew, Turkish, Azerbaijani, Kazakh, Uzbek, Kyrgyz, Tajik, Kurdish
- **Europe** — English, Russian, Ukrainian, Bulgarian, Serbian, Croatian, Polish, Czech, Slovak, Hungarian, Romanian, Greek, German, Dutch, French, Italian, Spanish, Portuguese, Catalan, Swedish, Danish, Norwegian, Finnish, Lithuanian, Latvian, Estonian, Albanian, Icelandic
- **Asia-Pacific** — Chinese (both scripts), Japanese, Korean, Vietnamese, Thai, Lao, Khmer, Burmese, Indonesian, Malay, Filipino, Mongolian, Tibetan
- **Africa** — Swahili, Amharic, Somali, Hausa, Yoruba, Igbo, Zulu, Xhosa, Afrikaans
- **Roman Urdu / Hinglish** — special-cased, because it borrows English tech words constantly

Register matters as much as language:

| Client writes | Bot answers |
|---|---|
| "Assalam o alaikum sir, kindly share the price" | formal — aap/آپ, no slang |
| "yaar kya haal hai, price batao" | casual — tum/yaar energy |
| "Bonjour madame, pourriez-vous…" | vous |
| "hey du, was kostet das?" | du |

Force one register with `bot.formality` if you prefer.

---

## Missed calls

**Honest version:** WhatsApp's Web protocol — the only free way in — lets a bot *see* calls but **not carry the audio**. Picking up and talking needs the official Cloud API, which is not part of the $0 stack.

What this bot does instead:

1. A client calls → you get *"📞 Incoming call from Emma."* instantly
2. Nobody answers within **60s** → the assistant messages them in **their** language and register:
   > "Hey — saw your call just now, sorry I couldn't pick up. This is HasDevs' assistant. Tell me here what you need and Hashir can call you back."
3. Sent as a **voice note** by default (feels like someone picked up) or text
4. They reply → the full intake/quote/memory flow continues
5. You get *"☎️ Missed call from Emma — assistant replied by voice note."*

```env
CALLS_ENABLED=true
CALL_FALLBACK_SECONDS=60          # 0 = instant, 600 = give yourself 10 minutes
CALL_FALLBACK_MODE=auto           # auto | voice_note | text
CALL_FALLBACK_TONE=auto           # auto | formal | casual
CALL_FALLBACK_MAX_PER_DAY=3       # never spam a butt-dial
```

Answered calls are left alone, groups are excluded, `.calls` lists what happened.

---

## Offline & bad internet

Two different problems, two honest answers.

**1. WhatsApp drops the connection for a minute.** This is the common one, and it is now handled:

- Every outgoing message goes through an **outbox** (`src/services/outbox.js`).
- If the send fails with a network/socket error, the message is stored in SQLite and retried automatically: right after reconnect, then every 25 seconds.
- Up to 5 attempts within 30 minutes; after that it is marked failed and logged, never silently lost.
- Permanent errors (blocked, logged out, invalid JID) are **not** retried — they surface immediately.
- Messages that arrived while the socket was down are delivered by WhatsApp when it reconnects, and the bot answers them then.

Check it any time: `.status` shows `Outbox: N queued`, and the dashboard has the same number.

**2. The whole process is off / the machine has no internet at all.** Nothing can answer while the bot isn't running — no software can reply from a powered-off laptop. What happens: the client's messages stay unread, and when the bot comes back online WhatsApp delivers them and the assistant replies in order. For 24/7 coverage, run it on a host that stays up (a $0 VPS or a Raspberry Pi).

---

## Team (several people, one inbox)

Add people in `config/owner.json`:

```jsonc
"team": [
  { "number": "923001112233", "name": "Ayesha", "role": "sales" },
  { "number": "923004445566", "name": "Bilal", "role": "support", "permissions": ["quotes"] }
]
```

| Role | Can do |
|---|---|
| `owner` | everything |
| `admin` | everything |
| `manager` | leads, chats, quotes, pause/resume, assign, reports, calls |
| `sales` | leads, chats, quotes, pause/resume, calls |
| `support` | chats, pause/resume, calls |

- A teammate messages the bot from their own WhatsApp → it answers as *their* assistant, not as a client bot
- `.takeover 92300…` assigns a chat to them and silences the bot there for 45 minutes
- `.assign 92300… Ayesha` (owner/manager) hands a chat over and pings her
- `.mine` → their queue · `.release 92300…` → back to the bot
- Escalations and quotes ping the **assigned** person, not just the owner
- Permissions are enforced in code; strangers get nothing

---

## Commands

Type in your own WhatsApp chat (message yourself):

| Command | What it does |
|---|---|
| `.help` | everything below |
| `.chats` | recent conversations with local time |
| `.leads [status]` | pipeline ranked by score, with next actions |
| `.lead 92300…` | full dossier: score, reasons, memory, project, quote |
| `.pause 92300… 60` | bot quiet in that chat for 60 min (works inside the chat too) |
| `.resume 92300…` | hand the chat back to the bot |
| `.block` / `.unblock` | spam control |
| `.reset 92300…` | clear project intake |
| `.quote 92300…` | rebuild and send a quote |
| `.team` | roster + workload |
| `.mine` | chats assigned to you |
| `.takeover 92300…` | assign a chat to yourself |
| `.release 92300…` | give it back to the bot |
| `.assign 92300… Ayesha` | hand a chat to a teammate |
| `.calls` | recent calls and what the bot did |
| `.report` | today's brief now |
| `.usage` | free-tier usage today |
| `.status` | providers, memory, outbox, ffmpeg, follow-ups |
| `.voice off\|request\|match\|always` | voice-reply behaviour |
| `.ai on\|off` | global kill switch |
| `.export` | JSON backup of contacts + leads |
| `.sync` | push leads to Google Sheets |
| `.id` / `.ping` | debugging |

Commands typed inside a client's chat are deleted right after they run — the client never sees them. Anything sensitive is owner-only.

---

## Dashboard

Each user gets their own dashboard (`http://localhost:<port>`):

- connection status, QR / pairing code
- contacts, messages, leads, follow-ups, **outbox queue**
- **client pipeline with score + next action**
- **team** card and **calls** card
- today's AI / vision / voice quota
- capability chips and a recent-activity feed

Endpoints: `/health`, `/api/status`, `/qr.png`.

See it with sample data before connecting anything:

```bash
npm run demo
```

---

## Deploy for free

**Your own PC** — `npm start`, keep the terminal open. Simplest and most reliable.

**Railway / Render / Koyeb / Fly free tier**

1. Push the repo to GitHub, create a **Web Service**
2. Build `npm install`, start `node src/index.js` (the `Procfile` says so)
3. Add env vars: `MY_NUMBER`, `GROQ_API_KEY`, `GEMINI_API_KEY`, optionally `PAIRING_NUMBER`, `PORT`
4. No persistent disk? Add `WA_SESSION` (from `npm run session`) so restarts don't need a QR
5. Multiple users on one host: either run `node scripts/run-all.js` (needs a persistent disk for `tenants/`), or deploy one service per user with their own env vars

**Raspberry Pi / old laptop** — ideal for 1–5 users; needs only outbound HTTPS.

Notes:

- Free tiers **sleep**; `PAIRING_NUMBER` + `WA_SESSION` make restarts painless
- `data/assistant.db` (or `tenants/<slug>/data/assistant.db`) is the memory — back it up with `.export`
- ffmpeg is what makes voice replies arrive as *voice notes*; install it on the host

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| QR keeps appearing | Another WhatsApp Web session took the account; delete `sessions/` (or `tenants/<slug>/sessions/`) and link once |
| Connection loop / `405` after scanning | `npm i @whiskeysockets/baileys@latest` |
| "Connection closed (401)" | Logged out — delete the session folder and re-link |
| Replies but no images described | `npm run doctor -- gemini`; check the key, then `GEMINI_VISION_MODEL` |
| "Gemini rejected the API key" | Revoked or restricted — mint a fresh `AQ.…` key |
| Voice notes not understood | `GROQ_API_KEY` missing, or the note exceeds `MAX_AUDIO_SECONDS` |
| Voice reply arrives as a file | No ffmpeg — install it |
| `.status` shows outbox queued | Normal during a dropout; it flushes on reconnect. Stuck? Check the number isn't logged out |
| Two users disconnect each other | They share a WhatsApp number — one number per user |
| Bot talks over me | It pauses 45 min after your manual reply; check `.resume` |
| Everything rate-limited | Free tiers reset daily; raise `DAILY_LLM_CALLS` only if your provider allows |

---

## Honest limitations

- **Baileys is an unofficial WhatsApp client.** Automating a personal number can get it banned. Use a spare number for anything valuable, or move to the official Cloud API.
- **Calls are answered in chat, not with audio.** WhatsApp Web carries no call audio; that requires the paid Cloud API.
- **The bot must be running.** Downloads, sleep and dead batteries mean unanswered messages until it's back — then they're answered in order.
- **AI can be wrong.** Facts and prices come from config, but free models occasionally phrase things badly. Watch the first week.
- **Free-tier data:** Gemini's free tier and Groq may use inputs to improve their services. Don't paste confidential material.
- **Edge TTS is an unofficial endpoint**; if Microsoft changes it, voice output degrades to text automatically.
- **Groups and channels are impossible by design** — not a bug.
- **Quotes are estimates**, not contracts.

---

## Privacy

- Everything lives on the machine running the bot: `data/` (or `tenants/<slug>/data/`).
- Media is downloaded to `tmp/` only while processing, and swept regularly.
- Nothing leaves the machine except the calls to your chosen AI providers.
- `.env`, `sessions/`, `data/`, `tenants/` and `config/owner.local.json` are gitignored.
- Each user's data is in their own folder — there is no cross-tenant query path.

---

## Project structure

```
config/
  owner.example.json    full schema + defaults
  owner.json            your business knowledge (edit this)
  countries.json        phone prefix → country / timezone / currency
src/
  index.js              boot, WhatsApp connection, reconnect, session restore
  server.js             dashboard + /api/status
  config/env.js         validated configuration, tenants, team, calls
  handlers/
    messageHandler.js   router: guards, media, intake, reply, quote, escalation
    ownerCommands.js    .help .leads .team .takeover …
  core/
    llm.js              Groq / Gemini / OpenRouter with model + quota fallback
    brain.js            persona, self-knowledge, language + register rules
    projectIntake.js    discovery state machine (persisted)
    pricing.js          deterministic multi-currency quotes
    humanizer.js        typing, delays, bubbles, quiet hours
  services/
    leads.js            lead scoring, next actions, pipeline summary
    outbox.js           offline queue: never lose a reply
    calls.js            missed-call rescue
    language.js         86 languages + register detection
    transcription.js  vision.js  video.js  documents.js
    tts.js  edgeTts.js  ffmpeg.js  media.js
    memory.js  followUps.js  report.js  sheets.js
    spamGuard.js  deletedMessages.js  geo.js
  utils/
    db.js               SQLite (sql.js): contacts, messages, leads, outbox, calls
    gemini.js           Gemini auth + error classification
    sessionBackup.js
scripts/
  tenant.js             create / inspect / delete users
  run-all.js            run every user at once
  doctor.js  simulate.js  seed-demo.js  session-backup.js
test/                   129 tests (node:test, no dependencies)
```

---

## Tests

```bash
npm test          # 129 tests: languages, leads, outbox, tenants, calls, router…
npm run doctor    # environment + live API checks
npm run chat -- --mock   # talk to the brain with no keys
```

---

## License

MIT. Use it for your own business or for other people's — but the people talking to it should know a bot may be answering.

Built for Hashir / HasDevs, and now for anyone who needs it.
