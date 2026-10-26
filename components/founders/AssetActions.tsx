"use client";

/**
 * Approve · Archive · Delete, on the tile.
 *
 * CC, 2026-08-14, having to ask an agent to remove one ad: *"the last one, 'Oasis
 * Instagram system ad v1', I wanted to delete it."* — and then, looking at a grid of
 * everything badged IN REVIEW: *"some of them I can't even click on and view. It's kind of
 * weird functionality that I'm not 100% sure how to use."*
 *
 * Both complaints are the same missing thing. The Library could show you 39 assets and let
 * you do nothing to any of them, so every verdict had to leave the app and become a
 * request to an agent. A review surface with no verdict button is a gallery.
 *
 * DESIGN NOTES
 * - Optimistic on the status pill, because a review pass is a rhythm and a 300ms round
 *   trip per asset breaks it. Reverts loudly on failure rather than lying.
 * - Delete asks first. It removes rows for good (the R2 object survives and is reported by
 *   the route), so it gets a confirm step rather than a one-click regret. The step says it
 *   is permanent and offers Archive instead: the screen used to promise "can be restored"
 *   after a delete, and nothing in the app can bring a deleted asset back.
 * - `router.refresh()` after a verdict so the counts in the header and the Studio pipeline
 *   agree with the grid. Without it the tile changes and the page still says 39 in review.
 * - Approve moves the asset to approved and does nothing else: it books, schedules and
 *   posts nothing. The poster and the spend gate act on their own.
 * - Request changes (an in-review asset, drawn wherever the other verdicts are) opens a note box INSIDE the
 *   tile and will not send without words in it. The note goes to the marketing agent through
 *   POST .../request-changes (lib/founders/request-changes.ts); the asset goes back to draft.
 */

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AssetStatus } from "@/lib/founders-marketing-core";

// `in_review` is a verdict target too — it is how Restore undoes an archive.
// The [id] route has always accepted it (REACHABLE); only the button was absent.
type Verdict = "approved" | "archived" | "in_review";

const LABEL: Record<Verdict, string> = {
  approved: "Approve",
  archived: "Archive",
  in_review: "Restore",
};

/** Mirrors REQUEST_CHANGES_NOTE_MAX in lib/founders/request-changes.ts (a server file this client component must not import). */
const NOTE_MAX = 2000;

/** What the request-changes route's error codes say to a person. */
const REQUEST_REASON: Record<string, string> = {
  note_required: "Add a note saying what should change.",
  note_too_long: `That note is too long. Keep it under ${NOTE_MAX} characters.`,
  not_in_review: "This asset is no longer in review, so there is nothing to send back.",
  status_changed: "Someone changed this asset first. Reload the page to see where it is now.",
  not_found: "This asset could not be found.",
};

/**
 * What the [id] route's PATCH and DELETE error codes say to a person. A bare
 * "update_failed" under the Approve button told the founder nothing about what
 * to do next (audit, 2026-10-26). status_changed is kept for symmetry with
 * REQUEST_REASON; this component never sends `from`, so the route cannot answer it here.
 */
const VERDICT_REASON: Record<string, string> = {
  not_found: REQUEST_REASON.not_found,
  status_changed: REQUEST_REASON.status_changed,
  read_failed: "Could not read this asset. Try again.",
  update_failed: "Could not save that. Try again.",
  not_reviewable: "This video is kept for reference and takes no verdict.",
  delete_failed: "Could not delete it. Try again.",
  media_delete_failed: "Could not delete it. Try again.",
  delete_did_not_take: "The delete did not take. Reload the page to see where it is.",
};

