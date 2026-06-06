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
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { getEntityDefinition } from "@/lib/import/entities";
import { importRowsForTenant } from "@/lib/import/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = {
  rows?: unknown;
  dedup_by?: unknown;
  default_source?: unknown;
  dry_run?: unknown;
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

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const db = getServiceSupabase();
  const profileRes = await db
    .from("user_profiles")
    .select("tenant_id, team_role")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const profile = profileRes.data as { tenant_id: string | null; team_role: string | null } | null;
  if (!profile?.tenant_id) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 401 });
  }

  // Read-only members cannot import — same gate as elsewhere in the dashboard.
  if (profile.team_role === "read_only") {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Read-only members can't run imports." },
      { status: 403 },
    );
  }

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

  const result = await importRowsForTenant({
    db,
    tenantId: profile.tenant_id,
    entity,
    rows,
    dedupBy,
    defaultSource,
    dryRun,
  });

  if (!result.ok) {
    const status =
      result.error === "no_rows" ? 400
      : result.error === "too_many_rows" ? 413
      : result.error === "dedup_lookup_failed" ? 500
      : result.error === "insert_failed" ? 500
      : 400;
    return NextResponse.json(result, { status });
  }

  return NextResponse.json(result);
}
