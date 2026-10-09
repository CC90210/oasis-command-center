/**
 * lib/health/department-chat-run.ts - run the department-chat checks for every
 * workspace that has department turns, without one workspace taking the rest
 * (or the rest of the health route) down with it.
 *
 * WHY A MODULE. This lived in the route, where one throw anywhere in the
 * per-workspace fan-out rejected the whole Promise.all and dropped the
 * calendar, estate and fleet results with it (review of PR #569). A health
 * check that can silence the other health checks is the failure this whole
 * subsystem exists to prevent. Here a workspace that throws is logged, recorded
 * as check_broken for THAT workspace, and the others carry on; the fan-out is
 * bounded so a large estate cannot flood the 60 s route.
 *
 * WHO IS PAGED. An alert's audience is a property of the workspace
 * (lib/notify/alert-route.ts), and these checks name CC's operator chat. So
 * only a workspace that alertAudienceFor() resolves to OASIS's operator chat
 * pages; any other is graded and recorded (health_check_runs) with notify off.
 * A client whose own AI key ran dry is that client's to fix, and paging a
 * client's bot needs the workspace-alert path the lane-based runner lacks.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { alertAudienceFor } from "@/lib/notify/alert-route";
import { worstVerdict } from "./checks-core";
import { DEPARTMENT_CHAT_CHECKS, departmentChatTenantIds } from "./department-chat-checks";
import { runHealthChecks, type RunSummary } from "./runner";

/** Workspaces graded at once. */
export const DEPARTMENT_CHAT_FANOUT = 5;

export type DepartmentChatRun = { tenantId: string; summary: RunSummary; failed: boolean };

/** A run that could not happen: one check_broken result, so `worst` and the history say so. */
export function brokenSummary(checkId: string, reason: string): RunSummary {
  const results = [{ id: checkId, verdict: "check_broken" as const, observed: NaN, baseline: null, reason: reason.slice(0, 300) }];
  return { ran: 1, results, alerted: [], recovered: [], worst: worstVerdict(results) };
}

async function recordBrokenRun(tenantId: string, reason: string, nowMs: number): Promise<void> {
  try {
    const r = await getServiceSupabase().from("health_check_runs").insert({
      tenant_id: tenantId,
      check_id: "department_chat_outcomes",
      surface: "oasis",
      verdict: "check_broken",
      observed: null,
      baseline: null,
      reason: reason.slice(0, 500),
      ran_at: new Date(nowMs).toISOString(),
    });
    if (r.error) console.error("[health-check] could not record a broken department chat run", { tenantId, error: r.error.message });
  } catch (err) {
    console.error("[health-check] could not record a broken department chat run", { tenantId, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function runDepartmentChatHealth(
  opts: {
    notify: boolean;
    nowMs?: number;
    /** Test seams. */
    discover?: typeof departmentChatTenantIds;
    run?: typeof runHealthChecks;
    fanout?: number;
  },
): Promise<DepartmentChatRun[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const run = opts.run ?? runHealthChecks;
  const width = Math.max(1, opts.fanout ?? DEPARTMENT_CHAT_FANOUT);
  const { tenantIds, error } = await (opts.discover ?? departmentChatTenantIds)(nowMs);
  // OASIS is still graded. A ledger that is down fails that run as check_broken
  // and pages; this line covers only a narrower failure of the tenant list,
  // which would otherwise leave client workspaces unwatched.
  if (error) console.error("[health-check] department chat tenant discovery failed", error);

  const out: DepartmentChatRun[] = [];
  for (let i = 0; i < tenantIds.length; i += width) {
    const batch = tenantIds.slice(i, i + width);
    out.push(
      ...(await Promise.all(
        batch.map(async (tenantId): Promise<DepartmentChatRun> => {
          try {
            const summary = await run(tenantId, {
              nowMs,
              notify: opts.notify && alertAudienceFor(tenantId) === "oasis_operator",
              checks: DEPARTMENT_CHAT_CHECKS,
            });
            return { tenantId, summary, failed: false };
          } catch (err) {
            const reason = `department chat run threw: ${err instanceof Error ? err.message : String(err)}`;
            console.error("[health-check] department chat run failed", { tenantId, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
            await recordBrokenRun(tenantId, reason, nowMs);
            return { tenantId, summary: brokenSummary("department_chat_outcomes", reason), failed: true };
          }
        }),
      )),
    );
  }
  return out;
}
