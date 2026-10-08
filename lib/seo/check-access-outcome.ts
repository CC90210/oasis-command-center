import type { AccessResult } from "./types";

/**
 * What a check-access POST means for the add-a-site screen's Phase, isolated from fetch/React so
 * it is unit-testable directly. A 400 (e.g. no_domain, actor_required) carries the route's own
 * message, the same as the add path already does; only 0/5xx/unknown fall back to the generic
 * "did not answer" DOWN banner (M2, 2026-10-07). Lives in lib/seo/ rather than components/seo/ so
 * tests can import it without pulling in next/link (the component's "use client" neighbour).
 */
export function checkAccessOutcome(r: { status: number; json: Record<string, unknown> | null }):
  | { kind: "ok"; result: AccessResult }
  | { kind: "gone" }
  | { kind: "bad_request"; message: string }
  | { kind: "down" } {
  const result = r.json as AccessResult | null;
  if (r.status === 200 && result?.result) return { kind: "ok", result };
  if (r.status === 404) return { kind: "gone" };
  if (r.status === 400) return { kind: "bad_request", message: String(r.json?.error ?? "Check failed. Try again.") };
  return { kind: "down" };
}
