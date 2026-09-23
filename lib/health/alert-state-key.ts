/**
 * Health alert state has historically used a globally unique `alert_key`.
 * Check ids are reused across tenants, so the tenant must be part of that key
 * as well as a query predicate or one workspace can inherit another's decay
 * ladder and recovery state.
 */
export function healthAlertStateKey(tenantId: string, checkId: string): string {
  return `health:${tenantId}:${checkId}`;
}

/** Read both tenant-qualified keys and pre-isolation legacy rows in the panel. */
export function healthAlertStateKeys(tenantId: string, checkId: string): string[] {
  return [healthAlertStateKey(tenantId, checkId), `health:${checkId}`];
}

/** Recover a check id from either the current or legacy alert-key shape. */
export function checkIdFromHealthAlertStateKey(alertKey: string, tenantId: string): string {
  const scopedPrefix = `health:${tenantId}:`;
  if (alertKey.startsWith(scopedPrefix)) return alertKey.slice(scopedPrefix.length);
  if (alertKey.startsWith("health:")) return alertKey.slice("health:".length);
  return alertKey;
}
