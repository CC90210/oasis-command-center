"use client";

/**
 * components/meet/TrackVideo.tsx - a camera or screen track on the page, and a remote microphone track that plays.
 *
 * Both attach in an effect (srcObject cannot be set while rendering), so the server's markup is the bare
 * element. Every <video> here is muted: other people's voices come through RemoteAudio, one hidden <audio> per
 * remote microphone, and a person's own voice is never played back to them.
 */

import { useEffect, useRef } from "react";

export function TrackVideo({
  track,
  mirrored = false,
  fit = "cover",
  label,
}: {
  track: MediaStreamTrack | null;
  /** The person's own camera is shown the way a mirror shows it. */
  mirrored?: boolean;
  fit?: "cover" | "contain";
  label?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!track) {
      el.srcObject = null;
      return;
    }
    el.srcObject = new MediaStream([track]);
    // Some browsers hold a muted video that has not started; asking is harmless where autoplay already did it.
    el.play().catch(() => undefined);
    return () => {
      el.srcObject = null;
    };
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      aria-label={label}
      className={`absolute inset-0 h-full w-full ${fit === "contain" ? "object-contain" : "object-cover"} ${mirrored ? "-scale-x-100" : ""}`.trim()}
    />
  );
}

/**
 * One remote microphone. If the browser will not start sound without a tap (phones, mostly) it says so through
 * onBlocked; `retry` goes up each time the person taps, which plays it again from that tap.
 */
export function RemoteAudio({ track, retry, onBlocked }: { track: MediaStreamTrack; retry: number; onBlocked: () => void }) {
  const ref = useRef<HTMLAudioElement>(null);
  const blocked = useRef(onBlocked);
  useEffect(() => {
    blocked.current = onBlocked;
  }, [onBlocked]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = new MediaStream([track]);
    el.play().catch(() => blocked.current());
    return () => {
      el.srcObject = null;
    };
  }, [track, retry]);
  return <audio ref={ref} autoPlay hidden />;
}
