/**
 * GET+POST /api/cron/health-check — outcome-based health monitoring.
 *
 * Runs every 15 minutes from the Cloudflare/GitHub scheduler. Checks whether the drip estate is
 * actually PRODUCING, not whether processes are up, and alerts to Telegram on
 * anything that is not ok.
 *
 * WHY THIS EXISTS. On 2026-08-06 SMS was found to have been failing for three
 * weeks and email for a day. The local Fleet Watchdog covers process liveness
 * but had no visibility into the hosted jobs where
 * both failures happened. Backtested against 40 days of production, these
 * checks would have fired on 2026-07-24 for SMS and 2026-07-18 for email.
 *
 * It also carries the reverse dead-man's switch: this runs on Cloudflare, a
 * different machine and failure domain from the local fleet, and reports when
 * the local monitor's heartbeat goes stale. A watchdog that cannot report its
 * own death is decorative (2026-06-30 audit, finding #3).
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  runHealthChecks,
  checkFleetHeartbeat,
  OASIS_GLOBAL_CHECKS,
  ESTATE_WIDE_CHECKS,
  DEPARTMENT_CHAT_CHECKS,
  type RunSummary,
} from "@/lib/health/runner";
import { departmentChatTenantIds } from "@/lib/health/department-chat-checks";
import { worstVerdict } from "@/lib/health/checks-core";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Department chat, once per workspace that had a department turn in the last 6
 * h (OASIS always). Per tenant, not under OASIS: a client's broken chat pages
 * against that client's own alert ladder and history. Needs the ai_usage_events
 * ledger only, so it adds nothing to the calendar probe's wall-clock budget.
 */
async function runDepartmentChat(notify: boolean): Promise<Array<{ tenantId: string; summary: RunSummary }>> {
  const { tenantIds, error } = await departmentChatTenantIds();
  // OASIS is still graded below. A ledger that is down fails that run as
  // check_broken and pages; this line covers only a narrower failure of the
  // tenant list, which would otherwise leave client workspaces unwatched.
  if (error) console.error("[health-check] department chat tenant discovery failed", error);
  return Promise.all(
    tenantIds.map(async (tenantId) => ({
      tenantId,
      summary: await runHealthChecks(tenantId, { notify, checks: DEPARTMENT_CHAT_CHECKS }),
    })),
  );
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  // `?notify=0` runs and records without sending, for manual inspection.
  const notify = req.nextUrl.searchParams.get("notify") !== "0";

  try {
    // Keep tenant outcomes in the tenant that owns them. The workspace calendar
    // is OASIS-global infrastructure; persisting it under SunBiz hid it from
    // the OASIS health page and attached the wrong tenancy to its history.
    // Start the Calendar proof immediately alongside independent work. Its
    // probe owns one 30s wall-clock budget (including an 8s delete reserve), so
    // it cannot be queued behind tenant checks and run into this route's 60s
    // platform ceiling before removing its synthetic event.
    //
    // SUNBIZ'S LANE IS GONE (2026-09-28, SunBiz retired). This route used to
    // run SunBiz's tenant outcome checks and its guard audit every 15 minutes,
    // which kept writing health_check_runs (~208 rows / 2h) and
    // health_alert_state for a tenant whose data is being exported and
    // deleted. Its drip, email-drip, shop-out, phone-lookup and extraction
    // checks graded SunBiz only, so they stop with it. The estate-wide checks
    // that had ridden along (production serves main, alert delivery, the form
    // dead-letter table) now run under the OASIS tenant instead.
    const [calendarSummary, estateSummary, heartbeat, departmentRuns] = await Promise.all([
      runHealthChecks(WEBDEV_TENANT_ID, {
        notify,
        checks: OASIS_GLOBAL_CHECKS,
      }),
      runHealthChecks(WEBDEV_TENANT_ID, {
        notify,
        checks: ESTATE_WIDE_CHECKS,
      }),
      checkFleetHeartbeat(getServiceSupabase()),
      runDepartmentChat(notify),
    ]);
    // A client workspace's ids carry its tenant so two workspaces' rows differ.
    const tag = (tenantId: string, id: string) => (tenantId === WEBDEV_TENANT_ID ? id : `${tenantId.slice(0, 8)}:${id}`);
    const departmentResults = departmentRuns.flatMap((d) =>
      d.summary.results.map((r) => ({ ...r, id: tag(d.tenantId, r.id) })));
    const results = [...estateSummary.results, ...calendarSummary.results, ...departmentResults];

    return NextResponse.json({
      ok: true,
      worst: worstVerdict(results),
      ran: estateSummary.ran + calendarSummary.ran + departmentRuns.reduce((n, d) => n + d.summary.ran, 0),
      alerted: [
        ...estateSummary.alerted,
        ...calendarSummary.alerted,
        ...departmentRuns.flatMap((d) => d.summary.alerted.map((id) => tag(d.tenantId, id))),
      ],
      recovered: [
        ...estateSummary.recovered,
        ...calendarSummary.recovered,
        ...departmentRuns.flatMap((d) => d.summary.recovered.map((id) => tag(d.tenantId, id))),
      ],
      fleet_heartbeat: { verdict: heartbeat.verdict, reason: heartbeat.reason },
      results: results.map((r) => ({
        id: r.id, verdict: r.verdict, observed: r.observed, baseline: r.baseline, reason: r.reason,
      })),
    });
  } catch (err) {
    // The route failing is itself a monitoring failure. Return 500 so the
    // Cloudflare runtime and scheduler record a failure rather than a cheerful 200.
    console.error("[health-check] run failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "health_check_failed" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
