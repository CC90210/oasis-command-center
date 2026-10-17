/**
 * request-changes - "send this back with a note", the one Library verdict the
 * existing asset route (app/api/founders/marketing/assets/[id]/route.ts) does
 * not carry.
 *
 * WHERE THE NOTE GOES. A `marketing_review` row (database/133_marketing_hub.sql):
 * decision 'request_changes', the note, who asked, and `acted_on_at` left NULL.
 * That table is the marketing agent's inbox by design - its own comment reads
 * "Set when the agent has read and acted on this verdict", so an open row is
 * work waiting on the agent - and the one place a request for changes ranks
 * highest as training signal (trainingWeight). The agent finds it by
 * `decision = 'request_changes' AND acted_on_at IS NULL`, joined on asset_id,
 * and stamps `acted_on_at` when it has revised the asset. The note is NOT
 * written into `marketing_asset.meta`: Maven's tools read-modify-write that
 * column, and a write from here could be lost under one of theirs.
 *
 * WHAT THE ASSET DOES. It moves from in_review to draft (statusAfterDecision:
 * "not ready", Studio's own wording for that stage) and nothing else changes.
 * Nothing is scheduled, queued or posted; posting stays with the marketing
 * agent's own scheduler and the spend gate.
 *
 * ORDER, BECAUSE THE TURSO RUNNER IS NOT TRANSACTIONAL. The review row goes in
 * first and the status change second, guarded on `status = 'in_review'`. A
 * crash between the two leaves an open note on an asset still in review (the
 * agent revises, nobody is hurt); the other order leaves a draft with no reason
 * on it, which is the one outcome that loses the founder's words. If the status
 * change is refused (someone else moved the asset first) the review row this
 * call made is removed again, so a lost race leaves nothing behind.
 *
 * The database is passed in so tests/library-review.test.ts runs this against
 * real SQLite. The route (assets/[id]/request-changes/route.ts under
 * app/api/founders/marketing) supplies the service client and the verified
 * founder.
 */

import type { getServiceSupabase } from "@/lib/supabase-server";
import {
  decisionRequiresNote,
  statusAfterDecision,
  type AssetStatus,
} from "@/lib/founders-marketing-core";

type Db = ReturnType<typeof getServiceSupabase>;

/** The longest note accepted. marketing_review.note is free text; this keeps one row readable. */
export const REQUEST_CHANGES_NOTE_MAX = 2000;

export type NoteCheck = { ok: true; note: string } | { ok: false; error: "note_required" | "note_too_long" | "invalid_body" };

/** The note from a request body: a string with something in it, at most REQUEST_CHANGES_NOTE_MAX. */
export function checkRequestChangesBody(body: unknown): NoteCheck {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid_body" };
  const raw = (body as { note?: unknown }).note;
  const note = typeof raw === "string" ? raw.trim() : "";
  // The rule lives in founders-marketing-core (decisionRequiresNote), shared with
  // the database CHECK on marketing_review: a request for changes with no reason
  // says something was wrong and not where.
  if (!note && decisionRequiresNote("request_changes")) return { ok: false, error: "note_required" };
  if (note.length > REQUEST_CHANGES_NOTE_MAX) return { ok: false, error: "note_too_long" };
  return { ok: true, note };
}

export type RequestChangesResult =
  | { ok: true; asset: { id: string; title: string; status: AssetStatus }; reviewId: string }
  | { ok: false; http: 404 | 409 | 500; error: string; current?: string | null };

export async function requestChanges(
  db: Db,
  input: { tenantId: string; assetId: string; note: string; reviewer: string },
): Promise<RequestChangesResult> {
  const { tenantId, assetId, note, reviewer } = input;

  // Tenant-scoped on every statement below. A uuid in the URL is not proof of
  // ownership: another workspace's asset matches nothing and answers 404.
  const existing = await db
    .from("marketing_asset")
    .select("id, title, status")
    .eq("tenant_id", tenantId)
    .eq("id", assetId)
    .maybeSingle();
  if (existing.error) {
    console.error("[founders.request-changes] read failed", existing.error.message);
    return { ok: false, http: 500, error: "read_failed" };
  }
  if (!existing.data) return { ok: false, http: 404, error: "not_found" };
  if (existing.data.status !== "in_review") {
    return { ok: false, http: 409, error: "not_in_review", current: String(existing.data.status) };
  }
  const title = String(existing.data.title ?? "");

  const review = await db
    .from("marketing_review")
    .insert({
      tenant_id: tenantId,
      asset_id: assetId,
      decision: "request_changes",
      note,
      reviewer,
      reviewer_agent: null,
      acted_on_at: null,
    })
    .select("id")
    .maybeSingle();
  if (review.error || !review.data?.id) {
    console.error("[founders.request-changes] note not recorded", review.error?.message ?? "insert returned no row");
    return { ok: false, http: 500, error: "review_not_recorded" };
  }
  const reviewId = String(review.data.id);

  const next = statusAfterDecision("request_changes", "in_review");
  const moved = await db
    .from("marketing_asset")
    .update({ status: next, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", assetId)
    .eq("status", "in_review")
    .select("id, title, status")
    .maybeSingle();

  if (moved.error || !moved.data) {
    // Take the note back: it describes a change that did not happen.
    const undo = await db
      .from("marketing_review")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("id", reviewId);
    if (undo.error) {
      console.error("[founders.request-changes] could not remove the unused note", reviewId, undo.error.message);
    }
    if (moved.error) {
      console.error("[founders.request-changes] status change failed", moved.error.message);
      return { ok: false, http: 500, error: "update_failed" };
    }
    const now = await db
      .from("marketing_asset")
      .select("status")
      .eq("tenant_id", tenantId)
      .eq("id", assetId)
      .maybeSingle();
    return { ok: false, http: 409, error: "status_changed", current: now.data ? String(now.data.status) : null };
  }

  // The activity trail. Best effort - the verdict and its note are already
  // durable - but a failure is logged, never swallowed.
  const event = await db.from("marketing_event").insert({
    tenant_id: tenantId,
    actor: reviewer,
    verb: "changes_requested",
    asset_id: assetId,
    detail: `Asked for changes on "${title.slice(0, 120)}"`,
  });
  if (event.error) console.warn("[founders.request-changes] activity row not written", event.error.message);

  return {
    ok: true,
    asset: { id: String(moved.data.id), title: String(moved.data.title ?? title), status: next },
    reviewId,
  };
}
