// src/services/typingTest.js
// `.typing-test` — five presence updates and a phone in the owner's hand.
//
// Why a command and not a test: whether the "typing…" bubble appears is decided
// by the *receiver's* phone, not by our process. A fake socket proves we called
// a function; only a human looking at the other screen can prove WhatsApp
// accepted the call. So the bot sends presence four different ways, one after
// another, each clearly separated in time, and the owner says which one was
// visible. `.typing-test use <n>` stores that answer as the default.
//
// The variants exist because each of the known causes looks identical from our
// side and different from theirs:
//   a. composing only                     — the shape that was always used
//   b. presenceSubscribe, then composing   — WhatsApp wants a subscription first
//   c. 'available', then composing         — some accounts ignore composing
//                                            until the device is "online"
//   d. composing on the alternate JID      — LID chats: the message came from
//                                            one address, the phone shows the
//                                            other
//
// Only presence is sent. No text, ever — a diagnostic must not look like a
// message to the customer.

import { profile, setPath } from './profile.js';

export const STRATEGIES = {
  a: { id: 'a', label: 'composing only', hint: 'the current default' },
  b: { id: 'b', label: 'presenceSubscribe, then composing', hint: 'subscription first' },
  c: { id: 'c', label: 'available, then composing', hint: 'device online first' },
  d: { id: 'd', label: 'composing on the alternate JID', hint: 'LID vs phone form' },
};

export const STRATEGY_IDS = Object.keys(STRATEGIES);

function num(value, fallback, { min = 0, max = 120000 } = {}) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** Timings, overridable so a test does not take a minute. */
export function testTiming(env = process.env) {
  return {
    // A floor of 10 ms, not 100: the tests drive this with short values and a
    // silently-substituted default is exactly the kind of thing that makes a
    // diagnostic lie about what it measured.
    holdMs: num(env.TYPING_TEST_HOLD_MS, 6000, { min: 10, max: 60000 }),
    gapMs: num(env.TYPING_TEST_GAP_MS, 8000, { min: 10, max: 60000 }),
    refreshMs: num(env.TYPING_TEST_REFRESH_MS, 8000, { min: 10, max: 60000 }),
  };
}

/**
 * Send presence through whichever object we were given:
 * a raw socket (`sendPresenceUpdate(state, jid)`) or a transport
 * (`setPresence(jid, state)`). The argument order is the whole point of the
 * exercise, so it is spelled out once, here.
 */
export function presenceSender(target) {
  if (typeof target?.sendPresenceUpdate === 'function') {
    return {
      via: 'sendPresenceUpdate',
      send: async (state, jid) => target.sendPresenceUpdate(state, jid || undefined),
    };
  }
  if (typeof target?.setPresence === 'function') {
    return { via: 'setPresence', send: async (state, jid) => target.setPresence(jid || undefined, state) };
  }
  return null;
}

async function subscribe(target, jid) {
  const fn = target?.presenceSubscribe || target?.sock?.presenceSubscribe;
  if (typeof fn !== 'function') return { ok: false, error: 'not supported' };
  try {
    await fn.call(target?.presenceSubscribe ? target : target.sock, jid);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 120) };
  }
}

/**
 * What the four variants will do for this contact, in order.
 * `forms` comes from transportAudit.jidForms(number).
 */
