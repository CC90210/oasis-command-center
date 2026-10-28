/**
 * lib/perf/nav-kind.ts - how a request was asked for, decided where it can still be seen.
 *
 * Next sends RSC: 1 on a client navigation's server fetch and
 * Next-Router-Prefetch: 1 on a prefetch, but it strips both (its flight
 * headers) from what headers() returns to a page or layout (Codex review,
 * 2026-10-28). Middleware still sees the raw request, so it decides the kind
 * there and forwards it under NAV_KIND_HEADER; lib/perf/server-timing.ts
 * navKindOf() reads that header back.
 *
 * Pure and edge-safe: middleware imports it.
 */

export type NavKind = "doc" | "rsc" | "prefetch";

/** Set by middleware.ts on every request it forwards. */
export const NAV_KIND_HEADER = "x-oasis-nav";

const NAV_KINDS: ReadonlySet<string> = new Set(["doc", "rsc", "prefetch"]);

export function isNavKind(value: unknown): value is NavKind {
  return typeof value === "string" && NAV_KINDS.has(value);
}

/**
 * The kind, from the RAW request headers (middleware):
 *   - "prefetch": a router prefetch that stops at the loading boundary;
 *   - "rsc": a client navigation's RSC fetch, or a FULL prefetch (it carries
 *     RSC: 1 but no prefetch header);
 *   - "doc": a full document load (typed URL, reload, first visit).
 */
export function navKindFromRequestHeaders(h: { get(name: string): string | null }): NavKind {
  try {
    if (h.get("next-router-prefetch") === "1") return "prefetch";
    return h.get("rsc") === "1" ? "rsc" : "doc";
  } catch {
    return "doc";
  }
}
