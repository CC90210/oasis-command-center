import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getTursoClient } from "@/lib/turso";
import { cloudJobDryRun, cloudJobEnabled } from "@/lib/cloud-jobs/control";
import { runServiceChecks } from "@/lib/cloud-jobs/service-checks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  // The handover off-switch is deliberately the first read. Unset or mistyped
  // means disabled, so the Windows copy can remain the explicit backup.
  if (!cloudJobEnabled("SERVICE_CHECKS_ENABLED")) {
    return NextResponse.json({ ok: true, skipped: "service_checks_disabled" });
  }
  const denied = checkCronAuth(request);
  if (denied) return denied;
  try {
    const result = await runServiceChecks({
      db: getTursoClient(),
      dryRun: cloudJobDryRun(request, "SERVICE_CHECKS_DRY_RUN"),
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (error) {
    console.error("[cron.service-checks]", error instanceof Error ? error.stack : error);
    return NextResponse.json({ ok: false, error: "service_checks_failed" }, { status: 500 });
  }
}
