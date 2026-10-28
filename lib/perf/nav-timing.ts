/**
 * lib/perf/nav-timing.ts - what a click feels like, measured in the browser (2026-10-28).
 *
 * Server logs (`[perf]` lines) show how long a render took on the Worker, not
 * how long the person waited. These three first-party metrics close that gap,
 * beaconed to /api/perf/vitals beside the web vitals:
 *   - OASIS-nav-commit: a link click to the new route being on screen (its
 *     loading skeleton or its content);
 *   - OASIS-board-soft: a link click to the board being drawn;
 *   - OASIS-board-full: a full page load (navigation start) to the board being
 *     drawn.
 *
 * Browser-only: every function here runs from an event handler or an effect.
 * The state below is one browser tab's, never a request's. Same payload rules
 * as the web-vitals beacon: metric name, value and pathname only (no query
 * string, no identity), and every path is fail-open.
 */

export const VITALS_ENDPOINT = "/api/perf/vitals";
/** A click this old is not the cause of what is on screen now. */
const CLICK_WINDOW_MS = 60_000;

export function sendVital(name: string, value: number, rating: string | null, path: string): void {
  try {
    const body = JSON.stringify({
      name,
      value: Math.round(value * 1000) / 1000,
      rating,
      // pathname only — location.search is deliberately excluded.
      path: path.slice(0, 100),
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(VITALS_ENDPOINT, body);
    } else {
      fetch(VITALS_ENDPOINT, {
        method: "POST",
        body,
        keepalive: true,
        headers: { "content-type": "application/json" },
      }).catch(() => {});
    }
  } catch {
    // fail-open
  }
}

/** The last plain same-origin link click that leaves the current route. */
type Click = { at: number; path: string; committed: boolean; boardReported: boolean };
let lastClick: Click | null = null;
let fullBoardReported = false;

/** Capture-phase document click listener (installed by components/PerfVitals.tsx). */
export function recordLinkClick(event: MouseEvent): void {
  try {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target as Element | null;
    const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href, window.location.href);
    // Same route, other search params: the page swaps in place, nothing to time here.
    if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
    lastClick = { at: performance.now(), path: url.pathname, committed: false, boardReported: false };
  } catch {
    // fail-open
  }
}

function recentClickTo(path: string): Click | null {
  const click = lastClick;
  if (!click || click.path !== path) return null;
  return performance.now() - click.at <= CLICK_WINDOW_MS ? click : null;
}

/** The route on screen changed to `pathname`: report click → commit once per click. */
export function reportRouteCommit(pathname: string | null): void {
  try {
    const click = pathname ? recentClickTo(pathname) : null;
    if (!pathname || !click || click.committed) return;
    click.committed = true;
    sendVital("OASIS-nav-commit", performance.now() - click.at, null, pathname);
  } catch {
    // fail-open
  }
}

/**
 * The board calls this once on mount. After a click it reports click → board;
 * on a fresh page load (nobody has clicked a link yet) it reports navigation
 * start → board. At most once per click, and once per document.
 */
export function reportBoardVisible(): void {
  try {
    const path = window.location.pathname;
    const click = recentClickTo(path);
    if (click) {
      if (click.boardReported) return;
      click.boardReported = true;
      sendVital("OASIS-board-soft", performance.now() - click.at, null, path);
      return;
    }
    if (lastClick === null && !fullBoardReported) {
      fullBoardReported = true;
      sendVital("OASIS-board-full", performance.now(), null, path);
    }
  } catch {
    // fail-open
  }
}
