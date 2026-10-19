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
 */
import { useRef, useState } from "react";

export const MEDIA_FAILED_TEXT = "Couldn't load this. Reload the page.";
export const RESIGN_ROUTE = "/api/founders/marketing/media/resign";

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
 * The link to render for `src`, the handler for the element's error event, and
 * whether it has given up. A new `src` (the next carousel slide, a re-render
 * with a fresh page) starts over with one retry of its own.
 */
export function useSignedSrc(src: string | null | undefined): {
  src: string | null | undefined;
  failed: boolean;
  onError: () => void;
} {
  const [fresh, setFresh] = useState<{ from: string; to: string } | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const retried = useRef<string | null>(null);

  // A plain function, not useCallback: nothing compares it, and the Library's render tests drive these components
  // with a dispatcher that knows only useState, useRef, useEffect and useContext (tests/library-phone-preview.render.ts).
  const onError = () => {
    if (!src) return;
    // The fresh link failed as well: stop, and say so.
    if (retried.current === src) {
      setFailedFor(src);
      return;
    }
    retried.current = src;
    void resignMediaUrl(src).then((next) => {
      // The same link back means the object, not the signature, is the problem: a retry would fail the same way.
      if (next && next !== src) setFresh({ from: src, to: next });
      else setFailedFor(src);
    });
  };

  return {
    src: fresh && fresh.from === src ? fresh.to : src,
    failed: Boolean(src) && failedFor === src,
    onError,
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
}: {
  src: string;
  alt: string;
  width?: number | null;
  height?: number | null;
  className?: string;
  failedClassName?: string;
}) {
  const media = useSignedSrc(src);
  if (media.failed) return <MediaFailed className={failedClassName} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- signed R2 URL, deliberately short-lived; see the note in marketing-shared
    <img
      src={media.src ?? undefined}
      alt={alt}
      loading="lazy"
      decoding="async"
      width={width ?? undefined}
      height={height ?? undefined}
      className={className}
      onError={media.onError}
    />
  );
}
