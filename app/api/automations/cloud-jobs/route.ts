/**
 * POST /api/automations/cloud-jobs - switch one scheduled cloud job ON or OFF
 * (2026-10-31, CC: "turn any cloud automation on or off with a single click").
 *
 * Body: { route: <a workers/oasis-cc-cron CRON_TABLE path>, enabled: boolean }.
 * Only the agents owner (CC) in an OASIS workspace may switch, and only from
 * this site; everyone else gets 404. The switch is stored in cron_job_switches
 * and every scheduled route checks it first (lib/automations/cron-switches.ts
 * cronPauseGate), so OFF stops the work on the next tick. Every change is
 * written to tenant_audit_log. The work: lib/automations/cloud-job-switch.ts.
 */
import type { NextResponse } from "next/server";
import { handleCloudJobSwitch } from "@/lib/automations/cloud-job-switch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  return handleCloudJobSwitch(req);
}
