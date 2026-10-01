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
 * audience will see it rather than under a desktop scrubber.
 */

import { useEffect, useRef, useState } from "react";
import { Play, Volume2, VolumeX } from "lucide-react";

export function TileVideo({
  src,
  posterUrl,
  width,
  height,
  title,
  variant = "native",
}: {
  src: string;
  posterUrl?: string | null;
  width?: number | null;
  height?: number | null;
  title: string;
  variant?: "native" | "phone";
}) {
  const [open, setOpen] = useState(false);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [progress, setProgress] = useState(0);
  const ref = useRef<HTMLVideoElement | null>(null);
  const phone = variant === "phone";

  useEffect(() => {
    const v = ref.current;
    if (!open || !v) return;
    // Sound on first, since the viewer just asked for it. A browser that refuses
    // unmuted playback (Safari outside the click's own task) gets muted
    // playback instead; if even that is refused, the play button stays on
    // screen and one more tap plays it. Nothing is lost by either refusal.
    v.play().catch(() => {
      v.muted = true;
      v.play().catch(() => setPaused(true));
    });
  }, [open]);

  if (open) {
    return (
      <div className="relative h-full w-full">
        <video
          className="h-full w-full bg-black object-contain"
          ref={ref}
          src={src}
          poster={posterUrl || undefined}
          preload="none"
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
          onClick={(e) => {
            if (!phone) return;
            const v = e.currentTarget;
            if (v.paused) v.play().catch(() => setPaused(true));
            else v.pause();
          }}
        />
        {phone && (
          <>
            {paused && (
              <span className="pointer-events-none absolute left-1/2 top-1/2 flex h-[14cqw] w-[14cqw] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55">
                <Play className="ml-[0.6cqw] h-[6cqw] w-[6cqw] fill-white text-white" />
              </span>
            )}
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

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={`Play ${title}`}
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
