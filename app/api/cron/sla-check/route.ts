/**
 * /api/cron/sla-check — support first-response SLA watcher.
 *
 * Guarded by lib/cron-auth.ts (CRON_SECRET bearer + platform proof). Flags
 * first-response breaches, alerts the founders ONCE per breach (Telegram
 * operator lane + email from the OASIS mailbox; a lane that failed is retried
 * on the next run), and reconciles support-form intake. See
 * lib/delivery/sla-cron.ts.
 *
 * Before 2026-09-24 this inserted into agent_events with a column that table
 * does not have (agent_name), against a support_tickets table that did not
 * exist, and relied on "background systems" to turn those rows into alerts.
 *
 * Returns 500 when a breach alert failed to send, so the cron runner's own
 * failure reporting sees it; the per-ticket reason is on each ticket.
 *
 * SCHEDULED every 15 minutes, in all three places a cron schedule lives:
 * config/cron-registry.json, workers/oasis-cc-cron/src/index.ts, and the
 * 15-minute group in .github/workflows/cron-driver.yml. A schedule change
 * touches all three.
 */
import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { defaultNotifyDeps } from "@/lib/delivery/notify";
import { runSlaCheck } from "@/lib/delivery/sla-cron";

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
    const result = await runSlaCheck(getTursoClient(), defaultNotifyDeps(), new Date());
    // Alert failures fail the run, and every run after it until the retry
    // goes through or the ticket is answered or closed: a dead alert channel
    // stays red. An unparseable orphan submission is reported in the body and
    // logged, but would re-fail every run for a week, so it does not flip the
    // status.
    const ok = result.alert_failures.length === 0;
    return NextResponse.json({ ok, ...result }, { status: ok ? 200 : 500 });
  } catch (err) {
    console.error("[cron.sla-check]", err instanceof Error ? err.stack : err);
    return NextResponse.json(
      { ok: false, error: "sla_check_failed", detail: err instanceof Error ? err.message.slice(0, 300) : String(err) },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
