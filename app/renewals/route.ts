/**
 * /renewals - retired 2026-09-30 (OASIS OS plan, track T1).
 *
 * It was the SunBiz renewal queue over funded_deals. Before retiring it, a
 * static scan of every literal href in app/, components/ and lib/ found no
 * live link to it: only the retired SunBiz dashboard, the unused SUN_NAV
 * array and the retired Funded Deals placeholder pointed here.
 *
 * SunBiz was retired on 2026-09-28 and these legacy pages were still reachable
 * by URL from every workspace, OASIS's clients included. This route answers
 * HTTP 404 before anything renders. It was a page calling notFound(), which
 * drew the not-found screen with a 200 status (lib/os/retired-routes.ts says
 * why). A signed-out visitor meets the login page first (the path is not
 * public), a signed-in one the 404.
 *
 * Pinned by tests/client-route-gating.test.ts; tests/os-redirects.test.ts
 * fails if anything in app/, components/ or lib/ links here again.
 */
import { retiredRouteResponse } from "@/lib/os/retired-routes";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return retiredRouteResponse();
}
