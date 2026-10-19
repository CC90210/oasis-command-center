"use client";

/**
 * A carousel is ONE post with N slides, shown as one card.
 *
 * CC's Library rendered every slide-1 as an isolated 4:5 image with "01/05 ·
 * swipe →" printed on the artwork — a card promising four more slides that the
 * database had never held. The slides were rendered and never uploaded; they are
 * registered now, so this is the surface that reads them.
 *
 * ORDER IS THE PAYLOAD. A carousel read out of order is a different post, so the
 * slide array arrives pre-ordered from `media_urls` and this component never
 * sorts, dedupes or re-derives it.
 *
 * Keyboard reachable because a review pass is a rhythm: arrow keys move between
 * slides once the strip has focus, which is faster than aiming at a chevron
 * thirty-nine times.
 *
 * MOTION SLIDES. A motion carousel's slides are MP4s (CC, 2026-10-16: ten
 * decks showed a broken-image icon and "slide 1 of 4" because every slide was
 * drawn as an <img>). A video slide is drawn by TileVideo, so it keeps the
 * Library's one rule for video: a cover until someone presses play, then a
 * <video preload="none">. Slide 1's cover is the asset's poster. Inside a tile
 * the slide plays IN PLACE - the tile's enlarge slot is hidden from it, because
 * the big phone opens on slide 1 and would play the wrong slide; Enlarge still
 * opens the big phone, where each slide waits for its own play press.
 */

import { useContext, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { enlargeSlotContext } from "@/components/founders/PhoneEnlarge";
import { SignedImg } from "@/components/founders/SignedMedia";
import { TileVideo } from "@/components/founders/TileVideo";
import { slideKind } from "@/lib/founders-marketing-core";

export function CarouselFrame({
  slides,
  title,
  className,
  style,
  width,
  height,
  posterUrl,
  variant = "native",
}: {
  slides: string[];
  title: string;
  className?: string;
  style?: React.CSSProperties;
  /** The slides' measured pixels, so the browser can size the image before it loads. */
  width?: number | null;
  height?: number | null;
  /** The asset's cover: slide 1's poster when slide 1 is a video. */
  posterUrl?: string | null;
  /** How a video slide plays: as a Reel inside a PhoneFrame, or with browser controls. */
  variant?: "native" | "phone";
}) {
  const [i, setI] = useState(0);
  const Slot = enlargeSlotContext();
  const slot = useContext(Slot);
  const count = slides.length;
  const at = Math.min(i, Math.max(count - 1, 0));
  const isVideo = count > 0 && slideKind(slides[at]) === "video";
  const slideTitle = `${title}, slide ${at + 1} of ${count}`;

  // Wrap deliberately: a carousel is a loop on every network that renders one,
  // and stopping at the end makes a reviewer think it broke.
  const go = (delta: number) => setI((n) => (count ? (n + delta + count) % count : 0));

  if (!count) return null;

  return (
    <div
      className={`group/car relative flex items-center justify-center overflow-hidden bg-bg-deep ${className || ""}`}
      style={style}
      role="group"
      aria-roledescription="carousel"
      aria-label={`${title} — ${count} slides`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
        if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      }}
    >
      {/* ONE slide on screen. An image slide is one lazy <img>: the first loads
          when the tile nears the viewport, every other only when the viewer
          moves to it. A video slide is a cover until play (see MOTION SLIDES);
          `key` gives each slide its own player, so moving on stops the last. */}
      {isVideo ? (
        <Slot.Provider value={slot?.place === "tile" ? null : slot}>
          <TileVideo
            key={at}
            src={slides[at]}
            posterUrl={at === 0 ? posterUrl : null}
            width={width}
            height={height}
            title={slideTitle}
            variant={variant}
          />
        </Slot.Provider>
      ) : (
        // A signed R2 URL, deliberately short-lived (see the note in marketing-shared); an expired one is retried
        // once with a fresh link (components/founders/SignedMedia.tsx).
        <SignedImg
          src={slides[at]}
          alt={slideTitle}
          width={width}
          height={height}
          className="h-full w-full object-contain"
        />
      )}

      <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-bg-deep/80 px-2 py-0.5 text-[9px] font-bold tabular-nums tracking-wider text-fg-muted">
        {at + 1}/{count}
      </span>

      {count > 1 && (
        <>
          <button
            type="button"
            aria-label="Previous slide"
            onClick={(e) => { e.preventDefault(); go(-1); }}
            className="absolute left-1 top-1/2 -translate-y-1/2 rounded-full bg-bg-deep/70 p-1 text-fg-muted opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/car:opacity-100"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Next slide"
            onClick={(e) => { e.preventDefault(); go(1); }}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full bg-bg-deep/70 p-1 text-fg-muted opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/car:opacity-100"
          >
            <ChevronRight className="h-4 w-4" />
          </button>

          <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1">
            {slides.map((_, n) => (
              <button
                key={n}
                type="button"
                aria-label={`Slide ${n + 1}`}
                aria-current={n === at}
                onClick={(e) => { e.preventDefault(); setI(n); }}
                className={
                  "h-1.5 rounded-full transition-all " +
                  (n === at ? "w-4 bg-accent" : "w-1.5 bg-fg-dim/50 hover:bg-fg-dim")
                }
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
