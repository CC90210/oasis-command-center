/**
 * GET  /api/manifest/<slug>/views — list saved views (optionally for one object).
 * POST /api/manifest/<slug>/views — create a saved view.
 *
 * V6.9.1 substrate. Per-user views (owner_user_id = caller) and
 * workspace-shared views (owner_user_id = null) are both returned to the
 * caller; on create, omit owner_user_id in the body to mint a shared view.
 *
 * Auth: session required + caller must own this slug (resolveDataTenant).
 * Preview-mode callers (wrong slug ownership) receive 403.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { manifestExists } from "@/lib/manifest/loader";
import { loadViewsForObject } from "@/lib/views/loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const VIEW_SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const VIEW_KINDS = new Set(["table", "kanban", "calendar", "gallery"]);

async function resolveContext(
  userId: string,
  slug: string,
): Promise<
  | { ok: true; tenantId: string }
  | { ok: false; status: number; error: string }
> {
  if (!SLUG_RE.test(slug)) return { ok: false, status: 400, error: "invalid_slug" };
  if (!(await manifestExists(slug))) return { ok: false, status: 404, error: "unknown_tenant" };

  const db = getServiceSupabase();
  const profileRes = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  const userTenantId =
    (profileRes.data as { tenant_id: string | null } | null)?.tenant_id ?? null;

  const dataTenantId = await resolveDataTenant(slug, userTenantId);
  if (!dataTenantId) {
    return { ok: false, status: 403, error: "preview_mode_no_writes" };
  }
  return { ok: true, tenantId: dataTenantId };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const context = await resolveContext(user.id, slug);
  if (!context.ok) {
    return NextResponse.json({ ok: false, error: context.error }, { status: context.status });
  }

  const objectId = req.nextUrl.searchParams.get("object_metadata_id");
  if (!objectId) {
    return NextResponse.json({ ok: false, error: "object_metadata_id_required" }, { status: 400 });
  }

  const views = await loadViewsForObject(context.tenantId, objectId, user.id);
  return NextResponse.json({ ok: true, views });
}

type CreateBody = {
  object_metadata_id?: string;
  slug?: string;
  name?: string;
  kind?: string;
  is_default?: boolean;
  shared?: boolean; // when true, owner_user_id = null
  kanban_field_name?: string | null;
  description?: string | null;
  fields?: Array<{ field_metadata_id: string; position?: number; width?: number | null; is_visible?: boolean }>;
  filters?: Array<{ field_metadata_id: string; operator: string; value?: unknown; conjunction?: "AND" | "OR"; position?: number }>;
  sorts?: Array<{ field_metadata_id: string; direction?: "ASC" | "DESC"; position?: number }>;
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const context = await resolveContext(user.id, slug);
  if (!context.ok) {
    return NextResponse.json({ ok: false, error: context.error }, { status: context.status });
  }

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  if (!body.object_metadata_id) return NextResponse.json({ ok: false, error: "object_metadata_id_required" }, { status: 400 });
  if (!body.name || !body.name.trim()) return NextResponse.json({ ok: false, error: "name_required" }, { status: 400 });
  if (!body.slug || !VIEW_SLUG_RE.test(body.slug)) return NextResponse.json({ ok: false, error: "invalid_slug" }, { status: 400 });
  const kind = body.kind ?? "table";
  if (!VIEW_KINDS.has(kind)) return NextResponse.json({ ok: false, error: "invalid_kind" }, { status: 400 });

  const db = getServiceSupabase();

  /* V6.9.5 hotfix: validate cross-table IDs against this tenant BEFORE
     inserting the view. Otherwise an attacker with a session on tenant A
     could pass tenant B's object_metadata_id and bind a view across
     tenants. Same logic for child field_metadata_id rows. */
  const objectRes = await db
    .from("object_metadata")
    .select("id, tenant_id")
    .eq("id", body.object_metadata_id)
    .eq("tenant_id", context.tenantId)
    .maybeSingle();
  if (objectRes.error || !objectRes.data) {
    return NextResponse.json({ ok: false, error: "object_metadata_not_in_tenant" }, { status: 400 });
  }

  const childFieldIds = Array.from(
    new Set<string>([
      ...(body.fields?.map((f) => f.field_metadata_id) ?? []),
      ...(body.filters?.map((f) => f.field_metadata_id) ?? []),
      ...(body.sorts?.map((s) => s.field_metadata_id) ?? []),
    ]),
  );
  if (childFieldIds.length > 0) {
    const fieldsRes = await db
      .from("field_metadata")
      .select("id, object_id")
      .in("id", childFieldIds)
      .eq("object_id", body.object_metadata_id);
    if (fieldsRes.error) {
      return NextResponse.json({ ok: false, error: "db_error", detail: fieldsRes.error.message }, { status: 500 });
    }
    const foundIds = new Set((fieldsRes.data ?? []).map((r) => (r as { id: string }).id));
    const missing = childFieldIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      return NextResponse.json({ ok: false, error: "field_metadata_not_in_object", missing }, { status: 400 });
    }
  }

  const insertView = await db
    .from("views")
    .insert({
      tenant_id: context.tenantId,
      object_metadata_id: body.object_metadata_id,
      slug: body.slug,
      name: body.name,
      kind,
      owner_user_id: body.shared ? null : user.id,
      is_default: Boolean(body.is_default),
      kanban_field_name: body.kanban_field_name ?? null,
      description: body.description ?? null,
    })
    .select("id")
    .single();

  if (insertView.error || !insertView.data) {
    return NextResponse.json({ ok: false, error: "db_error", detail: insertView.error?.message }, { status: 500 });
  }
  const viewId = (insertView.data as { id: string }).id;

  /* V6.9.5 hotfix: child insert errors are checked. Previously they were
     silently ignored, so POST could return ok with a partially-created
     view. If any child fails, soft-delete the parent and return the
     specific error rather than leaving a half-baked row. */
  if (body.fields?.length) {
    const rows = body.fields.map((f, idx) => ({
      view_id: viewId,
      field_metadata_id: f.field_metadata_id,
      position: f.position ?? idx,
      width: f.width ?? null,
      is_visible: f.is_visible ?? true,
    }));
    const r = await db.from("view_fields").insert(rows);
    if (r.error) {
      await db.from("views").update({ is_active: false }).eq("id", viewId);
      return NextResponse.json({ ok: false, error: "child_insert_failed", detail: `view_fields: ${r.error.message}` }, { status: 500 });
    }
  }
  if (body.filters?.length) {
    const rows = body.filters.map((f, idx) => ({
      view_id: viewId,
      field_metadata_id: f.field_metadata_id,
      operator: f.operator,
      value: f.value ?? null,
      conjunction: f.conjunction ?? "AND",
      position: f.position ?? idx,
    }));
    const r = await db.from("view_filters").insert(rows);
    if (r.error) {
      await db.from("views").update({ is_active: false }).eq("id", viewId);
      return NextResponse.json({ ok: false, error: "child_insert_failed", detail: `view_filters: ${r.error.message}` }, { status: 500 });
    }
  }
  if (body.sorts?.length) {
    const rows = body.sorts.map((s, idx) => ({
      view_id: viewId,
      field_metadata_id: s.field_metadata_id,
      direction: s.direction ?? "ASC",
      position: s.position ?? idx,
    }));
    const r = await db.from("view_sorts").insert(rows);
    if (r.error) {
      await db.from("views").update({ is_active: false }).eq("id", viewId);
      return NextResponse.json({ ok: false, error: "child_insert_failed", detail: `view_sorts: ${r.error.message}` }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, view_id: viewId });
}
