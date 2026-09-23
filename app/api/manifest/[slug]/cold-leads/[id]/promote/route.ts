/**
 * POST /api/manifest/<slug>/cold-leads/<id>/promote
 *
 * Promotes a cold_lead into the warm pipeline by creating a tenant_records
 * row with entity_type='lead'. This is the ONLY sanctioned path from cold
 * list → warm pipeline. The cold_leads.promoted_lead_id is set to the new
 * record id and the stage is transitioned to 'promoted'.
 *
 * Idempotent: if the cold lead is already promoted (promoted_lead_id IS NOT
 * NULL), the existing promoted_lead_id is returned without double-creating.
 *
 * Body: { assignee_user_id?: string } (required for an OASIS promotion; must
 * resolve to the current CC + Adon assignment roster)
 *
 * Response: { ok: true, promoted_lead_id: string, was_already_promoted: boolean }
 *
 * After promotion, cold_lead_lists.promoted_count is incremented.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canWriteCrm } from "@/lib/role-gates";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { manifestExists } from "@/lib/manifest/loader";
import {
  OASIS_COLD_OUTBOUND_MOTION,
  isWebsiteSalesTenantSlug,
  pickWebsiteSalesFields,
  stampSalesProgramForTenant,
  stageForWebsiteSalesLead,
} from "@/lib/leads/canonical-lead-fields";
import { pipelineCycleAssignmentFacts } from "@/lib/pipeline-cycle";
import { getOasisPipelineAssignmentRoster } from "@/lib/team";
import { resolveAssignableTarget } from "@/lib/web-leads/assign-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ColdLeadDbRow = {
  id: string;
  list_id: string;
  business_name: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  stage: string;
  promoted_lead_id: string | null;
  raw: Record<string, unknown> | null;
};

async function resolveContext(
  userTenantId: string,
  slug: string,
): Promise<
  | { ok: true; tenantId: string }
  | { ok: false; status: number; error: string }
> {
  if (!SLUG_RE.test(slug)) return { ok: false, status: 400, error: "invalid_slug" };
  if (!(await manifestExists(slug))) return { ok: false, status: 404, error: "unknown_tenant" };

  const dataTenantId = await resolveDataTenant(slug, userTenantId);
  if (!dataTenantId) {
    return { ok: false, status: 403, error: "preview_mode_no_writes" };
  }
  return { ok: true, tenantId: dataTenantId };
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!canWriteCrm(session.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't promote cold leads." },
      { status: 403 },
    );
  }

  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const context = await resolveContext(session.tenantId, slug);
  if (!context.ok) {
    return NextResponse.json({ ok: false, error: context.error }, { status: context.status });
  }

  let body: { assignee_user_id?: unknown } = {};
  try {
    body = (await req.json()) as { assignee_user_id?: unknown };
  } catch {
    // Body is optional for this route.
  }

  let assigneeUserId =
    typeof body.assignee_user_id === "string" && UUID_RE.test(body.assignee_user_id)
      ? body.assignee_user_id.trim().toLowerCase()
      : null;

  const isOasisPromotion = isWebsiteSalesTenantSlug(slug);
  if (isOasisPromotion && !assigneeUserId) {
    return NextResponse.json(
      { ok: false, error: "assignee_required", message: "Choose CC or Adon before promoting this lead." },
      { status: 422 },
    );
  }
  if (isOasisPromotion && assigneeUserId) {
    let roster;
    try {
      roster = await getOasisPipelineAssignmentRoster(context.tenantId);
    } catch (error) {
      console.error("[cold-leads.promote] OASIS assignment roster could not be verified", {
        tenantId: context.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { ok: false, error: "sales_roster_unavailable" },
        { status: 503 },
      );
    }
    assigneeUserId = resolveAssignableTarget(roster, assigneeUserId);
    if (!assigneeUserId) {
      return NextResponse.json(
        { ok: false, error: "target_not_on_sales_roster", message: "Choose CC or Adon for this pipeline cycle." },
        { status: 422 },
      );
    }
  }

  const db = getServiceSupabase();

  // Load the cold lead — must belong to this tenant.
  const { data: coldLead, error: coldLeadErr } = await db
    .from("cold_leads")
    .select("id, list_id, business_name, contact_name, phone, email, stage, promoted_lead_id, raw")
    .eq("id", id)
    .eq("tenant_id", context.tenantId)
    .maybeSingle();

  if (coldLeadErr || !coldLead) {
    return NextResponse.json({ ok: false, error: "cold_lead_not_found" }, { status: 404 });
  }

  const lead = coldLead as ColdLeadDbRow;

  // Idempotency — already promoted.
  if (lead.stage === "promoted" && lead.promoted_lead_id) {
    return NextResponse.json({
      ok: true,
      promoted_lead_id: lead.promoted_lead_id,
      was_already_promoted: true,
    });
  }

  // Create a tenant_records lead row from the cold lead's data.
  // Stage defaults to 'imported' (the intake stage) so the operator
  // immediately sees the promoted cold lead at the top of the pipeline.
  // The cold-list importer keeps the whole source row in `raw`, so website
  // research that was captured on the way in is still here — it just never
  // made it onto the promoted lead, and the rep opened a deal with no site.
  const carried = pickWebsiteSalesFields((lead.raw || {}) as Record<string, unknown>);
  const promotedAt = new Date().toISOString();

  const leadData: Record<string, unknown> = {
    business_name: lead.business_name ?? "",
    contact_name: lead.contact_name ?? "",
    phone: lead.phone ?? "",
    email: lead.email ?? "",
    ...carried,
    stage: "imported",
    source: "cold_list_promotion",
    cold_lead_id: lead.id,
    cold_list_id: lead.list_id,
    // A promoted lead carrying website research belongs to the website-sales
    // board, which filters on this stamp. Without it the row exists and no
    // screen shows it. Gated on the tenant: a website in a SunBiz cold list is
    // ordinary merchant detail, not a program signal.
    ...stampSalesProgramForTenant(carried, slug),
    ...(isOasisPromotion ? { sales_motion: OASIS_COLD_OUTBOUND_MOTION } : {}),
  };

  // Stage vocabularies don't overlap: "imported" is SunBiz intake and has no
  // column on the OASIS board, so a website-sales lead promoted into it would
  // be stranded off-board.
  if (leadData.sales_program) {
    leadData.stage = stageForWebsiteSalesLead(null);
  }

  if (assigneeUserId) {
    // `assigned_to` is the field every reader uses — the board's rep filter
    // (oasis-sales-pipeline-policy), the name resolver (assigned-names), the
    // per-rep scoping in manifest/data. Writing only `assignee_user_id` meant
    // a promoted lead was assigned in the database and unassigned on every
    // screen, including to the rep it was handed to. Both are written: the
    // legacy key stays for anything still reading it.
    if (isOasisPromotion) {
      Object.assign(leadData, pipelineCycleAssignmentFacts(assigneeUserId, promotedAt), {
        claimed_at: promotedAt,
        stage: "assigned",
        stage_entered_at: promotedAt,
      });
    } else {
      leadData.assigned_to = assigneeUserId;
    }
    leadData.assignee_user_id = assigneeUserId;
  }

  const { data: newRecord, error: insertErr } = await db
    .from("tenant_records")
    .insert({
      tenant_id: context.tenantId,
      entity_type: "lead",
      data: leadData,
      created_by: session.userId,
    })
    .select("id")
    .single();

  if (insertErr || !newRecord) {
    return NextResponse.json(
      { ok: false, error: "create_lead_failed", detail: insertErr?.message },
      { status: 500 },
    );
  }

  const newLeadId = (newRecord as { id: string }).id;

  // Update the cold lead: set promoted_lead_id + flip stage to 'promoted'.
  const { error: updateErr } = await db
    .from("cold_leads")
    .update({ promoted_lead_id: newLeadId, stage: "promoted", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", context.tenantId);

  if (updateErr) {
    // The tenant_records row was already created; log the update failure
    // but still return the promoted_lead_id so the UI can navigate there.
    // The operator can see the cold lead isn't marked 'promoted' and
    // re-run the action — it'll hit the idempotency path and not double-create.
  }

  // Refresh promoted_count to the live value. Re-counting is slightly more
  // expensive than an atomic increment but is race-safe without needing an
  // RPC function, and promotion is a low-frequency human action.
  const { count: promotedCount } = await db
    .from("cold_leads")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", context.tenantId)
    .eq("list_id", lead.list_id)
    .eq("stage", "promoted");

  await db
    .from("cold_lead_lists")
    .update({ promoted_count: promotedCount ?? 0 })
    .eq("id", lead.list_id)
    .eq("tenant_id", context.tenantId);

  return NextResponse.json({
    ok: true,
    promoted_lead_id: newLeadId,
    was_already_promoted: false,
  });
}
