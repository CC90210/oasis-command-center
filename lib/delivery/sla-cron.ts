/**
 * lib/delivery/sla-cron.ts — one pass of the support SLA watcher, over every
 * desk: OASIS's own and each workspace desk registered in support_desks
 * (lib/delivery/desks.ts). Each desk is handled with its own tenant id.
 *
 *   1. Flag every unanswered open ticket whose first-response target passed.
 *      Every desk: the flag is what the desk's Breaching view and badge count.
 *   2. Claim and send ONE alert per breach (store.claimBreachAlerts is a
 *      single conditional UPDATE, so overlapping runs cannot both alert).
 *   3. Retry the breach alerts an earlier pass could not deliver, on the lanes
 *      that failed only (store.reclaimFailedBreachAlerts, compare-and-set, so
 *      overlapping runs cannot both retry one). A retry keeps the FAILED text
 *      on the ticket while it sends, so a pass that dies mid-retry leaves it
 *      to the next pass instead of losing it.
 *      Steps 2 and 3 run only on desks that have alert lanes — today OASIS's
 *      (lib/delivery/notify.ts). Another desk's breach is NOT claimed, so it is
 *      neither reported as alerted when nothing was sent nor lost: it waits,
 *      flagged and visible on that desk, until the workspace has lanes.
 *   4. Reconcile the support intake on every desk: tickets for submissions
 *      whose request died half-way, and notifications whose after() never ran
 *      (email tickets included: their acknowledgement re-reads the decision
 *      the support inbox made at ingest, so a retry sends only what was meant).
 *   5. The support inbox (support@): alert ONCE when it has not been read for
 *      20 minutes (lib/delivery/support-inbox-health.ts), and forget non-ticket
 *      mail after 30 days (lib/delivery/email-intake.ts). Both are no-ops on a
 *      database without migration bravo__200.
 *
 * Returned counts are what the cron route reports. A failed alert is counted
 * and its reason recorded on the ticket; it is never silently dropped, and it is
 * retried every pass until it goes through or the ticket is answered or closed.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { claimBreachAlerts, flagSlaBreaches, reclaimFailedBreachAlerts } from "@/lib/delivery/store";
import { alertSlaBreach, deskUsesOasisLanes, type NotifyDeps } from "@/lib/delivery/notify";
import { reconcileSupportIntake } from "@/lib/delivery/support-intake";
import { OASIS_DESK, listRegisteredDesks } from "@/lib/delivery/desks";
import { alertStaleSupportInboxes, type StaleAlertResult } from "@/lib/delivery/support-inbox-health";
import { purgeOldNonTicketMessages } from "@/lib/delivery/email-intake";

export type SlaCheckResult = {
  /** Desks checked this pass (OASIS's + registered workspace desks). */
  desks: number;
  flagged: number;
  alerted: number;
  retried: number;
  /** Breaches flagged on desks with no alert lane yet: visible on the desk, not alerted. */
  flagged_without_lane: number;
  alert_failures: Array<{ ticket_id: string; status: string | null; error?: string }>;
  reconcile: Awaited<ReturnType<typeof reconcileSupportIntake>>;
  /** support@: stale-read alerts this pass, non-ticket mail forgotten, and a step that threw. */
  support_inbox: StaleAlertResult & { purged: number; errors: string[] };
};

/**
 * A run is green only when every breach alert went out, both support inbox
 * steps ran, and every "support@ not read" alert went out: an undelivered
 * alert keeps the run red until a later run delivers it, like a breach alert.
 */
export function slaRunOk(r: Pick<SlaCheckResult, "alert_failures" | "support_inbox">): boolean {
  return r.alert_failures.length === 0 && r.support_inbox.errors.length === 0 && r.support_inbox.failures.length === 0;
}

function thrown(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

export async function runSlaCheck(db: Client, deps: NotifyDeps, now: Date): Promise<SlaCheckResult> {
  const desks = [OASIS_DESK, ...(await listRegisteredDesks(db))];
  let flagged = 0;
  let alerted = 0;
  let retried = 0;
  let flaggedWithoutLane = 0;
  const alert_failures: SlaCheckResult["alert_failures"] = [];
  for (const desk of desks) {
    const newlyFlagged = await flagSlaBreaches(db, desk.tenantId, now);
    flagged += newlyFlagged.length;
    if (!deskUsesOasisLanes(desk.tenantId)) {
      flaggedWithoutLane += newlyFlagged.length;
      continue;
    }
    const claimed = await claimBreachAlerts(db, desk.tenantId, now);
    const retries = await reclaimFailedBreachAlerts(db, desk.tenantId, now);
    alerted += claimed.length;
    retried += retries.length;
    for (const { id, previous_status } of [...claimed.map((id) => ({ id, previous_status: null })), ...retries]) {
      let status: string | null;
      try {
        status = await alertSlaBreach(db, desk.tenantId, id, deps, now, previous_status);
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
  }
  const reconcile = await reconcileSupportIntake(db, deps, now);
  // The support inbox steps run apart from the pass above and from each other:
  // one that throws is logged and reported (it fails the run, slaRunOk), and
  // never costs the breach alerts and reconcile already done, or the other step.
  const errors: string[] = [];
  let stale: StaleAlertResult = { checked: 0, alerted: [], failures: [] };
  try {
    stale = await alertStaleSupportInboxes(db, deps, now);
  } catch (err) {
    console.error("[delivery.sla_cron] support inbox stale check threw", err instanceof Error ? err.stack : err);
    errors.push(`stale_check: ${thrown(err)}`);
  }
  let purged = 0;
  try {
    purged = await purgeOldNonTicketMessages(db, now);
  } catch (err) {
    console.error("[delivery.sla_cron] support inbox purge threw", err instanceof Error ? err.stack : err);
    errors.push(`purge: ${thrown(err)}`);
  }
  return {
    desks: desks.length,
    flagged,
    alerted,
    retried,
    flagged_without_lane: flaggedWithoutLane,
    alert_failures,
    reconcile,
    support_inbox: { ...stale, purged, errors },
  };
}
