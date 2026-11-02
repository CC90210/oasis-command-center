import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { cronPauseGate } from "@/lib/automations/cron-switches";
import { dispatchGuidedAutomations } from "@/lib/automations/guided-dispatcher";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

async function handle(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  const paused = await cronPauseGate(req);
  if (paused) return paused;
  if (!tursoConfigured()) return NextResponse.json({ ok: false, error: "database_not_configured" }, { status: 503 });
  try {
    const summary = await dispatchGuidedAutomations({ db: getTursoClient() });
    const failed = summary.failed.length > 0;
    // The dispatcher owns run/slot state and any retry on the next tick.
    // An immediate scheduler retry can hide this failure behind no-work success.
    return NextResponse.json({ ...summary, ok: !failed }, { status: failed ? 409 : 200 });
  } catch (error) {
    console.error("[cron.dispatch-automations] failed", { code: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ ok: false, error: "automation_dispatch_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
