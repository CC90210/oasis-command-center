"use client";

/**
 * components/os/LinkPending.tsx - a link says it was heard the moment it is clicked (2026-10-28).
 *
 * A link that keeps its route and changes only the search (a stage chip, Next, a queue tab) shows no
 * loading.tsx: the router keeps the current page on screen inside a transition until the new one has
 * rendered, so a slow render looked like a click that did nothing. These read next/link's own pending
 * state (useLinkStatus) and must sit INSIDE the <Link> they describe. The 100 ms delay keeps a fast
 * navigation from flashing.
 */
import { useLinkStatus } from "next/link";

/** A small dot beside the link's text, shown while its navigation is in flight. */
export function LinkPending({ className = "" }: { className?: string }) {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-current transition-opacity duration-150 ${
        pending ? "opacity-70 delay-100" : "opacity-0"
      } ${className}`}
    />
  );
}

/** A bar down the left edge of a stretched row link (one positioned `absolute inset-0`), while it opens. */
export function LinkPendingBar() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-accent transition-opacity duration-150 ${
        pending ? "opacity-100 delay-100" : "opacity-0"
      }`}
    />
  );
}
