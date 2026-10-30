import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getTursoClient } from "@/lib/turso";
import { cloudJobDryRun, cloudJobEnabled } from "@/lib/cloud-jobs/control";
import { runPostAnalyticsSync } from "@/lib/cloud-jobs/post-analytics-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  if (!cloudJobEnabled("POST_ANALYTICS_SYNC_ENABLED")) {
    return NextResponse.json({ ok: true, skipped: "post_analytics_sync_disabled" });
  }
  const denied = checkCronAuth(request);
  if (denied) return denied;
  try {
    const result = await runPostAnalyticsSync({
      db: getTursoClient(),
      dryRun: cloudJobDryRun(request, "POST_ANALYTICS_SYNC_DRY_RUN"),
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[cron.post-analytics-sync]", error instanceof Error ? error.stack : error);
    return NextResponse.json({ ok: false, error: "post_analytics_sync_failed" }, { status: 500 });
  }
}
