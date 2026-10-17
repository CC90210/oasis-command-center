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
 * change is refused (zero rows: someone else moved the asset first) the review
 * row this call made is removed again, so a lost race leaves nothing behind.
 * If it FAILS with an error instead, the outcome is ambiguous (the write may
 * have committed and only its answer been lost), so the asset is re-read and the
 * note is taken back only when another verdict got there first: a draft means it
 * landed (success, note kept); still in review, or unreadable, leaves the note
 * open (500, nothing lost).
 *
 * The note is also closed, not deleted, when a later verdict settles the asset
 * (Approve, Archive, Reject on assets/[id]/route.ts stamp `acted_on_at`), so an
 * open `request_changes` row always belongs to an asset waiting on the agent.
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

  let landed: { id: unknown; title?: unknown } | null = !moved.error && moved.data ? moved.data : null;
  let current: string | null = null;

  if (!landed) {
    // The write did not hand back the row. Two very different things look like
    // this, and only one of them may take the note back:
    //
    //   ZERO ROWS, no error: the guard refused it - someone moved the asset first.
    //   That is DEFINITE. The note describes a change that did not happen, so it
    //   goes (below), and the answer says where the asset is now.
    //
    //   AN ERROR: AMBIGUOUS. The adapter turns any driver error into {error}
    //   (lib/turso-postgrest.ts run), a timeout after the commit included, so the
    //   write may well have landed with its answer lost on the way back. Deleting
    //   the note then would leave a draft with no reason on it, the exact outcome
    //   the write order exists to avoid, and the retry would meet a 409. So LOOK.
    const now = await db
      .from("marketing_asset")
      .select("id, title, status")
      .eq("tenant_id", tenantId)
      .eq("id", assetId)
      .maybeSingle();
    current = now.data ? String(now.data.status) : null;

    if (moved.error) {
      console.error("[founders.request-changes] status change failed", moved.error.message);
      if (!now.error && now.data && current === next) {
        // It committed; only the answer was lost. The note stays and this is a success.
        landed = now.data;
      } else if (now.error || !now.data || current === "in_review") {
        // Could not look, or it did not commit: either way the note STAYS. An open
        // note on an asset still in review is the documented harmless state (the
        // agent acts on a note whose asset is a draft), and the founder's words
        // are not lost. A retry writes a second note with the same words.
        return { ok: false, http: 500, error: "update_failed" };
      }
      // Anything else: another verdict got there first. Fall through, as a refusal.
    }

    if (!landed) {
      // Take the note back: it describes a change that did not happen.
      const undo = await db
        .from("marketing_review")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("id", reviewId);
      if (undo.error) {
        console.error("[founders.request-changes] could not remove the unused note", reviewId, undo.error.message);
      }
      return { ok: false, http: 409, error: "status_changed", current };
    }
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
    asset: { id: String(landed.id), title: String(landed.title ?? title), status: next },
    reviewId,
  };
}
