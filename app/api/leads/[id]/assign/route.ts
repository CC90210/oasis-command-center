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
import { resolveTenantId } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
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
  // scoping but doesn't restrict entity_type, so we still gate here.
  const existing = await db
    .from("tenant_records")
    .select("id, entity_type")
    .eq("tenant_id", tenantId)
    .in("entity_type", ["lead", "application", "funded_deal", "renewal"])
    .eq("id", recordId)
    .maybeSingle();
  if (!existing.data) {
    return NextResponse.json({ ok: false, error: "record_not_found" }, { status: 404 });
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

  return NextResponse.json({ ok: true, assigned_to: nextAssignedTo });
}
