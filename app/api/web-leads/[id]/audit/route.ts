/**
 * GET /api/web-leads/[id]/audit
 *
 * The lead detail panel's website-score data: one of `no_website`,
 * `unreachable`, `not_scored`, or `scored` (see lib/web-leads/audit.ts for the
 * ordering and why it matters -- `unreachable` is checked before `not_scored`
 * so a known failure to reach a site is never reported as "not tried", and a
 * site we could not reach is NEVER given a score).
 *
 * Auth mirrors app/api/web-leads/[id]/route.ts EXACTLY: libSQL has no
 * row-level security, so this route is the authorization boundary, not a
 * convenience. An unresolved caller gets a 401, never the record. A caller
 * resolved to a DIFFERENT tenant gets a 403 -- resolving a session and never
 * checking its tenantId would let any authenticated user of any tenant read a
 * Web Studio lead's audit by id. Both checks happen BEFORE any read.
 *
 * A tenant check alone is NOT sufficient: `agent` is the commission-only
 * outside-contractor role added for website sales, and it lives INSIDE this
 * tenant -- #237 (26ecc31a) hardened the manifest records route for this exact
 * reason. fetchAudit() applies the identical role scoping (via fetchLead, see
 * isScopedContractor in lib/web-leads/data.ts) and its underlying fetchLead
 * call returns null for a lead outside the viewer's scope exactly as it does
 * for one that doesn't exist at all -- so this route answers 404, never 403,
 * for an id a scoped contractor may not see, and ids cannot be probed.
 */

import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { fetchLead, WEBDEV_TENANT_ID } from "@/lib/web-leads/data";
import { fetchAudit } from "@/lib/web-leads/audit";
import { resolveWebLeadViewer } from "@/lib/web-leads/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  }
  // Resolving a caller and then not constraining them to a tenant is the same
  // class of bug as an auth check that can never fire. libSQL has no
  // row-level security, so this is the ONLY thing standing between a SunBiz
  // rep's normal login and any Web Studio lead's audit data.
  if (session.tenantId !== WEBDEV_TENANT_ID) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  try {
    const viewer = await resolveWebLeadViewer(session);
    // Same existence-and-visibility check the sibling [id]/route.ts uses,
    // so an id outside this viewer's scope 404s here too instead of leaking
    // through to a state the audit lookup alone couldn't have distinguished.
    // The resolved lead is then handed to fetchAudit() directly rather than
    // re-fetched there, so authorization happens exactly once per request.
    const lead = await fetchLead(id, viewer);
    if (!lead) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

    const audit = await fetchAudit(id, lead);
    return NextResponse.json(audit);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "audit_failed" },
      { status: 500 },
    );
  }
}
