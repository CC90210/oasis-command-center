/**
 * /api/cron/connection-health — re-probe every live connection that has not
 * been checked in the last 50 minutes, record each result, and flip statuses
 * (lib/connections/health.ts runConnectionHealthPass). Also trims health
 * history past 30 days and OAuth states past a day.
 *
 * Why it exists: a Settings card is green only while its last live probe is
 * under 24 hours old (lib/connections/rules.ts isVerifiedHealthy). Without this
 * run every card would fall back to "waiting for a health check" a day after
 * connecting, and a key revoked in Stripe would keep looking connected until
 * someone pressed Test.
 *
 * Guarded by lib/cron-auth.ts (CRON_SECRET bearer + platform proof). A probe
 * that FINDS a problem is data, not a failed run; a probe that THROWS (a
 * database read failed) fails the run with a 500 so the cron runner reports it,
 * after every other connection has still been checked.
 *
 * SCHEDULED every 15 minutes (doc 03 a.3), in all three places a cron schedule
 * lives: config/cron-registry.json, workers/oasis-cc-cron/src/index.ts, and the
 * 15-minute group in .github/workflows/cron-driver.yml
 * (tests/cron-driver-coverage.test.ts holds them together). Each connection is
 * still probed about hourly — a run only takes connections checked more than
 * 50 minutes ago, 40 per run.
 */
import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { runConnectionHealthPass } from "@/lib/connections/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  if (!tursoConfigured()) {
    return NextResponse.json({ ok: false, error: "database_not_configured" }, { status: 503 });
  }
  try {
    const result = await runConnectionHealthPass({ db: getTursoClient(), now: () => new Date() });
    const ok = result.errors.length === 0;
    return NextResponse.json({ ok, ...result }, { status: ok ? 200 : 500 });
  } catch (err) {
    console.error("[cron.connection-health]", err instanceof Error ? err.stack : err);
    return NextResponse.json(
      {
        ok: false,
        error: "connection_health_failed",
        detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
      },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
