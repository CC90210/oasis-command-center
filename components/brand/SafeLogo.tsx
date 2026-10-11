"use client";

/**
 * SafeLogo - a workspace's logo that never draws a broken-image icon.
 *
 * A logo that does not load (deleted, moved, a host that is down) shows
 * `fallback` instead: nothing, or the brand's name, as the caller chooses.
 * Adon saw the broken-image glyph on the public offer page because the old
 * address answered 404 (lib/tenant/logo-url.ts); the address is fixed, and this
 * makes the NEXT failure, whatever it is, quiet instead of broken.
 *
 * The server markup is the same <img> each caller drew before (same attributes,
 * same order): tests/offer-pages-public.test.ts holds the public form's markup
 * byte for byte. An image that already failed before this component hydrated
 * fired its error event with no listener attached, so on mount a finished image
 * with no pixels is checked with decode(), which rejects for a broken image and
 * resolves for a good one (an SVG with no intrinsic size reports 0 width, so
 * width alone would hide a good logo).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

export function SafeLogo({
  src,
  alt,
  height,
  className,
  fallback = null,
}: {
  src: string | null | undefined;
  alt: string;
  height?: number;
  className?: string;
  fallback?: ReactNode;
}) {
  const ref = useRef<HTMLImageElement>(null);
  // The src that failed, not a flag: a new src gets a fresh try.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!src || !el || !el.complete || el.naturalWidth > 0) return;
    let live = true;
    el.decode().then(
      () => undefined,
      () => {
        if (live) setFailedSrc(src);
      },
    );
    return () => {
      live = false;
    };
  }, [src]);

  if (!src || failedSrc === src) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a workspace's own mark, from any host it chose
    <img ref={ref} src={src} alt={alt} height={height} className={className} onError={() => setFailedSrc(src)} />
  );
}
