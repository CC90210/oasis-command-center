"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps the Feed current without a websocket: the server component re-renders
 * on router.refresh(), so this island holds no data of its own.
 *
 * Every 30 s, and only while the tab is visible. The old tape refreshed every
 * 5 s whether anyone was looking or not, and each refresh re-runs the whole
 * shell's session reads — a background tab cost a server render every five
 * seconds for nobody. A hidden tab now catches up the moment it is shown.
 *
 * No spinner: a looping animation for a sub-second refresh is motion without
 * information. The button's label says what is happening.
 */
const INTERVAL_MS = 30_000;

export function FeedRefresher() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    };
    const id = window.setInterval(refresh, INTERVAL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);

  return (
    <button
      type="button"
      onClick={() => startTransition(() => router.refresh())}
      disabled={pending}
      className="btn-secondary"
      aria-live="polite"
    >
      {pending ? "Refreshing…" : "Refresh"}
    </button>
  );
}
