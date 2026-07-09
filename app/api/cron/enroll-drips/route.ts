/**
 * GET+POST /api/cron/enroll-drips — Vercel cron, every 15 min (vercel.json).
 * Cron-secret authed (lib/cron-auth.ts, same pattern as every other
 * /api/cron/* route) — Vercel calls both GET and POST the same way, so both
 * methods are wired to the same handler.
 *
 * Thin wrapper: all logic lives in lib/drips/enroller.ts runEnrollDrips().
 * See that file's header for the full dry-run/DRIPS_LIVE contract — this
 * route never branches on it, it just reports whatever the enroller returns.
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { runEnrollDrips } from "@/lib/drips/enroller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handleEnroll(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  try {
    const result = await runEnrollDrips();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[enroll-drips] unhandled error", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unhandled_error" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return handleEnroll(req);
}

export async function POST(req: NextRequest) {
  return handleEnroll(req);
}
