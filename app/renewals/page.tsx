import { notFound } from "next/navigation";

/**
 * /renewals - retired 2026-09-30 (OASIS OS plan, track T1).
 *
 * It was the SunBiz renewal queue over funded_deals. Before retiring it, a static scan of every literal href in app/, components/ and lib/ found no live link to it: only the retired SunBiz dashboard, the unused SUN_NAV array and the retired Funded Deals placeholder pointed here.
 *
 * SunBiz was retired on 2026-09-28 and these legacy pages were still reachable
 * by URL from every workspace, OASIS's clients included. The page now calls
 * notFound(), the same mechanism #479 used for /start, /configure and
 * /demo/sun. A signed-out visitor meets the login page first (the path is not
 * public), a signed-in one the 404.
 *
 * Pinned by tests/client-route-gating.test.ts; tests/os-redirects.test.ts
 * fails if anything in app/, components/ or lib/ links here again.
 */
export default function RetiredRenewalsPage(): never {
  notFound();
}
