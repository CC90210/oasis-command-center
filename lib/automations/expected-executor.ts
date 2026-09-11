/**
 * lib/automations/expected-executor.ts — which machine runs each tenant's
 * scheduled jobs.
 *
 * One EXPECTED EXECUTOR per tenant. Cron jobs are machine-affine — the scripts
 * live in repos that exist on exactly one machine — but ANY paired machine
 * could pull the list and, worse, REPORT results. Three incidents in one week
 * came through that gap: a stale-code Mac stamped "unresolvable root" over
 * healthy Atlas rows, and the VPS spent 11 days paired to the wrong tenant.
 * Revocation cannot close it: the Mac holds an operator session and re-pairs
 * itself within the hour (three times on 2026-08-22, same machine
 * fingerprint). So the gate lives on the job pipe itself
 * (app/api/cron-jobs/poll/route.ts): an unexpected executor receives an EMPTY
 * job list and its result reports are refused.
 *
 * Moved out of that route on 2026-09-11 so SunBiz's health check can ask
 * whether the machine that runs SunBiz's jobs is alive, from this one map
 * rather than a copy of it. A Next.js route file cannot export it.
 *
 * Mirrors cron_health_check.EXPECTED_PAIRINGS in the harness — change both.
 */
export const EXPECTED_EXECUTOR_BY_TENANT_PREFIX: Readonly<Record<string, string>> = {
  ef8d389e: "CCPC (Windows)", // OASIS — CC's PC
  aa04fa1f: "srv1723601 (Linux)", // SunBiz — the VPS
};

/** The pairing label that must run this tenant's jobs, or undefined when none is declared. */
export function expectedExecutorFor(tenantId: string): string | undefined {
  return EXPECTED_EXECUTOR_BY_TENANT_PREFIX[tenantId.slice(0, 8)];
}

export function isExpectedExecutor(tenantId: string, label: string): boolean {
  const expected = expectedExecutorFor(tenantId);
  // Tenants without a declared executor keep the old open behavior — this
  // gate hardens the governed tenants without bricking future ones.
  return expected === undefined || expected === label;
}
