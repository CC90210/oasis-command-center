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
 * for its tenant lane. The operator Empire lane (`cron_jobs`) is read only by
 * loadEmpireRoutines below, only for the platform operator standing in OASIS
 * (the verified check GET /api/cron-jobs lists the same rows behind), and only
 * for the health counts (routine-rules.ts routineHealth): the panel never
 * lists its rows, and a failure in it links to Automations, which does.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { normalizeEmpireRow, type EmpireCronRow } from "@/lib/cron-empire-row";
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

/**
 * The Empire scheduler's rows that belong to this workspace: `cron_jobs`
 * carries a tenant_id (migration 084), and GET /api/cron-jobs reads its
 * operator lane with the same `.eq("tenant_id", …)`. Every live row carries
 * the OASIS workspace's id, so for OASIS these ARE its routines (post
 * analytics sync, inbound email sweep, …) even though they run on the
 * operator's machine rather than the bridge.
 *
 * The caller decides who may ask (the platform operator in OASIS). The status comes from
 * lib/cron-empire-row normalizeEmpireRow, the classifier the Automations tab
 * and the watchdog share, so `{"errors": 3}` is a failure here too and an
 * unresolved fail_count keeps a row red until a clean run clears it.
 */
export async function loadEmpireRoutines(tenantId: string): Promise<Read<RoutineRow[]>> {
  try {
    const res = await getServiceSupabase()
      .from("cron_jobs")
      .select("id, name, description, schedule, action_type, action_config, owner_agent_key, is_active, last_run_at, last_result, next_run_at, run_count, fail_count, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });
    if (res.error) throw new Error(res.error.message);
    return {
      ok: true,
      value: ((res.data || []) as EmpireCronRow[]).map((row) => {
        const job = normalizeEmpireRow(row);
        return normalizeRoutineRow({
          id: job.id,
          agent_key: job.agent_key,
          name: job.name,
          description: job.description,
          schedule: job.schedule,
          enabled: job.enabled,
          last_run_at: job.last_run_at,
          last_run_status: job.last_run_status,
          lane: "empire",
        });
      }),
    };
  } catch (err) {
    console.error("[os.department.routines.empire]", err);
    return { ok: false };
  }
}
