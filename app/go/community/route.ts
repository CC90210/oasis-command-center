/**
 * GET /go/community?form=<slug>&t=<tenant slug>&step=<n>&v=<visit id>
 *
 * The "save basin" redirect (HANDOVER section 1.3 / 5.4): where any offer
 * page's "Not ready? Join the free community" link goes. Public, no
 * session — a visitor who has not given any details may never have an
 * account, so this must be reachable the same way /f/ and /api/forms/submit
 * are (middleware.ts PUBLIC_PATH_PREFIXES).
 *
 * NEVER AN OPEN REDIRECT. The destination comes ONLY from
 * lib/offers/community-link.ts, which reads server config — ?form and ?t are
 * used to resolve WHICH workspace/offer is routing someone here (so the click
 * can be recorded against the right tenant_id/form_id and, if the visit
 * already has a lead, the save_basin interaction lands on the right record),
 * never to pick the target URL itself.
 *
 * form/t resolve through the exact same resolvePublicForm the submit route
 * and the ingest beacon use, which also requires the form to be `enabled` —
 * an unknown tenant, unknown form, or disabled form all collapse to the same
 * 404 a visitor following a stale/bad link would get anyway.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolvePublicForm } from "@/lib/forms/public-resolver";
import { communityUrlForTenant } from "@/lib/offers/community-link";
import { recordSaveBasinEnrolled } from "@/lib/offers/save-basin";
import {
  offerPagesDb,
  insertFunnelEvent,
  findLeadForVisit,
  isValidVisitId,
  sanitizeStepIndex,
} from "@/lib/offers/tracking-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = () => new NextResponse("Not found", { status: 404 });

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Top-level catch: a redirect must never fire from an uncertain state. If
  // anything below throws (a DB error mid-resolve, say), refusing with 404 is
  // the fail-closed answer — never an uncaught 500, and never a guess at the
  // destination.
  try {
    const sp = req.nextUrl.searchParams;
    const formSlug = sp.get("form") || "";
    const tenantSlug = sp.get("t") || "";
    if (!formSlug || !tenantSlug) return NOT_FOUND();

    const resolved = await resolvePublicForm(getServiceSupabase(), tenantSlug, formSlug);
    if (!resolved.ok) return NOT_FOUND();

    // Resolved from server config, by tenant_id — never from the query string.
    const destination = communityUrlForTenant(resolved.tenant_id);
    if (!destination) return NOT_FOUND();

    const rawVisit = sp.get("v");
    const visitId = isValidVisitId(rawVisit) ? rawVisit : null;
    const stepIndex = sanitizeStepIndex(sp.get("step"));

    // Tracking is best-effort: every helper below swallows its own errors
    // (lib/offers/tracking-store.ts, lib/offers/save-basin.ts), so nothing
    // here can turn into a failed redirect for the visitor.
    if (visitId) {
      const db = offerPagesDb();
      if (db) {
        await insertFunnelEvent(db, {
          tenantId: resolved.tenant_id,
          formId: resolved.form.id,
          visitId,
          event: "community_click",
          stepIndex,
        });
        const leadId = await findLeadForVisit(db, resolved.tenant_id, visitId);
        if (leadId) {
          await recordSaveBasinEnrolled(getServiceSupabase(), {
            tenantId: resolved.tenant_id,
            leadId,
            formId: resolved.form.id,
            visitId,
            stepIndex,
          });
        }
      }
    }

    return NextResponse.redirect(destination, 302);
  } catch (err) {
    console.error("/go/community crashed:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    return NOT_FOUND();
  }
}
