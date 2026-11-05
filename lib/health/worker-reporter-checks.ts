/**
 * lib/health/worker-reporter-checks.ts — is worker status still reaching us?
 *
 * WHY. On 2026-09-23 the local bridge kept pinging every minute while its
 * process-table read failed inside the long-running process. The twelve
 * background-worker rows simply stopped arriving, the Automations panel aged
 * every one of them into "Down — stopped reporting", and for about thirty
 * hours nobody was told anything — the failure only went to the stderr of a
 * detached process. Every daemon was in fact running.
 *
 * The bridge now reports its own `fleet_watchdog` row each tick (healthy, or
 * down with the error). This check pages CC's lane when that reporter is
 * FAILING (it says it cannot read the fleet) or SILENT (the bridge is online
 * but the fleet report has gone stale), using the same rule the panel renders
 * (lib/automations/worker-status.ts describeStatusReporter). A bridge that is
 * simply offline is not this check's alarm — the heartbeat banner owns that.
 */

import "server-only";
import type { DripCheck } from "./drip-checks";
import { isProductionRuntime } from "./runtime-environment";
import {
  FLEET_REPORTER_SERVICE,
  WORKER_REPORTER_OFFLINE_REASON,
  describeStatusReporter,
  pickLocalWorkerPairing,
  reporterPairingId,
} from "@/lib/automations/worker-status";
import { WEBDEV_TENANT_ID } from "@/lib/oasis-tenant";
import { isOnline } from "@/lib/devices/presence";
import { OASIS_SCRIPT_EXECUTOR } from "@/lib/automations/tenant-script-lease";

const OK = 0;
const FAILING = 1;
const SILENT = 2;

/** Generous on purpose: one missed 60s tick must not page anyone. */
export const REPORTER_ALERT_AFTER_MS = 10 * 60_000;

const observeReporter: NonNullable<DripCheck["observeDetailed"]> = async (db, _tenantId, endMs) => {
    // Only production grades the operator's fleet; previews have no bridge.
    if (!isProductionRuntime()) return { observed: OK, reason: "not graded outside production" };
    const reporter = await db.from("integrations_health")
        .select("status, metadata, last_ping_at")
        .eq("tenant_id", WEBDEV_TENANT_ID)
        .eq("service", FLEET_REPORTER_SERVICE)
        .order("last_ping_at", { ascending: false })
        .limit(1);
    if (reporter.error) return { observed: null, reason: "worker reporter read failed" };
    const row = reporter.data?.[0] as
      | { status: string; metadata: Record<string, unknown> | null; last_ping_at: string | null }
      | undefined;
    // The server stamps this ID from the bearer-authenticated bridge pairing.
    const sourceId = reporterPairingId(row?.metadata);
    if (!sourceId) return { observed: null, reason: "worker report has no authenticated source" };
    // Grading the computer that wrote the report (not the freshest pairing)
    // keeps the always-online daemon VPS and a Mac left on from reading "bridge
    // online, fleet silent" while the PC is off (2026-11-05 nightly false page).
    // Only CC's own computers count (CodeRabbit, #805): the executor's user is
    // the agents owner whose fleet this row reports.
    const pairing = await db.from("bridge_pairings")
      .select("id, last_seen_at")
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("user_id", OASIS_SCRIPT_EXECUTOR.userId)
      .eq("id", sourceId)
      .is("revoked_at", null)
      .limit(1);
    if (pairing.error) return { observed: null, reason: "worker reporter pairing read failed" };
    const localComputer = pickLocalWorkerPairing(
      pairing.data as Array<{ id: string; last_seen_at?: string | null }> | null, sourceId,
    );
    const bridgeOnline = isOnline(localComputer?.last_seen_at ?? null, endMs);
    const state = describeStatusReporter({ row, bridgeOnline, now: endMs, staleMs: REPORTER_ALERT_AFTER_MS }).state;
    if (state === "unknown" && !bridgeOnline) {
      return { observed: OK, reason: WORKER_REPORTER_OFFLINE_REASON };
    }
    const observed = state === "failing" ? FAILING : state === "silent" ? SILENT : OK;
    return { observed, reason: observed === OK ? "none observed" : `reporter ${state}` };
};

export const WORKER_REPORTER_CHECKS: DripCheck[] = [{
  id: "fleet.worker_status_reporter",
  severity: "high",
  lane: "operator",
  rule: { kind: "must_be_zero" },
  observe: async (db, tenantId, endMs) => (await observeReporter(db, tenantId, endMs)).observed,
  observeDetailed: observeReporter,
  describe: (r) => {
    if (r.observed === OK) {
      return "background-worker status is reaching the dashboard (or the bridge is offline, which its own banner reports).";
    }
    if (r.observed === FAILING) {
      return (
        "WORKER STATUS IS NOT REACHING THE DASHBOARD — the local bridge reports it cannot read its " +
        "process list, so the Automations panel cannot say which background workers are running. The " +
        "workers may be fine. The exact error is on the panel and in ~/.oasis/bridge.log; restarting " +
        "\"Bridge heartbeat\" (claude-bridge-ping) reloads the reader."
      );
    }
    return (
      "WORKER STATUS HAS GONE SILENT — the bridge is online but has not reported the worker fleet for " +
      "over 10 minutes (an older bridge without the fleet report, or a reader stuck in the long-running " +
      "process). Restart \"Bridge heartbeat\" (claude-bridge-ping) and check ~/.oasis/bridge.log."
    );
  },
}];
