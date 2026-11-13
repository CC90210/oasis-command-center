/**
 * lib/site-scan/sweep.ts — a scan as it should read right now, closing what is stuck.
 *
 * Shared by GET /api/scan/:id and the live stream, so both say the same thing: a read that died
 * (the Worker was recycled mid-run) is failed after three minutes; an enrichment the runner never
 * delivered is closed after ENRICH_WAIT_MINUTES; a queued enrichment with no live runner after
 * NO_RUNNER_GRACE_MS hands the visitor the Worker's report instead of a spinner (the job stays
 * queued, and a runner that comes back fills the permalink in).
 */
import type { Client } from "@libsql/client";
import { enrichRunnerLive } from "@/lib/site-scan/run";
import { getScan, setStatus } from "@/lib/site-scan/store";
import type { ScanRow } from "@/lib/site-scan/types";
import { enrichOverdue, readOverdue } from "@/lib/site-scan/view";

export const NO_RUNNER_GRACE_MS = 90_000;

export async function currentScan(db: Client, tenantId: string, id: string, now: Date): Promise<ScanRow | null> {
  const row = await getScan(db, tenantId, id);
  if (!row) return null;
  if (readOverdue(row, now)) {
    await setStatus(db, { tenantId, id, status: "failed", stage: "read", errorCode: "read_timeout", now, onlyFrom: ["reading", "queued"] });
    return (await getScan(db, tenantId, id)) ?? row;
  }
  if (enrichOverdue(row, now)) {
    await setStatus(db, { tenantId, id, status: "done", stage: "done", errorCode: "enrich_overdue", now, onlyFrom: ["enriching"] });
    return (await getScan(db, tenantId, id)) ?? row;
  }
  if (row.status === "enriching" && now.getTime() - new Date(row.updatedAt).getTime() > NO_RUNNER_GRACE_MS && !(await enrichRunnerLive(db, tenantId, now))) {
    await setStatus(db, { tenantId, id, status: "done", stage: "done", errorCode: "enrich_no_runner", now, onlyFrom: ["enriching"] });
    return (await getScan(db, tenantId, id)) ?? row;
  }
  return row;
}
