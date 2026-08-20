/**
 * GET+POST /api/cron/health-check — outcome-based health monitoring.
 *
 * Runs every 15 minutes (vercel.json). Checks whether the drip estate is
 * actually PRODUCING, not whether processes are up, and alerts to Telegram on
 * anything that is not ok.
 *
 * WHY THIS EXISTS. On 2026-08-06 SMS was found to have been failing for three
 * weeks and email for a day. The existing watchdog covers 9 local PM2 processes
 * — 8 of them liveness-only — and had no visibility into the Vercel crons where
 * both failures happened. Backtested against 40 days of production, these
 * checks would have fired on 2026-07-24 for SMS and 2026-07-18 for email.
 *
 * It also carries the reverse dead-man's switch: this runs on Vercel, a
 * different machine and failure domain from the local fleet, and reports when
 * the local monitor's heartbeat goes stale. A watchdog that cannot report its
 * own death is decorative (2026-06-30 audit, finding #3).
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { runHealthChecks, checkFleetHeartbeat } from "@/lib/health/runner";
import { runGuardAudit, announceGuardAudit } from "@/lib/health/guard-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SUNBIZ_TENANT_ID = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

async function handle(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  // `?notify=0` runs and records without sending, for manual inspection.
  const notify = req.nextUrl.searchParams.get("notify") !== "0";

  try {
    const summary = await runHealthChecks(SUNBIZ_TENANT_ID, { notify });
    // The reverse dead-man's switch runs regardless of the drip checks, so a
    // failure in one cannot hide the other.
    const heartbeat = await checkFleetHeartbeat(getServiceSupabase());

    // DID EACH GUARD ACTUALLY DO ANYTHING?
    //
    // The checks above measure OUTCOMES (did texts go out, did email volume
    // hold). This measures the MECHANISMS, and it exists because all three bugs
    // found on 2026-08-20 were guards that ran, raised nothing, and affected
    // nothing. A filter that excludes 100% of its input is indistinguishable
    // from a quiet upstream unless something asks.
    //
    // Runs every tick but only PAGES once a day: the reading is a weekly
    // window, so re-alerting every 15 minutes would say the same thing 96 times
    // and get the channel muted. Failures here are swallowed for the same
    // reason the alerting is — a broken self-check must not take down the
    // health check it rides on.
    const guards = await runGuardAudit(SUNBIZ_TENANT_ID).catch(() => null);
    if (notify && guards) {
      await announceGuardAudit(SUNBIZ_TENANT_ID, guards).catch(() => undefined);
    }

    return NextResponse.json({
      ok: true,
      worst: summary.worst,
      ran: summary.ran,
      alerted: summary.alerted,
      recovered: summary.recovered,
      fleet_heartbeat: { verdict: heartbeat.verdict, reason: heartbeat.reason },
      guard_audit: guards
        ? { summary: guards.summary, findings: guards.findings.filter((f) => f.severity !== "info") }
        : { summary: "guard audit could not run", findings: [] },
      results: summary.results.map((r) => ({
        id: r.id, verdict: r.verdict, observed: r.observed, baseline: r.baseline, reason: r.reason,
      })),
    });
  } catch (err) {
    // The route failing is itself a monitoring failure. Return 500 so Vercel
    // records it and the cron shows as failing, rather than a cheerful 200.
    console.error("[health-check] run failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "health_check_failed" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
