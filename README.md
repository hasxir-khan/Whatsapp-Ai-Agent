# 🤖 WhatsApp AI Assistant — multi-user edition

**A WhatsApp assistant that knows your business, remembers every client, hears voice notes, watches videos, scores leads, answers missed calls in chat, and survives bad internet. For $0/month — and one install can serve many different people, each with their own keys.**

Configured for **Hashir** and **HasDevs** out of the box, but built so **anyone can be a user**: their own API keys, their own business profile, their own WhatsApp number, their own clients — fully isolated from everyone else's.


---

## Try it in 60 seconds — with your key, or without one

If you only want to see it work:

```bash
git clone https://github.com/hasxir-khan/Whatsapp-Ai-Agent.git
cd Whatsapp-Ai-Agent
npm install
npm run demo
```

Open **http://localhost:3111/inbox** and type in the *“Type as a customer”* bar at the top.

**If you have a free key, the demo uses it.** Put `GROQ_API_KEY=gsk_...` (or `GEMINI_API_KEY=AQ...`) in `.env` before `npm run demo` and every reply is generated live by the model, on exactly the same code path as a real number. The terminal says `Demo is up — real AI (Groq)` and the inbox bar shows the same.

**Without a key it still runs**, and says so plainly: the pipeline is real (language detection, catalogue, pricing, bookings, opt-outs, the inbox) and only the AI's wording is canned. Nothing costs a token and nobody needs a WhatsApp account either way.

Here is a real exchange from that page, not a mock-up:

```
you (as the customer):  table for 4 kal shaam 7 baje
assistant:              Done — Wed 18/11, 19:00. Booking #1. Reply "cancel" any time.

you:                    stop
assistant:              Understood — no more reminders from me. If you ever want them
                        back, just say "start".
```

Both of those are deterministic code, not the model: a real slot was checked, a real row was written, and the opt-out is honoured from the next message. Free-form questions ("delivery charges kya hain?") are where the model matters — with a key you get a written answer, without one you get a canned line and a note in the bar telling you how to turn the real thing on.

Or from a terminal, without a browser:

```bash
npm run chat -- --mock     # talk to the brain in your terminal
```

Everything the demo writes lives in `./demo` and is gitignored; delete the folder and it is gone. When you want the real thing, the next section is the one you want — a WhatsApp number and a free Groq key.

> Without keys the AI is a stub. Everything around it — catalogue, booking slots, follow-up timing, PDF invoices, the inbox, opt-outs — is the real code against a real database.

---

## Contents