export function AssetActions({
  id,
  status,
  title,
  afterDeleteHref,
}: {
  id: string;
  status: AssetStatus;
  title: string;
  /**
   * Where to go once deleted; absent = refresh this page (the grid, which then
   * draws without the tile). The asset's own page passes its way back to the
   * Library: a refresh there re-reads a row that is gone and lands on "Page not
   * found" (audit, 2026-10-26), the dead end that page exists to prevent.
   */
  afterDeleteHref?: string;
}) {
  const router = useRouter();
  const noteId = useId();
  const [pending, start] = useTransition();
  const [shown, setShown] = useState<AssetStatus>(status);
  const [confirming, setConfirming] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inflight, setInflight] = useState(false);
  const busy = pending || inflight;
  // Only an asset waiting on a verdict can be sent back; it is offered wherever the
  // other verdicts are, to whoever the founders gate admits (the route's own gate).
  const canAsk = shown === "in_review";

  async function verdict(next: Verdict) {
    // Guard synchronously. `pending` only flips inside start(), which runs AFTER
    // the await, so until then both verdict buttons and Delete stay live and a
    // fast second click fires a second mutation.
    if (inflight) return;
    setInflight(true);
    setError(null);
    setNotice(null);
    const previous = shown;
    setShown(next); // optimistic
    const res = await fetch(`/api/founders/marketing/assets/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: next }),
    }).catch(() => null);
    const body = await res?.json().catch(() => null);
    if (!res?.ok || !body?.ok) {
      setShown(previous);
      setError(VERDICT_REASON[String(body?.error)] ?? `Could not mark ${next}. Try again.`);
      setInflight(false);
      return;
    }
    setInflight(false);
    start(() => router.refresh());
  }

  async function remove() {
    if (inflight) return;
    setInflight(true);
    setError(null);
    const res = await fetch(`/api/founders/marketing/assets/${id}`, { method: "DELETE" }).catch(
      () => null,
    );
    const body = await res?.json().catch(() => null);
    if (!res?.ok || !body?.ok) {
      setError(VERDICT_REASON[String(body?.error)] ?? "Could not delete it. Try again.");
      setConfirming(false);
      setInflight(false);
      return;
    }
    setInflight(false);
    setGone(true);
    if (afterDeleteHref) router.push(afterDeleteHref);
    else start(() => router.refresh());
  }

  async function sendBack() {
    if (inflight) return;
    const text = note.trim();
    // The server refuses an empty note too (note_required); this keeps the round trip off.
    if (!text) {
      setError(REQUEST_REASON.note_required);
      return;
    }
    setInflight(true);
    setError(null);
    const res = await fetch(`/api/founders/marketing/assets/${id}/request-changes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: text }),
    }).catch(() => null);
    const body = await res?.json().catch(() => null);
    if (!res?.ok || !body?.ok) {
      // The note stays in the box: a refusal must never cost the founder their words.
      setError(REQUEST_REASON[String(body?.error)] ?? "Could not send it back. Your note is still here; try again.");
      setInflight(false);
      return;
    }
    setShown("draft");
    setAsking(false);
    setNote("");
    setNotice("Sent back. The marketing agent will see your note.");
    setInflight(false);
    start(() => router.refresh());
  }

  if (gone) {
    return (
      <div className="mt-2 rounded-lg border border-bg-border bg-bg-deep/60 px-3 py-2 text-[11px] text-fg-dim">
        Deleted. It is gone from the Library for good.
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      {notice && (
        <div role="status" className="rounded-lg border border-accent/30 bg-accent-soft px-3 py-1.5 text-[11px] text-accent">
          {notice}
        </div>
      )}
      {error && (
        // Say what failed. "Something went wrong" is why people stop trusting a button.
        <div role="alert" className="rounded-lg border border-hot/40 bg-hot/10 px-3 py-1.5 text-[11px] text-hot">
          {error}
        </div>
      )}

      {asking ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={noteId} className="text-[11px] leading-4 text-fg-muted">
            {`What should change in "${title}"? The marketing agent reads this note.`}
          </label>
          <textarea
            id={noteId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={NOTE_MAX}
            rows={3}
            disabled={busy}
            placeholder="For example: the first three seconds are too slow."
            className="w-full resize-y rounded-md border border-bg-border bg-bg-deep px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-dim focus:border-accent/50 focus:outline-none disabled:opacity-50"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={sendBack}
              disabled={busy || !note.trim()}
              className="rounded-md bg-accent/15 px-2.5 py-1 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
            >
              Send back
            </button>
            <button
              type="button"
              onClick={() => {
                setAsking(false);
                setError(null);
              }}
              disabled={busy}
              className="rounded-md px-2.5 py-1 text-[11px] text-fg-dim transition-colors hover:text-fg"
            >
              Cancel
            </button>
            <span className="ml-auto text-[10px] tabular-nums text-fg-dim">
              {note.length}/{NOTE_MAX}
            </span>
          </div>
          {!note.trim() && <span className="text-[10px] text-fg-dim">A note is required.</span>}
        </div>
      ) : confirming ? (
        <div className="flex flex-col gap-2">
          <span className="text-[11px] leading-4 text-fg-muted">
            {`Delete "${title}" for good? It cannot be undone. Archive keeps it, and it can be restored.`}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="rounded-md bg-hot/15 px-2.5 py-1 text-[11px] font-semibold text-hot transition-colors hover:bg-hot/25 disabled:opacity-50"
            >
              Delete for good
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                void verdict("archived");
              }}
              disabled={busy}
              className="rounded-md bg-bg-deep px-2.5 py-1 text-[11px] font-semibold text-fg-muted transition-colors hover:text-fg disabled:opacity-40"
            >
              Archive instead
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="ml-auto rounded-md px-2.5 py-1 text-[11px] text-fg-dim transition-colors hover:text-fg"
            >
              Keep
            </button>
          </div>
        </div>
      ) : shown === "archived" || shown === "rejected" ? (
        /*
         * ARCHIVE HAD NO INVERSE. CC, 2026-08-16: "I just archived a video, and
         * it's completely gone now. I have no idea where it's gone, and I want it
         * back, but I just don't know how to get it."
         *
         * The row was never gone — it was intact in the database the whole time,
         * and the Library simply had no filter that could show an archived asset
         * and no control that could return one. The API has accepted `in_review`
         * as a target since it shipped (REACHABLE in the [id] route), so the
         * capability existed and only the button was missing.
         *
         * An action that looks destructive, is offered one click from Approve,
         * and has no visible way back is a trapdoor. Restore puts it back where
         * it was: awaiting a verdict.
         *
         * A rejected row is filed under the same Archived pill and badge, so it
         * gets the same way back (audit, 2026-10-26): without it the only routes
         * out were Approve, skipping review, or Archive then Restore.
         */
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[11px] text-fg-dim">
            {shown === "rejected" ? "Rejected" : "Archived"} — nothing was deleted.
          </span>
          <button
            type="button"
            onClick={() => verdict("in_review")}
            disabled={busy}
            className="rounded-md bg-accent/15 px-2.5 py-1 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
          >
            Restore
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {(["approved", "request", "archived"] as const)
            .filter((v) => v !== "request" || canAsk)
            .map((v) =>
              v === "request" ? (
                <button
                  key={v}
                  type="button"
                  onClick={() => {
                    setError(null);
                    setNotice(null);
                    setAsking(true);
                  }}
                  disabled={busy}
                  className="rounded-md bg-status-warm/10 px-2.5 py-1 text-[11px] font-semibold text-status-warm transition-colors hover:bg-status-warm/20 disabled:opacity-40"
                >
                  Request changes
                </button>
              ) : (
                <button
                  key={v}
                  type="button"
                  onClick={() => verdict(v)}
                  disabled={busy || shown === v}
                  className={
                    "rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-40 " +
                    (v === "approved"
                      ? "bg-accent/15 text-accent hover:bg-accent/25"
                      : "bg-bg-deep text-fg-muted hover:text-fg")
                  }
                >
                  {shown === v ? `${LABEL[v]}d` : LABEL[v]}
                </button>
              ),
            )}
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy}
            className="ml-auto rounded-md px-2.5 py-1 text-[11px] text-fg-dim transition-colors hover:text-hot disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
