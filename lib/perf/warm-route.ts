/**
 * lib/perf/warm-route.ts - warm a route on intent without rendering its data (2026-10-28).
 *
 * router.prefetch(href) with no kind is a FULL prefetch whenever the client
 * segment cache is off, which it is here
 * (node_modules/next/dist/client/components/app-router-instance.js, the
 * `PrefetchKind.FULL` default). A FULL prefetch renders the whole page, data
 * included, on every hover, and the router keeps that render for five minutes:
 * a click inside that window shows the page as it was when the pointer passed
 * over it. next.config.js refuses a client router cache for exactly that reason
 * ("wrong data is worse than a slow tab").
 *
 * An AUTO prefetch renders only down to the route's loading.tsx, so the click
 * paints the skeleton at once and the data it then fetches is fresh. A route
 * with no loading.tsx gets its route tree only, with no render at all
 * (next/dist/server/app-render/walk-tree-with-flight-router-state.js).
 *
 * PrefetchKind is not part of Next's public exports, so it is imported from its
 * internal path here and nowhere else (tests/perf-nav-warm.test.ts pins both).
 */
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";

type PrefetchingRouter = { prefetch: (href: string, options?: { kind: PrefetchKind }) => void };

export function warmRoute(router: PrefetchingRouter, href: string): void {
  try {
    router.prefetch(href, { kind: PrefetchKind.AUTO });
  } catch {
    // Prefetch is best-effort; it must never break a click.
  }
}
