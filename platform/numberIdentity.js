// Business-number uniqueness and trial abuse checks need equality, never a
// plaintext address. Stable per-install salt survives session-secret rotation.
import crypto from 'node:crypto';
export const numberId = (number, salt) =>
  'n:' +
  crypto.createHmac('sha256', salt).update(String(number).replace(/\D/g, '').replace(/^00/, '')).digest('hex');
export function migrateNumbers(db) {
  db.run('CREATE TABLE IF NOT EXISTS number_identity_salt(id INTEGER PRIMARY KEY,salt TEXT NOT NULL)');
  db.run('INSERT OR IGNORE INTO number_identity_salt VALUES(1,?)', [crypto.randomBytes(32).toString('hex')]);
  const salt = db.exec('SELECT salt FROM number_identity_salt')[0].values[0][0];
  for (const t of ['tenants', 'trial_numbers']) {
    const legacy =
      db.exec(`SELECT number FROM ${t} WHERE number IS NOT NULL AND number NOT LIKE 'n:%'`)[0]?.values || [];
    for (const [number] of legacy)
      db.run(`UPDATE ${t} SET number=? WHERE number=?`, [numberId(number, salt), number]);
  }
  return salt;
}
