// Shared by every tenant launcher. A managed worker is started only by the
// control plane, including v1 tenants provisioned before the metadata marker.
import fs from 'node:fs';
import path from 'node:path';

export function platformManaged(dir, meta) {
  if (meta?.platformManaged) return true;
  try { return /^PLATFORM_TENANT_TOKEN=\S+/m.test(fs.readFileSync(path.join(dir, '.env'), 'utf8')); }
  catch { return false; }
}

export function childBase(isolated = false) {
  if (!isolated && !Object.keys(process.env).some((key) => key.startsWith('PLATFORM_'))) return process.env;
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'NODE_ENV', 'SystemRoot'].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

export function emptyProviderSlots() {
  const env = { GOOGLE_API_KEY: '', LLM_KEY_REFS: '{}' };
  for (const provider of ['GROQ', 'GEMINI', 'OPENROUTER']) {
    for (const suffix of ['', '_2', '_3']) env[`${provider}_API_KEY${suffix}`] = '';
  }
  return env;
}

/** Learners and indexers do not need provider credentials on a managed tenant. */
export function helperBase(dir, meta) {
  return platformManaged(dir, meta) ? { ...childBase(true), ...emptyProviderSlots() } : childBase();
}
