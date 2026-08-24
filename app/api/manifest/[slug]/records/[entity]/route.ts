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
import { canOpenOasisSalesRecord, rejectedRepPatchKeys } from "@/lib/oasis-sales-pipeline-policy";
import { generateApplicationDocumentFromRecord } from "@/lib/forms/application-document";

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
  return !isAdmin && teamRole === "agent";
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
  if (!r.is_admin) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  let body: { data?: Record<string, unknown> };
  try {
    body = (await req.json()) as { data?: Record<string, unknown> };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body.data || typeof body.data !== "object") {
    return NextResponse.json({ ok: false, error: "data_required" }, { status: 400 });
  }

  try {
    const row = await createRecord({
      tenant_id: r.tenant_id,
      entity: entity.toLowerCase(),
      data: body.data,
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
    const existing = await getRecord({ tenant_id: r.tenant_id, entity: "lead", id }).catch(() => null);
    const mine =
      existing &&
      canOpenOasisSalesRecord(existing, {
        role: r.team_role,
        userId: user.id,
        isOwner: false,
        adminAccess: false,
      });
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
