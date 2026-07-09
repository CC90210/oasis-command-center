/**
 * GET+POST /api/cron/dispatch-drips — fires due rows from `drip_runs`
 * (database/115_drip_runs.sql). Vercel cron, every 5 min (vercel.json).
 * Cron-secret authed (lib/cron-auth.ts, same pattern as every other
 * /api/cron/* route) — Vercel calls both GET and POST the same way, so both
 * methods are wired to the same handler.
 *
 * Thin wrapper: all logic lives in lib/drips/executor.ts runDispatchDrips().
 * See that file's header for the claim/retry/quiet-hours/DRIPS_LIVE
 * contract — this route never branches on any of it, it just reports
 * whatever the executor returns.
 *
 * TRIGGER: Vercel Cron (vercel.json crons) is the primary driver. The Vercel
 * scheduler only attaches to a genuine Git-integration production deployment,
 * so this route must reach prod via a Git push/merge, not an API-only
 * redeploy. The handler is idempotent (CAS row-claim) so an additional
 * external pinger of this endpoint is safe as a belt-and-suspenders backup.
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { runDispatchDrips } from "@/lib/drips/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handleDispatch(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  try {
    const result = await runDispatchDrips();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[dispatch-drips] unhandled error", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unhandled_error" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return handleDispatch(req);
}

export async function POST(req: NextRequest) {
  return handleDispatch(req);
}
