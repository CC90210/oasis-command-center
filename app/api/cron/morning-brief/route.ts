import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import {
  jobForwardingEnabled,
  MORNING_BRIEF_FORWARD_ENV,
  requestedDryRun,
  runMorningBrief,
} from "@/lib/automations/operator-database-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const dryRun = requestedDryRun(req.nextUrl);
  const forwardEnabled = jobForwardingEnabled(process.env[MORNING_BRIEF_FORWARD_ENV]);
  if (!forwardEnabled && !dryRun) {
    return NextResponse.json({
      ok: true,
      mode: "off",
      forward_enabled: false,
      switch: MORNING_BRIEF_FORWARD_ENV,
      notification_writes: 0,
      notification_sends: 0,
    });
  }

  try {
    return NextResponse.json({ ...(await runMorningBrief(dryRun)), forward_enabled: forwardEnabled });
  } catch (error) {
    console.error("[cron.morning-brief] failed", error);
    return NextResponse.json({ ok: false, error: "morning_brief_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
