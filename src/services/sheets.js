// src/services/sheets.js
// Optional Google Sheets lead export — pure HTTP + JWT, no googleapis package.
// Completely optional: if GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT aren't set,
// every function is a no-op and the local database stays the source of truth.

import { createSign } from 'node:crypto';
import { config } from '../config/env.js';

let cachedToken = null;
let tokenExpiry = 0;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || 'Leads';

export function sheetsEnabled() {
  return !!(config.sheets.id && config.sheets.serviceAccount);
}

function createJWT(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    })
  ).toString('base64url');

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(serviceAccount.private_key, 'base64url');
  return `${header}.${payload}.${signature}`;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  if (!sheetsEnabled()) return null;

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(config.sheets.serviceAccount);
  } catch {
    console.error('Sheets: GOOGLE_SERVICE_ACCOUNT is not valid JSON');
    return null;
  }

  const jwt = createJWT(serviceAccount);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    signal: AbortSignal.timeout(15000),
  });

  const data = await res.json();
  if (!data.access_token) {
    console.error('Sheets auth failed:', data.error_description || data.error);
    return null;
  }

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function appendRow(values) {
  const token = await getAccessToken();
  if (!token) return false;

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${config.sheets.id}/values/` +
    `${encodeURIComponent(SHEET_TAB)}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [values] }),
    signal: AbortSignal.timeout(20000),
  });

  return res.ok;
}

const HEADER = [
  'Updated', 'Number', 'Name', 'Company', 'Country', 'Currency', 'Project type',
  'Goal', 'Features', 'Timeline', 'Budget', 'Quote min', 'Quote max', 'Status',
];

export async function initSheet() {
  if (!sheetsEnabled()) {
    console.log('📋 Google Sheets not configured — using local database only');
    return;
  }
  const token = await getAccessToken();
  if (!token) return;

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${config.sheets.id}/values/${encodeURIComponent(SHEET_TAB)}!A1:N1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => ({}));

  if (!data.values || !data.values.length) {
    await appendRow(HEADER);
    console.log('📊 Sheet headers created');
  } else {
    console.log('📊 Google Sheets connected');
  }
}

/** Append one lead (called when a quote is sent). */
export async function saveLeadToSheet(lead = {}) {
  if (!sheetsEnabled() || !lead.number) return false;
  const row = [
    new Date().toISOString(),
    lead.number,
    lead.name || '',
    lead.company || '',
    lead.country || '',
    lead.quote_currency || 'PKR',
    lead.project_type || '',
    (lead.goal || '').slice(0, 400),
    Array.isArray(lead.features) ? lead.features.join('; ') : lead.features || '',
    lead.timeline || '',
    lead.budget || '',
    lead.quote_min ?? '',
    lead.quote_max ?? '',
    lead.status || 'quoted',
  ];
  try {
    return await appendRow(row);
  } catch (err) {
    console.error('Sheets append failed:', err.message);
    return false;
  }
}

export default { initSheet, saveLeadToSheet, sheetsEnabled };
