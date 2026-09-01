/**
 * GET /api/web-leads/[id]/battlecard
 *
 * Everything the full-screen battle card needs, in ONE request: the lead, its
 * audit, where it sits against real competitors in its own industry and city,
 * and the raw signals behind the score.
 *
 * WHY ONE REQUEST AND NOT FOUR. This page exists to be read while a rep is on
 * the phone. Four endpoints means four independent loading states resolving in
 * an order nobody controls, so the score arrives before the percentile that
 * explains it and the competitor list lands last -- the card visibly assembles
 * itself under the rep mid-sentence. It also means four chances for one of them
 * to fail and leave a card that looks complete and is not.
 *
 * Auth mirrors app/api/web-leads/[id]/audit/route.ts EXACTLY, and for the same
 * reasons: libSQL has no row-level security, so this route is the authorization
 * boundary rather than a convenience. An unresolved caller gets a 401, never
 * the record. A caller resolved to a DIFFERENT tenant gets a 403 -- resolving a
 * session and never reading its tenantId is precisely how the sibling routes
 * leaked every Web Studio lead to any authenticated user of any tenant. Both
 * checks happen BEFORE any read.
 *
 * A tenant check alone is NOT sufficient: `agent` is the commission-only
 * outside-contractor role added for website sales and it lives INSIDE this
 * tenant (#237, 26ecc31a). fetchLead() applies the identical role scoping and
 * returns null for a lead outside the viewer's scope exactly as it does for one
 * that does not exist, so this route answers 404 -- never 403 -- for an id a
 * scoped contractor may not see, and ids cannot be probed.
 *
 * THE COMPETITOR PANEL IS NOT A SECOND DOOR ONTO OTHER REPS' LEADS. It returns
 * a business name, city, province, public website URL and OUR measured score,
 * and deliberately no lead id, phone, address, owner, stage or claim state.
 * Nothing about who holds which lead crosses this boundary; see the rule-3
 * comment in lib/web-leads/competitors.ts.
 *
 * COMPETITOR DATA IS ONLY EVER ATTACHED TO A `scored` AUDIT. A lead whose site
 * we could not reach has no number, so it cannot have a percentile, a rank or a
 * head-to-head -- and manufacturing one by treating "we could not check it" as
 * a zero would put a rep in front of a prospect claiming they are the worst
 * salon in their city on the strength of a failed crawl. The three non-scored
 * states carry `competitors: null` and the card renders a sentence.
 */

import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { fetchLead, WEBDEV_TENANT_ID, type Viewer } from "@/lib/web-leads/data";
import { fetchAudit, fetchAuditSignals, businessIdForLead } from "@/lib/web-leads/audit";
import { fetchCompetitorContext } from "@/lib/web-leads/competitors";
import { getOasisSalesRepRoster } from "@/lib/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  }
  // Resolving a caller and then not constraining them to a tenant is the same
  // class of bug as an auth check that can never fire.
  if (session.tenantId !== WEBDEV_TENANT_ID) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;

  try {
    // A manager's team read is an assigned-only roster boundary, not an admin
    // impersonation. Resolve it independently at this API door so a browser
    // cannot forge ids that were trusted by the server-rendered lead page.
    const readableAssigneeIds =
      session.teamRole.trim().toLowerCase() === "manager"
        ? (await getOasisSalesRepRoster(session.tenantId)).flatMap((member) =>
            member.auth_user_id ? [member.auth_user_id] : [],
          )
        : undefined;
    const viewer: Viewer = {
      userId: session.userId,
      teamRole: session.teamRole,
      isAdmin: session.isAdmin,
      readableAssigneeIds,
    };
    // Authorization happens exactly once, here, and the resolved lead is passed
    // through to fetchAudit rather than re-fetched inside it.
    const lead = await fetchLead(id, viewer);
    if (!lead) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

    const audit = await fetchAudit(id, lead);
    if (audit.state !== "scored") {
      return NextResponse.json({ lead, audit, competitors: null, signals: null });
    }

    const businessId = await businessIdForLead(id);
    // A scored audit implies a business id -- fetchAudit cannot reach `scored`
    // without one. Handled rather than asserted: an assertion that can never
    // fire is not a guard, and a 500 here would blank a card that has a
    // perfectly good score on it.
    if (!businessId) {
      return NextResponse.json({ lead, audit, competitors: null, signals: null });
    }

    const [competitors, signals] = await Promise.all([
      fetchCompetitorContext({
        businessId,
        industry: lead.industry,
        city: lead.city,
        province: lead.province,
        score: audit.composite,
        dimensions: audit.dimensions,
      }),
      fetchAuditSignals(businessId),
    ]);

    return NextResponse.json({ lead, audit, competitors, signals });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "battlecard_failed" },
      { status: 500 },
    );
  }
}
