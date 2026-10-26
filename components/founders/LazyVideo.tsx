"use client";

/**
 * One extracted video, mounted only when its card comes near the screen
 * (Extracted videos, inside the Video extractor).
 *
 * The Library's rule (components/founders/TileVideo.tsx): a page of tiles must
 * not fetch every video on arrival. A <video preload="metadata"> per card would
 * do exactly that, up to 24 range reads plus a first-frame decode each. So the
 * server markup holds no <video> at all; an IntersectionObserver mounts it once
 * the card is within 200px of the viewport, and then preload="metadata" with
 * #t=0.1 paints the first frame. A browser with no IntersectionObserver mounts
 * it straight away (the old behaviour, still correct).
 *
 * A signed link lasts an hour or two, and this player mounts late by design: a
 * card reached after that used to be a black frame with a dead control bar and
 * no words (audit, 2026-10-26). The Library's own hook renews the link once and,
 * failing that, says so in plain words (components/founders/SignedMedia.tsx).
 *
 * The extractor's MP4s carry their index (moov) first (CMO-Agent
 * scripts/content_tools_runner.py ensure_faststart), so that metadata read is a
 * small range request rather than the whole file.
 */

import { useEffect, useRef, useState } from "react";
import { MediaFailed, useSignedVideo } from "@/components/founders/SignedMedia";

export function LazyVideo({
  src,
  posterUrl,
  width,
  height,
  title,
}: {
  src: string;
  posterUrl?: string | null;
  width?: number | null;
  height?: number | null;
  title: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLVideoElement | null>(null);
  const [near, setNear] = useState(false);
  // The renewed link carries on from the second the old one failed, playing if the viewer had pressed play.
  const video = useSignedVideo(src, () => player.current);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={box} className="flex h-full w-full items-center justify-center" data-lazy-video={near ? "mounted" : "waiting"}>
      {near ? (
        video.failed ? (
          <MediaFailed className="flex h-full w-full items-center justify-center px-3 text-center text-[11px] text-fg-muted" />
        ) : (
          <video
            ref={player}
            src={video.src ? `${video.src}#t=0.1` : undefined}
            onError={video.onError}
            onPlay={video.onPlay}
            onPause={video.onPause}
            poster={posterUrl ?? undefined}
            controls
            preload="metadata"
            playsInline
            aria-label={title}
            className="h-full max-w-full"
            style={{ aspectRatio: width && height ? `${width} / ${height}` : "9 / 16" }}
          />
        )
      ) : (
        <span className="sr-only">{title}</span>
      )}
    </div>
  );
}
