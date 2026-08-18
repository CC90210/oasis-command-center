/**
 * GET+POST /api/cron/dispatch-bulk-email — drains the dashboard bulk-email
 * queue (lead_interactions, agent_source='dashboard_bulk_email_v2') through
 * the tenant's encrypted submissions-mailbox App Password. Vercel cron, every
 * 5 min (vercel.json). Cron-secret authed (lib/cron-auth.ts, same pattern as
 * every other /api/cron/* route); Vercel calls both GET and POST the same way.
 *
 * Thin wrapper: all logic lives in lib/bulk-email/dispatch.ts
 * runDispatchBulkEmail() — see that file's header for the claim/retry/cap/
 * fail-closed contract. The handler is idempotent (CAS row-claim), so an
 * external belt-and-suspenders pinger of this endpoint is safe.
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { runDispatchBulkEmail } from "@/lib/bulk-email/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handleDispatch(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  try {
    const result = await runDispatchBulkEmail();
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (err) {
    console.error("[dispatch-bulk-email] unhandled error", err);
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
