import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getTursoClient } from "@/lib/turso";
import { cloudJobDryRun, cloudJobEnabled } from "@/lib/cloud-jobs/control";
import { runEventBusRetention } from "@/lib/cloud-jobs/event-bus-retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  if (!cloudJobEnabled("EVENT_BUS_RETENTION_ENABLED")) {
    return NextResponse.json({ ok: true, skipped: "event_bus_retention_disabled" });
  }
  const denied = checkCronAuth(request);
  if (denied) return denied;
  try {
    const result = await runEventBusRetention({
      db: getTursoClient(),
      dryRun: cloudJobDryRun(request, "EVENT_BUS_RETENTION_DRY_RUN"),
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (error) {
    console.error("[cron.event-bus-retention]", error instanceof Error ? error.stack : error);
    return NextResponse.json({ ok: false, error: "event_bus_retention_failed" }, { status: 500 });
  }
}
