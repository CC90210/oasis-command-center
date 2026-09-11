/**
 * Records API — manifest-defined entity CRUD.
 *
 * GET    /api/manifest/<slug>/records/<entity>?limit=&offset=&sort=
 * POST   /api/manifest/<slug>/records/<entity>          body: { data }
 * PATCH  /api/manifest/<slug>/records/<entity>?id=<id>  body: { patch }
 * DELETE /api/manifest/<slug>/records/<entity>?id=<id>
 *
 * Auth: requires session + tenant_id. The entity name must exist in the
 * tenant manifest's data_model — otherwise we 404 (don't leak whether
 * other tenants happen to have an entity with that name).
 *
 * Writes are gated to admin/owner role for now; reads are open to any
 * member of the tenant. When marketplace billing ships we'll wire role-
 * to-entity grants per-tenant via the manifest.
 */

import { NextResponse, type NextRequest } from "next/server";
import { mustSeeOwnRecordsOnly } from "@/lib/team-roles";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { getManifest, manifestExists } from "@/lib/manifest/loader";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import {
  RecordsError,
  createRecord,
  deleteRecord,
  listRecords,
  listByAssignedScope,
  updateRecord,
  getRecord,
} from "@/lib/manifest/data";
import { resolveAssignedScope, leadScopingEnabled, SCOPED_ENTITIES, isAdminProfile } from "@/lib/lead-scope";
import {
  ownsOasisSalesRecord,
  rejectedOasisGenericPatchKeys,
  rejectedRepPatchKeys,
  roleMayOperateOasisSalesLead,
  roleMaySelfEditLead,
} from "@/lib/oasis-sales-pipeline-policy";
import { isWebsiteSalesTenantSlug } from "@/lib/leads/canonical-lead-fields";
import { generateApplicationDocumentFromRecord } from "@/lib/forms/application-document";
import { mayWorkWebsiteSalesLifecycle } from "@/lib/website-sales-workflow";
import { planOasisLeadCreate } from "@/lib/oasis-lead-create";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const ENTITY_RE = /^[a-z][a-z0-9_]{0,62}$/;

async function resolveContext(
  user: { id: string },
  slug: string,
  entity: string
): Promise<
  | { ok: true; tenant_id: string; is_admin: boolean; team_role: string }
  | { ok: false; status: number; error: string; message: string }
> {
  if (!SLUG_RE.test(slug))
    return { ok: false, status: 400, error: "invalid_slug", message: "That workspace address isn't valid." };
  if (!ENTITY_RE.test(entity))
    return { ok: false, status: 400, error: "invalid_entity", message: "That record type isn't valid." };
  if (!(await manifestExists(slug)))
    return { ok: false, status: 404, error: "unknown_tenant", message: "No workspace found at that address." };

  const manifest = await getManifest(slug);
  const known = (manifest.data_model || []).some((e) => e.name === entity);
  if (!known)
    return { ok: false, status: 404, error: "unknown_entity", message: `This workspace has no "${entity}" records.` };

  const service = getServiceSupabase();
  const profileQuery = await service
    .from("user_profiles")
    .select("tenant_id, team_role, is_owner, admin_access")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const profile = profileQuery.data as
    | { tenant_id: string | null; team_role: string; is_owner: boolean; admin_access: boolean | null }
    | null;
  if (!profile?.tenant_id)
    return {
      ok: false,
      status: 403,
      error: "no_tenant",
      message: "This account isn't attached to a workspace yet.",
    };

  // Cross-tenant write/read guard — the caller must own this slug
  // (either via tenant_manifests.tenant_id match OR seed-slug fallback).
  // Without this, a caller could POST to /api/manifest/<not-yours>/records/<entity>
  // and write into THEIR tenant under someone else's manifest namespace.
  // resolveDataTenant returns null when the slug isn't owned by the caller.
  const dataTenant = await resolveDataTenant(slug, profile.tenant_id);
  if (!dataTenant) {
    return {
      ok: false,
      status: 403,
      error: "slug_not_owned",
      message: "This record belongs to a workspace this account can't write to.",
    };
  }

  return {
    ok: true,
    tenant_id: dataTenant,
    is_admin: isAdminProfile(profile),
    team_role: profile.team_role || "read_only",
  };
}

/**
 * `LEAD_SCOPING_ENABLED` defaults OFF, and the unscoped branch below hands the
 * caller every lead in the tenant. That flag exists to stage scoping for
 * SunBiz's established roles without emptying their boards overnight — but
 * `agent` is the commission-only OUTSIDE contractor role added for website
 * sales, and one URL against this route would have handed a contractor the
 * whole tenant, defeating every page-level control. Agents are therefore always
 * scoped to their own records regardless of the flag; SunBiz's roles keep their
 * staged rollout untouched.
 */
