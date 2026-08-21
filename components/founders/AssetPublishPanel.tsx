"use client";

/**
 * Pick channels, publish the asset to them.
 *
 * CC, 2026-08-14: *"I should be able to click on one of these videos and then
 * manually post it to all the social media channels via our API key that we have
 * connected."* Until now the only route to a channel was asking an agent to run a
 * script.
 *
 * SEPARATE FROM AssetActions ON PURPOSE. That component owns the verdict
 * (approve / archive / delete) and lives on the tile; this owns distribution and
 * lives on the detail page. They collided on one filename during concurrent work
 * — different jobs, so they are different components rather than one that does
 * both badly.
 *
 * CHANNELS ARE OPT-IN, ONE TAP EACH. Not a "post everywhere" button: publishing
 * is irreversible in the way that counts, because a deleted post has still been
 * seen. The operator picks, reads exactly what will happen, and confirms. The
 * server re-validates all of it; nothing chosen here is trusted.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * The channels reachable from here, and which of them can take a given asset,
 * live in lib/founders/publish-targets — pure so they can be tested without a DOM.
 *
 * PUBLISH_CHANNELS mirrors CMO-Agent/scripts/schedule_posts.py ACCOUNTS, which is
 * the only place that knows what is actually connected — the drainer re-checks
 * against it and refuses rather than silently posting to fewer surfaces than asked.
 *
 * `googlebusiness` is connected and deliberately absent: CC's own call,
 * 2026-07-27 — local/offer posts are a different content shape, added on purpose
 * rather than by default.
 */
import {
  PUBLISH_CHANNELS,
  formatList,
  refusalFor,
  unavailableChannels,
  type PublishMediaKind,
} from "@/lib/founders/publish-targets";

