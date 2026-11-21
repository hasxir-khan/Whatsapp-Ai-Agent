// src/handlers/brainCommands.js
// Phase 6 Part 3 — the WhatsApp surface for the business brain.
//
// Every command here either reports numbers or prepares a draft. Nothing sends
// a customer message: `.do <n>` produces text you approve, and the send still
// happens through growth.js like every other proactive message.

import { config } from '../config/env.js';
import { impactReport } from '../services/impact.js';
import { strategistEnabled, dailyBrief, weeklyReview, prepareAction, whyAction, currentProposals } from '../services/strategist.js';
import { parseGoal, addGoal, goalsText, listGoals, dropGoal, METRICS, MAX_ACTIVE_GOALS } from '../services/goals.js';
import {
  createExperiment,
  listExperiments,
  experimentText,
  adoptWinner,
  variantFor,
  EXPERIMENT_KINDS,
} from '../services/experiments.js';
import { weightsText, resetWeights } from '../services/learning.js';
import { reasoningConfig, activeProvider, reasoningUsedToday, reasoningBudget } from '../services/reasoning.js';
import { hasLLM } from '../core/llm.js';

const on = (v) => ['on', 'true', 'yes', '1', 'enable'].includes(String(v || '').toLowerCase());
const off = (v) => ['off', 'false', 'no', '0', 'disable'].includes(String(v || '').toLowerCase());

function disabledText() {
  return [
    'The business brain is off.',
    '',
    'Turn it on with: .brain on',
    'It reads your own numbers, explains them, and prepares drafts. It never sends to a customer on its own.',
  ].join('\n');
}

async function setFlag(flag, value, onText, offText) {
  const P = await import('../services/profile.js');
  const result = P.savePatch({ features: { [flag]: value } });
  if (result && result.ok === false) return `Could not save: ${(result.errors || ['unknown error']).join('; ')}`;
  return value ? onText : offText;
}

export function brainMenu({ now = new Date() } = {}) {
  const cfg = reasoningConfig();
  const provider = activeProvider(cfg);
  const used = reasoningUsedToday(now);
  const budget = reasoningBudget(cfg);
  const lines = [
    '🧠 *Business brain*',
    '',
    strategistEnabled() ? 'Status: on' : 'Status: off — turn it on with .brain on',
    '',
    '.impact — automation, response time, leads, revenue and hours saved',
    '.brain — today in three lines',
    '.strategy — the weekly review and the five things worth doing',
    '.do <n> — prepare action n as a draft (it does not send)',
    '.why <n> — why that action is on the list',
    '.goal add 20 orders by 2026-12-31 — progress and a projection',
    '.experiment — test two wordings on a stable split',
    '.brain weights — what the loop has learned (and .brain reset)',
    '',
    `Reasoning: ${hasLLM() ? `${provider?.id || 'off'}` : 'no model key — deterministic mode'}`,
    `Reasoning calls today: ${used}/${budget}`,
  ];
  if (!strategistEnabled()) lines.push('', 'With it off nothing changes: the bot answers exactly as it does today.');
  return lines.join('\n');
}

/**
 * @param {{sub?:string, args?:string[], raw?:string, now?:Date}} input
 */
