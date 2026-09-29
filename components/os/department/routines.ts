/**
 * components/os/department/routines.ts — the workspace's routines, read once
 * per department page.
 *
 * Read-only in Phase 1: the panel shows each routine with its schedule, On/Off
 * and last run. Turning one on or off stays in Automations, which carries the
 * owner check, the daemon confirmation loop and the audit trail
 * (app/api/cron-jobs/[id]); a second toggle here would be a second path around
 * all three.
 *
 * Scoped by the SESSION tenant id, the same predicate GET /api/cron-jobs uses
 * for its tenant lane. The operator Empire lane (`cron_jobs`) is never read.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { normalizeRoutineRow, type RoutineRow } from "./routine-rules";

/** A read that can fail. `ok: false` means "could not find out", never "none". */
export type Read<T> = { ok: true; value: T } | { ok: false };

export async function loadTenantRoutines(tenantId: string): Promise<Read<RoutineRow[]>> {
  try {
    const res = await getServiceSupabase()
      .from("tenant_cron_jobs")
      .select("id, agent_key, name, description, schedule, enabled, last_run_at, last_run_status")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });
    if (res.error) throw new Error(res.error.message);
    return {
      ok: true,
      value: ((res.data || []) as Array<Record<string, unknown>>).map(normalizeRoutineRow),
    };
  } catch (err) {
    console.error("[os.department.routines]", err);
    return { ok: false };
  }
}
