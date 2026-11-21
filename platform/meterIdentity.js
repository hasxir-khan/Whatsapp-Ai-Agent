// Part 3 already wrapped legacy conversation labels using HMAC-SHA256 keyed by
// installSalt + NUL + slug. Keep those IDs (and monthly distinct counts). The
// 64-hex-character salt plus separator and slug exceed SHA-256's 64-byte HMAC
// block: RFC 2104 reduces that key to SHA256(key) before using it. Deliver only
// this tenant's effective key to its worker, never the installation secret.
import { createHash } from 'node:crypto';
import { alias } from '../src/services/reportContract.js';

export function tenantMeterKey(installSalt, slug) {
  if (!/^[0-9a-f]{64}$/.test(installSalt) || !slug) throw new Error('missing_meter_key');
  return createHash('sha256').update(`${installSalt}\0${slug}`).digest();
}

// Old Part 2 writers (and dashboards that were never enabled) could have
// persisted the unkeyed label itself. Upgrade on open, before reads, not just
// for active tenants or entries beyond the importer cursor. Already-keyed
// Part 3 rows and rollups retain their identities.
export function migrateMeterIdentities(db, installSalt) {
  const pattern = 'id-' + '[a-p]'.repeat(16);
  db.create_function('protect_meter_label', (slug, label) =>
    label ? alias(label, tenantMeterKey(installSalt, slug), 'chat') : null,
  );
  db.run(
    'UPDATE usage_events SET conversation=protect_meter_label(tenant,conversation) WHERE conversation IS NOT NULL AND conversation NOT GLOB ?',
    [pattern],
  );
  return db.getRowsModified() > 0;
}
