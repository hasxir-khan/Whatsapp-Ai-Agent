import { AsyncLocalStorage } from 'node:async_hooks';
import { recordAudit as append } from '../audit.js';
// Attribution is taken from the authenticated route, never from a form field.
const actors = new AsyncLocalStorage();
export const asActor = (role, accountId, fn) => actors.run({ role, accountId }, fn);
export function recordAudit({ action, tenant, detail = {} }) {
  const actor = actors.getStore();
  const row = append({
    action,
    tenant,
    accountId: actor?.accountId,
    detail: { ...detail, actor: actor?.role || 'system' },
  });
  if (!row.ok) throw Error('billing_audit_unavailable');
  return row;
}
