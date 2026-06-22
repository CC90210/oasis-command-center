/**
 * POST /api/leads/[id]/assign — set the assigned_to soft-owner on a
 * tenant_records row (lead / application / funded_deal / renewal).
 *
 * Phase 3 of the SunBiz multi-employee personalization plan
 * (2026-05-29). assigned_to is a presentation hint — surfaces the
 * record at the top of the assignee's personal "My active deals"
 * widget — NOT an authorization gate. Anyone in the tenant can still
 * act on the record regardless of who's assigned. Migration 077
 * (SunBiz-Agent) enforces a UUID-shape CHECK constraint and powers a
 * partial index for the personal-dashboard query.
 *
 * Body:
 *   { assigned_to: string | null }   — auth_user_id of the assignee,
 *                                       or null to clear assignment.
 *
 * Authorization: any team member of the tenant. Soft-ownership means
 * any team member can re-assign. If/when CC asks for "only the current
 * assignee + admins can re-assign" semantics, that gate goes here.
 *
 * Response 200: { ok: true, assigned_to: string | null }
 * Response 4xx: { ok: false, error, message? }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { nudgeBoards } from "@/lib/realtime/board-nudge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  // Authorization is owner-or-admin (Adon Batch 2.2): an ADMIN can reassign any
  // lead to any user; an AGENT can only reassign a lead they currently OWN (peer
  // handoff). The owner check happens after we read the record below — an agent
  // must not be able to pull a lead off another agent's board.
  const tenantId = sess.tenantId;
  const { id: recordId } = await ctx.params;
  if (!recordId || !UUID_RE.test(recordId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let body: { assigned_to?: string | null };
  try {
    body = (await req.json()) as { assigned_to?: string | null };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const raw = body.assigned_to;
  // null / undefined / empty string → CLEAR the assignment. Any other
  // value must be a UUID matching auth_user_id. The DB CHECK constraint
  // would reject non-UUIDs anyway; we validate here for a cleaner
  // 400-with-message rather than the constraint's generic error.
  let nextAssignedTo: string | null = null;
  if (typeof raw === "string" && raw.trim().length) {
    const candidate = raw.trim().toLowerCase();
    if (!UUID_RE.test(candidate)) {
      return NextResponse.json(
        { ok: false, error: "invalid_assigned_to", message: "Must be a user UUID or null." },
        { status: 400 },
      );
    }
    nextAssignedTo = candidate;
  }

  const db = getServiceSupabase();

  // Verify the candidate UUID is a member of THIS tenant. Prevents
  // cross-tenant assignment by accident. We don't need to gate on what
  // role the assignee has — any member is a valid assignee.
  if (nextAssignedTo) {
    const memberCheck = await db
      .from("user_profiles")
      .select("auth_user_id")
      .eq("tenant_id", tenantId)
      .eq("auth_user_id", nextAssignedTo)
      .maybeSingle();
    if (!memberCheck.data) {
      return NextResponse.json(
        {
          ok: false,
          error: "not_a_tenant_member",
          message: "That user isn't on this tenant.",
        },
        { status: 400 },
      );
    }
  }

  // Existence + entity-type check — patch_tenant_record_data has tenant
  // scoping but doesn't restrict entity_type, so we still gate here. Also pull
  // `data` so we can read the current owner for the owner-or-admin gate.
  const existing = await db
    .from("tenant_records")
    .select("id, entity_type, data")
    .eq("tenant_id", tenantId)
    .in("entity_type", ["lead", "application", "funded_deal", "renewal"])
    .eq("id", recordId)
    .maybeSingle();
  if (!existing.data) {
    return NextResponse.json({ ok: false, error: "record_not_found" }, { status: 404 });
  }

  // Owner-or-admin gate. Admins reassign anything; an agent may only reassign a
  // lead they currently own. 404 (not 403) for a non-owner agent so the endpoint
  // doesn't confirm a lead they can't see exists. Fail closed.
  const currentOwner =
    typeof (existing.data as { data?: Record<string, unknown> }).data?.assigned_to === "string"
      ? ((existing.data as { data?: Record<string, unknown> }).data!.assigned_to as string).toLowerCase()
      : null;
  if (!sess.isAdmin && currentOwner !== (sess.userId || "").toLowerCase()) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // 2026-06-06 (Codex audit self-review extension) — atomic merge via
  // the patch_tenant_record_data RPC. The previous read-then-spread-then-
  // write pattern silently dropped concurrent sibling edits on the
  // tenant_records.data blob. Unassign sets the key to null (consumers
  // already treat null as "not assigned") rather than deleting the key,
  // which keeps this on the same RPC.
  const update = await db.rpc("patch_tenant_record_data", {
    p_id: recordId,
    p_tenant_id: tenantId,
    p_patch: { assigned_to: nextAssignedTo },
  });
  if (update.error) {
    return NextResponse.json(
      { ok: false, error: "update_failed", message: update.error.message },
      { status: 500 },
    );
  }

  // Audit trail — who reassigned this record to whom. Best-effort; a logging
  // failure never fails the assignment. Only meaningful for lead/application
  // (the assignee-scoped entities); funded_deal/renewal still log harmlessly.
  try {
    const note = nextAssignedTo
      ? `Reassigned to ${nextAssignedTo} by ${sess.email || "an admin"}.`
      : `Assignment cleared by ${sess.email || "an admin"}.`;
    await db.from("lead_interactions").insert({
      tenant_id: tenantId,
      lead_id: recordId,
      type: "lead_reassigned",
      channel: "system",
      direction: "outbound",
      agent_source: "dashboard_assign",
      subject: "Lead reassigned",
      content: note,
      content_preview: note,
      metadata: {
        assigned_to: nextAssignedTo,
        assigned_by: sess.userId,
        entity_type: existing.data.entity_type,
      },
    });
  } catch {
    /* best-effort audit */
  }

  // Live nudge — the deal left the previous owner's board and joined the new
  // owner's. Refresh both (no-op for whichever is null).
  await nudgeBoards([currentOwner, nextAssignedTo]);

  return NextResponse.json({ ok: true, assigned_to: nextAssignedTo });
}
