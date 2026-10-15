/**
 * GET /vsl[?cat=p1..p4&kw=&utm_*]
 *
 * The one short link ads, bios and emails point at. It goes to the "Start here"
 * router form when that form is live, and to the live AI audit (the form with the
 * inline founder calendar) until then, so ad traffic never lands on a 404 while
 * the four offer pages are still drafts.
 *
 * A TEMPORARY redirect on purpose. The old next.config.js rule was a 308: a
 * browser or crawler caches that for good, so the day the router is published
 * the cached visitors would still go to the audit. A 302 re-decides each time.
 *
 * The query string rides along untouched (utm_*, kw, cat, gclid), because
 * FormPublicClient reads attribution from window.location.search on mount.
 * The destination is one of two fixed internal paths, never request input, so
 * this cannot be an open redirect.
 *
 * Public in middleware.ts PUBLIC_PATH_PREFIXES: a route handler runs after
 * middleware, unlike a next.config.js redirect.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolvePublicForm } from "@/lib/forms/public-resolver";
import { AI_AUDIT_SLUG, AI_AUDIT_TENANT_SLUG } from "@/lib/forms/oasis-ai-audit-seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The router form's slug. Its definition is content/offers/oasis/vsl.json. Not
 * exported: a Next.js route module may export only its HTTP handlers and route
 * config, and `next build` rejects anything else.
 */
const VSL_ROUTER_SLUG = "vsl";

/** Longest query string carried across. A real ad URL is a few hundred bytes. */
const MAX_QUERY_LENGTH = 1500;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const search = req.nextUrl.search.length <= MAX_QUERY_LENGTH ? req.nextUrl.search : "";

  let routerLive = false;
  try {
    const found = await resolvePublicForm(getServiceSupabase(), AI_AUDIT_TENANT_SLUG, VSL_ROUTER_SLUG);
    routerLive = found.ok;
  } catch (err) {
    // A failed lookup means "use the audit", never an error page: the audit is
    // live and bookable, and a lead that lands there is a lead we keep.
    console.error("[vsl] router lookup failed, sending to the audit", err instanceof Error ? err.message : String(err));
  }

  const slug = routerLive ? VSL_ROUTER_SLUG : AI_AUDIT_SLUG;
  // A relative Location, not an absolute URL: behind OpenNext the request's own
  // origin is not guaranteed to be the public host, and the browser resolves a
  // relative one against the address it actually used.
  return new NextResponse(null, {
    status: 302,
    headers: { Location: `/f/${AI_AUDIT_TENANT_SLUG}/${slug}${search}`, "Cache-Control": "no-store" },
  });
}
