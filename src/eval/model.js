// src/eval/model.js
// The two models the harness can put behind the bot.
//
//   scripted (deterministic): no keys, no network. Every model turn comes from
//     the scenario's recording, in order, and the harness checks that every
//     recorded step was actually used — a stale recording fails instead of
//     silently measuring nothing.
//   live: the real provider, behind a counter. The counter is the budget: at the
//     cap the next call is refused, so an eval run cannot spend more than
//     EVAL_LIVE_MAX_CALLS (default 60).
//
// Both are installed through the same seam the bot's own tests use
// (`__setFetch` in src/core/llm.js), so the pipeline under test is the real one.

// Importing the sandbox first is not optional: src/core/llm.js reads config at
// import time, and a config read before EVAL_DIR is set points at the real data
// directory. Every harness entry point does it for that reason.
import './evalEnv.js';
import { __setFetch } from '../core/llm.js';

const CONFIRM_SYSTEM = /confirm the action|asking the customer to confirm/i;

/** Which of the bot's model calls is this? */
export function classifyCall(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = String(messages.find((m) => m.role === 'system')?.content || '');
  if (body.response_format?.type === 'json_object' || body.generationConfig?.responseMimeType === 'application/json') {
    return 'json';
  }
  if (CONFIRM_SYSTEM.test(system)) return 'confirm';
  // Reading a document part by part is infrastructure, not a conversation
  // turn: it is answered from the scenario's recorded notes so a 70 KB brief
  // does not have to record thirteen model steps.
  if (/read documents sent on whatsapp|summari[sz]e documents/i.test(system)) return 'doc';
  if (/extract structured|Extract the project/i.test(system)) return 'json';
  return 'main';
}

function openAiText(text) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: text } }], usage: { total_tokens: Math.max(1, Math.ceil(text.length / 4)) } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function openAiTool(name, args) {
  const call = { id: 'call_eval', type: 'function', function: { name, arguments: JSON.stringify(args || {}) } };
  return new Response(
    JSON.stringify({ choices: [{ message: { content: '', tool_calls: [call] } }], usage: { total_tokens: 20 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * Deterministic model. One queue per conversation turn.
 */
export class ScriptedModel {
  constructor({ docNotes = [] } = {}) {
    this.queue = [];
    this.calls = [];
    this.exhausted = 0;
    this.installed = false;
    // What "reading the document" says. One note is reused for every chunk and
    // for the merge; several are consumed in order.
    this.docNotes = [...docNotes];
    this.lastDocNote = null;
  }

  install() {
    if (this.installed) return this;
    this.installed = true;
    __setFetch(async (url, opts = {}) => {
      let body = {};
      try {
        body = JSON.parse(opts.body || '{}');
      } catch {
        body = {};
      }
      const kind = classifyCall(body);
      this.calls.push({ kind, model: body.model || null });

      // Utility calls the conversation cannot do without: give them a stable,
      // valid answer so they never eat a scripted step.
      if (kind === 'json') return openAiText('{}');
      if (kind === 'confirm') {
        return openAiText('Just checking the details — shall I go ahead?');
      }
      if (kind === 'doc') {
        const note = this.docNotes.length ? this.docNotes.shift() : this.lastDocNote || 'Nothing useful in this part.';
        this.lastDocNote = note;
        return openAiText(note);
      }

      const step = this.queue.shift();
      if (!step) {
        // Still answer, so the run finishes and the report can say exactly
        // which turn lost its recording.
        this.exhausted += 1;
        return openAiText('One moment please.');
      }
      if (step.timeout) {
        // The chain's timeout path: this model never answered in time.
        const err = new Error('provider timed out');
        err.name = 'TimeoutError';
        err.status = 0;
        throw err;
      }
      if (step.tool) return openAiTool(step.tool, step.args || {});
      if (step.error) {
        const err = new Error(step.error.message || 'provider error');
        err.status = Number(step.error.status) || 500;
        err.body = step.error.message || 'provider error';
        throw err;
      }
      return openAiText(step.text || '');
    });
    return this;
  }

  beginTurn(steps = []) {
    this.queue = [...steps];
  }

  endTurn() {
    const leftover = this.queue.length;
    this.queue = [];
    return leftover;
  }

  reset() {
    this.queue = [];
    this.calls = [];
    this.exhausted = 0;
    this.lastDocNote = null;
  }
}

/**
 * Live model: the real provider, counted.
 * @param {{maxCalls?:number}} opts
 */
export class LiveModel {
  constructor({ maxCalls = 60 } = {}) {
    this.maxCalls = maxCalls;
    this.calls = 0;
    this.tokens = 0;
    this.blocked = 0;
    this.installed = false;
    this.realFetch = globalThis.fetch;
  }

  install() {
    if (this.installed) return this;
    this.installed = true;
    const real = this.realFetch;
    // The same function the bot's provider calls go through, kept on the
    // instance so a test can exercise the counter without a network.
    this.fetchImpl = async (url, opts = {}) => {
      this.reserve();
      const res = await real(url, opts);
      // Audio responses do not contain token JSON. Do not buffer a second copy.
      if (res.headers?.get('content-type')?.startsWith('audio/')) return res;
      try {
        const clone = res.clone();
        const text = await clone.text();
        const parsed = JSON.parse(text);
        const used = parsed.usage?.total_tokens ?? parsed.usageMetadata?.totalTokenCount ?? 0;
        this.tokens += Number(used) || 0;
      } catch {
        /* token accounting is a nicety, not a gate */
      }
      return res;
    };
    __setFetch(this.fetchImpl);
    return this;
  }

  // The very same allowance covers non-HTTP transports (Edge WebSocket).
  reserve() {
    if (this.calls >= this.maxCalls) {
      this.blocked += 1;
      const err = new Error(`eval budget reached (${this.maxCalls} calls)`);
      err.status = 429;
      err.body = 'eval budget reached';
      throw err;
    }
    this.calls += 1;
  }

  reset() {
    this.calls = 0;
    this.tokens = 0;
    this.blocked = 0;
  }
}

/**
 * Voice notes: the transcription call is a plain global fetch to Groq Whisper.
 * In deterministic mode we answer it with the scenario's transcript instead, so
 * no audio ever leaves the machine and no key is needed.
 */
export function installTranscriptStub(transcript) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/audio/transcriptions')) {
      return new Response(
        JSON.stringify({ text: transcript, language: 'ur', duration: 6.2 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return real(url, opts);
  };
  return () => {
    globalThis.fetch = real;
  };
}

export default { ScriptedModel, LiveModel, classifyCall, installTranscriptStub };