export function planVariants(forms = {}) {
  const phone = forms.phone || forms.replyJid || null;
  const primary = forms.replyJid || phone;
  const alternate = forms.lid && forms.lid !== primary ? forms.lid : null;

  const plan = [
    { id: 'a', jid: primary, steps: ['composing'], label: STRATEGIES.a.label },
    { id: 'b', jid: primary, steps: ['subscribe', 'composing'], label: STRATEGIES.b.label },
    { id: 'c', jid: primary, steps: ['available', 'composing'], label: STRATEGIES.c.label },
  ];

  if (alternate) {
    plan.push({ id: 'd', jid: alternate, steps: ['composing'], label: STRATEGIES.d.label });
  } else if (phone && primary !== phone) {
    plan.push({ id: 'd', jid: phone, steps: ['composing'], label: STRATEGIES.d.label });
  } else {
    plan.push({
      id: 'd',
      jid: null,
      steps: [],
      skipped: 'this contact has only ever written from the phone-number form, so there is no second address to try',
      label: STRATEGIES.d.label,
    });
  }
  return plan;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run every variant, one after another, with a gap between them.
 * Returns a report a human can act on — never throws for a failed presence.
 */
export async function runTypingTest({ target, number, forms = null, timing = testTiming(), now = () => Date.now() } = {}) {
  const { jidForms, noteTyping } = await import('./transportAudit.js');
  const sender = presenceSender(target);
  if (!sender) {
    return { ok: false, error: 'no_transport', message: 'No connected transport in this process, so there is nothing to send presence with.' };
  }

  const resolved = forms || jidForms(number);
  const plan = planVariants(resolved);
  const startedAt = now();
  const results = [];

  for (const [index, variant] of plan.entries()) {
    if (variant.skipped) {
      results.push({ ...variant, steps: [], ok: false, skipped: variant.skipped });
    } else {
      const steps = [];
      let ok = true;
      for (const step of variant.steps) {
        if (step === 'subscribe') {
          const res = await subscribe(target, variant.jid);
          steps.push({ step, at: now() - startedAt, ok: res.ok, error: res.error || null });
          if (!res.ok) ok = false;
          continue;
        }
        const state = step === 'available' ? 'available' : 'composing';
        const jid = step === 'available' ? null : variant.jid;
        try {
          await sender.send(state, jid);
          steps.push({ step: state, jid, at: now() - startedAt, ok: true });
          noteTyping({ jid: jid || null, state, via: sender.via, sock: target, ok: true });
        } catch (err) {
          ok = false;
          steps.push({ step: state, jid, at: now() - startedAt, ok: false, error: String(err?.message || err).slice(0, 120) });
          noteTyping({ jid: jid || null, state, via: sender.via, sock: target, ok: false, error: err?.message });
        }
      }

      // Keep "typing…" alive for `holdMs`, refreshing at `refreshMs`, then
      // always take it down — a test must never leave a bubble on the screen.
      let waited = 0;
      while (waited + timing.refreshMs <= timing.holdMs) {
        await sleep(timing.refreshMs);
        waited += timing.refreshMs;
        try {
          await sender.send('composing', variant.jid);
          noteTyping({ jid: variant.jid, state: 'composing', via: sender.via, sock: target, ok: true });
        } catch {
          /* counted by the first send */
        }
      }
      if (waited < timing.holdMs) {
        await sleep(timing.holdMs - waited);
      }
      try {
        await sender.send('paused', variant.jid);
        noteTyping({ jid: variant.jid, state: 'paused', via: sender.via, sock: target, ok: true });
        steps.push({ step: 'paused', jid: variant.jid, at: now() - startedAt, ok: true });
      } catch (err) {
        ok = false;
        steps.push({ step: 'paused', jid: variant.jid, at: now() - startedAt, ok: false, error: String(err?.message || err).slice(0, 120) });
      }
      results.push({ ...variant, steps, ok });
    }

    if (index < plan.length - 1) await sleep(timing.gapMs);
  }

  return {
    ok: true,
    number: resolved.number || String(number || '').replace(/\D/g, ''),
    jid: resolved.replyJid,
    via: sender.via,
    holdMs: timing.holdMs,
    gapMs: timing.gapMs,
    durationMs: now() - startedAt,
    results,
  };
}

/** The reply the owner reads while looking at the other phone. */
export function describeResults(report) {
  if (!report?.ok) return report?.message || 'The typing test could not run.';
  const lines = [
    `*Typing test* — +${report.number || '?'} · ${report.results.length} variants`,
    `Sent through \`${report.via}\` · each one holds ${report.holdMs / 1000}s, then pauses · ${report.gapMs / 1000}s between variants.`,
    '',
  ];
  for (const [index, variant] of report.results.entries()) {
    const n = index + 1;
    if (variant.skipped) {
      lines.push(`${n}. ${variant.label} — skipped: ${variant.skipped}`);
      continue;
    }
    const sent = variant.steps.filter((s) => s.step !== 'paused').map((s) => `${s.step}${s.jid ? ` → ${s.jid}` : ''}${s.ok ? '' : ' (failed)'}`);
    lines.push(`${n}. ${variant.label}${variant.ok ? '' : ' ⚠️'}`);
    lines.push(`   ${sent.join(' · ') || 'nothing sent'}`);
  }
  lines.push('');
  lines.push('Watch the phone. Which number did you see “typing…” for?');
  lines.push('Set it as the default: .typing-test use <number>');
  lines.push('If none of them showed, that is useful too: reply with that and check .health.');
  return lines.join('\n');
}

/** The effective strategy: what the owner chose, else what the env says, else a. */
export function strategy() {
  try {
    const chosen = profile()?.typing?.strategy;
    if (chosen && STRATEGIES[String(chosen)]) return String(chosen);
  } catch {
    /* an unreadable profile is not a reason to stop sending presence */
  }
  const env = String(process.env.TYPING_STRATEGY || '').trim();
  return STRATEGIES[env] ? env : 'a';
}

/** `.typing-test use <n>` — persisted in the tenant's owner.json. */
export function setStrategy(raw) {
  const key = String(raw || '').trim().toLowerCase();
  const byNumber = STRATEGY_IDS[Number(key) - 1];
  const chosen = STRATEGIES[key] ? key : byNumber;
  if (!chosen) {
    throw new Error(
      `Pick 1-${STRATEGY_IDS.length} (${STRATEGY_IDS.map((id, i) => `${i + 1}=${STRATEGIES[id].label}`).join(', ')})`,
    );
  }
  setPath('typing.strategy', chosen);
  return chosen;
}

export default {
  STRATEGIES,
  STRATEGY_IDS,
  testTiming,
  presenceSender,
  planVariants,
  runTypingTest,
  describeResults,
  strategy,
  setStrategy,
};
