/**
 * /api/sequences/[id]/versions — edit history for one sequence's templates.
 *
 * GET  → newest-first version snapshots (prior steps, who, when).
 * POST → restore: body { versionId }. Loads the snapshot and applies it via
 *        the SAME guarded path a manual edit takes (guardSequenceSteps with
 *        the current row as baseline; the current copy is snapshotted first),
 *        so a restore can never bypass compliance and is itself reversible.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveTenantId } from "@/lib/api-auth";
import { getSessionContext, canManageTeam } from "@/lib/team";
import { parseDripSteps, type DripStep } from "@/lib/drips/types";
import { guardSequenceSteps } from "@/lib/drips/edit-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const tenantId = await resolveTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });

  const db = getServiceSupabase();
  const res = await db
    .from("drip_sequence_versions")
    .select("id, name, steps, edited_by, created_at")
    .eq("tenant_id", tenantId)
    .eq("sequence_id", id)
    .order("created_at", { ascending: false })
    .limit(30);
  if (res.error) {
    return NextResponse.json({ ok: false, error: res.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, versions: res.data ?? [] });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSessionContext();
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!canManageTeam(session.teamRole, session.adminAccess)) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Only owners/admins can restore template versions." },
      { status: 403 },
    );
  }
  const tenantId = session.tenantId;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });

  let versionId = "";
  try {
    const body = ((await req.json()) ?? {}) as { versionId?: unknown };
    if (typeof body.versionId === "string") versionId = body.versionId;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!UUID_RE.test(versionId)) {
    return NextResponse.json({ ok: false, error: "invalid_version_id" }, { status: 400 });
  }

  const db = getServiceSupabase();
  const [verRes, curRes] = await Promise.all([
    db.from("drip_sequence_versions").select("steps")
      .eq("tenant_id", tenantId).eq("sequence_id", id).eq("id", versionId).maybeSingle(),
    db.from("drip_sequences").select("name, steps")
      .eq("tenant_id", tenantId).eq("id", id).maybeSingle(),
  ]);
  if (verRes.error || curRes.error) {
    return NextResponse.json(
      { ok: false, error: (verRes.error || curRes.error)!.message },
      { status: 500 },
    );
  }
  if (!verRes.data) return NextResponse.json({ ok: false, error: "version_not_found" }, { status: 404 });
  if (!curRes.data) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  let restoredSteps: DripStep[];
  let currentSteps: DripStep[] | null;
  try {
    restoredSteps = parseDripSteps(verRes.data.steps);
  } catch {
    return NextResponse.json({ ok: false, error: "version_invalid" }, { status: 422 });
  }
  try {
    currentSteps = parseDripSteps(curRes.data.steps);
  } catch {
    currentSteps = null;
  }

  // Same guard as any edit: a historical snapshot that no longer passes the
  // CURRENT compliance rules (e.g. a lender name added to the tenant list
  // since) must not come back. Token/STOP preservation is baselined against
  // the snapshot itself (restoring intentionally replaces current copy).
  const guarded = await guardSequenceSteps(tenantId, restoredSteps, null);
  if (!guarded.ok) {
    return NextResponse.json(
      { ok: false, error: guarded.error, step: guarded.step, message: `Restore blocked — ${guarded.message}` },
      { status: 400 },
    );
  }

  // Snapshot the CURRENT copy first so the restore is itself undoable.
  await db.from("drip_sequence_versions").insert({
    tenant_id: tenantId,
    sequence_id: id,
    name: curRes.data.name,
    steps: currentSteps ?? curRes.data.steps,
    edited_by: session.authUserId ?? null,
  });

  const upd = await db
    .from("drip_sequences")
    .update({ steps: guarded.steps })
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .select()
    .single();
  if (upd.error) {
    return NextResponse.json({ ok: false, error: upd.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, sequence: upd.data });
}
