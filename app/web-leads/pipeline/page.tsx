import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /web-leads/pipeline — retired as a standalone destination (2026-08-23
 * revamp). The operator said, verbatim, "Not a separate pipeline page":
 * Pipeline is now an in-page view inside /web-leads, reached through a
 * segmented control and carried in the URL as `?view=pipeline`
 * (lib/web-leads/filters.ts), the same way every other filter on that page
 * already works. The WEBDEV_NAV sidebar entry for this route is gone
 * (lib/nav-config.ts) -- but the route itself stays alive, purely as a
 * redirect, so no bookmark or shared link built against the old URL 404s.
 * Every search param this route received (rep, lead, ...) is forwarded
 * along with the new view param, so a deep link like
 * `/web-leads/pipeline?rep=<id>` still lands on the right slice of the board.
 */
export default async function WebLeadsPipelineRedirect({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) || {};
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") sp.set(key, value);
    else if (Array.isArray(value) && value.length > 0) sp.set(key, value[0]);
  }
  sp.set("view", "pipeline");
  redirect(`/web-leads?${sp.toString()}`);
}
