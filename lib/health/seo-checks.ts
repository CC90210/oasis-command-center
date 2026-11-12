/**
 * lib/health/seo-checks.ts — can the Search (SEO) screen still read the measurement service?
 *
 * WHY. The SEO screen's banner used to say "The health monitor pages if this lasts" while no
 * check watched it. The screen reads a separate Worker (oasis-seo-measure) through a service
 * binding and two keys; any of the three can go missing on a deploy or a secrets push, and the only
 * way CC found out was opening the tab. This check makes the list call the screen makes, once per
 * run, and names the reason (the same codes the banner explains) when it fails.
 *
 * Estate-wide: the screen is CC's, not a tenant's. Outside the production Worker (local dev, CI)
 * there is no binding by design, so the check reports 0 rather than a standing false alarm.
 */

import "server-only";
import { SeoUnavailable } from "@/lib/seo/client";
import { seoClient } from "@/lib/seo/occ";
import type { DripCheck } from "./drip-checks";
import { isProductionRuntime } from "./runtime-environment";

export const SEO_CHECK_ID = "seo.measurement_service_readable";

async function observeSeo(): Promise<{ observed: number | null; reason: string }> {
  if (!isProductionRuntime()) return { observed: 0, reason: "not production; the SEO binding exists only in the Worker" };
  try {
    const client = await seoClient();
    const list = await client.listSites({ includeTest: true });
    return { observed: 0, reason: `the measurement service listed ${list.sites.length} site(s)` };
  } catch (err) {
    if (err instanceof SeoUnavailable) return { observed: 1, reason: `seo_unavailable: ${err.reason}` };
    const message = err instanceof Error ? err.message : String(err);
    return { observed: 1, reason: `seo_error: ${message.slice(0, 160)}` };
  }
}

/**
 * No audience here: lib/health/runner.ts gives it OASIS's operator chat where it registers it
 * (tests/workspace-alerts.test.ts keeps the files that name a lane to a list that only shrinks).
 */
export const SEO_CHECKS: Array<Omit<DripCheck, "lane">> = [
  {
    id: SEO_CHECK_ID,
    severity: "high",
    rule: { kind: "must_be_zero" },
    observe: async () => (await observeSeo()).observed,
    observeDetailed: async () => observeSeo(),
    describe: (r) =>
      r.observed === 0
        ? "the Search (SEO) screen can read the measurement service."
        : "the Search (SEO) screen cannot read the measurement service (oasis-seo-measure). The `reason` column of health_check_runs names the code: binding_missing (wrangler.jsonc services), read_key_missing / manage_key_missing (Worker secrets), 401/403 (the keys do not match the service's), timeout or unreachable (the service itself). The screen's banner says the same words.",
  },
];
