/**
 * /commissions - retired 2026-10-28 (Command Center refactor, phase 1).
 *
 * This was the website-sales commission portal: each rep's ledger lines, and
 * the approve / mark-paid / void controls. CC retired it with the Prospects
 * surface. On the day it retired, neither OASIS workspace held a single
 * commission row or website deal, so no payout was stranded. The table and the
 * Today tiles that read it (lib/website-sales-commission-summary.ts) stay.
 *
 * This route answers HTTP 404 before anything renders
 * (lib/os/retired-routes.ts says why not notFound()).
 *
 * Pinned by tests/client-route-gating.test.ts; tests/os-redirects.test.ts
 * fails if anything in app/, components/ or lib/ links here again.
 */
import { retiredRouteResponse } from "@/lib/os/retired-routes";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return retiredRouteResponse();
}