export function AssetPublishPanel({
  assetId,
  mediaKind,
  slideCount = 0,
  lastIntent,
  staleWarning = null,
}: {
  assetId: string;
  /**
   * What is actually attached — NOT "is there a video".
   *
   * 2026-08-21: this was `hasVideo: boolean`, computed from the video url alone.
   * A carousel has no video and never will, so it always arrived false and the
   * panel told CC "every channel below will refuse this asset" about the exact
   * format the Library was rebuilt to hold. The backend was never the problem:
   * marketing_publish_drain.fetch_media returns the cover plus the ordered
   * slides for asset_type "carousel" and publishes them correctly. The gate was
   * written when every asset was a reel, and it outlived that assumption.
   */
  mediaKind: PublishMediaKind;
  /** Slides in the deck — decides which channels can take it (see PUBLISH_CHANNELS). */
  slideCount?: number;
  lastIntent?: { state: string; platforms: string[]; created_at: string } | null;
  /**
   * Computed by the SERVER via stalePublishWarning, not here.
   *
   * Same reason the timestamp below is a raw `<time dateTime>` rather than
   * toLocaleString(): this is a client component pre-rendered on the server, and
   * anything derived from `new Date()` inside it would be evaluated twice, in two
   * clocks, and mismatch on hydration. The page is force-dynamic, so a
   * server-computed string is fresh on every request anyway.
   */
  staleWarning?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  async function submit() {
    // `busy` is set synchronously here rather than relying on the transition:
    // `pending` stays false until start() runs AFTER the await, so a fast second
    // click would fire a second request. The route 409s on a duplicate, but the
    // button should not have let it happen — and on a slow upload the window is
    // seconds wide.
    // Belt and braces: refused channels are already disabled, but never POST a
    // platform this asset cannot satisfy. The route would record the intent and
    // the drain would fail it later, which reads as a publishing bug rather than
    // a bad pick.
    const platforms = picked.filter((id) => {
      const c = PUBLISH_CHANNELS.find((x) => x.id === id);
      return c ? !refusalFor(c, mediaKind, slideCount) : false;
    });
    if (!platforms.length || busy) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/founders/marketing/assets/${assetId}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platforms }),
    }).catch(() => null);
    const body = await res?.json().catch(() => null);
    setBusy(false);

    if (!res?.ok || !body?.ok) {
      // Show the server's own reason. A generic "failed" is exactly what made
      // invite_create_failed take months to diagnose.
      setMsg({ ok: false, text: body?.error ? String(body.error) : `Could not queue (${res?.status ?? "network"}).` });
      return;
    }
    setPicked([]);
    // This said "the publisher picks it up within a minute" — true of the drain's
    // SCHEDULE (a cron_engine SEED_JOB on `* * * * *`) and not of the outcome.
    // That drain runs on the operator's machine, so when the machine is off the
    // row simply waits, and the sentence promised a minute that could be a night.
    // It now reports what definitely happened (a request was recorded) and names
    // the condition for the rest; the panel below flags a request nothing has
    // collected.
    setMsg({
      ok: true,
      text: `Recorded for ${(body.platforms || platforms).join(", ")}. It goes out on the next publisher run.`,
    });
    start(() => router.refresh());
  }

  const working = busy || pending;

  // Computed once for the hint line and reused as the per-button gate, so the
  // sentence and the disabled state can never disagree.
  const unavailable = unavailableChannels(mediaKind, slideCount);

  return (
    <div className="space-y-4">
      {mediaKind === "none" && (
        <p className="text-xs text-fg-dim">
          No media is attached, so every channel below will refuse this asset.
        </p>
      )}

      {mediaKind === "images" && unavailable.length > 0 && (
        <p className="text-xs text-fg-dim">
          {formatList(unavailable.map((c) => c.label))} cannot take a {slideCount}-slide
          deck — hover for why. The rest accept it.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {PUBLISH_CHANNELS.map((c) => {
          const on = picked.includes(c.id);
          const refusal = refusalFor(c, mediaKind, slideCount);
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => toggle(c.id)}
              disabled={working || Boolean(refusal)}
              aria-pressed={on}
              // The handle is what CC needs on a channel he CAN use; the reason
              // is what he needs on one he cannot.
              title={refusal ?? c.handle}
              className={
                "rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-40 " +
                (on
                  ? "bg-accent/20 text-accent ring-1 ring-inset ring-accent/40"
                  : "bg-bg-deep text-fg-muted hover:text-fg")
              }
            >
              {c.label}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={submit}
        disabled={working || !picked.length}
        className="w-full rounded-md bg-accent/15 px-3 py-2 text-xs font-semibold text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
      >
        {working
          ? "Queueing…"
          : picked.length
            ? `Publish to ${picked.length} channel${picked.length === 1 ? "" : "s"}`
            : "Pick a channel"}
      </button>

      <p className="text-[11px] leading-5 text-fg-dim">
        Goes through the send gateway — killswitch, daily caps and audit trail all apply. A
        published post can be deleted, but it cannot be unseen.
      </p>

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

      {/* A request nothing has collected yet. Rendered as a warning rather than
          left to look like normal queue latency — see stalePublishWarning.
          Computed from the row's own age on each render, so it reports the drain
          being unreachable (operator machine off, cron paused, process wedged)
          without this page needing to reach that machine to ask. */}
      {staleWarning && (
        <div
          role="status"
          className="rounded-lg border border-hot/40 bg-hot/10 px-3 py-2 text-[11px] leading-5 text-hot"
        >
          {staleWarning}
        </div>
      )}

      {lastIntent && (
        <div className="border-t border-bg-border pt-3 text-[11px] text-fg-dim">
          Last request: <span className="text-fg-muted">{lastIntent.state}</span>
          {lastIntent.platforms.length > 0 && <> · {lastIntent.platforms.join(", ")}</>} ·{" "}
          {/* <time> with the raw ISO value, not toLocaleString(). This component is
              pre-rendered on the server, and locale/timezone differ there, so the
              formatted string would not match on hydration. The browser renders the
              title on hover in the reader's own zone. */}
          <time dateTime={lastIntent.created_at} title={lastIntent.created_at}>
            {lastIntent.created_at.replace("T", " ").slice(0, 16)} UTC
          </time>
        </div>
      )}
    </div>
  );
}
