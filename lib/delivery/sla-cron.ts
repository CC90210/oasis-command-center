/**
 * lib/delivery/sla-cron.ts — one pass of the support SLA watcher.
 *
 *   1. Flag every unanswered open ticket whose first-response target passed.
 *   2. Claim and send ONE founder alert per breach (store.claimBreachAlerts is a
 *      single conditional UPDATE, so overlapping runs cannot both alert).
 *   3. Retry the breach alerts an earlier pass could not deliver, on the lanes
 *      that failed only (store.reclaimFailedBreachAlerts, compare-and-set, so
 *      overlapping runs cannot both retry one). A retry keeps the FAILED text
 *      on the ticket while it sends, so a pass that dies mid-retry leaves it
 *      to the next pass instead of losing it.
 *   4. Reconcile the support intake: tickets for submissions whose request died
 *      half-way, and notifications whose after() never ran.
 *
 * Returned counts are what the cron route reports. A failed alert is counted
 * and its reason recorded on the ticket; it is never silently dropped, and it is
 * retried every pass until it goes through or the ticket is answered or closed.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { claimBreachAlerts, flagSlaBreaches, reclaimFailedBreachAlerts } from "@/lib/delivery/store";
import { alertSlaBreach, type NotifyDeps } from "@/lib/delivery/notify";
import { reconcileSupportIntake } from "@/lib/delivery/support-intake";

export type SlaCheckResult = {
  flagged: number;
  alerted: number;
  retried: number;
  alert_failures: Array<{ ticket_id: string; status: string | null; error?: string }>;
  reconcile: Awaited<ReturnType<typeof reconcileSupportIntake>>;
};

export async function runSlaCheck(db: Client, deps: NotifyDeps, now: Date): Promise<SlaCheckResult> {
  const flagged = await flagSlaBreaches(db, now);
  const claimed = await claimBreachAlerts(db, now);
  const retries = await reclaimFailedBreachAlerts(db, now);
  const alert_failures: SlaCheckResult["alert_failures"] = [];
  for (const { id, previous_status } of [...claimed.map((id) => ({ id, previous_status: null })), ...retries]) {
    let status: string | null;
    try {
      status = await alertSlaBreach(db, id, deps, now, previous_status);
    } catch (err) {
      // One alert that throws (a read or the outcome write failing) must not
      // strand the rest of the pass. It fails the run; a retry keeps its FAILED
      // text on the ticket and is taken again once its lease runs out.
      console.error("[delivery.sla_cron] breach alert threw", { ticket: id, error: err instanceof Error ? err.stack : err });
      alert_failures.push({ ticket_id: id, status: null, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
      continue;
    }
    if (!status || status.includes("FAILED")) alert_failures.push({ ticket_id: id, status });
  }
  const reconcile = await reconcileSupportIntake(db, deps, now);
  return { flagged: flagged.length, alerted: claimed.length, retried: retries.length, alert_failures, reconcile };
}
