// One read-only check shared by doctor and readiness. No provider traffic and no
// key values, fingerprints, account IDs or tenant slugs in the result.
import fs from 'node:fs';
import { readSnapshot } from './db.js';
import { platformDbFile, platformEnabled, dashboardEnabled, platformSecret, secureOrigin, transportProblem } from './env.js';
import { keySecretProblem, decryptValue } from './crypto.js';
import { activeMailer } from './mailer.js';

export function diagnostics(rows) {
  const errors = [], warnings = [];
  if (!platformEnabled()) return { ok: true, enabled: false, errors, warnings };
  const production = process.env.NODE_ENV?.toLowerCase() === 'production';
  if (!platformSecret()) errors.push('platform_secret_missing');
  if (transportProblem()) errors.push('https_required');
  else if (production && !secureOrigin()) warnings.push('insecure_http_override');
  const problem = keySecretProblem();
  if (problem) errors.push('key_secret_unusable');
  if (production && process.env.PLATFORM_TRUST_PROXY?.trim() === '1') warnings.push('trusts_all_proxy_peers');
  const mail = activeMailer().mode;
  if (mail === 'file' && production) warnings.push('outbox_in_production');
  if (mail === 'invalid' || (mail === 'http' && (!process.env.PLATFORM_MAIL_TOKEN || !process.env.PLATFORM_MAIL_FROM || !/^https:\/\//i.test(process.env.PLATFORM_MAIL_URL || 'https://api.resend.com')))) errors.push('mailer_misconfigured');
  if (/^(1|true|on|yes)$/i.test(process.env.PLATFORM_DEV_SHOW_CODES || '')) warnings.push('dev_show_codes_set');
  if (process.env.LLM_KEY_SOURCE === 'platform') errors.push('platform_keys_unavailable');
  if (dashboardEnabled()) {
    const token = process.env.PLATFORM_OPERATOR_TOKEN;
    if (!token) warnings.push('report_operator_disabled');
    else if (
      token.length < 32 ||
      [platformSecret(), process.env.PLATFORM_KEY_SECRET, process.env.ADMIN_TOKEN].includes(token)
    )
      errors.push('report_operator_credential');
    if (rows)
      try {
        if (rows('SELECT MAX(version) v FROM report_schema')[0]?.v !== 1) errors.push('report_schema');
        const cutoff = new Date(Date.now() - 15 * 60000).toISOString();
        if (
          rows(
            "SELECT 1 FROM tenants t LEFT JOIN r_state s ON s.slug=t.slug WHERE t.status='active' AND (s.at IS NULL OR s.at<?) LIMIT 1",
            [cutoff]
          ).length
        )
          warnings.push('report_stale');
      } catch {
        errors.push('report_schema');
      }
  }
  if (rows) {
    try {
      if (!errors.includes('platform_keys_unavailable') && rows("SELECT slug FROM tenants WHERE key_source = 'platform' LIMIT 1").length) errors.push('platform_keys_unavailable');
      if (!problem && rows("SELECT slug, id, key_version, secret FROM tenant_keys WHERE status = 'active'").some((r) =>
        !decryptValue(r.secret, { aad: `${r.slug}:${r.id}:${r.key_version}` }).ok)) errors.push('cannot_decrypt');
    } catch { errors.push('schema_not_ready'); }
  }
  return { ok: !errors.length, enabled: true, errors, warnings };
}

/** A CLI must never open a *second writable instance* of a live sql.js DB. */
export async function doctorDiagnostics() {
  const file = platformDbFile();
  if (!platformEnabled() || !fs.existsSync(file)) return diagnostics();
  return readSnapshot(diagnostics, file);
}

export const remedy = {
  report_schema: 'Restart the platform writer to apply the dashboard schema migration.',
  report_stale:
    'An active assistant has not published a dashboard snapshot in 15 minutes. Check its live worker, shared tenant data mount and platform importer.',
  report_operator_disabled: 'Fleet view is disabled. Set a separate strong PLATFORM_OPERATOR_TOKEN only if needed.',
  report_operator_credential: 'Use a random, independent operator credential of at least 32 characters.',
  platform_secret_missing: 'Set PLATFORM_SECRET for session signing.',
  https_required:
    'Set PLATFORM_PUBLIC_URL to the HTTPS public origin. Production refuses plain HTTP unless PLATFORM_ALLOW_HTTP=1.',
  insecure_http_override:
    'PLATFORM_ALLOW_HTTP=1: your production login and keys can travel over plain HTTP. Configure HTTPS and remove the override.',
  key_secret_unusable:
    'Set a strong, independent PLATFORM_KEY_SECRET (at least 32 characters); keep a separate protected copy.',
  cannot_decrypt:
    'At least one stored key cannot be decrypted. Restore the original PLATFORM_KEY_SECRET or replace the affected key.',
  platform_keys_unavailable: 'The platform key pool is unavailable. Use the tenant key source.',
  trusts_all_proxy_peers:
    'Legacy PLATFORM_TRUST_PROXY=1 trusts XFF from all peers. Pin the immediate ingress peer and restrict direct access.',
  outbox_in_production:
    'The file outbox does not deliver email. Configure PLATFORM_MAILER=http or an injected SMTP adapter.',
  dev_show_codes_set: 'Unset PLATFORM_DEV_SHOW_CODES before deployment (ignored in production).',
  mailer_misconfigured: 'Check PLATFORM_MAILER, the HTTPS endpoint, sender and token.',
  schema_not_ready: 'Start the platform once to apply migrations; check database storage.',
};
