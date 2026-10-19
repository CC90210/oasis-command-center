"use client";

/**
 * Library media that heals an expired link instead of showing a broken icon.
 *
 * Every Library image and video is a signed R2 link that lives one to two hours
 * (lib/r2-storage.ts readWindowSec). A tab left open longer, or a lazy tile the
 * viewer reaches later, asks R2 with an expired signature, gets a 403, and the
 * browser draws its broken-image icon: CC saw exactly that on the newest quote
 * cards (2026-10-19, through Maven) while every link signed that minute worked.
 *
 * So on an error the element hands its link to POST
 * /api/founders/marketing/media/resign (lib/founders/media-resign.ts), which
 * signs that one object again if it belongs to this workspace's Library, and
 * retries ONCE with the fresh link. If that fails too, or nothing fresher comes
 * back, it says so in plain words instead of the icon (MEDIA_FAILED_TEXT).
 *
 * Hooks here use only useState, useRef and useEffect, and handlers are plain
 * functions (no useCallback): nothing compares them, and the Library's render
 * tests drive these components with a dispatcher that knows only those hooks
 * (tests/library-phone-preview.render.ts, tests/library-review.render.ts).
 */
import { useEffect, useRef, useState } from "react";

export const MEDIA_FAILED_TEXT = "Couldn't load this. Reload the page.";
export const RESIGN_ROUTE = "/api/founders/marketing/media/resign";

type Link = string | null | undefined;
type PauseEvent = { currentTarget?: { error?: unknown } | null };

// One request per link, however many elements show it (a poster and a slide can be the same object).
const inflight = new Map<string, Promise<string | null>>();

/** A fresh signed link for `url`, or null when there is none to be had. Never throws. */
export function resignMediaUrl(url: string): Promise<string | null> {
  const pending = inflight.get(url);
  if (pending) return pending;
  const request = fetch(RESIGN_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
    credentials: "same-origin",
    cache: "no-store",
  })
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json()) as { ok?: boolean; url?: unknown };
      return body.ok === true && typeof body.url === "string" ? body.url : null;
    })
    .catch(() => null)
    .finally(() => inflight.delete(url));
  inflight.set(url, request);
  return request;
}

/**
 * Renewal for every link one component shows: the link to render for each, its
 * error handler, and whether it has given up. Every result is kept under the
 * link it is FOR: one element shows many links in turn (CarouselFrame's slides)
 * and a pack comparison shows many at once, and renewals settle in any order,
 * so a single "current" slot let slide A's late answer overwrite slide B's, and
 * an error of A's old link while A's renewal was still on its way read as the
 * fresh link failing (CodeRabbit and Codex on #706).
 */
export function useSignedLinks(): {
  src: (url: Link) => Link;
  failed: (url: Link) => boolean;
  onError: (url: Link) => void;
  /** Original link -> its renewed link; a new object whenever one is added. */
  renewed: Readonly<Record<string, string>>;
} {
  const [renewed, setRenewed] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, true>>({});
  // Per link: its renewal is on its way, or has been answered (the one retry is spent).
  const asked = useRef<Map<string, "pending" | "answered">>(new Map());

  const onError = (url: Link) => {
    if (!url) return;
    const state = asked.current.get(url);
    // The old link failing again while its renewal is on the way: wait for the renewal.
    if (state === "pending") return;
    // The renewed link failed as well: stop, and say so.
    if (state === "answered") {
      setFailed((prev) => ({ ...prev, [url]: true }));
      return;
    }
    asked.current.set(url, "pending");
    void resignMediaUrl(url).then((next) => {
      asked.current.set(url, "answered");
      // The same link back means the object, not the signature, is the problem: a retry would fail the same way.
      if (next && next !== url) setRenewed((prev) => ({ ...prev, [url]: next }));
      else setFailed((prev) => ({ ...prev, [url]: true }));
    });
  };

  return {
    src: (url) => (url ? (renewed[url] ?? url) : url),
    failed: (url) => Boolean(url && failed[url]),
    onError,
    renewed,
  };
}