export async function handleBrainCommand({ sub = '', args = [], raw = '', now = new Date() } = {}) {
  const cmd = String(sub || '').toLowerCase();
  const rest = args.join(' ').trim();
  const arg = (i) => String(args[i] || '');

  // `.brain` has to work with the flag off, or the owner cannot turn it on.
  if (cmd === 'brain') {
    if (on(arg(0))) {
      return {
        handled: true,
        reply: await setFlag(
          'businessBrain',
          true,
          'Business brain: ON\nTry .brain for the daily brief, .impact for the numbers, or .strategy for the week.'
        ),
      };
    }
    if (off(arg(0))) {
      return { handled: true, reply: await setFlag('businessBrain', false, '', 'Business brain: OFF. The bot answers exactly as it did before.') };
    }
    if (arg(0) === 'weights') return { handled: true, reply: weightsText() };
    if (arg(0) === 'reset') {
      resetWeights();
      return { handled: true, reply: '↺ Learning weights are back to 1.0. The record of what happened stays in the audit log.' };
    }
    if (arg(0) === 'reasoning') {
      if (on(arg(1))) return { handled: true, reply: await setFlag('reasoning', true, 'Reasoning: ON. Complex turns get a plan and a check before they answer.') };
      if (off(arg(1))) return { handled: true, reply: await setFlag('reasoning', false, '', 'Reasoning: OFF. Every turn takes the normal path.') };
    }
    if (!strategistEnabled()) return { handled: true, reply: disabledText() };
    const brief = await dailyBrief({ now });
    return { handled: true, reply: brief.text };
  }

  if (cmd === 'impact') {
    const report = impactReport({ now });
    return { handled: true, reply: report.text };
  }

  if (!strategistEnabled()) return { handled: true, reply: disabledText() };
  void raw;

  switch (cmd) {
    case 'strategy': {
      const review = await weeklyReview({ now });
      return { handled: true, reply: review.text };
    }

    case 'do': {
      const n = Number(arg(0));
      if (!Number.isInteger(n) || n < 1) return { handled: true, reply: 'Which action? `.strategy` lists them, then `.do 1`.' };
      const result = await prepareAction(n, { now });
      return { handled: true, reply: result.text };
    }

    case 'why': {
      const n = Number(arg(0));
      const result = whyAction(n, { now });
      return { handled: true, reply: result.text };
    }

    case 'goal': {
      const verb = arg(0).toLowerCase();
      if (verb === 'add') {
        const parsed = parseGoal(rest);
        if (!parsed.ok) return { handled: true, reply: `⚠️ ${parsed.reason}` };
        const added = addGoal({ metric: parsed.metric, target: parsed.target, dueAt: parsed.dueAt, now });
        if (!added.ok) return { handled: true, reply: `⚠️ ${added.reason}` };
        return {
          handled: true,
          reply: `🎯 Goal #${added.goal.id}: ${parsed.target} ${parsed.metric} by ${parsed.due}.\n\n${goalsText({ now })}`,
        };
      }
      if (verb === 'drop' || verb === 'remove') {
        const dropped = dropGoal(arg(1));
        return { handled: true, reply: dropped.ok ? `Dropped goal #${dropped.goal.id}.` : `⚠️ ${dropped.reason}` };
      }
      return { handled: true, reply: goalsText({ now }) };
    }

    case 'experiment': {
      const verb = arg(0).toLowerCase();
      if (verb === 'new') {
        const kind = arg(1).toLowerCase();
        const pair = rest.slice(rest.indexOf(arg(1)) + arg(1).length).split('|');
        if (pair.length < 2) {
          return { handled: true, reply: '⚠️ Two variants, separated by |:\n.experiment new followup "text A" | "text B"' };
        }
        const created = createExperiment({
          kind: EXPERIMENT_KINDS.includes(kind) ? kind : 'followup',
          variantA: pair[0].replace(/"/g, ''),
          variantB: pair[1].replace(/"/g, ''),
          now,
        });
        if (!created.ok) return { handled: true, reply: `⚠️ ${created.reason}` };
        return {
          handled: true,
          reply: `🧪 Experiment #${created.experiment.id} (${created.experiment.kind}) is running.\nA: "${created.experiment.variant_a}"\nB: "${created.experiment.variant_b}"\n\nEach contact gets the same variant every time. Nothing rolls out on its own — .experiment ${created.experiment.id} when there is enough data.`,
        };
      }
      if (verb === 'adopt') {
        const adopted = adoptWinner(arg(1), now);
        return { handled: true, reply: adopted.ok ? adopted.text : `⚠️ ${adopted.reason}` };
      }
      if (Number(arg(0))) return { handled: true, reply: experimentText(Number(arg(0))) };

      const list = listExperiments();
      if (!list.length) {
        return {
          handled: true,
          reply: ['No experiments yet.', '', 'Start one:', '.experiment new followup "Want me to hold your usual table?" | "Should I save your usual slot?"', `Kinds: ${EXPERIMENT_KINDS.join(', ')}`].join('\n'),
        };
      }
      return {
        handled: true,
        reply: ['🧪 *Experiments*', '', ...list.map((e) => `#${e.id} ${e.kind} — ${e.status} · .experiment ${e.id}`)].join('\n'),
      };
    }

    case 'proposals': {
      const list = currentProposals();
      if (!list.length) return { handled: true, reply: 'Nothing proposed yet. .strategy builds the list.' };
      return {
        handled: true,
        reply: ['🧾 *Proposals*', '', ...list.map((p) => `#${p.id} [${p.status}] ${p.title}`), '', 'Nothing is sent without you.'].join('\n'),
      };
    }

    default:
      return { handled: true, reply: brainMenu({ now }) };
  }
}

export default { handleBrainCommand, brainMenu };
