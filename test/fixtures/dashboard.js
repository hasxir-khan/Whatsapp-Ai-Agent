// Entirely disposable: no repository owner profile, service, key or session.
import { isolate } from '../helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const root = isolate('dashboard'),
  slug = 'sample-cafe',
  zone = 'America/New_York';
export const phone = '12025550139',
  other = '12025550141',
  privateText = 'PRIVATE_CLIENT_SENTENCE',
  fakeKey = 'private-placeholder-' + crypto.randomUUID();
Object.assign(process.env, {
  PLATFORM_ENABLED: '1',
  PLATFORM_DASHBOARD: '1',
  PLATFORM_SECRET: crypto.randomUUID(),
  PLATFORM_KEY_SECRET: crypto.randomUUID(),
  PLATFORM_OPERATOR_TOKEN: crypto.randomUUID(),
  PLATFORM_TENANT_TOKEN: crypto.randomUUID(),
  PLATFORM_DIR: path.join(root, 'platform'),
  TENANTS_DIR: path.join(root, 'tenants'),
  TENANT_DASHBOARD: '1',
  DASHBOARD_TOKEN: crypto.randomUUID(),
  TENANT_SLUG: slug,
  CONFIG_DIR: path.join(root, 'config'),
  PLATFORM_PUBLIC_URL: '',
  ENV_FILE: path.join(root, 'no.env'),
});
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
fs.writeFileSync(
  path.join(process.env.CONFIG_DIR, 'owner.json'),
  JSON.stringify({
    owner: { name: 'Fixture', number: process.env.MY_NUMBER },
    business: {
      name: 'Example Cafe',
      type: 'restaurant',
      timezone: zone,
      hours: 'Daily 09:00-17:00',
      currency: 'PKR',
    },
    features: { businessBrain: true, paymentReview: true, ownerDecisions: true, liveInbox: true },
  }),
);
export const tenant = await import('../../src/utils/db.js'),
  db = await import('../../platform/db.js');
export const reports = await import('../../src/services/tenantReports.js'),
  store = await import('../../platform/reportStore.js');
export const { dashboard, pages } = await import('../../platform/dashboard.js'),
  { record } = await import('../../platform/usage.js');
export const { localDateString, midnight, shiftDay } = await import('../../src/services/reportCalendar.js');
const plans = await import('../../platform/plans.js'),
  accounts = await import('../../platform/accounts.js'),
  session = await import('../../platform/session.js');
export const { createPlatformServer } = await import('../../platform/index.js');
await tenant.initDB();
await db.initPlatformDb();
plans.seedPlans();
reports.reportIndexes();
export const now = new Date(),
  day = localDateString(now, zone),
  from = midnight(day, zone),
  ago = (n) => new Date(Date.parse(from) - n * 60000).toISOString();
export function account(role = 'owner') {
  const id = crypto.randomUUID(),
    email = id + '@example.invalid';
  db.run('INSERT INTO accounts(id,email,email_norm,email_verified,created_at) VALUES(?,?,?,1,?)', [
    id,
    email,
    email,
    now.toISOString(),
  ]);
  accounts.recordConsent(id);
  if (role) db.run('INSERT INTO memberships VALUES(?,?,?,?)', [id, slug, role, now.toISOString()]);
  const s = session.issueSession(id);
  return { id, cookie: s.cookies.map((v) => v.split(';')[0]).join('; '), csrf: s.csrf, cookies: s.cookies };
}
export const owner = account(),
  staff = account('staff'),
  outsider = account(null);
