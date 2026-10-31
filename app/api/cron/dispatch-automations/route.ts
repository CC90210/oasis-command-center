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
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    console.error("[cron.dispatch-automations] failed", { code: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ ok: false, error: "automation_dispatch_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
