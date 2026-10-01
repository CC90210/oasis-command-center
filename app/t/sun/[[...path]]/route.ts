/**
 * /t/sun and /t/sun/* - retired 2026-10-01 (OASIS OS plan, track W0).
 *
 * The SunBiz workspace shell (audit U1-22). SunBiz was retired on 2026-09-28;
 * W0 deleted its in-code seed (lib/manifest/seeds.ts SUN_SEED), so
 * manifestExists("sun") is false and app/t/[slug] would answer notFound() for
 * it. But a page calling notFound() draws the not-found screen with HTTP 200
 * (the root loading.tsx streams the shell first; lib/os/retired-routes.ts says
 * why), and a monitor or crawler reads 200 as "this page exists". This static
 * segment wins over [slug], and a route handler answers before anything
 * renders, so /t/sun/<anything> is a real 404 like /applications or /lenders.
 * The missing seed stays as the second line of defence; "sun" stays in
 * PROTECTED_SLUGS so no tenant can write a manifest row under it.
 *
 * Pinned by tests/client-route-gating.test.ts next to the other retired
 * folders; tests/os-redirects.test.ts already treats every /t/sun link as dead.
 */
import { retiredRouteResponse } from "@/lib/os/retired-routes";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return retiredRouteResponse();
}
