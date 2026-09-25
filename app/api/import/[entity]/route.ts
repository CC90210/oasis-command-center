/**
 * POST /api/import/[entity]
 *
 * Generic multi-entity bulk-import endpoint. Replaces the leads-only
 * /api/leads/import in spirit (the older route stays in place for
 * backward compatibility — the new wizard and direct API consumers
 * should target this one).
 *
 * Supported [entity] slugs come from IMPORT_ENTITIES in
 * lib/import/entities.ts:
 *   - leads
 *   - applications
 *   - lenders
 *   - funded-deals
 *
 * Body:
 *   {
 *     rows: Array<Record<string, unknown>>,
 *     dedup_by?: string[],     // override entity's default dedup keys
 *     default_source?: string, // tag applied to every row's `source` field
 *     dry_run?: boolean,       // if true, return counts but don't insert
 *   }
 *
 * Returns the same shape as importRowsForTenant — ImportResult on
 * success, ImportFailure on validation error.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canWriteCrm } from "@/lib/role-gates";
import { getEntityDefinition } from "@/lib/import/entities";
import { importRowsForTenant } from "@/lib/import/service";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { isWebsiteSalesTenantSlug } from "@/lib/leads/canonical-lead-fields";
import { getOasisPipelineAssignmentRoster } from "@/lib/team";
import { resolveAssignableTarget } from "@/lib/web-leads/assign-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = {
  rows?: unknown;
  dedup_by?: unknown;
  default_source?: unknown;
  dry_run?: unknown;
  assignee_user_id?: unknown;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ entity: string }> },
) {
  const { entity: entityKey } = await params;
  const entity = getEntityDefinition(entityKey);
  if (!entity) {
    return NextResponse.json(
      { ok: false, error: "unknown_entity", message: `Unknown import entity '${entityKey}'.` },
      { status: 404 },
    );
  }

  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (!canWriteCrm(session.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't run imports." },
      { status: 403 },
    );
  }
  const db = getServiceSupabase();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const rows = Array.isArray(body.rows) ? (body.rows as Array<Record<string, unknown>>) : [];
  const dedupBy = Array.isArray(body.dedup_by)
    ? (body.dedup_by as unknown[]).filter((k): k is string => typeof k === "string")
    : undefined;
  const defaultSource = typeof body.default_source === "string" ? body.default_source : undefined;
  const dryRun = body.dry_run === true;
  const tenantSlug = await resolveOwnedSlug(session.tenantId);
  if (entity.entity_type === "lead" && !tenantSlug) {
    return NextResponse.json(
      { ok: false, error: "tenant_scope_unresolved" },
      { status: 503 },
    );
  }
  const isOasisLeadImport =
    entity.entity_type === "lead" && isWebsiteSalesTenantSlug(tenantSlug);
  let oasisAssigneeUserId: string | null = null;
  if (isOasisLeadImport) {
    const requestedAssignee =
      typeof body.assignee_user_id === "string" ? body.assignee_user_id.trim() : "";
    if (!requestedAssignee) {
      return NextResponse.json(
        {
          ok: false,
          error: "assignee_required",
          message: "Choose CC or Adon before importing OASIS leads.",
        },
        { status: 422 },
      );
    }

    try {
      const roster = await getOasisPipelineAssignmentRoster(session.tenantId);
      oasisAssigneeUserId = resolveAssignableTarget(roster, requestedAssignee);
    } catch (error) {
      console.error("[import] OASIS assignment roster could not be verified", {
        tenantId: session.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        {
          ok: false,
          error: "sales_roster_unavailable",
          message: "The CC + Adon assignment roster could not be verified.",
        },
        { status: 503 },
      );
    }
    if (!oasisAssigneeUserId) {
      return NextResponse.json(
        {
          ok: false,
          error: "target_not_on_sales_roster",
          message: "OASIS leads can only be assigned to CC or Adon this cycle.",
        },
        { status: 422 },
      );
    }
  }

  const result = await importRowsForTenant({
    db,
    tenantId: session.tenantId,
    entity,
    rows,
    dedupBy,
    defaultSource,
    dryRun,
    // Decides whether website columns classify the lead onto the
    // website-sales board, or are just detail on a funding application.
    tenantSlug,
    oasisAssigneeUserId,
  });

  if (!result.ok) {
    const status =
      result.error === "no_rows" ? 400
      : result.error === "too_many_rows" ? 413
      : result.error === "assignee_required" ? 422
      // A row's assigned_to named a deactivated teammate or a non-member;
      // the whole batch was refused (same codes as /api/leads/import).
      : result.error === "member_deactivated" ? 422
      : result.error === "not_a_tenant_member" ? 422
      : result.error === "member_check_failed" ? 503
      : result.error === "tenant_scope_unresolved" ? 503
      : result.error === "dedup_lookup_failed" ? 500
      : result.error === "insert_failed" ? 500
      : 400;
    return NextResponse.json(result, { status });
  }

  return NextResponse.json(result);
}
