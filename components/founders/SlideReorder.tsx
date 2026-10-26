"use client";

/**
 * Re-order the slides of a carousel.
 *
 * Slide order is not decoration — it is what the audience reads, and what
 * scripts/marketing_publish_drain.py publishes. So this writes to
 * marketing_asset.media_urls, the single record of which slide is which.
 *
 * MOVES ARE LOCAL, SAVING IS EXPLICIT. Dragging a slide and having it commit on
 * drop makes an irreversible-feeling change out of a twitch. You rearrange, you
 * see the new order numbered, then you Save — and Reset is there until you do.
 *
 * The request sends storage PATHS, not indices. The server refuses anything that
 * is not a permutation of what the asset already owns, so a reorder cannot
 * become a way to point this asset at someone else's object.
 */

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { ArrowLeft, ArrowRight, Play, RotateCcw } from "lucide-react";

import { slideKind } from "@/lib/founders-marketing-core";
import { SignedImg } from "@/components/founders/SignedMedia";

export function SlideReorder({
  assetId,
  slidePaths,
  slideUrls,
}: {
  assetId: string;
  /** Storage paths, in current order — the identity sent to the server. */
  slidePaths: string[];
  /** Signed preview URLs, index-aligned with slidePaths. */
  slideUrls: string[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [order, setOrder] = useState<number[]>(() => slidePaths.map((_, i) => i));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // The strip keeps the operator's order until the refreshed slidePaths arrive
  // (the page re-reads media_urls after a save); only then does `order` go back
  // to identity. Resetting it on save re-numbered the OLD arrangement under
  // "Order saved" for the whole round trip (audit, 2026-10-26).
  const pathsKey = slidePaths.join("\n");
  const [seenKey, setSeenKey] = useState(pathsKey);
  if (pathsKey !== seenKey) {
    setSeenKey(pathsKey);
    setOrder(slidePaths.map((_, i) => i));
  }

  const dirty = useMemo(() => order.some((n, i) => n !== i), [order]);
  const working = busy || pending;

  function move(pos: number, delta: number) {
    const to = pos + delta;
    if (to < 0 || to >= order.length) return;
    setOrder((o) => {
      const copy = [...o];
      [copy[pos], copy[to]] = [copy[to], copy[pos]];
      return copy;
    });
    setMsg(null);
  }

  async function save() {
    if (!dirty || working) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/founders/marketing/assets/${assetId}/slides`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slides: order.map((n) => slidePaths[n]) }),
    }).catch(() => null);
    const body = await res?.json().catch(() => null);
    setBusy(false);

    if (!res?.ok || !body?.ok) {
      // The server's own reason. "Something went wrong" is why people stop
      // trusting a button.
      setMsg({ ok: false, text: body?.detail || body?.error || `Could not save (${res?.status ?? "network"}).` });
      return;
    }
    setMsg({ ok: true, text: "Order saved. This is the order it will publish in." });
    // The page re-reads media_urls; the strip keeps the saved order until the new
    // props land, and the block above then makes `order` identity again.
    start(() => router.refresh());
  }

  if (slidePaths.length < 2) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {order.map((slideIdx, pos) => (
          <div
            key={slidePaths[slideIdx]}
            className="group/slide relative w-[74px] shrink-0 overflow-hidden rounded-md border border-bg-border bg-bg-deep"
          >
            {/* Lazy and async like every Library image: each thumbnail is a
                full-size slide, so a long deck must not fetch them all up front.
                A motion slide (an MP4) is a labelled panel, never an <img> of a
                video: that drew a broken-image icon. It loads nothing; the
                carousel above plays it. */}
            {slideKind(slideUrls[slideIdx] ?? "") === "video" ? (
              <div
                role="img"
                aria-label={`Slide ${pos + 1}, video`}
                className="flex h-[92px] w-full flex-col items-center justify-center gap-1 bg-black text-fg-muted"
              >
                <Play aria-hidden className="h-4 w-4 fill-current" />
                <span className="text-[9px] font-bold uppercase tracking-wider">Video</span>
              </div>
            ) : (
              // A signed R2 URL, short-lived by design: renewed once if it has expired (components/founders/SignedMedia.tsx).
              <SignedImg
                src={slideUrls[slideIdx]}
                alt={`Slide ${pos + 1}`}
                className="h-[92px] w-full object-cover"
                failedClassName="flex h-[92px] w-full items-center justify-center px-1 text-center text-[9px] text-fg-dim"
              />
            )}
            <span className="absolute left-1 top-1 rounded bg-bg-deep/85 px-1 text-[9px] font-bold tabular-nums text-fg-muted">
              {pos + 1}
            </span>
            <div className="flex divide-x divide-bg-border border-t border-bg-border">
              <button
                type="button"
                aria-label={`Move slide ${pos + 1} earlier`}
                disabled={working || pos === 0}
                onClick={() => move(pos, -1)}
                className="flex-1 py-1 text-fg-dim transition-colors hover:text-fg disabled:opacity-25"
              >
                <ArrowLeft className="mx-auto h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label={`Move slide ${pos + 1} later`}
                disabled={working || pos === order.length - 1}
                onClick={() => move(pos, 1)}
                className="flex-1 py-1 text-fg-dim transition-colors hover:text-fg disabled:opacity-25"
              >
                <ArrowRight className="mx-auto h-3 w-3" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || working}
          className="rounded-md bg-accent/15 px-3 py-1.5 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
        >
          {working ? "Saving…" : dirty ? "Save order" : "Order saved"}
        </button>
        {dirty && !working && (
          <button
            type="button"
            onClick={() => { setOrder(slidePaths.map((_, i) => i)); setMsg(null); }}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] text-fg-dim transition-colors hover:text-fg"
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </button>
        )}
      </div>

      {msg && (
        <div
          role="status"
          className={
            "rounded-lg px-3 py-1.5 text-[11px] " +
            (msg.ok
              ? "border border-accent/30 bg-accent/10 text-accent"
              : "border border-hot/40 bg-hot/10 text-hot")
          }
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}
