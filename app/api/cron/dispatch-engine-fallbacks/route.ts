import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { cronPauseGate } from "@/lib/automations/cron-switches";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { dispatchDueEngineFallbacks } from "@/lib/os/runs/fallback-dispatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

/** Durable owner for explicit computer -> workspace API fallback. Browser SSE
 * followers may disappear and connectors may be offline; the minute scheduler
 * still promotes due rows with the same CAS and holds the hosted driver open. */
async function handle(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  const paused = await cronPauseGate(req);
  if (paused) return paused;
  if (!tursoConfigured()) {
    return NextResponse.json({ ok: false, error: "database_not_configured" }, { status: 503 });
  }
  try {
    const summary = await dispatchDueEngineFallbacks({ db: getTursoClient() });
    const ok = summary.failed.length === 0 && summary.errors.length === 0;
    return NextResponse.json({ ...summary, ok }, { status: ok ? 200 : 409 });
  } catch (error) {
    console.error("[cron.dispatch-engine-fallbacks] failed", error instanceof Error ? (error.stack ?? error.message) : String(error));
    return NextResponse.json({ ok: false, error: "engine_fallback_dispatch_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
