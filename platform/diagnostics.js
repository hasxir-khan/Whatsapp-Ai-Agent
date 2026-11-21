// One read-only check shared by doctor and readiness. No provider traffic and no
// key values, fingerprints, account IDs or tenant slugs in the result.
import fs from 'node:fs';
import { STALE_MINUTES, staleBefore } from './reportFreshness.js';
import { readSnapshot } from './db.js';
import { platformDbFile, billingEnabled, platformEnabled, dashboardEnabled, platformSecret, secureOrigin, transportProblem } from './env.js';
import { keySecretProblem, tenantTokenProblem, decryptValue } from './crypto.js';
import { activeMailer } from './mailer.js';

import { readTenantEnv } from '../src/services/adminPanel.js';
import { operatorConfigured, operatorSetupProblem } from './operatorAuth.js';

export function diagnostics(rows, { checkMounts = false } = {}) {
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
  if (billingEnabled()) {
    if (!mail || mail === 'file' || mail === 'invalid') warnings.push('billing_production_mailer_missing');
    let methods = [],
      paid = false;
    try {
      if (rows) {
        methods = JSON.parse(rows('SELECT value FROM b_config WHERE id=1')[0]?.value || '{}').methods || [];
        paid = rows(
          "SELECT p.spec FROM b_plan p WHERE plan!='free' AND revision=(SELECT MAX(revision) FROM b_plan v WHERE v.plan=p.plan)"
        ).some((r) => JSON.parse(r.spec).offered);
      }
    } catch {
      errors.push('billing_schema');
    }
    if (!methods.length) warnings.push('billing_instructions_missing');
    if (!paid) warnings.push('billing_paid_plans_missing');
  }
  if (dashboardEnabled()) {
    if (!process.env.PLATFORM_OPERATOR_TOKEN) warnings.push('report_operator_disabled');
    if (rows)
      try {
        if (rows('SELECT MAX(version) v FROM report_schema')[0]?.v !== 1) errors.push('report_schema');
        const cutoff = staleBefore(Date.now());
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
  if (billingEnabled() || (dashboardEnabled() && process.env.PLATFORM_OPERATOR_TOKEN)) {
    if (!operatorConfigured()) errors.push('report_operator_credential');
    else {
      const problem = operatorSetupProblem();
      if (problem) warnings.push(problem);
    }
  }
  if (rows) {
    try {
      const note = (code) => {
        if (code && !warnings.includes(code)) warnings.push(code);
      };
      const seen = new Set();
      for (const t of rows(
        "SELECT t.slug,k.value FROM tenants t LEFT JOIN tenant_secrets k ON k.slug=t.slug AND k.name='PLATFORM_TENANT_TOKEN' WHERE t.status IN ('active','provisioned','paused')"
      )) {
        note(tenantTokenProblem(t.value));
        if (t.value && seen.has(t.value)) note('tenant_token_weak');
        seen.add(t.value);
        if (checkMounts) {
          let local;
          try {
            local = readTenantEnv(t.slug).PLATFORM_TENANT_TOKEN;
          } catch {}
          note(tenantTokenProblem(local));
          if (local && t.value && local !== t.value) note('tenant_token_mismatch');
        }
      }
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
  return readSnapshot((rows) => diagnostics(rows, { checkMounts: true }), file);
}

export const remedy = {
  tenant_token_missing: 'PLATFORM_TENANT_TOKEN is missing for a managed assistant. Restore its original private token; see Backups and secrets.',
  tenant_token_weak: 'A managed PLATFORM_TENANT_TOKEN is weak or reused. Follow Backups and secrets for a coordinated rotation.',
  tenant_token_mismatch: 'PLATFORM_TENANT_TOKEN differs between the platform and a tenant mount. Stop that worker and restore a matched pair.',
  operator_totp_invalid: 'Operator login unavailable: configure a valid independent Base32 TOTP seed (at least 160 bits).',
  operator_alert_unavailable: 'Operator login requires an alert address (PLATFORM_OPERATOR_EMAIL) and a delivering mail adapter in production.',
  billing_production_mailer_missing:
    'Use a production mail adapter with PDF attachments and idempotency before taking payments.',
  billing_instructions_missing: 'Configure a masked receiver and transfer instructions in Billing operations.',
  billing_paid_plans_missing: 'Publish an offered plan with currency and prices for its terms.',
  billing_schema: 'Start the platform writer to initialise the billing tables.',
  report_schema: 'Restart the platform writer to apply the dashboard schema migration.',
  report_stale: `An active assistant has not published a dashboard snapshot in ${STALE_MINUTES} minutes. Check its live worker, shared tenant data mount and platform importer.`,
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
