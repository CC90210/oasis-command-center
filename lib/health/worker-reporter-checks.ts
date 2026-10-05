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
import { FLEET_REPORTER_SERVICE, describeStatusReporter } from "@/lib/automations/worker-status";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";

const OK = 0;
const FAILING = 1;
const SILENT = 2;

/** Generous on purpose: one missed 60s tick must not page anyone. */
export const REPORTER_ALERT_AFTER_MS = 10 * 60_000;
const BRIDGE_ONLINE_MS = 120_000;

export const WORKER_REPORTER_CHECKS: DripCheck[] = [{
  id: "fleet.worker_status_reporter",
  severity: "high",
  lane: "operator",
  rule: { kind: "must_be_zero" },
  observe: async (db, _tenantId, endMs) => {
    // Only production grades the operator's fleet; previews have no bridge.
    if (!isProductionRuntime()) return OK;
    const [pairing, reporter] = await Promise.all([
      db.from("bridge_pairings")
        .select("last_seen_at")
        .eq("tenant_id", WEBDEV_TENANT_ID)
        .is("revoked_at", null)
        .order("last_seen_at", { ascending: false })
        .limit(1),
      db.from("integrations_health")
        .select("status, metadata, last_ping_at")
        .eq("tenant_id", WEBDEV_TENANT_ID)
        .eq("service", FLEET_REPORTER_SERVICE)
        .order("last_ping_at", { ascending: false })
        .limit(1),
    ]);
    // A failed read is check_broken (null), never a quiet OK.
    if (pairing.error || reporter.error) return null;
    const lastSeen = pairing.data?.[0]?.last_seen_at ? Date.parse(pairing.data[0].last_seen_at) : NaN;
    const bridgeOnline = Number.isFinite(lastSeen) && endMs - lastSeen < BRIDGE_ONLINE_MS;
    const row = reporter.data?.[0] as
      | { status: string; metadata: Record<string, unknown> | null; last_ping_at: string | null }
      | undefined;
    const state = describeStatusReporter({ row, bridgeOnline, now: endMs, staleMs: REPORTER_ALERT_AFTER_MS }).state;
    return state === "failing" ? FAILING : state === "silent" ? SILENT : OK;
  },
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
