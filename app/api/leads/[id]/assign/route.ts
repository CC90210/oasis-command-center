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
 * Authorization: shared CRM semantics on legacy tenants. On OASIS, admins may
 * reassign anything; a sales rep may only transfer their own pre-handoff lead
 * to another pre-handoff sales role. Founder/builder ownership is workflow-only.
 *
 * Response 200: { ok: true, assigned_to: string | null }
 * Response 4xx: { ok: false, error, message? }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canWriteCrm } from "@/lib/role-gates";
import { nudgeBoards } from "@/lib/realtime/board-nudge";
import { assignLifecycleOwner } from "@/lib/lifecycle-assignment";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";
import {
  OASIS_WEBSITE_SALES_PROGRAM,
  isWebsiteSalesTenantSlug,
} from "@/lib/leads/canonical-lead-fields";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { roleMayOperateOasisSalesLead } from "@/lib/oasis-sales-pipeline-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Generic reassignment is only a pre-handoff convenience. Once a 15-minute
// audit is booked, ownership belongs to the structured closer/payment/builder
// workflow so attribution and fulfillment cannot be rewritten out of band.
const OASIS_REP_ASSIGNABLE_STAGES = new Set([
  "researched",
  "assigned",
  "attempting_contact",
  "connected",
  "qualified",
]);
const OASIS_PRE_HANDOFF_ASSIGNEE_ROLES = new Set(["opener", "agent", "manager"]);

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  // Shared CRM writers retain the SunBiz handoff model. OASIS sales titles are
  // admitted only far enough to prove role + ownership + pre-handoff stage below.
  if (!canWriteCrm(sess.teamRole) && !roleMayOperateOasisSalesLead(sess.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't reassign leads." },
      { status: 403 },
    );
  }
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
  let nextAssigneeRole: string | null = null;

  // Verify the candidate UUID is a member of THIS tenant. OASIS non-admin
  // transfers also validate the assignee's sales role after loading the lead.
  if (nextAssignedTo) {
    const memberCheck = await db
      .from("user_profiles")
      .select("auth_user_id, team_role")
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
    nextAssigneeRole =
      typeof memberCheck.data.team_role === "string" ? memberCheck.data.team_role : null;
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

  // Current owner + stage are used for OASIS authorization and board nudges.
  const record = existing.data as {
    id: string;
    entity_type: "lead" | "application" | "funded_deal" | "renewal";
    data: Record<string, unknown>;
  };

  const tenantSlug = await resolveOwnedSlug(tenantId);
  if (!tenantSlug) {
    return NextResponse.json({ ok: false, error: "tenant_scope_unresolved" }, { status: 500 });
  }
  const isOasisSalesLead =
    record.entity_type === "lead" &&
    (record.data.sales_program === OASIS_WEBSITE_SALES_PROGRAM ||
      isWebsiteSalesTenantSlug(tenantSlug));
  if (!isOasisSalesLead && !canWriteCrm(sess.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Your role can't reassign this record." },
      { status: 403 },
    );
  }
  if (isOasisSalesLead && !sess.isAdmin) {
    const access = await assertMayWorkLead({
      teamRole: sess.teamRole,
      userId: sess.userId,
      tenantId,
      leadId: recordId,
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

    const currentOwner =
      typeof record.data.assigned_to === "string"
        ? record.data.assigned_to.trim().toLowerCase()
        : "";
    const currentStage =
      typeof record.data.stage === "string" ? record.data.stage.trim().toLowerCase() : "";
    if (
      currentOwner !== sess.userId.toLowerCase() ||
      !OASIS_REP_ASSIGNABLE_STAGES.has(currentStage) ||
      (nextAssignedTo !== null &&
        !OASIS_PRE_HANDOFF_ASSIGNEE_ROLES.has((nextAssigneeRole || "").toLowerCase()))
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "use_website_sales_workflow",
          message: "Use the guided lead handoff for founder, payment, and builder ownership.",
        },
        { status: 409 },
      );
    }
  }

  // 2026-06-06 (Codex audit self-review extension) — atomic merge via
  // the patch_tenant_record_data RPC. The previous read-then-spread-then-
  // write pattern silently dropped concurrent sibling edits on the
  // tenant_records.data blob. Unassign sets the key to null (consumers
  // already treat null as "not assigned") rather than deleting the key,
  // which keeps this on the same RPC.
  const occurredAt = new Date().toISOString();
  const update = await assignLifecycleOwner({
    tenantId,
    record,
    assignedTo: nextAssignedTo,
    occurredAt,
  });
  if (!update.ok) {
    return NextResponse.json(
      { ok: false, error: "update_failed", message: update.error },
      { status: 500 },
    );
  }

  // Live nudge — the deal left the previous owner's board and joined the new
  // owner's. Refresh both (no-op for whichever is null).
  await nudgeBoards([...update.previousOwners, nextAssignedTo]);

  const note = nextAssignedTo
    ? `Reassigned to ${nextAssignedTo} by ${sess.email || "an admin"}.`
    : `Assignment cleared by ${sess.email || "an admin"}.`;
  const interaction = await db.from("lead_interactions").insert({
    tenant_id: tenantId,
    lead_id: recordId,
    type: "lead_reassigned",
    channel: "system",
    direction: "internal",
    agent_source: "dashboard_assign",
    actor_user_id: sess.userId,
    subject: "Lead reassigned",
    content: note,
    content_preview: note,
    created_at: occurredAt,
    metadata: {
      assigned_to: nextAssignedTo,
      assigned_by: sess.userId,
      entity_type: existing.data.entity_type,
      linked_record_ids: update.updatedIds.filter((id) => id !== recordId),
    },
  });
  if (interaction.error) {
    return NextResponse.json(
      {
        ok: false,
        error: "interaction_log_failed",
        detail: interaction.error.message,
        assignmentUpdated: true,
        assigned_to: nextAssignedTo,
        updated_record_ids: update.updatedIds,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, assigned_to: nextAssignedTo, updated_record_ids: update.updatedIds, touchAt: occurredAt });
}
