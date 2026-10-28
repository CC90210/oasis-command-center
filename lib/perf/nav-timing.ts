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
 *     drawn, only when the board is part of that first document;
 *   - OASIS-board-query: a click that keeps the route and changes its search
 *     (a stage chip, a page of results) to the board showing that search.
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

/**
 * The last plain same-origin link click that left the route it was made on.
 * `from` is that route: the click is credited to whatever route comes next,
 * not to its href, because a server redirect can land somewhere else
 * (/pipeline sends a non-OASIS workspace to /t/<slug>/leads).
 */
type Click = { at: number; from: string; committed: boolean; boardReported: boolean };
let lastClick: Click | null = null;
/**
 * The last plain link click that stayed on its route and changed only the
 * search (a stage chip, Next, a queue tab). The board credits it once it is
 * drawn for exactly that URL; a redirect to another search is never credited.
 */
type QueryClick = { at: number; path: string; search: string; reported: boolean };
let lastQueryClick: QueryClick | null = null;
/** True once any client-side route change has happened in this tab (a click or a router.push). */
let routeChanged = false;
let lastSeenPath: string | null = null;
let fullBoardReported = false;

/** Forget this tab's state. For tests: each scenario starts as a fresh page would. */
export function resetNavTiming(): void {
  lastClick = null;
  lastQueryClick = null;
  routeChanged = false;
  lastSeenPath = null;
  fullBoardReported = false;
}

/** The pathname of the document this tab loaded, from the browser's own navigation record. */
function documentPath(): string | null {
  try {
    const entry = performance.getEntriesByType?.("navigation")?.[0] as PerformanceEntry | undefined;
    return entry ? new URL(entry.name).pathname : null;
  } catch {
    return null;
  }
}

/** Capture-phase document click listener (installed by components/PerfVitals.tsx). */
export function recordLinkClick(event: MouseEvent): void {
  try {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target as Element | null;
    const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    if (url.pathname === window.location.pathname) {
      // Same route, other search params: the page swaps in place, and the
      // board times it when it is drawn for that search (reportBoardVisible).
      if (url.search === window.location.search) return;
      lastQueryClick = { at: performance.now(), path: url.pathname, search: url.search, reported: false };
      return;
    }
    lastClick = { at: performance.now(), from: window.location.pathname, committed: false, boardReported: false };
    // A click to another route supersedes a same-route click still in flight:
    // if that board is ever drawn later, the time in between is not its wait.
    lastQueryClick = null;
  } catch {
    // fail-open
  }
}

/** The recent click that led to `path`, if this route is where it went. */
function clickLeadingTo(path: string): Click | null {
  const click = lastClick;
  if (!click || click.from === path) return null;
  return performance.now() - click.at <= CLICK_WINDOW_MS ? click : null;
}

/** The route on screen is now `pathname`: notes the change, and reports click → commit once per click. */
export function reportRouteCommit(pathname: string | null): void {
  try {
    if (!pathname) return;
    if (lastSeenPath !== null && pathname !== lastSeenPath) {
      routeChanged = true;
      // Left the route (a click, Back, a router.push): a same-route click made
      // there is abandoned and must never be credited to a later return.
      lastQueryClick = null;
    }
    lastSeenPath = pathname;
    const click = clickLeadingTo(pathname);
    if (!click || click.committed) return;
    click.committed = true;
    routeChanged = true;
    sendVital("OASIS-nav-commit", performance.now() - click.at, null, pathname);
  } catch {
    // fail-open
  }
}

/**
 * The board calls this when it is drawn: on mount, and again whenever it shows
 * another stage, search or page. After a same-route click it reports click →
 * board for that search (OASIS-board-query). After a click it reports click → board.
 * For the board that came with the first document (no route change yet, and
 * the URL is still the one the browser loaded) it reports navigation start →
 * board. A board reached any other way (a router.push with no click, a route
 * change back to the first page) has no honest start time, so it reports
 * nothing rather than the whole age of the tab.
 */
export function reportBoardVisible(): void {
  try {
    const path = window.location.pathname;
    const query = lastQueryClick;
    if (
      query &&
      !query.reported &&
      query.path === path &&
      query.search === window.location.search &&
      performance.now() - query.at <= CLICK_WINDOW_MS
    ) {
      query.reported = true;
      sendVital("OASIS-board-query", performance.now() - query.at, null, path);
      return;
    }
    const click = clickLeadingTo(path);
    if (click) {
      if (click.boardReported) return;
      click.boardReported = true;
      sendVital("OASIS-board-soft", performance.now() - click.at, null, path);
      return;
    }
    if (fullBoardReported || routeChanged || lastClick !== null) return;
    const first = documentPath();
    if (first === null || first !== path) return;
    fullBoardReported = true;
    sendVital("OASIS-board-full", performance.now(), null, path);
  } catch {
    // fail-open
  }
}
