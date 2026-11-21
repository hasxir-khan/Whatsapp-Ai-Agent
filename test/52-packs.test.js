// Phase 6 Part 2 — industry agent packs.
//
// A pack is only useful if it is safe: it must validate, it must never ask for
// a tool the tenant does not have, and a clinic must never answer a medical
// question — least of all an emergency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, fakeSock, textMessages, incomingMessage, CLIENT, waitFor } from './helpers.js';

const dataDir = isolate('agent-packs');
const configDir = path.join(dataDir, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.CONFIG_DIR = configDir;
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;

const PACKS = ['restaurant', 'clinic', 'salon', 'real-estate', 'shop', 'agency', 'school', 'generic'];

function writeProfile({ type = 'Clinic', industry = 'clinic', features = {}, business = {} } = {}) {
  const A = PACKS.includes(industry) ? industry : 'clinic';
  fs.writeFileSync(
    path.join(configDir, 'owner.json'),
    JSON.stringify(
      {
        industry: A,
        business: {
          name: 'Demo Clinic',
          type,
          city: 'Islamabad',
          timezone: 'Asia/Karachi',
          hours: 'Mon–Sat 10:00–19:00',
          offers: ['10% off your first visit'],
          emergency: { label: 'emergency services', number: '1122' },
          ...business,
        },
        catalog: { items: [{ name: 'Consultation', kind: 'service', price: 2000, cost: 800 }] },
        policies: { maxDiscountPercent: 15, returns: 'Within 7 days with the receipt.' },
        owner: { name: 'Example Owner', number: '923001234567', team: [] },
        marketing: { approvalMode: true, minDaysBetweenPromos: 14, events: [], channels: [] },
        features: { multiAgent: true, toolCalling: true, catalog: true, crm: true, ...features },
      },
      null,
      2
    )
  );
}
writeProfile();

const A = await import('../src/services/agents.js');
const P = await import('../src/services/agentPacks.js');
const T = await import('../src/services/templates.js');
const db = await import('../src/utils/db.js');
const { handleIncoming } = await import('../src/handlers/messageHandler.js');
const { reloadProfile } = await import('../src/services/profile.js');
const { config } = await import('../src/config/env.js');

await db.initDB();

// ── every pack ───────────────────────────────────────────────

test('every industry ships two or three assistants, all disabled', () => {
  for (const id of PACKS) {
    const pack = A.templateAgents(id);
    assert.ok(pack.length >= 2 && pack.length <= 3, `${id}: ${pack.length} agents`);
    assert.equal(pack.every((a) => a.enabled === false), true, `${id}: must be off until the owner says otherwise`);
    assert.equal(new Set(pack.map((a) => a.id)).size, pack.length, `${id}: duplicate ids`);
  }
});

test('every pack agent validates: id, role, instructions, a hand-off target and never-rules', () => {
  writeProfile();
  reloadProfile();
  for (const id of PACKS) {
    for (const agent of A.templateAgents(id)) {
      const check = A.validateAgent({ ...agent, handoff: agent.handoff || 'owner' });
      assert.deepEqual(check.errors, [], `${id}/${agent.id}: ${check.errors.join('; ')}`);
      assert.ok(agent.instructions.length > 20, `${id}/${agent.id}: instructions too thin`);
      assert.ok(agent.never.length >= 2, `${id}/${agent.id}: needs "never do" rules`);
      assert.ok(agent.never.every((r) => r.length <= 160), `${id}/${agent.id}: a never-rule is too long`);
    }
  }
});

test('a pack agent can only ever ask for tools the tenant has', () => {
  const tenant = new Set(['check_stock', 'handoff']);
  for (const id of PACKS) {
    for (const agent of A.templateAgents(id)) {
      const allowed = A.agentTools(agent, tenant);
      for (const tool of allowed) assert.equal(tenant.has(tool), true, `${id}/${agent.id}: ${tool} is not the tenant's`);
      for (const tool of agent.tools) assert.ok(P.KNOWN_TOOLS.includes(tool), `${id}/${agent.id}: unknown tool ${tool}`);
    }
  }
});

test('the templates on disk carry the same packs, still switched off', () => {
  for (const id of PACKS) {
    const raw = JSON.parse(fs.readFileSync(path.join('config/templates', `${id}.json`), 'utf8'));
    assert.equal(raw.features.multiAgent, false, `${id}: multiAgent must ship off`);
    assert.equal(raw.features.marketingAgents, false, `${id}: marketingAgents must ship off`);
    assert.deepEqual(raw.agents.map((a) => a.id), P.packFor(id).map((a) => a.id), `${id}: template and pack disagree`);
    assert.equal(raw.agents.every((a) => a.enabled === false), true, `${id}: ships enabled`);
    assert.ok(raw.marketing && raw.marketing.approvalMode === true, `${id}: promos must need approval`);
  }
});

test('the template builder keeps the pack and the marketing block', () => {
  const built = T.buildProfileFromTemplate('clinic');
  assert.equal(built.agents.length, P.packFor('clinic').length);
  assert.equal(built.features.marketingAgents, false);
  assert.equal(built.marketing.approvalMode, true);
});

// ── the clinic ───────────────────────────────────────────────

test('clinic assistants are forbidden to diagnose or advise', () => {
  for (const agent of A.templateAgents('clinic')) {
    const text = agent.never.join(' ').toLowerCase();
    assert.match(text, /diagnos/);
    assert.match(text, /medicine|dosage/);
  }
});

test('emergency words are caught in English, Roman Urdu and Urdu script', () => {
  const cases = [
    ['my father has chest pain and cannot breathe', true],
    ['sans nahi aa rahi, jaldi karo', true],
    ['سانس نہیں آ رہی، فوراً آئیں', true],
    ['what are your timings tomorrow?', false],
    ['mera appointment confirm hai?', false],
  ];
  for (const [text, expected] of cases) {
    assert.equal(Boolean(P.detectEmergency(text)), expected, text);
  }
});

test('an emergency gets the configured number, no advice, and the owner is told', async () => {
  writeProfile();
  reloadProfile();
  db.run('DELETE FROM messages');

  const sock = fakeSock();
  const number = CLIENT.number;
  await handleIncoming(sock, incomingMessage('chest pain, cannot breathe'));
  await waitFor(() => sock.sent.length > 0, { timeout: 6000 });

  const messages = textMessages(sock.sent, number);
  assert.ok(messages.length >= 1, 'the customer got a reply');
  const reply = messages.join('\n');
  assert.match(reply, /1122/, 'the configured emergency number is in the reply');
  assert.doesNotMatch(reply, /\b\d+\s?mg\b/, 'no dosage');
  assert.doesNotMatch(reply, /take (a )?(tablet|medicine)/i, 'no medicine advice');

  const ownerTexts = () =>
    sock.sent.filter((m) => String(m.jid).startsWith(config.owner.number)).map((m) => String(m.payload?.text || ''));
  // notifyOwner goes through the humanizer (typing delay), so give it a moment.
  await waitFor(() => ownerTexts().some((t) => /emergency/i.test(t)), { timeout: 6000 }).catch(() => {});
  assert.ok(ownerTexts().some((t) => /emergency/i.test(t)), 'the owner was alerted');
});

test('a normal clinic question is not treated as an emergency', () => {
  assert.equal(P.detectEmergency('kal subah appointment mil sakti hai?'), null);
});

test('with multiAgent off the emergency guard does nothing at all', () => {
  writeProfile({ features: { multiAgent: false } });
  reloadProfile();
  assert.equal(P.emergencyGuardEnabled(), false);
  writeProfile();
  reloadProfile();
});
