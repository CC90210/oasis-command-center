/**
 * /api/cron/ai-audit-tick - the Free AI Audit's scheduled upkeep
 * (lib/ai-audit/tick.ts runAiAuditTick): PDF prints and the delivery approval
 * once a PDF exists, Stripe checks of open checkouts, onboarding after a
 * verified payment, refund and dispute re-checks, stall flags, and lead stage
 * repair, for OASIS's own workspaces only. It never contacts a client.
 *
 * Guarded by lib/cron-auth.ts (CRON_SECRET bearer + platform proof). SCHEDULED
 * every 5 minutes, in all three places a cron schedule lives:
 * config/cron-registry.json, workers/oasis-cc-cron/src/index.ts, and the
 * 5-minute group in .github/workflows/cron-driver.yml
 * (tests/cron-driver-coverage.test.ts holds them together). The answer carries
 * counts and step names only: no client data. Any step error answers 500 so
 * the driver reports it; the other steps still ran.
 */
import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { runAiAuditTick } from "@/lib/ai-audit/tick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;

async function handle(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  if (!tursoConfigured()) {
    return NextResponse.json({ ok: false, error: "database_not_configured" }, { status: 503 });
  }
  try {
    const report = await runAiAuditTick(getTursoClient(), { budgetMs: 200_000 });
    const { errors, ...counts } = report;
    const body = { ok: errors.length === 0, ...counts, errors: errors.map((e) => ({ step: e.step, error: e.error.slice(0, 120) })) };
    return NextResponse.json(body, { status: errors.length ? 500 : 200 });
  } catch (err) {
    console.error("[ai-audit-tick] run failed", err instanceof Error ? err.stack : err);
    return NextResponse.json({ ok: false, error: "ai_audit_tick_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
