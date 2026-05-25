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

  if (body.fields?.length) {
    const rows = body.fields.map((f, idx) => ({
      view_id: viewId,
      field_metadata_id: f.field_metadata_id,
      position: f.position ?? idx,
      width: f.width ?? null,
      is_visible: f.is_visible ?? true,
    }));
    await db.from("view_fields").insert(rows);
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
    await db.from("view_filters").insert(rows);
  }
  if (body.sorts?.length) {
    const rows = body.sorts.map((s, idx) => ({
      view_id: viewId,
      field_metadata_id: s.field_metadata_id,
      direction: s.direction ?? "ASC",
      position: s.position ?? idx,
    }));
    await db.from("view_sorts").insert(rows);
  }

  return NextResponse.json({ ok: true, view_id: viewId });
}
