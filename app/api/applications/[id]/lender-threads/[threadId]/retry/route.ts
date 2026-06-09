/**
 * POST /api/applications/[id]/lender-threads/[threadId]/retry
 *
 * Operator surface: flip ONE error-status lender thread back to pending so
 * the shop_out_sender daemon's next tick re-fires it through send_gateway.
 *
 * Why this exists: when send_gateway's kill-switch gate fail-closed on
 * 2026-06-08 every shop-out thread for the 8 lenders selected landed at
 * status='error'. Without this endpoint the operator's only recovery
 * path is either (a) raw SQL, or (b) SSH-ing to the VPS and running
 *   `python scripts/shop_out_sender.py retry-errors --tenant-id <uuid>`.
 * Neither is acceptable for non-engineer operators (Ezra, Jordan, Emily,
 * Alex). One-click Retry next to the error row is.
 *
 * Auth: session cookie + tenant_id match on the application (the same
 * gate /shop-out + /lender-threads use). The thread must belong to the
 * authenticated operator's tenant — strict scoping to prevent retrying
 * threads from another tenant.
 *
 * Idempotent: retrying a thread that's already pending/sending/sent is
 * a no-op success (we only update rows currently in 'error' state).
 *
 * Response: { ok: true, thread_id, previous_status, new_status }.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveTenantId } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; threadId: string }> },
) {
  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { id: applicationId, threadId } = await ctx.params;

  const db = getServiceSupabase();

  // Confirm the thread belongs to this tenant AND this application. The
  // tenant gate is the security boundary; the application gate is the UX
  // sanity check (a thread targeted via /applications/<wrongId>/.../retry
  // would otherwise affect the right tenant's threads under a wrong URL).
  const threadRes = await db
    .from("application_lender_threads")
    .select("id, tenant_id, application_id, status, last_error")
    .eq("id", threadId)
    .eq("tenant_id", tenantId)
    .eq("application_id", applicationId)
    .maybeSingle();
  if (threadRes.error) {
    return NextResponse.json(
      { ok: false, error: "thread_lookup_failed" },
      { status: 500 },
    );
  }
  if (!threadRes.data) {
    return NextResponse.json(
      { ok: false, error: "thread_not_found" },
      { status: 404 },
    );
  }
  const thread = threadRes.data as {
    id: string;
    status: string;
    last_error: string | null;
  };

  if (thread.status !== "error") {
    return NextResponse.json({
      ok: true,
      thread_id: thread.id,
      previous_status: thread.status,
      new_status: thread.status,
      noop: true,
    });
  }

  const updateRes = await db
    .from("application_lender_threads")
    .update({
      status: "pending",
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", thread.id)
    .eq("tenant_id", tenantId)
    .eq("status", "error")
    .select("id, status");
  if (updateRes.error) {
    return NextResponse.json(
      { ok: false, error: "thread_update_failed" },
      { status: 500 },
    );
  }
  const updatedCount = Array.isArray(updateRes.data) ? updateRes.data.length : 0;
  return NextResponse.json({
    ok: true,
    thread_id: thread.id,
    previous_status: "error",
    new_status: updatedCount > 0 ? "pending" : thread.status,
    noop: updatedCount === 0,
  });
}