function mustScopeRegardlessOfFlag(teamRole: string, isAdmin: boolean): boolean {
  // Widened 2026-08-24 from a bare `=== "agent"`. `opener`, `closer` and
  // `builder` are the roles that REPLACED `agent`, carry the same self-scoped
  // persona, and were reading the whole tenant through this door. The set is
  // shared with lib/web-leads/data.ts so the two cannot drift.
  return !isAdmin && mustSeeOwnRecordsOnly(teamRole);
}

function handleRecordsError(err: unknown): NextResponse {
  if (err instanceof RecordsError) {
    const status =
      err.code === "not_found" ? 404 :
      err.code === "forbidden" ? 403 :
      err.code === "validation" ? 422 :
      500;
    return NextResponse.json({ ok: false, error: err.code, message: err.message }, { status });
  }
  throw err;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; entity: string }> }
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { slug, entity } = await ctx.params;
  const r = await resolveContext(user, slug.toLowerCase(), entity.toLowerCase());
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, message: r.message }, { status: r.status });

  const sp = req.nextUrl.searchParams;
  const rawLimit = Number(sp.get("limit") || "100");
  const rawOffset = Number(sp.get("offset") || "0");
  const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
  const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
  const sort = sp.get("sort") || undefined;

  // Per-agent scoping (owner OR collaborator). Agents see only their own +
  // shared leads/applications/funded-deals; admins see all and can narrow via
  // ?agent=<auth_user_id> (shows THAT rep's board) or ?unassigned=1. Enforced
  // server-side here (RLS is bypassed by the service-role client). One shared
  // interpretation via resolveAssignedScope → listByAssignedScope.
  const entityName = entity.toLowerCase();
  try {
    let result;
    if (
      SCOPED_ENTITIES.has(entityName) &&
      (leadScopingEnabled() || mustScopeRegardlessOfFlag(r.team_role, r.is_admin))
    ) {
      const scope = resolveAssignedScope(
        { isAdmin: r.is_admin, userId: user.id },
        { agent: sp.get("agent"), unassigned: sp.get("unassigned") === "1" },
        true,
      );
      result = await listByAssignedScope({
        tenant_id: r.tenant_id,
        entity: entityName,
        scope,
        limit,
        offset,
        sort,
      });
    } else {
      result = await listRecords({ tenant_id: r.tenant_id, entity: entityName, limit, offset, sort });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return handleRecordsError(err);
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; entity: string }> }
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { slug, entity } = await ctx.params;
  const r = await resolveContext(user, slug.toLowerCase(), entity.toLowerCase());
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, message: r.message }, { status: r.status });

  const isOasisSalesLead = entity.toLowerCase() === "lead" && isWebsiteSalesTenantSlug(slug);
  /**
   * A SALES REP MAY CREATE THEIR OWN OASIS LEAD.
   *
   * Creation used to be admin-only everywhere, so a rep who found a business
   * themselves had nowhere to put it: /pipeline/new redirected them away and
   * this route answered 403. CC, 2026-09-08: reps have their own way of
   * sourcing leads and need to enter them, assigned to whoever found them.
   *
   * Deliberately NARROW. It widens creation for OASIS leads only, and only for
   * roles that already work this pipeline — every other entity and every other
   * workspace still requires an admin, because this is the generic record
   * endpoint and a blanket relaxation would let any member create any record
   * type in any tenant.
   */
  const repMayCreateOwnLead = isOasisSalesLead && mayWorkWebsiteSalesLifecycle(r.team_role);
  if (!r.is_admin && !repMayCreateOwnLead) {
    return NextResponse.json(
      {
        ok: false,
        error: "forbidden",
        message: isOasisSalesLead
          ? "Your role can't add leads to the OASIS pipeline. Ask an admin to add it, or to give you a sales role."
          : "Your role can't add these records. Ask an admin to add it.",
      },
      { status: 403 },
    );
  }

  let body: { data?: Record<string, unknown> };
  try {
    body = (await req.json()) as { data?: Record<string, unknown> };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body.data || typeof body.data !== "object") {
    return NextResponse.json({ ok: false, error: "data_required" }, { status: 400 });
  }

  /**
   * AN OASIS LEAD IS PLANNED, STAMPED AND OWNED SERVER-SIDE.
   *
   * planOasisLeadCreate (lib/oasis-lead-create.ts) is the one rule both create
   * doors share -- this route and /api/leads/quick-add. It decides which stages
   * this caller may start a lead in (an admin: every stage the board draws; a
   * sales rep: Assigned), refuses lifecycle fields a create may not carry, and
   * stamps the fields the board and /web-leads read: the creator as owner, the
   * cold_outbound motion, the website-sales program.
   *
   * Before 2026-09-10 this route accepted only `researched` -- a stage the board
   * had stopped drawing -- and stamped nothing on an admin's lead, so CC's leads
   * were saved and appeared on no screen. Nothing here is taken from the request
   * for ownership: a rep cannot assign a lead they found to somebody else.
   *
   * Every other entity and workspace keeps the plain copy, exactly as before.
   */
  let data: Record<string, unknown> = { ...body.data };
  if (isOasisSalesLead) {
    const plan = planOasisLeadCreate({
      viewer: { isAdmin: r.is_admin, teamRole: r.team_role },
      creatorUserId: user.id,
      data: body.data,
      now: new Date(),
      requireRegion: true,
    });
    if (!plan.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: plan.error,
          message: plan.message,
          ...(plan.fields ? { fields: plan.fields } : {}),
          ...(plan.allowedStages ? { allowed_stages: plan.allowedStages } : {}),
        },
        { status: plan.status },
      );
    }
    data = plan.data;
  }

  try {
    const row = await createRecord({
      tenant_id: r.tenant_id,
      entity: entity.toLowerCase(),
      data,
    });
    return NextResponse.json({ ok: true, record: row });
  } catch (err) {
    return handleRecordsError(err);
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; entity: string }> }
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { slug, entity } = await ctx.params;
  const r = await resolveContext(user, slug.toLowerCase(), entity.toLowerCase());
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, message: r.message }, { status: r.status });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id_required" }, { status: 400 });

  let body: { patch?: Record<string, unknown> };
  try {
    body = (await req.json()) as { patch?: Record<string, unknown> };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body.patch || typeof body.patch !== "object") {
    return NextResponse.json({ ok: false, error: "patch_required" }, { status: 400 });
  }

  const isOasisSalesLead = entity.toLowerCase() === "lead" && isWebsiteSalesTenantSlug(slug);
  if (isOasisSalesLead) {
    const protectedKeys = rejectedOasisGenericPatchKeys(body.patch);
    if (protectedKeys.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "use_website_sales_workflow",
          message: `Use the guided lifecycle action for ${protectedKeys.join(", ")}.`,
          fields: protectedKeys,
        },
        { status: 409 },
      );
    }
  }

  // A rep may correct the facts of a lead they own; only an admin may reshape
  // the pipeline around it. Before 2026-08-24 this was a flat admin gate, so a
  // closer could open the edit form, type into it, and get a 403 on save.
  if (!r.is_admin) {
    if (entity.toLowerCase() !== "lead") {
      return NextResponse.json(
        { ok: false, error: "forbidden", message: "Your role can't edit these records." },
        { status: 403 },
      );
    }
    // Ownership AND a role floor. Ownership alone would let a `read_only`
    // account write to any deal it is merely attached to, which is the one
    // thing that role name promises it cannot do.
    const roleMayEdit = isOasisSalesLead
      ? roleMayOperateOasisSalesLead(r.team_role)
      : roleMaySelfEditLead(r.team_role);
    if (!roleMayEdit) {
      return NextResponse.json(
        { ok: false, error: "forbidden", message: "Your role can't edit lead fields." },
        { status: 403 },
      );
    }
    const existing = await getRecord({ tenant_id: r.tenant_id, entity: "lead", id }).catch(() => null);
    // Ownership, not board visibility: ownsOasisSalesRecord has no role
    // shortcut, so the wide `member` default role cannot edit leads that
    // merely happen to be visible to it.
    const mine = existing && ownsOasisSalesRecord(existing, user.id);
    if (!mine) {
      return NextResponse.json(
        { ok: false, error: "forbidden", message: "You can only edit leads assigned to you." },
        { status: 403 },
      );
    }
    const rejected = rejectedRepPatchKeys(body.patch);
    if (rejected.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "forbidden_fields",
          message: `Your role can't change ${rejected.join(", ")}. Ask an admin to move or reassign this lead.`,
        },
        { status: 403 },
      );
    }
  }

  try {
    const row = await updateRecord({
      tenant_id: r.tenant_id,
      entity: entity.toLowerCase(),
      id,
      patch: body.patch,
    });
    // Editing an application's fields (e.g. swapping in a phone once it's found)
    // must regenerate the branded application PDF so the filed document always
    // reflects the current record. Awaited + soft-fail so a slow/failed render
    // never blocks the save, but a normal edit returns only once the fresh PDF
    // is filed — the drawer's Docs tab then shows the updated "Final Application
    // Form" on reload. (No-op for every other entity.)
    if (entity.toLowerCase() === "application") {
      await generateApplicationDocumentFromRecord({
        tenantId: r.tenant_id,
        applicationId: id,
        replace: true,
      }).catch(() => {});
    }
    return NextResponse.json({ ok: true, record: row });
  } catch (err) {
    return handleRecordsError(err);
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; entity: string }> }
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { slug, entity } = await ctx.params;
  const r = await resolveContext(user, slug.toLowerCase(), entity.toLowerCase());
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, message: r.message }, { status: r.status });
  if (!r.is_admin) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id_required" }, { status: 400 });

  try {
    await deleteRecord({
      tenant_id: r.tenant_id,
      entity: entity.toLowerCase(),
      id,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleRecordsError(err);
  }
}
