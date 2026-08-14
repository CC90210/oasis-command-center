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
 *   the route), so it gets a confirm step rather than a one-click regret.
 * - `router.refresh()` after a verdict so the counts in the header and the Studio pipeline
 *   agree with the grid. Without it the tile changes and the page still says 39 in review.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AssetStatus } from "@/lib/founders-marketing-core";

type Verdict = "approved" | "archived";

const LABEL: Record<Verdict, string> = { approved: "Approve", archived: "Archive" };

export function AssetActions({
  id,
  status,
  title,
}: {
  id: string;
  status: AssetStatus;
  title: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [shown, setShown] = useState<AssetStatus>(status);
  const [confirming, setConfirming] = useState(false);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = pending;

  async function verdict(next: Verdict) {
    setError(null);
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
      setError(body?.error ? String(body.error) : `Could not mark ${next}.`);
      return;
    }
    start(() => router.refresh());
  }

  async function remove() {
    setError(null);
    const res = await fetch(`/api/founders/marketing/assets/${id}`, { method: "DELETE" }).catch(
      () => null,
    );
    const body = await res?.json().catch(() => null);
    if (!res?.ok || !body?.ok) {
      setError(body?.error ? String(body.error) : "Could not delete.");
      setConfirming(false);
      return;
    }
    setGone(true);
    start(() => router.refresh());
  }

  if (gone) {
    return (
      <div className="mt-2 rounded-lg border border-bg-border bg-bg-deep/60 px-3 py-2 text-[11px] text-fg-dim">
        Deleted. The video file is kept in storage and can be restored.
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      {error && (
        // Say what failed. "Something went wrong" is why people stop trusting a button.
        <div className="rounded-lg border border-hot/40 bg-hot/10 px-3 py-1.5 text-[11px] text-hot">
          {error}
        </div>
      )}

      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[11px] text-fg-muted">Delete “{title}”?</span>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="rounded-md bg-hot/15 px-2.5 py-1 text-[11px] font-semibold text-hot transition-colors hover:bg-hot/25 disabled:opacity-50"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="rounded-md px-2.5 py-1 text-[11px] text-fg-dim transition-colors hover:text-fg"
          >
            Keep
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          {(["approved", "archived"] as const).map((v) => (
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
          ))}
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
