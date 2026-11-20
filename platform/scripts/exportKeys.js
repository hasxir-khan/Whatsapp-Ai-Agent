// Operator-only, never an HTTP route. Read a snapshot; never print a key.
import fs from 'node:fs';
import { readSnapshot } from '../db.js';
import { exportKeys } from '../keys.js';
import { validSlug } from '../../src/services/validation.js';

const [slug, file, flag] = process.argv.slice(2);
try {
  if (!validSlug(slug) || !file || (flag && flag !== '--with-keys')) throw new Error();
  const result = await readSnapshot((select) => exportKeys(slug, { select, withKeys: flag === '--with-keys' }));
  if (!result.ok) throw new Error(result.error);
  fs.writeFileSync(file, JSON.stringify(result.keys, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Wrote a new private export file.');
} catch {
  console.error('Export refused. Use: node platform/scripts/exportKeys.js SLUG NEW_FILE [--with-keys]. Plaintext requires PLATFORM_ALLOW_KEY_EXPORT=1 and the original master secret.');
  process.exitCode = 1;
}
