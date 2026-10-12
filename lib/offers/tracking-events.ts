/**
 * lib/offers/tracking-events.ts - the funnel event vocabulary (V5a, HANDOVER
 * section 5). Zero dependencies, on purpose: this is the ONE module the
 * BROWSER side (lib/offers/tracking-client.ts, and transitively
 * FormPublicClient.tsx / VideoFacade.tsx) may import for the event names.
 *
 * Codex review, PR #598, 2026-10-12 [P1]. tracking-client.ts used to import
 * this vocabulary from lib/offers/tracking-store.ts, which imports
 * `node:crypto` and the Turso client (@libsql/client) -- pulling the whole
 * server data layer into the browser bundle and breaking bundling outright
 * (an esbuild check reproduced the failure on `node:crypto`). This module
 * holds ONLY the vocabulary: no `node:*` import, no `@libsql/client`, no
 * `server-only`. tests/tracking-client-browser-safe.test.ts scans
 * tracking-client.ts's own import graph and fails if anything it reaches
 * (directly or transitively) carries one of those.
 *
 * lib/offers/tracking-store.ts re-exports everything here so existing
 * server-side imports (the ingest route, /go/community, the submit route)
 * are unchanged.
 */

export const FUNNEL_EVENT_NAMES = [
  "page_view",
  "video_play",
  "video_progress",
  "path_selected",
  "step_viewed",
  "step_submitted",
  "community_click",
  "checkout_click",
  "booking_made",
] as const;

export type FunnelEventName = (typeof FUNNEL_EVENT_NAMES)[number];

export function isValidFunnelEvent(value: unknown): value is FunnelEventName {
  return typeof value === "string" && (FUNNEL_EVENT_NAMES as readonly string[]).includes(value);
}
