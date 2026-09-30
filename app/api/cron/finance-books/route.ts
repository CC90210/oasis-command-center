/**
 * /api/cron/finance-books?job=fx-refresh|stripe-reconcile|wise-reconcile|wise-sync
 * — the books' daily upkeep (lib/founders-finances/books-cron.ts says what
 * each job does, why it is safe to repeat, and why they run in this order).
 *
 * SCHEDULED daily, one registration per job, in all three places a cron
 * schedule lives: config/cron-registry.json, workers/oasis-cc-cron/src/index.ts
 * and the manual rollback map in .github/workflows/cron-driver.yml
 * (tests/cron-driver-coverage.test.ts holds them together).
 *
 * Guarded by lib/cron-auth.ts (CRON_SECRET bearer + platform proof). The body
 * carries counts and stable codes only, because the rollback driver prints it
 * to a public Actions log; the full error goes to the server log. A job that
 * fails answers non-2xx so the Worker records the tick as failed.
 */
import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { financeBookJobFailure, isFinanceBookJob, runFinanceBookJob } from "@/lib/founders-finances/books-cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  const job = req.nextUrl.searchParams.get("job");
  if (!isFinanceBookJob(job)) return NextResponse.json({ ok: false, error: "unknown_job" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, job, result: await runFinanceBookJob(job) });
  } catch (e) {
    const { code, status } = financeBookJobFailure(e);
    console.error(`[cron.finance-books:${job}]`, e instanceof Error ? e.stack : e);
    return NextResponse.json({ ok: false, job, error: code }, { status });
  }
}

export const GET = handle;
export const POST = handle;