1. [What it does](#what-it-does)
2. [Enable the bot — step by step](#enable-the-bot--step-by-step)
3. [Add your own API keys](#add-your-own-api-keys)
4. [Run it for several users (multi-user)](#run-it-for-several-users-multi-user)
5. [Make it *your* business](#make-it-your-business)
6. [Business setup — three ways](#business-setup--three-ways)
7. [Actions the bot can take](#actions-the-bot-can-take)
8. [Who answers: the manager agent](#who-answers-the-manager-agent)
9. [Bookings and follow-ups (Phase 3)](#bookings-and-follow-ups-phase-3)
10. [Closing, reviews and the weekly report](#closing-reviews-and-the-weekly-report)
11. [Win-backs, content and the growth dashboard](#win-backs-content-and-the-growth-dashboard)
12. [PDF quotes, invoices and receipts](#pdf-quotes-invoices-and-receipts)
13. [Learning from your own replies](#learning-from-your-own-replies)
14. [Switching to the official Cloud API](#switching-to-the-official-cloud-api)
15. [Lead intelligence](#lead-intelligence)
16. [Languages](#languages)
17. [Missed calls](#missed-calls)
18. [Offline & bad internet](#offline--bad-internet)
19. [Team (several people, one inbox)](#team-several-people-in-one-inbox)
20. [Commands](#commands)
21. [Dashboard](#dashboard)
22. [Deploy for $0 — the whole guide](#deploy-for-0--the-whole-guide)
23. [Troubleshooting](#troubleshooting)
24. [Honest limitations](#honest-limitations)

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
MY_NUMBER=923001234567          # your WhatsApp number, international, no +
MY_NAME=Hashir
MY_BRAND=HasDevs
GROQ_API_KEY=gsk_...            # free — chat + voice transcription
GEMINI_API_KEY=AQ...            # free — images + video
```

### 3. Describe your business

Three ways, easiest first — a 10-question wizard, an industry template, or a document you already have:

```bash
node scripts/tenant.js templates        # see the 8 industries first
```

For a single-business install, edit **`config/owner.json`** by hand, or copy any template over it:

```bash
cp config/templates/restaurant.json config/owner.json
```

This file *is* the assistant's knowledge — the more real it is, the better every reply gets. ([details](#business-setup--three-ways))

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
- Prefer a code? Put `PAIRING_NUMBER=923001234567` in `.env`, restart, and type the 8-digit code WhatsApp shows

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

### Check every user in one command

```bash
npm run doctor:all        # config, keys, services, session, ports, duplicate numbers
npm run doctor:live       # the same, plus real API calls with each user"s key
node scripts/doctor.js all --json   # machine-readable output for dashboards/CI
```

It catches the mistakes that actually break a fleet:

```
🩺 Fleet check — 3 users

  ✔ alpha-co    Ayesha Designs  +923001112233  port 3001  keys:GM services:4  session:yes db:148 KB
  ▲ beta-co     Bilal Studio    +923001112233  port 3002  keys:G· services:3  session:no  db:0 KB
      ↳ no GEMINI_API_KEY — it cannot see images or video
      ↳ not logged in — QR needed on first start
      ↳ same number as alpha-co — two bots on one number disconnect each other
```

Exits non-zero if anything is wrong, so it works in a deploy script.

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

## Business setup — three ways

The bot can sell **anything** — a restaurant menu, clinic appointments, salon services, property visits, or a six-figure agency project. What changes is one file: `config/owner.json` (per user: `tenants/<slug>/config/owner.json`).

### Method 1 — the wizard (10 questions)

```bash
node scripts/tenant.js setup <slug>
```

It asks for the business name, industry, city, languages, opening hours, price list, currency and the number to escalate to — then writes a valid profile and turns on the right flags.

```
2. What kind of business is it?
  1. 🍽️ Restaurant / Café   Menu, delivery, table bookings, daily specials.
  2. 🩺 Clinic / Doctor      Appointments, consultation fees, services, directions.
  …
```

Non-interactive (for scripts and CI):

```bash
node scripts/tenant.js setup burger-point --non-interactive --type restaurant --city Islamabad --currency PKR
```

### Method 2 — an industry template

```bash
node scripts/tenant.js templates                      # 8 industries
node scripts/tenant.js new "Burger Point" --number 923001112233 --template restaurant
```

| Template | Built for | Ships with |
|---|---|---|
| `restaurant` | cafés, bakeries, cloud kitchens | menu items, delivery rules, table booking |
| `clinic` | doctors, dentists, physios, labs | consultation fees, lab panels, emergency rules |
| `salon` | salons, barbers, spas | price list, bridal packages, cancellation policy |
| `real-estate` | dealers, developers, rentals | valuation, listing package, commission rules |
| `shop` | clothing, electronics, retail | products with stock, exchange policy, COD |
| `agency` | developers, designers, consultants | project ranges, retainers, process |
| `school` | schools, academies, tuition | admission, monthly fees, transport |
| `generic` | anything else | a sane starting point |

Template prices are **examples** — edit them before going live. A templated business keeps its whole price list in `catalog`, so there is exactly one place to change prices.

### Method 3 — feed it the documents you already have

```bash
node scripts/tenant.js learn burger-point ./menu.pdf
node scripts/tenant.js learn burger-point https://your-site.com/services
node scripts/tenant.js learn ayesha-designs ./price-list.txt --name "2026 price list"
```

Reads PDF, TXT, MD, CSV, DOCX and web pages, cleans the text, splits it into overlapping chunks and stores them in that user's database.

### How documents actually get used

Turn it on per business:

```
.set features.rag true
```

Then every incoming question runs a **hybrid search** over that business's documents:

| Side | How it works |
|---|---|
| **Vectors** | Chunks are embedded with Gemini's free embedding model; the question is embedded the same way and compared by cosine similarity |
| **Keywords** | BM25 over the stored chunks — always available, no key, no network |

The two are merged: an excerpt found by both methods outranks one found by only one. The top four excerpts go into the prompt **with their source labels**, plus one hard rule — *answer from these and the price list only; if the answer isn't there, say you'll check with the owner.*

```
── FROM THE BUSINESS'S OWN DOCUMENTS ──
[menu.txt §2] Delivery is free over 2000 PKR within five kilometres…
Answer from these excerpts and the price list only. If the answer isn't in
them, say you'll check with the owner — never guess a price, policy, stock
level, timing or discount.
```

If a factual question finds nothing, the bot is told to say it will check with the owner rather than invent an answer. A casual "haha nice 😄" gets no block at all.

**It can never break a reply.** No key, an expired quota, a dead network or a slow provider — anything that goes wrong falls back to keyword search (and if even that finds nothing, the reply goes ahead without any excerpt). Retrieval is time-boxed at 2.5 seconds.

**It only pays for what changed.** Every chunk stores the hash it was embedded from; re-ingesting a document re-embeds only that document's chunks, and untouched documents cost zero API calls.

```bash
node scripts/tenant.js learn <slug> ./new-menu.pdf     # learns + embeds it
node scripts/tenant.js learn <slug> --reindex          # embed anything pending
node scripts/tenant.js learn <slug> --reindex --force  # re-embed everything
```

Check the state any time with `.knowledge` on WhatsApp, or `node scripts/doctor.js business`.

Free-tier knobs (`.env`): `EMBEDDINGS=off` disables vectors entirely, `EMBED_RPM=60` caps requests per minute, `RAG_TOP_K=4` sets how many excerpts are injected, `RAG_MIN_SCORE=0.5` sets the similarity floor.

### Edit from WhatsApp

Turn on `.set features.ownerEditing true` once, then:

```
.set business.hours Daily 12:00–23:00
.set business.city Islamabad
.set tone.style warm and quick, like a good waiter
.addservice Garlic Mayo Dip | 150
.addservice Website | 60000-180000
.addfaq Do you deliver? | Yes, within 5 km, 45–60 minutes
.profile
.services
```

Every change is written to that tenant's `owner.json`, backed by an atomic write, and is **live on the next message** — no restart. `.profile`, `.services`, `.set`, `.addservice`, `.addfaq` and `.features` are owner-only.

### What the profile looks like

```jsonc
{
  "business": {
    "name": "Burger Point", "type": "Restaurant", "city": "Islamabad",
    "languages": ["en", "ur"],
    "hours": "Daily 12:00–23:00",
    "closed": "Never",
    "delivery": "Within 5 km, 45–60 minutes, free over 2,000 PKR",
    "about": "Fresh, cooked-to-order food. Halal."
  },
  "catalog": {
    "items": [
      { "name": "Zinger Burger", "kind": "product", "price": 650, "duration": 12, "stock": 25 },
      { "name": "Family Platter", "kind": "product", "price": 3200, "duration": 30, "stock": 8 },
      { "name": "Website", "kind": "service", "min": 60000, "max": 180000, "days": "10–21" }
    ]
  },
  "tone":       { "style": "warm and quick", "emoji": "light", "avoid": ["corporate language"] },
  "goals":      { "primary": "take the order", "secondary": ["upsell a drink"], "target": "order confirmed in under 5 messages" },
  "escalation": { "when": "a complaint about a wrong order", "number": "923001112233", "topics": ["refund"] },
  "policies":   { "delivery": "Free over 2,000 PKR", "payment": "Cash, card, JazzCash" },
  "faqs":       [ { "q": "Do you deliver?", "a": "Yes — within 5 km." } ],
  "features":   { "businessProfile": true, "catalog": true }
}
```

`price` is a fixed amount; `min`/`max` is a range. Both work everywhere — the quote engine never invents a number, and an item with `"stock": 0` is described as out of stock instead of being sold.

### Feature flags

Everything new is **opt-in and off by default**, so an existing install behaves exactly as before until you say otherwise. Flip one from WhatsApp (`.set features.catalog true`) or in `owner.json`.

| Flag | Phase | What it turns on |
|---|---|---|
| `businessProfile` | 1 | Business identity, hours, tone, goals, escalation in the prompt |
| `catalog` | 1 | Product catalogue + stock awareness |
| `knowledge` | 1 | Learned documents (ingesting works either way) |
| `ownerEditing` | 1 | `.set`, `.addservice`, `.addfaq` from WhatsApp |
| `toolCalling` | 2 | The five actions, with validation, confirmation and logging |
| `rag` | 2 | Hybrid retrieval: excerpts from learned documents in every reply |
| `managerAgent` | 2 | Intent router with specialist agents |
| `cloudApi` | 2 | WhatsApp Cloud API transport alongside Baileys (see [Switching to the official Cloud API](#switching-to-the-official-cloud-api)) |
| `bookingAgent` | 3 | Booking agent: real free slots, confirmations, reminders, reschedules, no-show rescue (alias `booking`) |
| `followUpAgent` | 3 | Follow-up agent: 24h/72h nudges, personalised, in the customer's language (alias `followUps`) |
| `growthApproval` | 3 | **On by default.** Drafts wait for `.approve` / `.skip`; turn off for auto-send |
| `closerAgent` | 3 | Objection handling, discounts within your cap, quote + payment details (alias `closer`) |
| `reviewAgent` | 3 | Feedback ask after a job, review link for 4–5 stars, referral codes (alias `reviews`) |
| `analystAgent` | 3 | Weekly owner report, computed from your own data (alias `analyst`) |
| `reactivationAgent` | 3 | Owner-approved win-back campaign, two cycles max (alias `reactivation`) |
| `contentAgent` | 3 | Weekly pack: 5 posts, 3 statuses, 1 reel idea (alias `content`) |
| `pdfInvoices` | 4 | A4 PDF quote/invoice/receipt, sent on WhatsApp (alias `invoices`) |
| `selfHealing` | 4 | Learns FAQ rules from your own manual replies (alias `healing`) |
| `liveInbox` | 4 | Read and answer every chat from a browser page (alias `inbox`) |
| `adminPanel` | 4 | Admin-only control panel for every tenant: create, profile, keys, QR, start/stop (alias `admin`) |
| `visualSearch` | 4 | Recognise a customer's photo against your own catalogue, locally and free (alias `visual`) |
| `closer` | 3 | Objection handling, payment links |
| `reactivation` | 3 | Monthly win-back for old clients |
| `reviews` | 3 | Review and referral requests |
| `content` | 3 | Weekly content ideas for the owner |
| `analyst` | 3 | Weekly performance report over WhatsApp |
| `injectionGuard` | 4 | Extra prompt-injection defence |

Check what a specific business has:

```bash
node scripts/doctor.js business      # validates the profile, catalog, flags and knowledge base
```

---

## Actions the bot can take

Until now the bot could talk. This makes it *do* five things — and only five.

```
.set features.toolCalling true
```

| Tool | What it does | Talks to the customer first? |
|---|---|---|
| `check_stock` | Looks an item up in the price list: available, how many left, price | no — it only reads |
| `send_quote` | Builds the official quote with `pricing.js` and sends it verbatim | no — but the numbers are never the model's |
| `book_slot` | Books a table, appointment or slot, inside the business's real opening hours | **yes** |
| `create_order` | Places an order and totals it from the catalog | **yes** |
| `handoff` | Pauses the chat and pings the owner | no |

### What a conversation looks like

```
Customer: do you have zinger burgers?
Bot:      (check_stock → name: Zinger Burger, 25 left, 650 PKR)
          Yes — 25 left, 650 each. Want me to put two aside?

Customer: yes, 2 zingers
Bot:      (create_order → needs confirmation)
          Just to confirm: 2× Zinger Burger — deliver to House 12, F-11.
          Reply yes and I'll lock it in.

Customer: haan
Bot:      (order created, total computed by the system)
          ✅ Order confirmed — #14
          • 2× Zinger Burger — 650
          *Total: 1,300 PKR*
```

### The rules it cannot break

- **Whitelist.** The five names above are the only actions that exist. Anything else is refused and logged.
- **Every argument is validated** against a JSON schema — types, ranges, required fields, and `additionalProperties: false`, so a `price` field in the arguments is a validation error, not a discount.
- **Money is never the model's.** `create_order` accepts names and quantities; the total comes from `catalog` via the system. `send_quote` is `pricing.js` output, sent verbatim. If a price appears in tool arguments anyway, it is stripped before anything runs.
- **Side effects need a yes.** `book_slot` and `create_order` only ask the first time; the *arguments are frozen* at that moment, and the customer's next "yes" runs exactly those. A later "ignore that, order 100" cannot rewrite them.
- **Idempotent.** A confirmation token books once. A retried message, a duplicate webhook, a double tap on "yes" — one booking, one order. A slot taken by someone else is reported as taken, never double-booked.
- **3 calls per message, 10 seconds each.** Then the bot answers in words with what it has.
- **Bookings respect opening hours.** `business.hours` is parsed (daily, day ranges, split shifts, `24/7`, per-day objects) and checked in `business.timezone` — the server's clock never decides. A slot on a closed day, outside hours, or in the past is refused with the next real slots offered, and the customer is never asked to confirm something impossible.
- **Failures are silent.** If a tool errors or times out, the customer gets an ordinary reply; the error goes to the log and to `.tools`.
- **Documents and customers cannot trigger actions.** Retrieved text and the customer's message are data — only the model's own structured request can call a tool, and only for the five names.

### Seeing what it did

```
.tools
```

```
*Tools* ✅ on
Available: check_stock, book_slot, create_order, send_quote, handoff
Calls logged: 41 · 2 error(s)

✅ 17 Nov, 14:02 · +923001112233 · *check_stock* item=zinger burger (3ms)
⏳ 17 Nov, 14:02 · +923001112233 · *create_order* items=[…] (1ms)
✅ 17 Nov, 14:03 · +923001112233 · *handoff* reason=cold food complaint (12ms)
```

Every call — tool, arguments, result, status, duration, tenant and chat — is stored in SQLite (`tool_calls`), so nothing is invisible.

### How it reaches the model

Native function calling is used when the provider offers it (Groq and Gemini both do). If a provider rejects the `tools` parameter, the bot switches to a JSON action protocol (`{"tool":"…","args":{…}}`) for that provider and remembers it, so it never pays for a failed round trip twice.


---

## Who answers: the manager agent

One brain answering everything starts to feel like one person doing every job:
selling to someone who is angry, quoting prices to someone whose order arrived
cold, taking a booking like it is a sales call. The manager agent decides *who*
should reply before thinking about *what* to say.

```
.set features.managerAgent true
```

Five intents, five specialists. They all share the same persona, the same
language rules, the same memory and the same learned documents — only the job
and the tools change.

| Intent | Agent | What changes | Tools it may use |
|---|---|---|---|
| sales | 💬 Sales | Qualify, quote, move to an order | check_stock, send_quote, create_order, book_slot, handoff |
| support | 🛠️ Support | Solve first, sell nothing | check_stock, handoff |
| booking | 📅 Booking | Get what/day/time, confirm against real hours | check_stock, book_slot, handoff |
| complaint | 😟 Complaint | Stop selling, apologise once, hand to you | handoff |
| other | 🤖 General | Exactly the bot you had before | all five |

### How it decides (and why it is cheap)

1. **Rules first.** Keywords in English, Roman Urdu and Urdu script, plus the
   angry-tone detection that already existed. `"burger ki price kya hai?"` is
   sales without spending a token. Roughly the whole of ordinary traffic stops
   here.
2. **Remembered per conversation.** If the router ever had to think, the answer
   is kept for that chat for 15 minutes, so a long conversation does not pay
   for a router call on every message.
3. **The model last.** Only when the rules are genuinely unsure — no keyword
   hit, or two intents neck and neck. A tiny model, one word out, three-second
   leash.

**Routing can never cost a reply.** If the router times out, errors, or hits a
rate limit, the message goes to the plain brain and the customer never notices.

### A complaint, end to end

```
Customer: this is the third time my order is late, honestly useless service
Bot:      I'm sorry — three times is not a mistake, that's a pattern.
          Can I ask which order number it was? I'm passing this to the owner
          himself, he'll look at it today.
```

…and in your own chat:

```
😟 Complaint — +923001234567
They said: "this is the third time my order is late, honestly useless service"

Name: Ali · 3 orders · PKR 4,200 lifetime · last seen 2 min ago
```

No prices, no "anything else I can get you", no defending the business. The
complaint agent cannot even see the quoting tool.

### Seeing what it decided

```
.intents
```

```
*Intents today* — 34 messages
Routing: ✅ on (managerAgent)
💬 *Sales* — 19
🛠️ *Support* — 8
📅 *Booking* — 5
😟 *Complaint* — 2

Decided by: 29 rules · 4 remembered · 1 model · 0 default
⚠️ 2 complaints — check your notifications.
```

`.status` carries a one-line summary too, and every routing decision goes into
the `message_intents` table if you want to look at it later.

### Turning it off

```
.set features.managerAgent false
```

Back to one brain, immediately. Nothing is lost — the log stays, the tools stay,
the flag is the only switch.


---

## Bookings and follow-ups (Phase 3)

Two agents that act on their own — carefully, and only when you switch them on.

```json
"features": { "bookingAgent": true, "followUpAgent": true }
```

`growthApproval` is **true** by default: the follow-up agent writes the message but sends it to *you* first, and nothing reaches the customer until you type `.approve 12`. When you trust it, `.set features.growthApproval false` and it sends directly.

### The booking agent

A customer says *"kal 8 baje table chahiye"* or *"can I come in on Tuesday at 3?"* and the agent:

- reads their day and time in **their** language — Roman Urdu, Urdu, English, and "tomorrow"/"kal"/"کل" all work;
- checks the day against your opening hours (`.set business.hours Mon–Sat 10:00–21:00`), your timezone, and every slot already booked;
- offers **2–3 real free slots** as a numbered list when the time they asked for is taken or closed;
- confirms in one line and writes the booking down — SQLite, plus your Google Sheet if it's connected;
- sends a reminder **24 hours** and **2 hours** before;
- if they don't turn up, sends **one** polite "want to try another time?" and then leaves them alone;
- lets them reschedule or cancel by chat — the slot is free the same second.

```
you: can I get a table tomorrow at 8?
bot: Done — Table for 4, Wed 4/6 at 20:00. See you then! 🙌
```

Owner side: `.bookings` for today and tomorrow, `.cancel 12` to kill one. Times are always shown in your business timezone, never UTC.

Optional: mirror bookings into Google Calendar. Add `GOOGLE_CALENDAR_ID` plus either a service-account JSON file (`GOOGLE_SERVICE_ACCOUNT_FILE`) or the OAuth trio (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`). **Without credentials nothing breaks** — the booking is written to SQLite and the Sheets sync as usual, and the calendar step is simply skipped.

### The follow-up agent

A lead goes quiet after a quote or a question. After **24 hours**, and once more after **72**, this agent writes one short message that proves someone was listening:

> Hi Ali — you asked about delivery to F-7 and the Zinger Burger is PKR 650. Shall I put an order aside for you?

The rules it cannot break:

- only leads scoring at or above `GROWTH_MIN_SCORE` (default 40);
- **at most two** follow-ups, then the lead is marked cold — permanently;
- it quotes a price **only** if that item is in your catalogue;
- it writes in the customer's language, using their history — never a template;
- it stops instantly if they reply, opt out, or you pause / take over the chat.

### The safety layer (both agents)

Every proactive message — reminders, nudges, win-backs — goes through one gate before it can leave:

| Check | Default | Where to change it |
|---|---|---|
| Opt-out is honoured forever | — | they type "stop" / "band karo" / "مت بھیجو" |
| Quiet hours, in *your* timezone | 21:00–09:00 | `GROWTH_QUIET_START` / `GROWTH_QUIET_END` |
| Per person | 1 message / 24 h | `GROWTH_CONTACT_CAP` |
| Per day, whole assistant | 30 (12 on Baileys) | `GROWTH_DAILY_CAP` / `GROWTH_BAILEYS_CAP` |
| Cloud API 24-hour window | templates only | [see above](#4-the-24-hour-rule-the-part-that-surprises-people) |

Anything blocked is **logged with the reason** (`quiet_hours`, `contact_cap`, `window_closed`, …) — `.growth` shows today's sends per agent and `.status` shows the window. Nothing ever fails silently.

Booking reminders count as transactional: they ignore the one-per-24h limit, but never quiet hours, an opt-out, or the daily ceiling.

---

## Closing, reviews and the weekly report

Three more agents, each behind its own flag, all sharing the same safety layer from the chapter above.

```json
"features": { "closerAgent": true, "reviewAgent": true, "analystAgent": true }
```

### The closer — the four objections that lose sales

Customers say the same four things before they either buy or vanish: *it's too expensive*, *how do I know you're real*, *I'll think about it*, and *someone else is cheaper*. The closer answers each one with something true from **your** profile — a catalogue price, a guarantee you wrote down, an FAQ — then asks one question.

It recognises them in English, Roman Urdu and Urdu:

| They say | It answers with |
|---|---|
| "mehnga hai", "too expensive", "مہنگا ہے" | the real price, then what is included |
| "bharosa nahi", "is this a scam?", "بھروسہ" | your refund or guarantee policy, verbatim |
| "sochta hoon", "baad mein", "سوچتا ہوں" | no pressure — an offer to hold the slot |
| "kisi aur se sasta", "someone else is cheaper" | a fair comparison, not a put-down |

**Discounts are the part people get wrong**, so the rules are in code, not in a prompt:

- no `policies.maxDiscountPercent` in `owner.json` → **no discount is ever offered**; a customer who asks for one gets "that's the owner's call" and you are told
- with a cap → it may offer up to that cap and not a rupee more
- above the cap → handoff to you, every time

**Two attempts per objection, then a person.** The third "still too expensive" gets you, not another pitch. No countdown timers, no "last chance", no fake scarcity — the tests fail if those words appear.

When they say yes ("order kar do", "I'll take it", "how do I pay") the closer sends the quote, then the payment details from `business.payment`:

```json
"payment": {
  "bank": { "name": "Meezan", "title": "Burger Point", "number": "0123456789" },
  "jazzcash": { "number": "03001234567" },
  "easypaisa": { "number": "03451234567" },
  "stripeLink": "https://buy.stripe.com/…",
  "cod": true
}
```

Only the fields you fill in are ever mentioned. The order lands as **awaiting payment** — never "paid".

**Receipts are evidence, not proof.** If a customer sends a transfer screenshot, the bot reads it, forwards what it read to you with `.paid 12` as the next step, and confirms to the customer that *you* will verify. It cannot mark an order paid; only `.paid` does that.

### The review and referral agent

When a job is finished — `.done 12` on a booking, or an order marked delivered — the bot waits `REVIEW_AFTER_HOURS` (24 by default) and asks one short question in the customer's language: *how did we do, 1 to 5?*

What happens next is the whole point:

| Their answer | What the bot does |
|---|---|
| 4–5 | thanks them, sends `business.reviewLink`, and — once ever — invites them to refer someone with their own code |
| 1–3 | **never sends the review link.** Thanks them, and sends you the score with their exact words so you can fix it yourself |

One ask per finished job, honoured opt-outs, quiet hours, and no ask at 11 pm.

**Referral codes** are short and stable (`BP3F2K` for one customer, forever). When a stranger's first message mentions a code, the lead is tagged `referral`, the code's owner is credited, and you get a message saying who sent whom. Rewards are mentioned only if you configured one:

```json
"referral": { "reward": "10% off your next order" }
```

Leave `reward` empty and the bot tracks referrals without promising anything.

### The analyst — numbers first, suggestions second

Every Monday at 09:00 (`ANALYST_DAY`, `ANALYST_TIME`, in your timezone) you get one message with last week's real numbers, and how they compare to the week before:

- conversations, replies, average first-response time
- new leads, split by where they came from (including referrals)
- bookings made and completed
- orders and revenue, priced from your catalogue
- follow-ups sent vs answered
- opt-outs, complaints, review scores
- the busiest hours of your week
- questions the bot **could not answer** from your knowledge base

Those figures are computed in SQL and JavaScript. The model is only ever asked to write **three** suggestions on top of them — and if the week had fewer than five conversations, it says *"quiet week, too small to call a trend"* instead of inventing insight. No API key at all? You still get three suggestions, derived from the numbers deterministically.

`.report week` gives you the same report on demand; `.report` is still the daily brief.

---

## Win-backs, content and the growth dashboard

The last two agents are the ones that touch people you haven't heard from in a while, so they are the most careful.

```json
"features": { "reactivationAgent": true, "contentAgent": true }
```

### The reactivation agent — three segments, two cycles, six months

Once a month (or whenever you feel like it) the bot can go back to:

| Segment | Who | Rule |
|---|---|---|
| Past customers | a booking marked `.done`, an order paid or delivered | the job must be older than `REACTIVATION_AFTER_DAYS` (45) |
| Cold leads | never bought, quiet for the same period | anyone who replied since the last nudge is excluded |
| Dates | birthday / anniversary **the customer told you** | only from facts they shared, never guessed |

Nothing is sent until you approve it, and the approval is a real one:

```
you: .campaign preview
bot: 📣 Reactivation preview
      Audience: 23 people (21 sendable right now)
      • past customers: 15
      • cold leads: 8
      Sample: "Hi Ayesha — it's been a while. 10% off your next order this month. Can I set anything up for you?" → +92300…
      .campaign send to start · .campaign stop to halt

you: .campaign send
```

Then it sends **slowly** — one message at a time, with a random gap of 2–7 minutes, inside quiet hours, inside the daily cap, and never to someone who opted out. On Baileys that cap is 12 a day, and it is not raised for campaigns.

The message itself uses only what you wrote: `business.offers` first, then the catalogue, then a policy line. If there is no offer configured, the message mentions a real product at its real price — never a discount you did not authorise.

**Two cycles without a reply and the customer rests for six months.** If they reply at any point, they are warm again and the campaign leaves them alone.

On the Cloud API, anything outside the 24-hour window needs an approved template (`CLOUD_TEMPLATE_NAME`). If no template is configured the send is **skipped and recorded** — `.growth` tells you it was held and why, instead of the message vanishing.

### The content agent — a week of posts you can actually use

Every Wednesday at 10:00 (`CONTENT_DAY`, `CONTENT_TIME`), or immediately with `.content now`, you get:

- **5 post captions** — real catalogue items with real prices, your own offers, and the questions customers actually asked this month
- **3 WhatsApp Status lines** — short enough to read on a phone in two seconds
- **1 reel idea** — something filmable with a phone, no editing skills
- **Hashtags** from your business name, city and type, plus **posting times** that suit what you sell (a restaurant gets 12:30/19:30/21:00; a clinic gets 09:30/13:00/18:00)

The honesty rule is enforced in code: prices, offers and questions all come from config or from your own data, and customer questions are neutralised before they reach the model. There are no invented testimonials, no fake reviews, no "500 happy customers". Without an AI key you still get a full pack — blunter, but every word of it true.

### The growth dashboard

Your dashboard (`http://localhost:3000`) now has a growth section, and `/api/growth` returns the same data as JSON:

- **Funnel**: conversations → leads → quotes → orders → paid → reviewed, with conversion at each step
- **Per agent**: sent, replied, converted, opt-outs, and why the rest were skipped or held
- **Sources**: QR, link, referral, ad tag, direct — with revenue per source

Tag a QR sticker or an ad link by putting `#qr`, `#link` or `#ads` in the first message a customer sends. Their first tag sticks forever; later ones are ignored.

It is read-only, it shows no phone numbers, no keys and no message content. If the dashboard is reachable from the internet, **set a token**:

```bash
DASHBOARD_TOKEN=something-long
# then open http://your-server:3000/?token=something-long
```

With no token set it behaves exactly as before (`/health` and `/api/status` stay open for uptime checks).

---

## PDF quotes, invoices and receipts

Turn it on and every quote and order leaves a document behind:

```json
"features": { "pdfInvoices": true }
```

```
you (customer): theek hai, order confirm
bot: [the quote text]
bot: [INV-2026-0007.pdf]  Invoice (unpaid) · HasDevs Cafe · Total: PKR 2,800
```

**The label is the honest part.** No order yet is a **Quote**. An order that is `awaiting_payment` or `placed` is an **Invoice (unpaid)**. Only after you type `.paid 12` does it become a **Receipt**. The footer says "Not a tax invoice" unless you replace it.

**Every number comes from the order row or `core/pricing.js`.** The AI never touches it. Item lines are `qty × unit price`, and if the total you charged disagrees with the lines (a discount, a delivery fee), the difference is printed as its own line rather than either number being quietly rewritten.

**Payment details come from `business.payment`, and only the fields you filled in.** A blank JazzCash number is not printed; neither is a `//` comment. Bank, JazzCash, Easypaisa, a payment link, cash on delivery — whichever you actually configured:

```json
"payment": {
  "bank": { "name": "Meezan Bank", "title": "HasDevs", "number": "01234567890123" },
  "easypaisa": { "title": "HasDevs", "number": "03001234567" },
  "cod": false
}
```

**Your logo, your footer, your prefix:**

```json
"invoice": {
  "logo": "config/logo.png",
  "prefix": "HD",
  "footer": "Shukriya! HasDevs Cafe — 0300 1234567"
}
```

Without a logo the header is just text — nothing breaks. `INVOICE_KEEP_DAYS` (90) sweeps old PDFs; the order row remains the record, so nothing is ever lost.

### What happens when a customer speaks Urdu

This is where most "we support Urdu" claims fall apart, so here is exactly what this does.

The PDF embeds **Noto Sans** for Latin and Roman Urdu, and **Noto Naskh Arabic** for Arabic script. Both are bundled and subsetted (253 KB total), so the document looks the same on a server with no fonts installed.

- **Text that can be shaped and reordered** — standard Arabic, like the name `محمد علی` — is shaped into joined letter forms and drawn right-to-left. It looks correct.
- **Everything else** — which includes most Urdu, because Urdu's own letters (ٹ ڈ ڑ ں ھ ہ ے ک گ چ پ) have no isolated/joined codepoints in Unicode, and pdfkit has no bidi engine — is **transliterated into Roman Urdu**: `چکن کڑاہی` becomes `chkin krahi`.

Mirrored or disconnected Arabic is never printed. That is not a font bug you can install your way out of; it is what pdfkit can do without an OpenType shaper plus bidi, and pretending otherwise would put a broken document in front of your customer. If an item has a proper Roman name, use it — the transliteration is a fallback, not a translation.

### Commands and failure behaviour

```
.invoice 12          → build and send it to yourself
.invoice 12 send     → deliver it to the customer
```

The text quote always goes out **first**. The PDF is an attachment after it, so a missing font, a corrupt logo, a disk error or a transport that cannot send files costs the customer nothing — the failure is logged with its reason (`invoice_fallback`, `invoice_render_failed`) and the text answer stands.

---

## Learning from your own replies

Your best training data is the moment you type an answer yourself right after the bot got it wrong.

```json
"features": { "selfHealing": true }
```

That is all it takes. When you reply manually in a customer chat within 30 minutes of a bot reply, and your answer means something different, the exchange becomes **one candidate rule**:

```
🧠 New rule learned (#4)

Q: do you deliver to f 11
A: F-11 tak delivery hoti hai, 30 minute mein

Type .approve-rule 4 or .reject-rule 4
```

`Q` is the customer's actual question, so the rule matches how people really type. `A` is your answer.

**Nothing is applied until you say yes.** `.approve-rule 4` adds it through the same path as `.addfaq`, and it applies from the next customer message. `.reject-rule 4` marks it rejected and it is never proposed again — not for that question, not for a similar one.

What is stripped or refused before you ever see it:

| Check | What happens |
|---|---|
| Phone numbers, emails, links | removed |
| The customer's name | removed (we know it from the contact) |
| Addresses ("House 42, Street 7, F-11") | removed |
| Instruction-shaped text ("always tell customers…", "ignore previous…") | the rule is refused outright |
| A price that is not in your catalogue | refused — a learned rule can never invent a price |
| A discount above `policies.maxDiscountPercent` | refused |
| A question already covered by an FAQ | not proposed |
| You repeated what the bot said | not proposed; there is nothing to learn |

Limits: **3 proposals a day** (`SELF_HEALING_MAX_PER_DAY`), at most 10 waiting at once, and only chats where *you* replied — it never watches customer messages and never learns on its own. `SELF_HEALING_WINDOW_MINUTES` (30) decides how soon after the bot your reply counts as a correction.

`.rules` shows what is waiting. Rules approved today are ordinary FAQs tomorrow — review them with `.features` like anything else.

The notice goes to `MY_NUMBER`, so that number has to be real: if it is still the placeholder (`920000000000`), proposals are stored and you are never told — `npm run doctor` warns about exactly that, and the PDF rules are checked the same way (empty `business.payment`, a logo path that does not exist).

---

## Visual search — "is this something you sell?"

A customer sends a photo of a dish, a shoe, a hair colour. With this on, the bot
recognises it against **your** catalogue images and answers with your name,
your price and your stock — locally, on your machine, at $0 per lookup.

```bash
npm install @xenova/transformers          # optional dependency, ~90 MB model on first use
```

```json
// config/owner.json
"features": { "visualSearch": true },
"catalog": { "items": [
  { "name": "Chicken Karahi", "price": 1350, "stock": 5, "image": "menu/karahi.jpg" },
  { "name": "Zinger Burger",  "price": 650,  "stock": 0, "image": "menu/zinger.jpg" }
] }
```

```bash
node scripts/tenant.js index-images <slug>    # or npm run index-images, or the admin panel button
```

How it behaves, by score (cosine similarity between two CLIP vectors):

| Score | What the customer gets |
|---|---|
| ≥ `VISUAL_HIGH_THRESHOLD` (0.88) | "*Chicken Karahi* — PKR 1,350 · 5 in stock." Name, price and stock straight from the catalogue |
| ≥ `VISUAL_LOW_THRESHOLD` (0.78) | the top 3 with prices, and a question: which one did you mean? |
| below | "I'm not sure which of our items this is, so I won't guess" — plus a way to say the name or reach a human |

The thresholds are a starting point, not a law: run `index-images` on your own
photos, look at how close your own products sit to each other, and move them.

**Out of stock is out of stock.** If `stock` is `0` the reply says so; if you
never set `stock`, the bot does not invent a number.

### What it will not do

- **Nothing leaves the machine.** The model runs here; the photo is embedded in
  memory and dropped. It is never written into the catalogue, never uploaded to
  a vision API, and any stray temp file is swept hourly.
- **It does not guess.** Similar-looking products (two black t-shirts, two
  chicken dishes) will land in the "which one?" band, which is the honest answer.
- **Lighting and packaging cost accuracy.** A photo taken in a dark room, or of
  a competitor's packaging, may fall below the low threshold. That is a good
  outcome: an "I'm not sure" beats a wrong price.
- **The paid path is still there.** If `@xenova/transformers` is missing, the
  model cannot download, or the box has no RAM, every photo falls through to
  your existing Gemini vision provider — the feature degrades, it never blocks a
  reply.

### Cost on the box

- ~90 MB downloaded once (quantised CLIP ViT-B/32), then cached.
- ~800 MB RAM while loaded, in the process that uses it.
- One embedding job at a time, 20 s timeout, 8 MB image limit, and
  `VISUAL_SEARCH_DAILY_CAP` (300) lookups per tenant per day.
- `npm run doctor` prints the estimate, warns if the package is missing, if a
  catalogue image cannot be read, if an image path escapes the tenant folder, or
  if your thresholds are the wrong way round.

---

## The admin panel

One page that runs the whole box: every tenant you host, with its status, its
profile, its keys and its QR. It is **off by default and admin-only**, because it
can create and delete tenants — a leaked link here is a leaked fleet, not a
leaked conversation.

```bash
# .env
ADMIN_TOKEN=$(openssl rand -hex 24)   # its own secret, never DASHBOARD_TOKEN
```

```json
// the tenant's config/owner.json
"features": { "adminPanel": true }
```

Then open `http://localhost:3000/admin` and paste the token. What is there:

| Tab | What it does |
|---|---|
| Tenants | status, port, transport, session state, last activity, running pid |
| New tenant | name + WhatsApp number + industry template → the **same** `createTenant()` the CLI uses |
| Start / Stop / Restart | one tenant at a time, tracked by `tenants/<slug>/run.pid` |
| QR | live QR for that tenant (Baileys), or the webhook URL + verify token for a Cloud tenant |
| Profile | the raw `config/owner.json`, saved only if `profile.js` accepts it, reloaded live for the running tenant |
| Knowledge | drop a file → the existing learn pipeline, with the chunk count it produced |
| Keys | `GROQ_API_KEY` / `GEMINI_API_KEY`, **write-only**, shown masked, with a "test key" button that makes one small real call |
| Delete | needs the slug typed out; stops the process, then removes that tenant's folder |

### What protects it

- **No token, no panel.** With `ADMIN_TOKEN` empty every `/admin` and `/api/admin`
  route answers **404** — an unconfigured feature is never an open one.
- **Constant-time compare** on the token, bearer for scripts, an HMAC-signed
  `HttpOnly; SameSite=Strict` cookie for the browser.
- **CSRF** on every cookie-authenticated write: a double-submit token, or a
  same-origin check that a cross-site form cannot fake.
- **Rate limits**: 5 login attempts / 15 min, 10 creates and 5 deletes / hour.
- **Hardening headers**: `default-src 'none'` CSP, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `nosniff`, `no-store`, HSTS when on HTTPS.
- **No secrets out**: keys are write-only and masked; `.env`, session files and
  the database are never served.
- **Paths**: slugs must match `^[a-z0-9-]{2,40}$`, uploads are restricted to
  pdf/txt/md/csv/docx/png/jpg under 5 MB, stored inside that tenant's folder
  with the name reduced to a safe basename.
- **Audit**: every login, create, delete, profile save, key write, upload and
  process action lands in `admin_audit` (who / what / when / ip), and refused
  attempts are logged too.

### Deploying it safely

Do **not** open the port to the internet. Bind it to localhost and put a tunnel
in front:

```bash
HOST=127.0.0.1 ADMIN_TOKEN=… npm start
cloudflared tunnel --url http://localhost:3000
```

Then set `PUBLIC_URL=https://<the-tunnel-host>` so links are absolute, and keep
`ADMIN_TOKEN` different from `DASHBOARD_TOKEN` — `npm run doctor` warns about
every one of these mistakes (missing token, short token, shared token, `0.0.0.0`
without HTTPS).

---

## The live inbox

Everything else in this bot is about talking to customers. This is about *you* reading along, and stepping in when the bot is out of its depth.

```json
"features": { "liveInbox": true }
```

```
you: .inbox
bot: 📥 Live inbox
     3 unread in 2 chat(s) · 2 waiting for a reply
     1 chat(s) where the bot is quiet
     http://localhost:3000/inbox?token=…
     The link contains your token — do not forward it.
```

Open it and you get two panes: the chat list on the left with unread counts and who spoke last, the conversation on the right with every message labelled `bot`, `you` or nothing (the customer). It refreshes every three seconds, so a new message shows up while you are looking at the screen.

### What the buttons actually do

| Action | What happens |
|---|---|
| **Send** | The message goes out from your number, is recorded as *your* turn, and the bot steps back for the handoff window (45 min by default). Exactly what happens when you reply from your phone — one behaviour, two doors. |
| **Take over** | Pauses the bot in that chat for the chosen window (15 min by default), without sending anything. |
| **Release to bot** | Undoes it immediately. |
| **← Chats** | Back to the list (phones show one pane at a time). |

A chat is **unread** when the customer spoke last — not a flag that has to be maintained and can drift. `2 waiting` in `.inbox` means two customers are sitting there with no answer.

### Where it keeps its promises

- **Behind the token.** With `DASHBOARD_TOKEN` set, `/inbox` and every `/api/inbox` route return 401 without it — bearer header, `?token=`, or the cookie. The page also sends `Content-Security-Policy`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`, and it loads nothing from anywhere: no CDN, no fonts, no analytics. One HTML file, `src/web/inbox.html`.
- **It never invents data.** The list is a query over `messages` and `contacts`. There is no second store, no sync job, no "read" table to fall out of step.
- **It refuses honestly.** No transport connected in this process → `503 no_transport`, and nothing is written into the history pretending it was sent. Blocked chat → `409`. Over 4000 characters → `400 too_long`. Bad JSON → `400 bad_json`.
- **One tenant only.** The process owns one database; the page has no tenant switch and no way to query another. What is not in this SQLite file cannot be shown.

### Running it behind a tunnel

```bash
PUBLIC_URL=https://bot.yourdomain.com   # makes .inbox print a clickable link
DASHBOARD_TOKEN=something-long          # non-negotiable on a public box
```

`npm run doctor` says so out loud: with `liveInbox` on and no token, it warns that anyone who can reach the port can read every conversation — and again if `HOST=0.0.0.0` with no token. If you do not set `PUBLIC_URL`, `.inbox` prints a localhost link, which is correct when you are sitting at the machine.

---

## Switching to the official Cloud API

Baileys is the default because it is free and needs no approval: one QR scan and
the bot is on your own number. But it runs on WhatsApp's web protocol, which has
two real costs — the phone must stay linked, and the number can be shut out of
web sessions.

Meta's **Cloud API** is the official path. No phone needed while the bot runs,
no QR, no ban-by-protocol. In exchange: a free Meta developer account, a public
HTTPS address for webhooks, and Meta's rules about what you may send and when.

Everything else — memory, intake, quotes, tools, the manager agent, the outbox,
follow-ups, owner commands — is identical. That is the point of the transport
layer: only the wire changes.

### 1. Get the numbers from Meta (free)

1. Create a free app at [developers.facebook.com](https://developers.facebook.com) → **Create app** → type **Business**.
2. Add the **WhatsApp** product. Meta gives you a **test number** and a free
   sandbox — enough to run a real conversation at $0.
3. In **WhatsApp → API Setup** note two things:
   - **Phone number ID** (a long number, not the phone number) → `CLOUD_PHONE_ID`
   - a **temporary access token** (24 hours) — fine for a first test
4. Add your own phone as a **test recipient** on that page, then message the
   test number once. That opens the 24-hour window for you.

For anything longer than a day, create a **permanent token**:
**Business settings → Users → System users** → add a system user → *Generate
token* → choose your app → permission `whatsapp_business_messaging` →
`CLOUD_TOKEN`.

### 2. Fill in the four values

In `.env` (or the tenant's `.env` if you run several users):

```bash
TRANSPORT=cloud

CLOUD_PHONE_ID=123456789012345
CLOUD_TOKEN=EAAG...                    # permanent token, not the 24h test one
CLOUD_VERIFY_TOKEN=any-word-you-choose # you invent this; Meta echoes it back
CLOUD_APP_SECRET=abcdef123456          # App settings → Basic → App secret

# optional: a template used outside the 24-hour window
# CLOUD_TEMPLATE_NAME=hello_world
# CLOUD_TEMPLATE_LANG=en
```

Then, once, turn the feature on:

```
.set features.cloudApi true
```

The bot refuses to start on the Cloud API without all four values, and refuses
unsigned webhooks outright. No token ever appears in a log line.

### 3. Give Meta a webhook URL

Meta needs a public HTTPS address. On a laptop or a free host, a tunnel is the
easiest way:

```bash
# option A — cloudflared (no account needed for a quick tunnel)
cloudflared tunnel --url http://localhost:3000

# option B — ngrok
ngrok http 3000
```

Both print an address like `https://random-words.trycloudflare.com`.
Your webhook URL is:

```
https://random-words.trycloudflare.com/webhook/<slug>
```

`<slug>` is `default` for a single install, or the tenant's slug
(`ayesha-designs`, …). Put it in **Meta → WhatsApp → Configuration → Webhook**,
type the same `CLOUD_VERIFY_TOKEN` you set, and press **Verify and save**.

Meta sends a `GET` with your token; the bot answers with the challenge. It also
subscribes to the `messages` field — remember to click **Manage** and tick
`messages`, or nothing will arrive.

Check it from the outside in one line:

```bash
curl "https://<your-tunnel>/webhook/default?hub.mode=subscribe&hub.verify_token=<your-token>&hub.challenge=123"
# → 123
```

### 4. The 24-hour rule (the part that surprises people)

The Cloud API only lets you send a **free-form** message inside a 24-hour
window, and only the *customer* opens that window by writing to you. Outside it:

- if you configured `CLOUD_TEMPLATE_NAME`, the bot sends that approved template
  with the reply as its body parameter;
- if you did not, the message is **held in the outbox**, you are told in your
  own chat, and it goes out automatically the moment the customer writes again.

Nothing is ever dropped silently. `.status` shows how many messages are held,
and `node scripts/doctor.js` explains the rule and whether a template is set.

Templates must be approved by Meta first (**WhatsApp → Message templates**).
`hello_world` is approved out of the box and is fine for a first test.

### 5. What does not exist on the Cloud API

These switch themselves off instead of throwing — `.status` and
`node scripts/doctor.js` list them for the transport you are on:

| Feature | Baileys | Cloud API |
|---|---|---|
| Typing indicator / "recording" | ✅ | ✗ (no such thing) |
| Delete for everyone | ✅ | ✗ |
| Missed-call rescue | ✅ | ✗ (calls never reach the API) |
| Recover a deleted message | ✅ | ✗ |
| Reactions | ✅ | ✗ |
| Groups / channels | never, by design | never, by design |
| Approved templates | ✗ | ✅ |
| No phone linked while running | ✗ | ✅ |

The bot still behaves like a person: same persona, same languages, same memory.

### 6. Several cloud tenants on one public port

A tunnel exposes one port. `scripts/webhooks.js` puts every cloud tenant behind
it, each on its own path:

```bash
node scripts/run-all.js      # the bots (each on its own port)
node scripts/webhooks.js     # one public port, /webhook/<slug> per tenant

cloudflared tunnel --url http://localhost:8080
# → https://<tunnel>/webhook/ayesha-designs  →  her process
# → https://<tunnel>/webhook/burger-point    →  his process
```

The gateway forwards the raw bytes untouched, because Meta's signature is
computed over exactly those bytes.

### 7. Switching back

```bash
TRANSPORT=baileys
```

Restart, scan the QR once, done. Nothing in the database is transport-specific:
the same contacts, messages, leads and quotes are waiting.

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

**Honest version:** WhatsApp's Web protocol lets a bot *see* calls but **not carry the audio** — and the Cloud API transport in this project does not carry call audio either. So the assistant does the closest useful thing: the missed call becomes a message while the caller is still holding the phone.

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
| `.status` | providers, memory, outbox, ffmpeg, follow-ups, routing, transport |
| `.voice off\|request\|match\|always` | voice-reply behaviour |
| `.ai on\|off` | global kill switch |
| `.export` | JSON backup of contacts + leads |
| `.sync` | push leads to Google Sheets |
| `.profile` | business summary: hours, tone, goal, price list size, flags |
| `.services` | the price list the bot is allowed to quote, with stock |
| `.addservice Name \| 1500` | add (or re-price) an item — quotable immediately |
| `.addfaq Question \| Answer` | add an FAQ |
| `.set path value` | edit any setting, live: `.set business.hours Daily 12:00–23:00` |
| `.features` | what's on, what's off |
| `.knowledge` | learned documents, chunks and vector status |
| `.tools` | the last 10 actions the bot took, with arguments |
| `.intents` | who answered what today: sales, support, booking, complaint — and how it was decided |
| `.bookings` | today's and tomorrow's bookings, with ids |
| `.cancel 12` | cancel a booking by id — the slot is free again immediately |
| `.growth` | proactive messages sent today per agent, with caps and any opt-outs |
| `.optouts` | everyone who asked to stop, and when |
| `.approve 12` / `.skip 12` | send or drop a follow-up draft |
| `.done 12` | a booking or order is finished — starts the review flow |
| `.paid 12` | the money really arrived (only you can mark an order paid) |
| `.report week` | last seven days vs the week before |
| `.referrals` | who has a code, and who arrived with one |
| `.content now` | this week's pack on demand |
| `.campaign preview` | who would get a win-back message, with a sample |
| `.campaign send` / `.campaign stop` | start the campaign (this is the approval) or halt it |
| `.invoice <id>` | the PDF for an order — `.invoice <id> send` delivers it to the client |
| `.rules` | FAQ rules learned from your replies, waiting for a yes or no |
| `.approve-rule <id>` / `.reject-rule <id>` | decide one |
| `.inbox` | the live inbox link, with what is waiting |
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

## Deploy for $0 — the whole guide

Everything below runs on free infrastructure. Two options, in order of how much I would trust them.

### Option A — Oracle Cloud "Always Free" VM (recommended)

Oracle's always-free tier gives an ARM VM with 4 cores and 24 GB RAM (or an x86 micro instance) and 10 TB of egress a month. That is more than this bot will ever use.

1. **Create the VM.** Sign up at cloud.oracle.com → Compute → Instances → Create. Pick an *Always Free eligible* shape (VM.Standard.A1.Flex, 1–2 OCPUs, 6–12 GB), Ubuntu 24.04, and **download the SSH key**.
2. **Open only what you need.** In the instance's VCN → Security Lists, allow ingress 22 (SSH). Leave 3000 closed — you will reach the dashboard through an SSH tunnel or the token.
3. **Install.** Over SSH:
   ```bash
   sudo apt update && sudo apt install -y curl git ffmpeg
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs
   git clone https://github.com/hasxir-khan/Whatsapp-Ai-Agent.git
   cd Whatsapp-Ai-Agent && npm install --omit=dev
   cp .env.example .env && nano .env      # MY_NUMBER, GROQ_API_KEY, GEMINI_API_KEY
   ```
4. **Log in to WhatsApp once.** `npm start`, scan the QR with the business phone (Linked devices → Link a device). The session is saved in `sessions/` and survives restarts. Then `Ctrl-C`.

### Keep it running — systemd (simple) or pm2

**systemd** is the better choice on a box you rarely touch:

```ini
# /etc/systemd/system/wa-bot.service
[Unit]
Description=WhatsApp assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/Whatsapp-Ai-Agent
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wa-bot
sudo systemctl status wa-bot          # is it alive?
journalctl -u wa-bot -f               # live logs
```

**pm2** is the friendlier one, and does log rotation itself:

```bash
sudo npm i -g pm2
pm2 start src/index.js --name wa-bot
pm2 startup && pm2 save               # survive a reboot
pm2 logs wa-bot --lines 100
pm2 install pm2-logrotate             # keeps logs from filling the disk
```

If you run several businesses, start them with `node scripts/run-all.js` under systemd/pm2 instead — it launches one process per tenant.

### Logs that do not fill your disk

journald (systemd) can be capped globally:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\nSystemMaxFileSize=20M\n' | sudo tee /etc/systemd/journald.conf.d/size.conf
sudo systemctl restart systemd-journald
```

With pm2, `pm2 install pm2-logrotate` and then `pm2 set pm2-logrotate:max_size 10M`.

### Firewall

```bash
sudo ufw allow 22/tcp
sudo ufw enable
sudo ufw status
```

That is the whole list. The bot only makes *outbound* connections (WhatsApp, Groq, Gemini), so it needs no inbound port — except:

- **Cloud API webhook**: needs HTTPS on 443, and Meta must be able to reach it. Do not open 443 to the world directly; use a tunnel (below).
- **Dashboard**: either do not expose it, or set `DASHBOARD_TOKEN` and reach it through an SSH tunnel:
  ```bash
  ssh -L 3000:localhost:3000 ubuntu@your-vm   # then http://localhost:3000/?token=…
  ```

### Cloud API webhook behind cloudflared (free, no open ports)

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/

# quick tunnel for a test (url changes every restart — fine for one afternoon)
cloudflared tunnel --url http://localhost:3000

# a stable one (needs a free Cloudflare account + a domain in it)
cloudflared tunnel login
cloudflared tunnel create wa-bot
cloudflared tunnel route dns wa-bot bot.yourdomain.com
cloudflared tunnel run --url http://localhost:3000 wa-bot
```

Point Meta's webhook at `https://bot.yourdomain.com/webhook/<slug>` with the verify token from your `.env`. Run the tunnel as a service too (`sudo cloudflared service install`) so it comes back after a reboot.

### Backups (the only step people skip)

```bash
node scripts/backup.js default            # this install → backups/default-<time>.json.gz
node scripts/backup.js ayesha             # a tenant
node scripts/backup.js ayesha --with-keys # only if you have nowhere else to keep the keys
node scripts/restore.js backups/ayesha-….json.gz --slug ayesha --dry-run
node scripts/restore.js backups/ayesha-….json.gz --slug ayesha
```

The archive holds the SQLite database plus `config/` and `tenant.json`. It **excludes `.env` and `sessions/` unless you ask** — a backup with API keys in it is a liability, and you already have your keys somewhere. Restoring keeps a `.before-restore-<time>` copy of every file it overwrites.

A cron line that costs nothing:

```cron
15 3 * * * cd /home/ubuntu/Whatsapp-Ai-Agent && node scripts/backup.js default >/dev/null 2>&1
```

### First-week checklist

Run through this once, in order. It takes about twenty minutes and prevents most of the surprises.

- [ ] `npm run doctor` — no ❌, and the suggestions make sense
- [ ] `npm run doctor:all` if you have tenants — one bad tenant should not hide behind a good one
- [ ] Send the bot a message from a second phone: does it answer, in the right language?
- [ ] Send a voice note, a photo, and (if Cloud) a template-less message after 24 h
- [ ] Ask a price question you *know* the answer to — is the number the catalogue's number?
- [ ] `.set features.catalog true` then ask again
- [ ] Set `DASHBOARD_TOKEN` if the box has a public IP
- [ ] Turn on one agent only. Watch it for two days before turning on the next
- [ ] `.growth` every morning of week one: any `held`, `skipped` or `failed` line is telling you something
- [ ] `node scripts/backup.js default` — and copy the file off the box
- [ ] Reboot the VM and confirm the bot comes back by itself

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

- **Baileys is an unofficial WhatsApp client.** Automating a personal number can get it banned. Use a spare number for anything valuable, or [switch to the official Cloud API](#switching-to-the-official-cloud-api), which is supported.
- **Calls are answered in chat, not with audio.** Neither transport carries call audio here — a missed call becomes a message, not a conversation.
- **The bot must be running.** Downloads, sleep and dead batteries mean unanswered messages until it's back — then they're answered in order.
- **AI can be wrong.** Facts and prices come from config, but free models occasionally phrase things badly. Watch the first week.
- **Free-tier data:** Gemini's free tier and Groq may use inputs to improve their services. Don't paste confidential material.
- **Edge TTS is an unofficial endpoint**; if Microsoft changes it, voice output degrades to text automatically.
- **Groups and channels are impossible by design** — not a bug.
- **Quotes are estimates**, not contracts.
- **Booking reminders and follow-ups only go out if the process is running** at the right moment; a reminder that falls due while the bot is down is sent on the next start, still inside quiet hours and caps.
- **The weekly report's suggestions need a model**; without a key you get the deterministic three, which are blunter but still true. The numbers themselves never need a model.
- **A payment receipt is never auto-verified.** Reading a screenshot proves nothing about a bank balance — `.paid` stays a human decision.
- **The inbox is not a CRM.** No tags, no notes, no bulk actions, no filters beyond "newest first". It is for reading and answering, which is what a phone-sized business needs.
- **Three-second refresh, not websockets.** New messages appear within a few seconds; there is no typing indicator and no delivery-receipt display.
- **It is one process.** If you run several tenants with `run-all.js`, each has its own port and its own inbox — there is deliberately no combined view that could mix customers up.
- **Urdu in the PDF is transliterated, not typeset.** Standard Arabic shapes correctly; Urdu's extra letters cannot be rendered without an OpenType shaper plus bidi, which pdfkit does not have. You get readable Roman Urdu, never mirrored glyphs. If that matters for your invoices, put the Roman name in the catalogue.
- **A learned rule is only as good as your one sentence.** It is keyword-matched, like every FAQ. `.rules` and a quick read before `.approve-rule` is the whole quality process.
- **A win-back campaign is the riskiest thing here.** On Baileys, a burst of messages to people who have not written in a month is exactly what gets a number limited. The campaign is slow and capped for that reason — do not raise those caps to "get it done faster".
- **Content is only as good as your catalogue.** If the price list is thin, the captions are thin. No amount of AI fixes a missing menu.
- **The dashboard shows numbers, not answers.** It will tell you referral traffic converts better; it will not tell you why.
- **Prompt injection is contained, not eliminated.** Instructions inside customer text or documents are neutralised and quoted as data, but a sufficiently creative message can still influence wording. Prices and discounts are safe because they never come from the model.
- **Google Calendar sync is optional and unverified in this repo's tests** (no credentials in CI). Bookings themselves are fully tested; the calendar call is best-effort and never blocks a booking.

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
  owner.example.json    full schema + defaults (every option documented)
  owner.json            your business knowledge (edit this)
  templates/            8 industry starter profiles
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
    profile.js          universal business profile: read, write, validate, live reload
    templates.js        industry templates → owner.json
    knowledge.js        documents → chunks → SQLite
    embeddings.js       Gemini embeddings: batches, rate limits, fast failure
    rag.js              hybrid retrieval (vectors + BM25) and the prompt block
    tools.js            the five actions: schemas, validation, confirmations
    hours.js            opening hours parsed and checked in the business timezone
    manager.js          intent rules, the model router, specialist agents
    growth.js           the safety layer: opt-outs, quiet hours, caps, logging
    bookingAgent.js     bookings: parse, offer slots, reminders, no-shows
    followUpAgent.js    quiet-lead nudges: 24h/72h, personalised, draft-first
    calendar.js         optional Google Calendar mirror (never blocks)
    closerAgent.js      objections, discount cap, quote + payment, receipts
    reviewAgent.js      feedback asks, review links, referral codes
    analystAgent.js     weekly owner report: SQL numbers, model suggestions
    jobFlow.js          .done / .paid → the review clock
    reactivationAgent.js  segments, campaign preview/send/stop, slow sending
    contentAgent.js     weekly pack: posts, statuses, reel, hashtags, times
    growthDashboard.js  funnel, per-agent and per-source numbers
    invoice.js          PDF quotes, invoices and receipts
    selfHealing.js      candidate rules from the owner's own replies
    liveInbox.js        the inbox: chats, threads, replies, takeover
    injection.js        (core) untrusted text: detect, neutralise, fence
    script.js           (core) Urdu/Arabic → shaped or transliterated
  transport/            how the bot talks to WhatsApp, behind one interface
    base.js             the interface + the internal message shape
    baileys.js          Baileys (default), wrapped unchanged
    cloud.js            Cloud API: webhook, signatures, media, 24-hour window
    webhooks.js         /webhook/<slug> on a plain http server
    gateway.js          many cloud tenants, one public port
    toolCalling.js      the model loop: native function calling or JSON fallback
    leads.js            lead scoring, next actions, pipeline summary
    outbox.js           offline queue: never lose a reply
    calls.js            missed-call rescue
    language.js         86 languages + register detection
    transcription.js  vision.js  video.js  documents.js
    tts.js  edgeTts.js  ffmpeg.js  media.js
    memory.js  followUps.js  report.js  sheets.js
    spamGuard.js  deletedMessages.js  geo.js
  utils/
    db.js               SQLite: contacts, messages, leads, outbox, calls, tool log
    gemini.js           Gemini auth + error classification
    sessionBackup.js
scripts/
  tenant.js             create / setup / teach / inspect / delete users
  wizard.js             the 10-question business setup
  learn.js              ingest one document into a tenant's knowledge base
  run-all.js            run every user at once
  doctor.js  simulate.js  seed-demo.js  session-backup.js
  backup.js  restore.js   one-file backup of DB + config
src/web/inbox.html      the inbox page (one file, no dependencies)
assets/fonts/           Noto Sans + Noto Naskh Arabic (bundled, subsetted, OFL)
test/                   622 tests (node:test, no dependencies)
```

---

## Tests

```bash
npm test                 # 622 tests, ~39s, no network, no keys, no config/owner.json
npm run doctor           # environment + live API checks
npm run doctor:all       # every tenant at once, with risky-settings warnings
npm run chat -- --mock   # talk to the brain with no keys
```

The suite never touches the internet: `test/helpers.js` isolates each file in a temp directory, and the AI provider is replaced by a deterministic fake. Every phase ships with its own file — `test/27`–`test/29` for the growth agents, `30`–`32` for the analyst, closer and reviews, `33`–`36` for campaigns, content, the dashboard and hardening, `37`–`38` for PDF documents and the learning loop, `39` for the live inbox.

---

## License

MIT. Use it for your own business or for other people's — but the people talking to it should know a bot may be answering.

Built for Hashir / HasDevs, and now for anyone who needs it.
