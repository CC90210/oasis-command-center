/**
 * POST /api/leads/[id]/collaborators — add or remove a shared-deal collaborator
 * on a tenant_records row (lead / application / funded_deal).
 *
 * 2026-06-22 (per-employee CRM personalization). `data.collaborators` is an
 * array of auth_user_ids who can SEE + work a deal alongside the primary owner
 * (`data.assigned_to`). A deal shared by Alex with Jordan is visible to exactly
 * Alex (owner) + Jordan (collaborator) + admins — see lib/lead-scope
 * recordMatchesViewer.
 *
 * Body: { add?: string, remove?: string }  — auth_user_id to add/remove.
 *
 * Authorization: owner-or-admin (mirrors /assign). An admin edits any deal's
 * collaborators; an agent may only edit a deal they OWN. A collaborator can NOT
 * add/remove others (only the owner/admin manages the roster). 404 (not 403) for
 * a non-owner agent so the endpoint doesn't confirm a deal they can't see exists.
 *
 * Response 200: { ok: true, collaborators: string[] }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import {
  normalizeCollaborators,
  MAX_COLLABORATORS,
  COLLABORATORS_KEY,
} from "@/lib/lead-scope";
import { canWriteCrm } from "@/lib/role-gates";
import { nudgeBoards } from "@/lib/realtime/board-nudge";
import { canMutateGenericLeadForTenant } from "@/lib/lead-access";
import { roleMayOperateOasisSalesLead } from "@/lib/oasis-sales-pipeline-policy";

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
  // CRM-write authorization (2026-07-07, CC directive). Sharing a deal with a
  // teammate is core CRM work for ANY non-read_only member, on ANY lead in the
  // tenant — not owner-gated. Checked FIRST (before any record lookup) so a
  // read_only caller can't use the response to probe record existence (Codex
  // adversarial review 2026-07-07). Tenant isolation enforced by the fetch below.
  if (!canWriteCrm(sess.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't manage collaborators." },
      { status: 403 },
    );
  }
  const tenantId = sess.tenantId;
  const { id: recordId } = await ctx.params;
  if (!recordId || !UUID_RE.test(recordId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let body: { add?: string | null; remove?: string | null };
  try {
    body = (await req.json()) as { add?: string | null; remove?: string | null };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const addId = typeof body.add === "string" && body.add.trim() ? body.add.trim().toLowerCase() : null;
  const removeId = typeof body.remove === "string" && body.remove.trim() ? body.remove.trim().toLowerCase() : null;
  if (!addId && !removeId) {
    return NextResponse.json({ ok: false, error: "nothing_to_change", message: "Provide add or remove." }, { status: 400 });
  }
  if (addId && !UUID_RE.test(addId)) {
    return NextResponse.json({ ok: false, error: "invalid_add", message: "add must be a user UUID." }, { status: 400 });
  }
  if (removeId && !UUID_RE.test(removeId)) {
    return NextResponse.json({ ok: false, error: "invalid_remove", message: "remove must be a user UUID." }, { status: 400 });
  }

  const db = getServiceSupabase();

  // The added user must be a member of THIS tenant (prevents cross-tenant
  // sharing). Removal needs no membership check — we just drop the id.
  if (addId) {
    const memberCheck = await db
      .from("user_profiles")
      .select("auth_user_id")
      .eq("tenant_id", tenantId)
      .eq("auth_user_id", addId)
      .maybeSingle();
    if (!memberCheck.data) {
      return NextResponse.json(
        { ok: false, error: "not_a_tenant_member", message: "That user isn't on this tenant." },
        { status: 400 },
      );
    }
  }

  // Existence + entity gate + current owner/collaborators read.
  const existing = await db
    .from("tenant_records")
    .select("id, entity_type, data")
    .eq("tenant_id", tenantId)
    .in("entity_type", ["lead", "application", "funded_deal"])
    .eq("id", recordId)
    .maybeSingle();
  if (!existing.data) {
    return NextResponse.json({ ok: false, error: "record_not_found" }, { status: 404 });
  }

  const data = (existing.data as { data?: Record<string, unknown> }).data || {};
  // Managing the collaborator roster is stricter than working a shared lead.
  // On the OASIS sales surface, a collaborator may edit the lead itself but may
  // not grant or revoke somebody else's access. Only the assigned owner (or an
  // admin capability) controls this list.
  const currentOwner =
    typeof data.assigned_to === "string" ? data.assigned_to.trim().toLowerCase() : null;
  if (
    !canMutateGenericLeadForTenant(
      {
        teamRole: sess.teamRole,
        userId: sess.userId,
        isOwner: sess.isTrueAdmin,
        adminAccess: sess.adminAccess,
      },
      { id: recordId, data },
    ) ||
    (!sess.isAdmin &&
      roleMayOperateOasisSalesLead(sess.teamRole) &&
      currentOwner !== sess.userId.trim().toLowerCase())
  ) {
    return NextResponse.json({ ok: false, error: "record_not_found" }, { status: 404 });
  }

  // Compute the next collaborator set.
  let next = normalizeCollaborators(data);
  if (removeId) next = next.filter((c) => c !== removeId);
  if (addId) {
    // Adding the owner as a collaborator is redundant — they already see it.
    if (addId === currentOwner) {
      return NextResponse.json(
        { ok: false, error: "owner_not_collaborator", message: "The owner already has access; assign instead to transfer ownership." },
        { status: 400 },
      );
    }
    if (!next.includes(addId)) {
      if (next.length >= MAX_COLLABORATORS) {
        return NextResponse.json(
          { ok: false, error: "collaborator_cap", message: `A deal can have at most ${MAX_COLLABORATORS} collaborators.` },
          { status: 400 },
        );
      }
      next = [...next, addId];
    }
  }

  // Atomic merge (same RPC + rationale as /assign — avoids dropping concurrent
  // sibling edits on the data blob).
  const update = await db.rpc("patch_tenant_record_data", {
    p_id: recordId,
    p_tenant_id: tenantId,
    p_patch: { [COLLABORATORS_KEY]: next },
  });
  if (update.error) {
    return NextResponse.json(
      { ok: false, error: "update_failed", message: update.error.message },
      { status: 500 },
    );
  }

  // Audit trail — best-effort.
  try {
    const note = addId
      ? `Added collaborator ${addId} by ${sess.email || "an admin"}.`
      : `Removed collaborator ${removeId} by ${sess.email || "an admin"}.`;
    await db.from("lead_interactions").insert({
      tenant_id: tenantId,
      lead_id: recordId,
      type: "collaborator_changed",
      channel: "system",
      direction: "outbound",
      agent_source: "dashboard_collaborators",
      subject: "Collaborator changed",
      content: note,
      content_preview: note,
      metadata: {
        collaborators: next,
        changed_by: sess.userId,
        added: addId,
        removed: removeId,
        entity_type: existing.data.entity_type,
      },
    });
  } catch {
    /* best-effort audit */
  }

  // Live nudge — the owner + the added/removed collaborator's boards changed.
  await nudgeBoards([currentOwner, addId, removeId]);

  return NextResponse.json({ ok: true, collaborators: next });
}
