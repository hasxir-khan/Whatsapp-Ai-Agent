import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { platformDir } from '../env.js';
import { get, run, all, billingTransaction as transaction } from '../db.js';
import {
  extractFields,
  maskAccount,
  maskProofText,
  runChecks,
  riskFromChecks,
} from '../../src/services/paymentProofs.js';
import { invoice, paymentCard, uuid } from './payments.js';
import { settings } from './catalog.js';
import { stamp, need, fromDecimal, DAY } from './rules.js';
import { recordAudit } from './audit.js';

import { attachment, source } from './proofInput.js';
const folder = () => path.join(platformDir(), 'billing-proofs');
function proofFile(id) {
  need(uuid(id), 'not_found', 404);
  return path.join(folder(), id + '.json');
}
function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
function since(sid, now) {
  return get('SELECT count(*) n FROM b_proof WHERE sid=? AND at>?', [sid, stamp(+new Date(now) - DAY)]).n;
}
function evidence(input, i) {
  const text = input.text;
  need(
    typeof text === 'string' && text.length >= 4 && text.length <= 4096,
    'short_redacted_transcription_required'
  );
  need(
    !maskProofText(text).cardSeen && !/\b(?:cvv|cvc|pin|card\s*(?:number|no\b))\b/i.test(text),
    'remove_card_details'
  );
  let bytes = Buffer.from(text),
    kind = 'text';
  if (input.file) ({ bytes, kind } = attachment(input.file));
  // Opaque screenshots can hide PANs and PDFs can contain active content. Never spool
  // raw pixels/document, metadata, filename or arbitrary prose. Retain a structured,
  // masked evidence copy plus content fingerprint; record the field source separately.
  const f = extractFields(text);
  const c =
    new RegExp('(?:\\b' + i.currency + '|\\bamount:?)\\s*([\\d,]+(?:\\.\\d+)?)', 'i').exec(text)?.[1] ||
    /([\d,]+(?:\.\d+)?)\s*(?:PKR|INR|USD|EUR|AED|SAR)\b/i.exec(text)?.[1];
  const reference = /\b(?:tid|trx|txn|ref(?:erence)?|transaction\s*id)\b[:\s#-]*([A-Z0-9-]{4,32})\b/i
    .exec(text)?.[1]
    ?.toUpperCase();
  const fields = {
    amount: c ? fromDecimal(c, i.currency) : null,
    currency: new RegExp('\\b' + i.currency + '\\b', 'i').test(text) ? i.currency : f.currency || null,
    receiver: f.receiver || null,
    accountTail: f.accountTail ? String(f.accountTail).slice(-4) : null,
    occurredAt: f.occurredAt || null,
    referenceTail: reference ? reference.slice(-4) : null,
  };
  return {
    fields,
    kind,
    digest: digest(bytes),
    reference: reference
      ? createHmac('sha256', get('SELECT salt FROM number_identity_salt').salt)
          .update(reference)
          .digest('hex')
      : null,
  };
}
function checks(i, p, now) {
  const f = p.fields,
    methods = JSON.parse(i.methods);
  const method =
    methods.find((m) => m.tail && m.tail === f.accountTail) ||
    methods.find((m) => m.receiver && f.receiver?.toLowerCase().includes(m.receiver.toLowerCase())) ||
    methods[0] ||
    {};
  const duplicate = (field, value) =>
    value && !!get(`SELECT 1 FROM b_proof WHERE ${field}=? AND id!=? AND purged=0 LIMIT 1`, [value, p.id]);
  const seen = [
    {
      id: 'prior submission',
      sha256: duplicate('digest', p.digest) ? p.digest : null,
      extracted: { reference: duplicate('reference', p.reference) ? 'submitted' : null },
    },
  ];
  const rows = runChecks({
    extracted: { ...f, reference: p.reference ? 'submitted' : null, sha256: p.digest },
    order: {
      total: i.total,
      paid_amount: i.paid,
      currency: i.currency,
      status: i.due ? 'awaiting_payment' : 'paid',
      created_at: i.at,
    },
    proofs: seen,
    now: new Date(now),
    settings: { maxProofsPerDay: 5 },
    context: {
      business: { payment: { accountTail: method.tail, accountName: method.receiver } },
      submitted: since(i.sid, now),
    },
  });
  if (f.accountTail && methods.some((m) => m.tail) && !methods.some((m) => m.tail === f.accountTail)) {
    Object.assign(
      rows.find((r) => r.id === 'receiver'),
      { status: 'fail', detail: 'The supplied account tail does not match a configured receiver.' }
    );
  }
  return { checks: rows, risk: riskFromChecks(rows).risk };
}
export function uploadProof(slug, id, input, now = Date.now()) {
  const i = invoice(slug, id);
  need(i.due > 0, 'no_balance_due', 409);
  need(since(i.sid, now) < 5, 'daily_proof_limit', 429);
  const proof = randomUUID(),
    pid = randomUUID(),
    p = { ...evidence(input, i), id: proof },
    result = checks(i, p, now);
  fs.mkdirSync(folder(), { mode: 0o700, recursive: true });
  const file = proofFile(proof);
  fs.writeFileSync(
    file,
    JSON.stringify({
      kind: p.kind,
      source: input[source] || (p.kind === 'text' ? 'submitted text' : 'owner transcription'),
      ...p.fields,
      accountTail: p.fields.accountTail ? maskAccount(p.fields.accountTail) : null,
    }),
    { flag: 'wx', mode: 0o600 }
  );
  try {
    return transaction(() => {
      run('INSERT INTO b_review(id,invoice,state,currency,at,provider) VALUES(?,?,?,?,?,?)', [
        pid,
        id,
        'review',
        i.currency,
        stamp(now),
        'manual',
      ]);
      run(
        'INSERT INTO b_proof(id,payment,sid,at,expires,digest,reference,fields,checks,risk,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        [
          proof,
          pid,
          i.sid,
          stamp(now),
          stamp(+new Date(now) + settings().proofDays * DAY),
          p.digest,
          p.reference,
          JSON.stringify(p.fields),
          JSON.stringify(result.checks),
          result.risk,
          p.kind,
        ]
      );
      recordAudit({ action: 'billing_proof_received', tenant: slug });
      return { id: pid, status: 'under_review' };
    });
  } catch (e) {
    if (!get('SELECT id FROM b_proof WHERE id=?', [proof])) fs.rmSync(file, { force: true });
    throw e;
  }
}
export function scopedProof(slug, id, now = Date.now()) {
  const p = get('SELECT f.* FROM b_proof f JOIN b_sub s ON s.sid=f.sid WHERE s.slug=? AND f.id=?', [
    slug,
    id,
  ]);
  need(p, 'not_found', 404);
  need(!p.purged && p.expires > stamp(now), 'proof_expired', 410);
  return p;
}
export function readProof(slug, id, now) {
  scopedProof(slug, id, now);
  return JSON.parse(fs.readFileSync(proofFile(id), 'utf8'));
}
export function recheck(slug, id, now = Date.now()) {
  const p = scopedProof(slug, id, now),
    i = invoice(slug, paymentCard(slug, p.payment).invoice),
    r = checks(i, { ...p, fields: JSON.parse(p.fields) }, now);
  return transaction(() => {
    run('UPDATE b_proof SET checks=?,risk=? WHERE id=?', [JSON.stringify(r.checks), r.risk, id]);
    recordAudit({ action: 'billing_proof_rechecked', tenant: slug });
    return r;
  });
}
export function purgeProofs(now = Date.now(), sid = null) {
  for (const p of all(`SELECT id FROM b_proof WHERE purged=0 AND ${sid ? 'sid=?' : 'expires<=?'}`, [
    sid || stamp(now),
  ])) {
    fs.rmSync(proofFile(p.id), { force: true });
    run(
      "UPDATE b_proof SET purged=1,digest='',reference=NULL,fields='{}',checks='[]',risk='expired' WHERE id=?",
      [p.id]
    );
  }
  // A power loss between file creation and DB commit cannot strand evidence.
  if (!sid && fs.existsSync(folder()))
    for (const name of fs.readdirSync(folder())) {
      const id = name.replace(/\.json$/, '');
      if (uuid(id) && !get('SELECT 1 FROM b_proof WHERE id=?', [id]))
        fs.rmSync(proofFile(id), { force: true });
    }
}
