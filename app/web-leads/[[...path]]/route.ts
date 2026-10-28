/**
 * /web-leads and /web-leads/* - retired 2026-10-28 (Command Center refactor, phase 1).
 *
 * This was the Prospects list and its per-business battle card: the researched
 * prospect pool reps claimed leads from. Inbound-first sales (2026-07-09) and
 * cold sending switched off for every workspace (#724) left it unused, and CC
 * retired it. The researched rows stay in tenant_records untouched; the
 * Pipeline never showed them (app/pipeline/page.tsx starts at `assigned`).
 *
 * An optional catch-all, so the list, a lead's card (/web-leads/<id>) and the
 * old /web-leads/pipeline redirect all answer a real HTTP 404 before anything
 * renders (lib/os/retired-routes.ts says why not notFound()).
 *
 * Pinned by tests/client-route-gating.test.ts; tests/os-redirects.test.ts
 * fails if anything in app/, components/ or lib/ links here again.
 */
import { retiredRouteResponse } from "@/lib/os/retired-routes";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return retiredRouteResponse();
}
