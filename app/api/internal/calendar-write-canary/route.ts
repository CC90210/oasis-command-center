import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { WEBDEV_TENANT_ID } from "@/lib/oasis-tenant";
import { CALENDAR_WRITE_CANARY_CHECKS } from "@/lib/health/calendar-checks";
import { runHealthChecks } from "@/lib/health/runner";
export const runtime = "nodejs";
export const maxDuration = 60;
/** Explicit owner-controlled canary only, using a separate configured calendar. */
export async function POST(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  const result = await runHealthChecks(WEBDEV_TENANT_ID, { checks: CALENDAR_WRITE_CANARY_CHECKS, notify: false });
  return NextResponse.json(result, { status: result.worst === "ok" ? 200 : 409 });
}
