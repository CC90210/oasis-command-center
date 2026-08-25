/**
 * POST /api/leads/[id]/drip-toggle — flip the lead's drip_paused flag.
 *
 * Stored in tenant_records.data.drip_paused (boolean). The OASIS drip
 * sequence runner (scripts/funnel_nurture.py and friends) honors this
 * flag: when true, the lead is skipped on every pass. Operators flip
 * it from the lead drawer's action toolbar when a lead is genuinely
 * stale and shouldn't be auto-poked anymore, or when they're picking
 * the conversation back up manually.
 *
 * Returns the resulting state so the UI doesn't have to optimistically
 * guess + roll back. Idempotent in the sense that two callers racing
 * to toggle will land on whichever read+write wins — small race window
 * is acceptable here since the operator is the only writer.
 *
 * Auth: session-cookie → tenant. Read-modify-write inside one request
 * so we don't clobber unrelated fields in the data jsonb.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  const access = await assertMayWorkLead({
    teamRole: sess.teamRole,
    userId: sess.userId,
    tenantId: sess.tenantId,
    leadId: id,
    isOwner: sess.isTrueAdmin,
    adminAccess: sess.adminAccess,
    accessMode: "owned_oasis_sales",
  });
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, error: access.error, message: access.message },
      { status: access.status },
    );
  }

  const db = getServiceSupabase();

  // Read the current drip state — the patch is a XOR of the prior value,
  // so we need to know what was set. This single-key read is fast and
  // doesn't carry the same lost-update risk as a multi-key write.
  const cur = await db
    .from("tenant_records")
    .select("data")
    .eq("tenant_id", sess.tenantId)
    .eq("entity_type", "lead")
    .eq("id", id)
    .maybeSingle();
  if (cur.error) {
    return NextResponse.json({ ok: false, error: cur.error.message }, { status: 500 });
  }
  if (!cur.data) {
    return NextResponse.json({ ok: false, error: "lead_not_found" }, { status: 404 });
  }

  const currentData =
    (cur.data.data as Record<string, unknown> | null) ?? {};
  const wasPaused = currentData.drip_paused === true;
  const nextPaused = !wasPaused;

  // 2026-06-06 (Codex audit) — atomic shallow merge so concurrent
  // sibling edits aren't clobbered. The previous {...currentData, drip_paused}
  // pattern silently overwrote any lead-detail field change that landed
  // between our read and write.
  const upd = await db.rpc("patch_tenant_record_data", {
    p_id: id,
    p_tenant_id: sess.tenantId,
    p_patch: {
      drip_paused: nextPaused,
      drip_paused_at: nextPaused ? new Date().toISOString() : null,
      drip_paused_by_user_id: nextPaused ? sess.userId : null,
    },
  });
  if (upd.error) {
    return NextResponse.json({ ok: false, error: upd.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, paused: nextPaused });
}