/** useSignedLinks for one link: the element that shows `src`. A new `src` starts over with one retry of its own. */
export function useSignedSrc(src: Link): { src: Link; failed: boolean; onError: () => void } {
  const links = useSignedLinks();
  return { src: links.src(src), failed: links.failed(src), onError: () => links.onError(src) };
}

/**
 * useSignedLinks for <video> elements, which a renewed link starts over from
 * 0:0 and paused. Puts each one back at the second its old link failed and, if
 * the viewer had pressed play, plays (CodeRabbit on #706: they had to press play
 * twice, and a pack comparison playing in sequence would wait on that clip
 * forever). `element` returns the <video> showing a link; `onRefused` runs when
 * the browser refuses that play().
 */
export function useSignedVideos(
  element: (url: string) => HTMLVideoElement | null,
  onRefused?: (url: string) => void,
): {
  src: (url: Link) => Link;
  failed: (url: Link) => boolean;
  onError: (url: Link) => void;
  onPlay: (url: Link) => void;
  onPause: (url: Link, e?: PauseEvent) => void;
} {
  const links = useSignedLinks();
  const wantsPlay = useRef<Set<string>>(new Set());
  const resumeAt = useRef<Map<string, number>>(new Map());
  const resumed = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const url of Object.keys(links.renewed)) {
      if (resumed.current.has(url)) continue;
      resumed.current.add(url);
      const v = element(url);
      if (!v) continue;
      const at = resumeAt.current.get(url) ?? 0;
      if (at > 0) v.currentTime = at;
      if (wantsPlay.current.has(url)) v.play().catch(() => onRefused?.(url));
    }
    // `element` and `onRefused` are read when a renewal lands; a new function each render must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links.renewed]);

  return {
    src: links.src,
    failed: links.failed,
    onError: (url) => {
      if (url) resumeAt.current.set(url, element(url)?.currentTime ?? 0);
      links.onError(url);
    },
    onPlay: (url) => {
      if (url) wantsPlay.current.add(url);
    },
    // A pause the viewer chose ends the wish to play; the pause a failing link causes does not.
    onPause: (url, e) => {
      if (url && !e?.currentTarget?.error) wantsPlay.current.delete(url);
    },
  };
}

/** useSignedVideos for one <video>: the player that shows `src`. */
export function useSignedVideo(
  src: Link,
  element: () => HTMLVideoElement | null,
  onRefused?: () => void,
): {
  src: Link;
  failed: boolean;
  onError: () => void;
  onPlay: () => void;
  onPause: (e?: PauseEvent) => void;
} {
  const videos = useSignedVideos(() => element(), () => onRefused?.());
  return {
    src: videos.src(src),
    failed: videos.failed(src),
    onError: () => videos.onError(src),
    onPlay: () => videos.onPlay(src),
    onPause: (e) => videos.onPause(src, e),
  };
}

/** The plain line shown where media could not be loaded twice. */
export function MediaFailed({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label={MEDIA_FAILED_TEXT}
      className={className ?? "flex h-full w-full items-center justify-center px-3 text-center text-[11px] text-fg-dim"}
    >
      {MEDIA_FAILED_TEXT}
    </span>
  );
}

/**
 * A lazy <img> of a signed Library link that retries once with a fresh link.
 *
 * Only the element's own error event starts a retry. An expired link fails long
 * after hydration, when the handler is attached; probing `complete` on mount
 * instead would read a lazy image the browser has not fetched yet as broken in
 * some browsers, and mark every tile below the fold failed.
 */
export function SignedImg({
  src,
  alt,
  width,
  height,
  className,
  failedClassName,
  loading = "lazy",
}: {
  src: string;
  alt: string;
  width?: number | null;
  height?: number | null;
  className?: string;
  failedClassName?: string;
  /** "eager" for the one image a page is about (the asset page); tiles stay lazy. */
  loading?: "lazy" | "eager";
}) {
  const media = useSignedSrc(src);
  if (media.failed) return <MediaFailed className={failedClassName} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- signed R2 URL, deliberately short-lived; see the note in marketing-shared
    <img
      src={media.src ?? undefined}
      alt={alt}
      loading={loading}
      decoding="async"
      width={width ?? undefined}
      height={height ?? undefined}
      className={className}
      onError={media.onError}
    />
  );
}