db.run('INSERT INTO tenants(slug,account_id,name,status,plan_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [
  slug,
  owner.id,
  'Example Cafe',
  'active',
  'growth',
  from,
  from,
]);
db.run('INSERT INTO tenant_secrets VALUES(?,?,?,?)', [
  slug,
  'PLATFORM_TENANT_TOKEN',
  process.env.PLATFORM_TENANT_TOKEN,
  from,
]);
export const dir = path.join(process.env.TENANTS_DIR, slug, 'data');
fs.mkdirSync(dir, { recursive: true });
export async function seed() {
  // Returning contact on both sides of local midnight; owner turn on day 2.
  const put = (table, cols, ...vals) =>
    tenant.run(`INSERT INTO ${table}(${cols}) VALUES(${vals.map(() => '?')})`, vals);
  const at = (t) => new Date(Date.parse(from) + t).toISOString();
  for (const [n, role, time] of [
    [phone, 'user', ago(9)],
    [phone, 'assistant', ago(6)],
    [phone, 'user', from],
    [phone, 'owner', at(2)],
    [other, 'user', at(1)],
    [other, 'assistant', at(60001)],
  ])
    put('messages', 'number,role,content,created_at', n, role, privateText + ' price?', time);
  for (const [i, n] of [phone, other].entries()) {
    put('leads', 'number,score,goal,status,created_at', n, 80, privateText, 'quoted', i ? from : ago(5));
    put(
      'orders',
      'chat,total,paid_amount,status,created_at',
      n + '@s.whatsapp.net',
      50,
      35,
      'paid',
      i ? from : ago(5),
    );
    put('intake', 'number,fields,updated_at', n, JSON.stringify({ budget: privateText }), from);
    put('contact_tags', 'number,tag,created_at', n, privateText, from);
    put('contact_sources', 'number,source,created_at', n, i ? 'qr' : privateText, from);
    put(
      'agent_events',
      'agent,chat,kind,detail,created_at',
      'sales',
      n,
      'route',
      JSON.stringify({ probe: privateText }),
      from,
    );
  }
  for (const [type, detail] of [
    ['reply_guard_rejected', JSON.stringify({ problems: ['price range changed ' + fakeKey] })],
    ['reply_guard_rejected', JSON.stringify({ problems: ['language: expected x'] })],
    ['reply_superseded', privateText],
    ['quote_sent', privateText],
    ['rag_miss', privateText],
    ['analyst_report_sent', JSON.stringify({ conversations: 4, newLeads: 2, probe: privateText })],
  ])
    put('events', 'type,number,detail,created_at', type, phone, detail, from);
  put('growth_sends', 'agent,number,result,detail,created_at', 'followup', phone, 'sent', privateText, from);
  put('bookings', 'chat,created_at', phone + '@s.whatsapp.net', ago(3));
  put('decisions', 'number,action,reason,rationale,created_at', phone, 'react', 'ack', privateText, from);
  put(
    'decision_requests',
    'id,contact,type,order_id,status,deadline_at,payload,reason_text,created_at',
    'DR-1',
    phone,
    'payment',
    1,
    'pending',
    ago(1),
    JSON.stringify({ due: 44, proof: privateText }),
    privateText,
    from,
  );
  put(
    'decision_requests',
    'id,contact,type,order_id,status,resolved_at,reason_code,created_at',
    'DR-2',
    phone,
    'payment',
    1,
    'rejected',
    from,
    'wrong_amount_short',
    ago(5),
  );
  put(
    'decision_events',
    'request_id,actor,kind,to_status,reason_text,detail,created_at',
    'DR-2',
    phone,
    'decided',
    'rejected',
    privateText,
    fakeKey,
    from,
  );
  put(
    'payment_proofs',
    'id,request_id,contact,file,extracted',
    'private-proof',
    'DR-1',
    phone,
    'data/proofs/private-proof-image.png',
    fakeKey,
  );
  put('message_intents', 'intent,chat,created_at', 'support', phone, from);
  put('reply_reviews', 'number,vote,note,created_at', phone, 'down', privateText, from);
  record({
    tenant: slug,
    uid: 'fake-call-1',
    conversation: phone,
    agent: 'sales',
    kind: 'router',
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    totalTokens: 120,
    estimated: true,
    keySlot: 1,
    at: from,
  });
  record({
    tenant: slug,
    uid: 'fake-call-2',
    conversation: phone,
    agent: privateText,
    kind: 'voice',
    provider: 'groq',
    model: fakeKey,
    errorCategory: privateText,
    at: from,
  });
  await reports.publishReports({ dir, now, days: 14, zone });
  await store.reconcileTenant(slug, { dir, now });
}
export async function serve() {
  const http = createPlatformServer();
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  return { http, origin: 'http://127.0.0.1:' + http.address().port };
}
