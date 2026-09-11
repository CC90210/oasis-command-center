/**
 * lib/bridge-executors.ts — which machine runs each governed tenant's cron jobs.
 *
 * One map, read by two gates:
 *   - app/api/cron-jobs/poll hands a tenant's jobs ONLY to its declared
 *     executor, and refuses result reports from any other machine;
 *   - app/api/auth/pair and app/api/auth/pair-code/redeem refuse to pair a
 *     declared executor into a DIFFERENT tenant.
 *
 * WHY THE PAIR GATE (added 2026-09-11). The poll gate stops a wrong-tenant
 * machine from running jobs, but it does not stop the pairing itself, and the
 * pairing is the leak: on 2026-08-31 SunBiz's VPS ("srv1723601 (Linux)") was
 * paired into the OASIS tenant, which put an OASIS bridge credential on
 * SunBiz's machine and made OASIS's bridge status flap between CC's PC and the
 * VPS. It was the second time: in August the same box spent 11 days on the
 * wrong tenant. Refusing at pair time means the credential is never minted.
 *
 * A machine that is not in this map is not affected by either gate.
 *
 * Mirrors cron_health_check.EXPECTED_PAIRINGS in the harness — change both.
 * That file's comment names this constant, so keep the name.
 */

// One EXPECTED EXECUTOR per tenant, keyed by the first 8 chars of tenant_id.
// Cron jobs are machine-affine: the scripts live in repos that exist on exactly
// one machine.
export const EXPECTED_EXECUTOR_BY_TENANT_PREFIX: Readonly<Record<string, string>> = {
  ef8d389e: "CCPC (Windows)", // OASIS — CC's PC
  aa04fa1f: "srv1723601 (Linux)", // SunBiz — the VPS
};

/** May this machine run (and report on) this tenant's cron jobs? */
export function isExpectedExecutor(tenantId: string, label: string): boolean {
  const expected = EXPECTED_EXECUTOR_BY_TENANT_PREFIX[tenantId.slice(0, 8)];
  // Tenants without a declared executor keep the old open behavior — this
  // gate hardens the governed tenants without bricking future ones.
  return expected === undefined || expected === label;
}

/**
 * The tenant prefix this machine is the declared executor FOR, when that is
 * not `tenantId`. null means the pairing is fine: the machine is undeclared,
 * or it is pairing into its own tenant.
 */
export function executorHomeElsewhere(tenantId: string, label: string): string | null {
  const prefix = tenantId.slice(0, 8);
  for (const [home, executor] of Object.entries(EXPECTED_EXECUTOR_BY_TENANT_PREFIX)) {
    if (executor === label && home !== prefix) return home;
  }
  return null;
}

/** True when this machine label is some tenant's declared executor. */
export function isDeclaredExecutor(label: string): boolean {
  return Object.values(EXPECTED_EXECUTOR_BY_TENANT_PREFIX).includes(label);
}

/** The refusal both pair routes return, so the machine's log says what to do. */
export function wrongTenantPairingReason(label: string, homePrefix: string): string {
  return (
    `executor_belongs_to_another_tenant: "${label}" is the declared cron executor ` +
    `for tenant ${homePrefix}…, so it cannot be paired into this one. Pair it with ` +
    `a code from its own workspace. If the machine really changed hands, update ` +
    `lib/bridge-executors.ts first.`
  );
}
