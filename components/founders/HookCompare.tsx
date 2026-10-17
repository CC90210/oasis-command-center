"use client";

/**
 * Hook comparison - one pack's variants, side by side or one after another.
 *
 * CC, 2026-10-08, through Maven: a pack is several cuts of the same ad that
 * differ only in how they open, and he has to pick the strongest opening. Each
 * card is one variant: its number, its style, its opening line, its video (16:9),
 * its status, and the same verdict buttons the Library tiles carry.
 *
 * TWO WAYS TO WATCH
 *   Play all together     every video starts at the beginning at once, muted
 *                         (a browser will not start several with sound), so the
 *                         openings can be compared frame for frame; unmute the
 *                         one you want to hear with its own controls. It is over,
 *                         and the controls say so, when every clip has ended.
 *   Play one after another  variant 1 with sound, and each starts when the one
 *                         before it ends. Stop ends either. A card removed by a
 *                         verdict while it plays ends the sequence.
 *
 * NOTHING LOADS UNTIL PRESSED. Every video is preload="none", the rule the rest
 * of the Library follows (components/founders/TileVideo.tsx: a page that fetched
 * every video on arrival took minutes). A press on a play button is the request.
 *
 * Approve here marks a variant approved and nothing more. It books, schedules
 * and posts nothing; the sentence under the buttons says so.
 */

import { useRef, useState } from "react";
import Link from "next/link";
import { Play, Square } from "lucide-react";

import { Tag } from "@/components/Card";
import { AssetActions } from "@/components/founders/AssetActions";
import { MetaBadges } from "@/components/founders/MetaBadges";
import { fmtDuration, lifecycleLabel, type Lifecycle } from "@/lib/founders-marketing-core";
import { hookStyleLabel, type HookVariantCard } from "@/lib/founders/library-meta";

type Tone = "neutral" | "accent" | "warm" | "engaged";

/** The same bucket colours as the Library tiles (StatusTag in marketing-shared.tsx). */
const LIFECYCLE_TONE: Record<Lifecycle, Tone> = {
  needs_review: "warm",
  approved: "accent",
  live: "engaged",
  archived: "neutral",
};

type Mode = "idle" | "together" | "order";

