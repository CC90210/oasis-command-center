/**
 * GET /api/cron/health-scan — the background health worker.
 *
 * Auth: checkCronAuth (Bearer CRON_SECRET **and** x-vercel-cron: 1). Auth is
 * the first non-trivial thing this route does, before any body or query read.
 *
 * DRY-RUN BY DEFAULT. Without ?write=1 it observes and scores but persists
 * nothing and pages nobody, so the route is safe to curl while tuning.
 *
 * Decoupling: runScan wraps every observer, so a target system that throws,
 * hangs, or vanishes produces a recorded 'unknown' rather than a 500 here. This
 * route returning non-200 should mean the MONITOR is broken, never that a
 * monitored feature is.
 *
 * Dead-man: the monitor cannot page about its own silence — a dead scanner
 * sends nothing, which is indistinguishable from all-clear. `scan_heartbeat`
 * below stamps every run so an EXTERNAL watcher (the JARVIS apex-health-monitor,
 * which runs on different infrastructure) can alert on the absence. See the
 * Context Gap Report: wiring that external watcher is still open.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { runScan, syncRegistry } from "@/lib/health/evaluate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authFail = checkCronAuth(req);
  if (authFail) return authFail;

  const write = req.nextUrl.searchParams.get("write") === "1";
  const started = Date.now();

  try {
    const db = getServiceSupabase();

    // Self-register code-defined checks. Only code-owned columns are touched,
    // so operator tuning in the UI survives every deploy.
    const { synced } = write ? await syncRegistry(db) : { synced: 0 };

    const { outcomes, alerted, cleared } = await runScan(db, { write });

    if (write) {
      // Heartbeat for the external dead-man watcher. Keyed on the condition, so
      // it dedups; the value is the timestamp, which is what the watcher reads.
      await db.from("health_alert_state").upsert(
        {
          condition_key: "monitor:scan_heartbeat",
          component: "monitor",
          scope: "scan",
          open: false,
          last_alert_at: new Date().toISOString(),
          next_alert_at: new Date().toISOString(),
          last_text: `scan ok: ${outcomes.length} checks, ${alerted.length} alerted`,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "condition_key" },
      );
    }

    const summary = {
      ok: true,
      dry_run: !write,
      duration_ms: Date.now() - started,
      synced,
      checks: outcomes.length,
      down: outcomes.filter((o) => o.status === "down").length,
      degraded: outcomes.filter((o) => o.status === "degraded").length,
      unknown: outcomes.filter((o) => o.status === "unknown").length,
      alerted,
      cleared: cleared.length,
      outcomes,
    };
    return NextResponse.json(summary);
  } catch (err) {
    // A throw here is a MONITOR failure. Say so loudly and distinctly — a 500
    // from this route must never be read as "a feature is down".
    console.error("[health-scan] scan failed:", err);
    return NextResponse.json(
      {
        ok: false,
        error: "monitor_failure",
        detail: err instanceof Error ? err.message : "unknown",
        duration_ms: Date.now() - started,
      },
      { status: 500 },
    );
  }
}
