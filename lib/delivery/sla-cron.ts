/**
 * lib/delivery/sla-cron.ts — one pass of the support SLA watcher.
 *
 *   1. Flag every unanswered open ticket whose first-response target passed.
 *   2. Claim and send ONE founder alert per breach (store.claimBreachAlerts is a
 *      single conditional UPDATE, so overlapping runs cannot both alert).
 *   3. Reconcile the support intake: tickets for submissions whose request died
 *      half-way, and notifications whose after() never ran.
 *
 * Returned counts are what the cron route reports. A failed alert is counted
 * and its reason recorded on the ticket; it is never silently dropped.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { claimBreachAlerts, flagSlaBreaches } from "@/lib/delivery/store";
import { alertSlaBreach, type NotifyDeps } from "@/lib/delivery/notify";
import { reconcileSupportIntake } from "@/lib/delivery/support-intake";

export type SlaCheckResult = {
  flagged: number;
  alerted: number;
  alert_failures: Array<{ ticket_id: string; status: string | null }>;
  reconcile: Awaited<ReturnType<typeof reconcileSupportIntake>>;
};

export async function runSlaCheck(db: Client, deps: NotifyDeps, now: Date): Promise<SlaCheckResult> {
  const flagged = await flagSlaBreaches(db, now);
  const claimed = await claimBreachAlerts(db, now);
  const alert_failures: SlaCheckResult["alert_failures"] = [];
  for (const id of claimed) {
    const status = await alertSlaBreach(db, id, deps, now);
    if (!status || status.includes("FAILED")) alert_failures.push({ ticket_id: id, status });
  }
  const reconcile = await reconcileSupportIntake(db, deps, now);
  return { flagged: flagged.length, alerted: claimed.length, alert_failures, reconcile };
}