export function HookCompare({
  heading,
  cards,
  note,
}: {
  heading: string;
  cards: HookVariantCard[];
  /** An honest line about what is NOT shown (the pack is larger than the comparison reads). */
  note?: string;
}) {
  // Everything below is keyed by a card's ID, never by its position. A verdict
  // that removes a card (Delete, Archive, Approve under a stage filter) refreshes
  // `cards` while a clip may be playing, and a stored position would then point
  // at the wrong card or past the end (Codex on #679).
  const videos = useRef(new Map<string, HTMLVideoElement>());
  // The variant the sequence is on. A ref as well as state: a video's `ended`
  // handler must read the CURRENT one, not the value from the render it was made in.
  const current = useRef<string | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [playingId, setPlayingId] = useState<string | null>(null);
  // "All together": the clips that have not ended yet.
  const [waiting, setWaiting] = useState<string[]>([]);

  const playable = cards.filter((c) => c.playbackUrl).length;

  // WHAT IS ACTUALLY HAPPENING, derived on every render from the cards on the
  // page. A sequence whose playing variant is gone (its card was removed) is
  // over, and "all together" is over when every clip still on the page has ended;
  // neither can leave the controls saying "playing" over a page where nothing is.
  const playingIndex = playingId === null ? -1 : cards.findIndex((c) => c.id === playingId);
  const waitingHere = waiting.filter((id) => cards.some((c) => c.id === id));
  const active: Mode =
    mode === "order" && playingIndex >= 0 ? "order" : mode === "together" && waitingHere.length > 0 ? "together" : "idle";

  function setCurrent(id: string | null) {
    current.current = id;
    setPlayingId(id);
  }

  function stop() {
    for (const v of videos.current.values()) v.pause();
    setCurrent(null);
    setWaiting([]);
    setMode("idle");
  }

  /** One "all together" clip is done (ended, or refused to play): one fewer to wait for. */
  function finish(id: string) {
    setWaiting((w) => w.filter((x) => x !== id));
  }

  function together() {
    setCurrent(null);
    const ids: string[] = [];
    for (const card of cards) {
      const v = videos.current.get(card.id);
      if (!v) continue;
      ids.push(card.id);
      v.pause();
      v.currentTime = 0;
      v.muted = true;
      v.play().catch(() => finish(card.id));
    }
    setWaiting(ids);
    setMode(ids.length ? "together" : "idle");
  }

  /** Play variant `from`, or the next one after it that has a video; finish when none is left. */
  function inOrder(from: number) {
    let i = from;
    while (i < cards.length && !videos.current.get(cards[i].id)) i += 1;
    if (i >= cards.length) {
      setCurrent(null);
      setMode("idle");
      return;
    }
    const id = cards[i].id;
    for (const [other, clip] of videos.current) {
      if (other !== id) clip.pause();
    }
    const v = videos.current.get(id)!;
    v.currentTime = 0;
    v.muted = false;
    setWaiting([]);
    setMode("order");
    setCurrent(id);
    v.scrollIntoView({ block: "nearest", behavior: "smooth" });
    // A browser that refuses unmuted playback gets it muted; if even that is
    // refused the video stays put and its own play button is the way on.
    v.play().catch(() => {
      v.muted = true;
      v.play().catch(() => undefined);
    });
  }

  const status =
    active === "order"
      ? `Playing ${cards[playingIndex].variantLabel} (${playingIndex + 1} of ${cards.length}).`
      : active === "together"
        ? "Playing all together, muted. Unmute one to hear it."
        : "";

  const button =
    "inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-40";

  return (
    <section aria-label={heading} className="space-y-4">
      <div className="space-y-1">
        <h2 className="break-words text-sm font-semibold text-fg">{heading}</h2>
        <p className="text-xs leading-5 text-fg-muted">
          Compare how each variant opens. Approve marks a variant approved and nothing more: it does not schedule or post it.
        </p>
        {note && <p className="text-xs leading-5 text-fg-muted">{note}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={together}
          disabled={playable === 0}
          aria-pressed={active === "together"}
          className={`${button} ${
            active === "together"
              ? "border-accent/30 bg-accent-soft text-accent"
              : "border-bg-border bg-bg-elev text-fg-muted hover:bg-bg-hover hover:text-fg"
          }`}
        >
          <Play aria-hidden className="h-3.5 w-3.5" />
          Play all together
        </button>
        <button
          type="button"
          onClick={() => inOrder(0)}
          disabled={playable === 0}
          aria-pressed={active === "order"}
          className={`${button} ${
            active === "order"
              ? "border-accent/30 bg-accent-soft text-accent"
              : "border-bg-border bg-bg-elev text-fg-muted hover:bg-bg-hover hover:text-fg"
          }`}
        >
          <Play aria-hidden className="h-3.5 w-3.5" />
          Play one after another
        </button>
        {active !== "idle" && (
          <button
            type="button"
            onClick={stop}
            className={`${button} border-bg-border bg-bg-deep/40 text-fg-dim hover:text-fg`}
          >
            <Square aria-hidden className="h-3.5 w-3.5" />
            Stop
          </button>
        )}
        <span role="status" aria-live="polite" className="text-xs text-fg-dim">
          {status}
        </span>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {cards.map((card, i) => (
          <article
            key={card.id}
            className={
              "flex flex-col gap-3 rounded-xl border bg-bg-panel p-3 shadow-card transition-colors " +
              (active === "order" && playingIndex === i ? "border-accent/60" : "border-bg-border")
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xs font-semibold text-fg">{card.variantLabel}</span>
                {card.hookStyle && (
                  <span className="text-[11px] text-fg-muted">{hookStyleLabel(card.hookStyle)}</span>
                )}
              </div>
              <Tag tone={LIFECYCLE_TONE[card.lifecycle]}>{lifecycleLabel(card.lifecycle)}</Tag>
            </div>

            <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
              {card.playbackUrl ? (
                <video
                  ref={(el) => {
                    if (el) videos.current.set(card.id, el);
                    else videos.current.delete(card.id);
                  }}
                  src={card.playbackUrl}
                  poster={card.posterUrl ?? undefined}
                  preload="none"
                  controls
                  playsInline
                  aria-label={`${card.variantLabel}: ${card.title}`}
                  onEnded={() => {
                    // In a sequence the clip that ends hands over to the next card
                    // (looked up by id, then by this render's position); in "all
                    // together" every clip that ends is one fewer to wait for.
                    if (current.current === card.id) inOrder(i + 1);
                    else finish(card.id);
                  }}
                  className="h-full w-full bg-black object-contain"
                />
              ) : card.posterUrl ? (
                // A signed, short-lived Storage URL: a plain <img> on purpose (see TileMedia in marketing-shared.tsx).
                // eslint-disable-next-line @next/next/no-img-element
                <img src={card.posterUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain" />
              ) : (
                <div className="flex h-full items-center justify-center px-4 text-center text-xs text-white/50">
                  No render on file yet
                </div>
              )}
            </div>

            <blockquote className="break-words border-l-2 border-accent/50 pl-3 text-sm font-medium leading-snug text-fg">
              {card.hook}
            </blockquote>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link
                href={card.href}
                title={card.title}
                className="min-w-0 truncate text-xs text-fg-muted transition-colors hover:text-accent"
              >
                {card.title}
              </Link>
              {card.durationS !== null && (
                <span className="text-[10px] tabular-nums text-fg-dim">{fmtDuration(card.durationS)}</span>
              )}
            </div>

            <MetaBadges offerSlug={card.offerSlug} burnedCaptions={card.burnedCaptions} />

            <AssetActions id={card.id} status={card.status} title={card.title} />
          </article>
        ))}
      </div>
    </section>
  );
}
