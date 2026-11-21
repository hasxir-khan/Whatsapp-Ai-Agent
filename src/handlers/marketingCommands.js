// src/handlers/marketingCommands.js
// Phase 6 Part 2 — the WhatsApp surface for the marketing team.
//
// Everything here is owner-facing and drafts-first: the only thing that sends
// to a customer is `.promo send`, and that goes through growth.js like every
// other proactive message.

import { config } from '../config/env.js';
import {
  marketingEnabled,
  marketingMenu,
  marketingConfig,
  planMonth,
  contentKit,
  evaluateOffer,
  promoSegments,
  promoPreview,
  promoStart,
  promoSendBatch,
  promoStop,
  promoState,
  reviewReply,
  channelRanking,
  adCopy,
} from '../services/marketing.js';
import { sourceLink, sourceLinksEnabled } from '../services/sourceLinks.js';

const on = (v) => ['on', 'true', 'yes', '1', 'enable'].includes(String(v || '').toLowerCase());
const off = (v) => ['off', 'false', 'no', '0', 'disable'].includes(String(v || '').toLowerCase());

function disabledText() {
  return [
    'The marketing team is off.',
    '',
    'Turn it on with: .marketing on',
    'It drafts plans, content, offers, ad copy and review replies. The only thing it ever sends to a customer is a promo you start yourself.',
  ].join('\n');
}

/**
 * @param {{sub?:string, args?:string[], raw?:string, transport?:object, now?:Date}} input
 */
export async function handleMarketingCommand({ sub = '', args = [], raw = '', transport = null, now = new Date() } = {}) {
  const cmd = String(sub || '').toLowerCase();
  const rest = args.join(' ').trim();
  const arg = (i) => String(args[i] || '');

  // `.marketing` itself works with the flag off: it has to, or the owner can
  // never discover how to switch it on.
  if (cmd === 'marketing') {
    if (on(arg(0))) return { handled: true, reply: await toggle('features.marketingAgents', true) };
    if (off(arg(0))) return { handled: true, reply: await toggle('features.marketingAgents', false) };
    return { handled: true, reply: marketingMenu({ now }) };
  }

  if (!marketingEnabled()) return { handled: true, reply: disabledText() };

  switch (cmd) {
    case 'plan': {
      const plan = planMonth({ now });
      const note = plan.warnings.length ? `\n\n⚠️ ${plan.warnings.slice(0, 2).join(' · ')}` : '';
      return { handled: true, reply: plan.text + note };
    }

    case 'content': {
      const words = rest.split(/\s+/).filter(Boolean);
      let kind = 'ad';
      if (words[0] === 'now' || words[0] === 'week' || words[0] === 'pack') words.shift();
      if (['ad', 'reel', 'status', 'bilingual'].includes((words[0] || '').toLowerCase())) kind = words.shift().toLowerCase();
      const topic = words.join(' ').trim();
      const kit = await contentKit({ kind, topic, now });
      const warn = kit.warnings?.length ? `\n\n⚠️ ${kit.warnings.slice(0, 2).join(' · ')}` : '';
      return { handled: true, reply: kit.text + warn };
    }

    case 'offer': {
      if (!rest) return { handled: true, reply: 'Usage: .offer 10% off Friday dinner' };
      const verdict = evaluateOffer({ idea: rest, now });
      return { handled: true, reply: verdict.text };
    }

    case 'promo': {
      const action = (arg(0) || 'preview').toLowerCase();
      if (action === 'stop') return { handled: true, reply: promoStop().text };

      if (action === 'send') {
        const started = promoState().campaign;
        if (!started || started.status !== 'running') {
          const res = promoStart({ now });
          if (!res.ok) return { handled: true, reply: res.text };
          const batch = await promoSendBatch({ transport, now, delayMs: 0 });
          return { handled: true, reply: `${res.text}\n\n${batch.text}` };
        }
        const batch = await promoSendBatch({ transport, now, delayMs: 0 });
        return { handled: true, reply: batch.text };
      }

      if (action === 'preview') {
        const segment = (arg(1) || 'all').toLowerCase();
        const message = rest.replace(/^preview\s+\S+\s*/i, '').replace(/^["']|["']$/g, '');
        const preview = promoPreview({ segment, message, now });
        if (!preview.ok) return { handled: true, reply: preview.text };
        return { handled: true, reply: preview.text };
      }

      // `.promo` alone: the state of things.
      const cfg = marketingConfig();
      const segments = promoSegments();
      const state = promoState().campaign;
      const lines = [
        '📣 *Promos*',
        '',
        `Reachable: ${segments.reachable} of ${segments.all} contacts`,
        `Opted out: ${segments.optedOut} · blocked: ${segments.blocked}`,
        `One promo per contact every ${cfg.minDaysBetweenPromos} days`,
        `Approval mode: ${cfg.approvalMode ? 'on' : 'OFF'}`,
        state ? `Current: ${state.status} — ${state.cursor}/${state.queue.length}` : 'No promo running.',
        '',
        'Segments: ' + ['all', ...segments.tags.slice(0, 5).map((t) => `${t.tag}(${t.count})`)].join(' · '),
        '',
        'Preview: .promo preview all "message"',
      ];
      return { handled: true, reply: lines.join('\n') };
    }

    case 'reply-review': {
      const stars = Number(arg(0)) || 0;
      if (!stars) {
        return { handled: true, reply: 'Usage: .reply-review 4 "what they wrote"  (1–5 stars, then the review)' };
      }
      const text = rest.replace(/^\d\s*/, '').replace(/^["']|["']$/g, '');
      const draft = reviewReply({ stars, text, now });
      return { handled: true, reply: draft.text };
    }

    case 'channels': {
      const ranking = channelRanking({ now });
      return { handled: true, reply: ranking.text };
    }

    case 'adcopy': {
      let link = '';
      if (sourceLinksEnabled()) {
        try {
          link = sourceLink('ads') || '';
        } catch {
          link = '';
        }
      }
      const copy = await adCopy({ topic: rest, now, link });
      return { handled: true, reply: copy.text };
    }

    default:
      return { handled: true, reply: marketingMenu({ now }) };
  }

  void raw;
  void config;
}

async function toggle(flag, value) {
  const P = await import('../services/profile.js');
  const result = P.savePatch({ features: { [flag.split('.').pop()]: value } });
  if (result && result.ok === false) return `Could not save: ${(result.errors || ['unknown error']).join('; ')}`;
  return value
    ? 'Marketing team: ON\nTry .plan, .offer 10% off, .channels, or .promo preview all "message".'
    : 'Marketing team: OFF. Nothing it drafted will be sent.';
}

export default { handleMarketingCommand };
