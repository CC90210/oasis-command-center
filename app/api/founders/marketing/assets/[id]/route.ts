/**
 * PATCH/DELETE /api/founders/marketing/assets/[id] — act on one library asset.
 *
 * CC, 2026-08-14, having to ask an agent to remove an ad for him: *"the last one,
 * 'Oasis Instagram system ad v1', I wanted to delete it. It's a very old-looking ad,
 * and it's not on brand."*
 *
 * The Library could show you thirteen assets and let you do nothing to any of them.
 * Every verdict had to go through a human asking an agent to run a script, which is
 * the opposite of a dashboard. This is the missing half.
 *
 * FOUNDERS ONLY. 404 (never 403) to anyone else, same as the pages and the ingest
 * route: a 403 would confirm the route exists.
 *
 * WHY DELETE REALLY DELETES
 * `archived` exists as a status, but the Library applies no status filter, so an
 * archived asset still renders in the grid — archiving would not have answered what CC
 * asked for. So DELETE removes the rows, and the media rows cascade on the asset FK.
 *
 * WHY IT DOES NOT DELETE THE BYTES
 * Deliberate, and the safer half. The object stays in R2 and is returned in the
 * response as `orphan` so a sweep can find it. A row is reconstructible from a backup;
 * a deleted object is not. If we ever want true purge it belongs in a job that backs
 * up first, not in a click that cannot be undone.
 */

import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveFounder } from "@/lib/founders/gate";
import { isAssetStatus, reviewDecisionFor, type AssetStatus } from "@/lib/founders-marketing-core";
import { methodNotHere } from "@/lib/founders/method-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

/** Verdicts an operator can reach from the Library, and what each one means. */
const REACHABLE: AssetStatus[] = ["approved", "rejected", "archived", "in_review"];

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const founder = await resolveFounder();
  if (!founder) return notFound();
  const { id } = await ctx.params;

  let body: { status?: string; note?: string };
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
    }
    body = parsed as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const next = body.status;
  if (!next || !isAssetStatus(next) || !REACHABLE.includes(next)) {
    return NextResponse.json(
      { ok: false, error: "unsupported_status", reachable: REACHABLE },
      { status: 400 },
    );
  }

  const db = getServiceSupabase();

  // Tenant-scoped on the way in. The id alone is not proof of ownership, and a
  // founder must not be able to act on another tenant's row by pasting a uuid.
  const existing = await db
    .from("marketing_asset")
    .select("id, title, status")
    .eq("tenant_id", founder.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (existing.error) {
    return NextResponse.json({ ok: false, error: "read_failed" }, { status: 500 });
  }
  if (!existing.data) return notFound();

  const updated = await db
    .from("marketing_asset")
    .update({ status: next, updated_at: new Date().toISOString() })
    .eq("tenant_id", founder.tenantId)
    .eq("id", id)
    .select("id, title, status")
    .maybeSingle();
  if (updated.error || !updated.data) {
    return NextResponse.json({ ok: false, error: "update_failed" }, { status: 500 });
  }

  /*
   * Record the verdict AND close it in the same breath.
   *
   * `marketing_review` rows with a null `acted_on_at` are what Studio counts as
   * "needs you". A verdict reached from the Library IS the action, so leaving it open
   * would make the counter climb every time the operator did something about an asset
   * — the exact inversion that made Studio say "Nothing waiting on you" while the
   * Library badged all 13 IN REVIEW.
   *
   * Best-effort: if the review table is unavailable the status change still stands.
   * A dashboard that refuses to record a decision because it could not also record a
   * note about the decision is worse than one that does the important half.
   */
  // `decision` is NOT the status. marketing_review.decision has a CHECK
  // constraint listing approve / approve_with_changes / request_changes / reject
  // / comment, so inserting "approved" or "archived" violated it and every
  // verdict silently failed to record — invisible, because this insert is
  // best-effort by design and only the audit trail went missing.
  const decision = reviewDecisionFor(next);
  const decided = new Date().toISOString();
  const note =
    typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 2000) : null;

  // The same table also requires a reason for anything that is not an approval
  // or a comment, so a bare rejection would be refused. Say why on the
  // operator's behalf rather than losing the row.
  const reason =
    note ?? (decision && !["approve", "comment"].includes(decision)
      ? `Marked ${next} from the founders library.`
      : null);

  const review = decision
    ? await db.from("marketing_review").insert({
        tenant_id: founder.tenantId,
        asset_id: id,
        decision,
        note: reason,
        reviewer: founder.displayName || "founder",
        reviewer_agent: null,
        acted_on_at: decided,
      })
    : null;

  return NextResponse.json({
    ok: true,
    asset: updated.data,
    from: existing.data.status,
    // null decision = nothing to record (a move back to in_review retracts a
    // verdict, it is not one), which is different from "the write failed".
    review_recorded: review ? !review.error : null,
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const founder = await resolveFounder();
  if (!founder) return notFound();
  const { id } = await ctx.params;

  const db = getServiceSupabase();
  const existing = await db
    .from("marketing_asset")
    .select("id, title")
    .eq("tenant_id", founder.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (existing.error) {
    return NextResponse.json({ ok: false, error: "read_failed" }, { status: 500 });
  }
  if (!existing.data) return notFound();

  // Read the media paths BEFORE the delete: the rows cascade, and an orphaned object
  // whose path nobody recorded is unfindable.
  const media = await db
    .from("marketing_asset_media")
    .select("storage_bucket, storage_path")
    .eq("tenant_id", founder.tenantId)
    .eq("asset_id", id);
  const orphans = (media.data || []).map(
    (m: { storage_bucket: string; storage_path: string }) => `${m.storage_bucket}/${m.storage_path}`,
  );

  // Explicit, then the asset. The media FK cascades, but deleting explicitly means the
  // failure is attributable instead of silent.
  const killMedia = await db
    .from("marketing_asset_media")
    .delete()
    .eq("tenant_id", founder.tenantId)
    .eq("asset_id", id);
  if (killMedia.error) {
    return NextResponse.json({ ok: false, error: "media_delete_failed" }, { status: 500 });
  }
  const killed = await db
    .from("marketing_asset")
    .delete()
    .eq("tenant_id", founder.tenantId)
    .eq("id", id);
  if (killed.error) {
    return NextResponse.json({ ok: false, error: "delete_failed" }, { status: 500 });
  }

  // Read back. "Deleted" is a claim about the database, so ask the database — this is
  // the exact failure the Turso-side bridge hit today, where a delete reported success
  // and the row was still there on the next read.
  const still = await db
    .from("marketing_asset")
    .select("id")
    .eq("tenant_id", founder.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (still.data) {
    return NextResponse.json({ ok: false, error: "delete_did_not_take" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, deleted: existing.data, orphan: orphans });
}

// Verbs this route does not implement answer 404, not the framework's 405.
// A 405 confirms the path is real, which is exactly what lib/founders/gate.ts
// refuses to tell a tenant that is not ours. See lib/founders/method-guard.ts.
export const GET = methodNotHere;
export const POST = methodNotHere;
export const PUT = methodNotHere;
