import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import {
  HOURLY_HEALTH_FORWARD_ENV,
  jobForwardingEnabled,
  requestedDryRun,
  runHourlyHealth,
} from "@/lib/automations/operator-database-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const dryRun = requestedDryRun(req.nextUrl);
  const forwardEnabled = jobForwardingEnabled(process.env[HOURLY_HEALTH_FORWARD_ENV]);
  if (!forwardEnabled && !dryRun) {
    return NextResponse.json({
      ok: true,
      mode: "off",
      forward_enabled: false,
      switch: HOURLY_HEALTH_FORWARD_ENV,
      notification_writes: 0,
      notification_sends: 0,
      recovery_writes: 0,
    });
  }

  try {
    return NextResponse.json({ ...(await runHourlyHealth(dryRun)), forward_enabled: forwardEnabled });
  } catch (error) {
    console.error("[cron.hourly-health] failed", error);
    return NextResponse.json({ ok: false, error: "hourly_health_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
