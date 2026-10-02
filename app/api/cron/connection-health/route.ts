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
 * 50 minutes ago, HEALTH_PASS_LIMIT (3) per run, the most that fit the pass's
 * 45-second budget even when every probe runs to its deadline. A run that
 * still runs short defers the rest and says how many (`deferred`).
 *
 * The response body is printed to a PUBLIC Actions log (cron-driver.yml), so
 * it carries stable error codes only; the full error and stack go to the
 * server log.
 */
import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { runConnectionHealthPass } from "@/lib/connections/health";
import { retrySlackTokenCleanups } from "@/lib/slack/install";
import { purgeSlackRetention } from "@/lib/slack/retention";
import { purgeClientErrorReports } from "@/lib/client-errors/retention";

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
    const db = getTursoClient();
    const result = await runConnectionHealthPass({ db, now: () => new Date() });
    // Slack's 90-day retention rides on this schedule (lib/slack/retention.ts).
    // Its own failure is reported by code, after the health pass has run.
    let slackRetention: Record<string, unknown>;
    let retentionFailed = false;
    try {
      slackRetention = { ...(await purgeSlackRetention(db, new Date())) };
    } catch (err) {
      console.error("[cron.connection-health.slack-retention]", err instanceof Error ? err.stack : err);
      slackRetention = { error: "slack_retention_failed" };
      retentionFailed = true;
    }
    // Browser crash reports keep 30 days (lib/client-errors/retention.ts).
    let clientErrorRetention: Record<string, unknown>;
    try {
      clientErrorRetention = { ...(await purgeClientErrorReports(db, new Date())) };
    } catch (err) {
      console.error("[cron.connection-health.client-error-retention]", err instanceof Error ? err.stack : err);
      clientErrorRetention = { error: "client_error_retention_failed" };
      retentionFailed = true;
    }
    // Slack tokens an install gave up and Slack did not confirm switching off
    // (lib/slack/install.ts abandonInstallToken) are retried here, counts only.
    let slackTokenCleanup: Record<string, unknown>;
    try {
      slackTokenCleanup = { ...(await retrySlackTokenCleanups({ db, now: () => new Date() })) };
    } catch (err) {
      console.error("[cron.connection-health.slack-token-cleanup]", err instanceof Error ? err.stack : err);
      slackTokenCleanup = { error: "slack_token_cleanup_failed" };
      retentionFailed = true;
    }
    const ok = result.errors.length === 0 && !retentionFailed;
    return NextResponse.json(
      { ok, ...result, slack_retention: slackRetention, client_error_retention: clientErrorRetention, slack_token_cleanup: slackTokenCleanup },
      { status: ok ? 200 : 500 },
    );
  } catch (err) {
    console.error("[cron.connection-health]", err instanceof Error ? err.stack : err);
    return NextResponse.json({ ok: false, error: "connection_health_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
