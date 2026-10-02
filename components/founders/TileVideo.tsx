"use client";

/**
 * A Library video that costs nothing until someone opens it.
 *
 * The tile used to be a <video preload="metadata">. For an MP4 whose moov box
 * sits at the end of the file (no faststart), "metadata" means reading deep
 * into the file - a page of 33 videos pulled tens of megabytes before anyone
 * pressed play, and with every tile at once that is a large part of why
 * opening the Library took minutes (CC, 2026-10-01).
 *
 * So the tile is a cover: the poster as a lazy, async <img> with its real
 * width and height, or a plain panel when there is no poster on file. The
 * <video> element mounts only when the viewer presses play, with
 * preload="none"; the play() call that follows is what loads it.
 *
 * Two players once open. `native` (the plain grid, the asset page's Original
 * view) keeps the browser's controls. `phone` (inside a PhoneFrame) plays the
 * way a Reel does: no control bar over the caption, tap to pause or play, a
 * mute toggle and a thin progress line - so the app's overlay is judged as the
 * audience will see it rather than under a desktop scrubber. The tap target is
 * a real button named for what it will do ("Play ..." / "Pause ..."), so the
 * keyboard and a screen reader can pause it too: a <video> with no controls
 * takes no focus and has no name.
 *
 * `initialOpen` is for the asset page, where the asset IS what the viewer
 * opened: the player is there from the start (most videos have no poster on
 * file, so a cover would be a black box) and loads its first frame, but nothing
 * plays until the viewer presses play. Library tiles never pass it.
 *
 * THE BIG PHONE (components/founders/PhoneEnlarge.tsx). Inside a tile that can
 * be enlarged, pressing the cover opens the asset in the big phone and plays it
 * THERE - CC: "when I click on it and make it big screen, it turns into a big
 * iPhone" - so the tile itself still never mounts a <video>. In the big phone
 * the player starts the way that press asked: playing from the second the
 * viewer was at, or as a cover (a player, on the asset page) that waits for
 * play. Outside both, it behaves exactly as above.
 */

import { useContext, useEffect, useRef, useState } from "react";
import { Play, Volume2, VolumeX } from "lucide-react";

import { enlargeSlotContext } from "@/components/founders/PhoneEnlarge";

export function TileVideo({
  src,
  posterUrl,
  width,
  height,
  title,
  variant = "native",
  initialOpen = false,
}: {
  src: string;
  posterUrl?: string | null;
  width?: number | null;
  height?: number | null;
  title: string;
  variant?: "native" | "phone";
  /** The asset page only: the player is open from the start and waits for play. */
  initialOpen?: boolean;
}) {
  const slot = useContext(enlargeSlotContext());
  // In the big phone: whether the press that opened it was a play press (or a
  // video was already playing in place), and the second to carry on from.
  const start = slot?.place === "big" ? slot.start : null;
  const autoplay = start?.play === true;
  const startAt = start?.at ?? 0;
  const [open, setOpen] = useState(initialOpen || autoplay);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [progress, setProgress] = useState(0);
  const ref = useRef<HTMLVideoElement | null>(null);
  const phone = variant === "phone";

  useEffect(() => {
    const v = ref.current;
    if (!open || !v) return;
    // Where the viewer was when they enlarged it.
    if (startAt > 0) v.currentTime = startAt;
    // Plays only when the viewer opened it from the cover, or opened the big
    // phone by pressing play. A player that starts open (the asset page) waits
    // for its play button: nothing autoplays.
    if (initialOpen && !autoplay) return;
    // Sound on first, since the viewer just asked for it. A browser that refuses
    // unmuted playback (Safari outside the click's own task) gets muted
    // playback instead; if even that is refused, the play button stays on
    // screen and one more tap plays it. Nothing is lost by either refusal.
    v.play().catch(() => {
      v.muted = true;
      v.play().catch(() => setPaused(true));
    });
  }, [open, initialOpen, autoplay, startAt]);

  const togglePlay = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => setPaused(true));
    else v.pause();
  };

  if (open) {
    return (
      <div className="relative h-full w-full">
        <video
          className="h-full w-full bg-black object-contain"
          ref={ref}
          src={src}
          poster={posterUrl || undefined}
          // A tile's player loads nothing until play. The asset page's loads its
          // first frame, which stands in for the poster most videos lack.
          preload={initialOpen ? "metadata" : "none"}
          controls={!phone}
          loop={phone}
          playsInline
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
          onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            if (phone && v.duration) setProgress(v.currentTime / v.duration);
          }}
        />
        {phone && (
          <>
            {/* Tap anywhere to play or pause, as in the apps - through a real
                button, so it also takes focus and says what it will do. The
                mute button is drawn after it and sits on top. */}
            <button
              type="button"
              onClick={togglePlay}
              aria-label={paused ? `Play ${title}` : `Pause ${title}`}
              className="absolute inset-0 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/80"
            >
              {paused && (
                <span
                  aria-hidden
                  className="pointer-events-none flex h-[14cqw] w-[14cqw] items-center justify-center rounded-full bg-black/55"
                >
                  <Play aria-hidden className="ml-[0.6cqw] h-[6cqw] w-[6cqw] fill-white text-white" />
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                const v = ref.current;
                if (v) v.muted = !v.muted;
              }}
              aria-label={muted ? `Unmute ${title}` : `Mute ${title}`}
              className="absolute right-[3cqw] top-[12%] flex h-[9cqw] w-[9cqw] items-center justify-center rounded-full bg-black/55 text-white"
            >
              {muted ? <VolumeX className="h-[4.6cqw] w-[4.6cqw]" /> : <Volume2 className="h-[4.6cqw] w-[4.6cqw]" />}
            </button>
            <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[0.6cqw] bg-white/25">
              <span className="block h-full bg-white" style={{ width: `${Math.round(progress * 1000) / 10}%` }} />
            </span>
          </>
        )}
      </div>
    );
  }

  // In a tile that can be enlarged, the cover opens the big phone and plays it
  // there; nothing mounts here.
  const enlargesOnPlay = slot?.place === "tile";
  return (
    <button
      type="button"
      onClick={(e) => {
        if (slot?.place === "tile") slot.enlarge({ play: true, at: 0 }, e.currentTarget);
        else setOpen(true);
      }}
      aria-label={`Play ${title}`}
      aria-haspopup={enlargesOnPlay ? "dialog" : undefined}
      className="group/play relative flex h-full w-full items-center justify-center bg-black"
    >
      {posterUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed R2 URL, deliberately short-lived; see the note in marketing-shared
        <img
          src={posterUrl}
          alt=""
          loading="lazy"
          decoding="async"
          width={width ?? undefined}
          height={height ?? undefined}
          className="h-full w-full object-contain"
        />
      ) : (
        // Below the play button rather than at the foot of the box: in a phone
        // frame the foot sits under the caption.
        <span className="absolute left-0 right-0 top-[60%] text-center text-[10px] text-white/50">
          No cover image on file
        </span>
      )}
      <span className="absolute flex h-12 w-12 items-center justify-center rounded-full bg-black/60 ring-1 ring-white/30 transition-transform group-hover/play:scale-105">
        <Play className="ml-0.5 h-5 w-5 fill-white text-white" />
      </span>
    </button>
  );
}
