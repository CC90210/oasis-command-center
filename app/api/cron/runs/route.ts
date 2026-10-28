/**
 * POST /api/cron/runs - the cron Worker's report of one tick (2026-10-28, Phase 7).
 *
 * workers/oasis-cc-cron posts {tick, results: [{path, ok, status, attempts, ms}]} after forwarding the
 * routes due that minute. Same two-leg auth as every cron route (lib/cron-auth.ts). Only routes in the
 * Worker's own CRON_TABLE are stored (lib/automations/cron-runs.ts), into cron_runs (bravo__249), which
 * the Automations flow cards read. Never scheduled itself (tests/cron-driver-coverage.test.ts).
 */
import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { parseCronRunBatch, recordCronRuns } from "@/lib/automations/cron-runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  if (!tursoConfigured()) return NextResponse.json({ ok: false, error: "database_not_configured" }, { status: 503 });
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const batch = parseCronRunBatch(raw);
  if (!batch) return NextResponse.json({ ok: false, error: "invalid_batch" }, { status: 400 });
  try {
    const recorded = await recordCronRuns(getTursoClient(), batch, Date.now());
    return NextResponse.json({ ok: true, recorded });
  } catch (err) {
    console.error("[cron.runs]", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false, error: "record_failed" }, { status: 503 });
  }
}
