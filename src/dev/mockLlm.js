// src/dev/mockLlm.js
// A deterministic fake of Groq / Gemini, used by `npm run chat --mock` and by
// the test suite. It lets you exercise the whole pipeline (memory, intake,
// pricing, language, routing) without spending a single token.

import { __setFetch } from '../core/llm.js';
import { config } from '../config/env.js';

let overrideReply = null;

/** Tests can force the next text reply. */
export function setMockReply(fn) {
  overrideReply = fn;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pickTextReply(userText) {
  if (overrideReply) return overrideReply(userText);

  const t = userText.toLowerCase();

  if (/price|cost|quote|how much|budget|kitna/.test(t)) {
    return 'Happy to price it — a few details first so I don’t guess: what should the site do, and roughly how many pages?';
  }
  if (/^(hi|hey|hello|salam|assalam|aoa)\b/.test(t)) {
    return 'Hey! Thanks for reaching out — what are you looking to build?';
  }
  if (/website|web site|landing|store|shop|app|dashboard|bot/.test(t)) {
    return 'Got it. What’s the main goal for it, and who’s it for?';
  }
  if (/pay|stripe|jazzcash|easypaisa|login|admin/.test(t)) {
    return 'Noted — anything else you need on it, or is that the full feature list?';
  }
  if (/week|month|asap|urgent|deadline/.test(t)) {
    return 'Timeline helps a lot. What budget range are you working with so I can match the scope?';
  }
  if (/thanks|thank you|shukriya/.test(t)) {
    return 'Any time. I’ll keep everything here so we don’t lose track.';
  }
  return 'Makes sense — tell me a bit more about what you need it to do.';
}

function extractFields(text) {
  const lower = text.toLowerCase();
  const updates = {};

  if (/website|web site|landing|store|shop|app|dashboard|bot|automation|portal/.test(lower)) {
    updates.projectType = /store|shop|ecommerce|e-commerce/.test(lower)
      ? 'e-commerce store'
      : /app|android|ios/.test(lower)
        ? 'mobile app'
        : /bot|automation|ai/.test(lower)
          ? 'AI bot'
          : 'business website';
    updates.goal = text.slice(0, 220);
  }

  const features = ['login', 'payment', 'stripe', 'paypal', 'jazzcash', 'easypaisa', 'admin', 'dashboard', 'chat', 'notification', 'search', 'upload', 'api'];
  const found = features.filter((f) => lower.includes(f));
  if (found.length) updates.features = found.join(', ');

  const money = text.match(/(?:\$|usd|pkr|rs\.?)\s?([\d,]+)/i) || text.match(/([\d,]{3,})\s?(?:pkr|usd|dollars?|rupees?)/i);
  if (money) updates.budget = money[0];

  const time = text.match(/\b(\d+\s*(?:weeks?|months?|days?)|next month|asap|urgent)\b/i);
  if (time) updates.timeline = time[0];

  if (/dark|light|minimal|modern|clean|modern look|design/.test(lower)) updates.design = text.slice(0, 160);

  return updates;
}

export function mockTransport() {
  // Pretend keys exist so the whole pipeline (chat, vision, speech) runs offline
  config.keys.groq = config.keys.groq || 'mock-groq-key';
  config.keys.gemini = config.keys.gemini || 'mock-gemini-key';
  config.keys.openrouter = config.keys.openrouter || 'mock-openrouter-key';

  __setFetch(async (url, options = {}) => {
    const href = String(url);
    const body = options.body ? safeParseBody(options.body) : {};

    // ── speech-to-text ────────────────────────────────────
    if (href.includes('/audio/transcriptions')) {
      return jsonResponse({
        text: 'Hi, I need a website for my clothing brand, maybe six pages with payments.',
        language: 'english',
        duration: 6.4,
      });
    }

    // ── text-to-speech ────────────────────────────────────
    if (href.includes('/audio/speech')) {
      return new Response(Buffer.alloc(5000, 7), { status: 200 });
    }

    // ── gemini ────────────────────────────────────────────
    if (href.includes('generativelanguage.googleapis.com')) {
      if (href.includes(':generateContent')) {
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: 'A screenshot of a clothing store homepage: hero image with a model, product grid of six items, prices in dollars, and a cart icon. The header navigation reads Home, Shop, About, Contact.' }] } }],
          usageMetadata: { totalTokenCount: 120 },
        });
      }
      return jsonResponse({ models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] });
    }

    // ── openai-compatible chat (groq / openrouter) ────────
    const messages = body.messages || [];
    const system = messages.find((m) => m.role === 'system')?.content || '';
    const user = [...messages].reverse().find((m) => m.role === 'user')?.content;
    const userText = typeof user === 'string' ? user : JSON.stringify(user || '');

    // Intake extraction
    if (/extract structured project requirements/i.test(system) || /Extract the project details/i.test(userText)) {
      const quoted = /Client's message:\s*\"\"\"([\s\S]*?)\"\"\"/.exec(userText);
      const source = (quoted ? quoted[1] : userText).trim().slice(0, 2000);
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                intent: 'project',
                updates: extractFields(source),
                ready_to_quote: /quote|price|how much/.test(source.toLowerCase()),
                name: '',
                company: '',
              }),
            },
          },
        ],
        usage: { total_tokens: 180 },
      });
    }

    // CRM summary
    if (/CRM memory|Return JSON with exactly these keys/i.test(`${system} ${userText}`)) {
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'Client wants a website for their clothing brand. Budget and timeline discussed. Needs payments.',
                facts: { country: '', company: '', budget: '', timeline: '' },
                stage: 'discovering',
                sentiment: 'positive',
                next_step: 'Confirm feature list',
              }),
            },
          },
        ],
        usage: { total_tokens: 90 },
      });
    }

    // Document summary / brief extraction
    if (/extract project requirements from documents/i.test(system)) {
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(extractFields(userText)) } }],
        usage: { total_tokens: 120 },
      });
    }

    // Default: a human-sounding reply
    return jsonResponse({
      choices: [{ message: { content: pickTextReply(userText) } }],
      usage: { total_tokens: 60 },
    });
  });
}

function safeParseBody(body) {
  if (typeof body !== 'string') return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

export default { mockTransport, setMockReply };
