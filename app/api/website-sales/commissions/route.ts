import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolvePersona } from "@/lib/role-surfaces";
import { loadCommissionPortal } from "@/lib/website-sales-commission-portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET - the Commissions portal's data, for its Refresh and the re-read after a
 * payout change. The page paints the same data on the server with the same
 * function (lib/website-sales-commission-portal.ts), so a visit needs no
 * request from the browser at all.
 */
export async function GET() {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const persona = resolvePersona({
    teamRole: session.teamRole,
    isTrueAdmin: session.isTrueAdmin,
    adminAccess: session.adminAccess,
  });
  const { status, body } = await loadCommissionPortal(session, persona);
  return NextResponse.json(body, { status });
}

type PatchBody = {
  id?: unknown;
  action?: unknown;
  requestId?: unknown;
  payoutReference?: unknown;
  voidReason?: unknown;
};

export async function PATCH(req: Request) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!session.isTrueAdmin) {
    return NextResponse.json({ ok: false, error: "founder_only" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as PatchBody | null;
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const action = typeof body?.action === "string" ? body.action.trim() : "";
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  if (!id || id.length > 200 || !["approve", "mark_paid", "void"].includes(action)) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  if (!requestId || requestId.length > 200) {
    return NextResponse.json({ ok: false, error: "request_id_required" }, { status: 400 });
  }
  const payoutReference = typeof body?.payoutReference === "string" ? body.payoutReference.trim() : "";
  const voidReason = typeof body?.voidReason === "string" ? body.voidReason.trim() : "";
  if (action === "mark_paid" && (payoutReference.length < 3 || payoutReference.length > 200)) {
    return NextResponse.json({ ok: false, error: "payout_reference_required" }, { status: 400 });
  }
  if (action === "void" && (voidReason.length < 8 || voidReason.length > 500)) {
    return NextResponse.json({ ok: false, error: "void_reason_required" }, { status: 400 });
  }

  const result = await getServiceSupabase().rpc("transition_commission_entry", {
    p_tenant_id: session.tenantId,
    p_commission_id: id,
    p_actor_user_id: session.userId,
    p_action: action,
    p_request_id: requestId,
    p_occurred_at: new Date().toISOString(),
    ...(action === "mark_paid" ? { p_payout_reference: payoutReference } : {}),
    ...(action === "void" ? { p_void_reason: voidReason } : {}),
  });
  if (result.error) {
    const message = result.error.message || "commission_transition_failed";
    // The portal shows a sentence for this (lib/ui/error-copy.ts), so the
    // detail is kept here.
    console.error("[website-sales.commissions.transition]", message);
    const status = message.includes("not_found_or_wrong_tenant")
      ? 404
      : message.includes("self_approval_forbidden")
        ? 403
        : message.includes("immutable") || message.includes("required") || message.includes("invalid")
          ? 400
          : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
  const data = result.data as { ok?: boolean; error?: string } | null;
  if (!data?.ok) {
    return NextResponse.json({ ok: false, error: data?.error || "status_conflict", data }, { status: 409 });
  }
  return NextResponse.json({ ok: true, data });
}
