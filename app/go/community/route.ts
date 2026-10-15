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
import {
  AI_AUDIT_SLUG,
  AI_AUDIT_TENANT_ID,
  AI_AUDIT_TENANT_SLUG,
} from "@/lib/forms/oasis-ai-audit-seed";
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
    // A bare /go/community is what ads, emails and bios link to. With no
    // ?form/?t it belongs to OASIS's own audit funnel instead of a 404, so
    // the free lounge is never a dead link. Defaults are OASIS's own constants,
    // not request input, and the destination below still comes from server
    // config only.
    const bare = !sp.get("form") && !sp.get("t");
    const formSlug = bare ? AI_AUDIT_SLUG : sp.get("form") || "";
    const tenantSlug = bare ? AI_AUDIT_TENANT_SLUG : sp.get("t") || "";
    if (!formSlug || !tenantSlug) return NOT_FOUND();

    const resolved = await resolvePublicForm(getServiceSupabase(), tenantSlug, formSlug);
    if (!resolved.ok) {
      // A bare link must still reach the lounge even if the audit form is
      // switched off; only the click log is lost. An explicit ?form/?t that
      // does not resolve stays a 404 (a stale link to someone else's offer).
      const fallback = bare ? communityUrlForTenant(AI_AUDIT_TENANT_ID) : null;
      return fallback ? NextResponse.redirect(fallback, 302) : NOT_FOUND();
    }

    // Resolved from server config, by tenant_id — never from the query string.
    const destination = communityUrlForTenant(resolved.tenant_id);
    if (!destination) return NOT_FOUND();

    const rawVisit = sp.get("v");
    // No visit id (an email or ad link opened outside a tracked page) still
    // counts: a one-off server-made id keeps the click without any IP, cookie
    // or fingerprint. It matches no lead, so no save_basin row is written.
    const visitId = isValidVisitId(rawVisit) ? rawVisit : crypto.randomUUID();
    const stepIndex = sanitizeStepIndex(sp.get("step"));
    const rawFrom = sp.get("from") || "";
    const from = /^[a-z0-9_-]{1,40}$/.test(rawFrom) ? rawFrom : bare ? "direct" : null;

    // Tracking is best-effort: every helper below swallows its own errors
    // (lib/offers/tracking-store.ts, lib/offers/save-basin.ts), so nothing
    // here can turn into a failed redirect for the visitor.
    {
      const db = offerPagesDb();
      if (db) {
        await insertFunnelEvent(db, {
          tenantId: resolved.tenant_id,
          formId: resolved.form.id,
          visitId,
          event: "community_click",
          stepIndex,
          detail: from ? JSON.stringify({ from }) : null,
        });
        const leadId = await findLeadForVisit(db, resolved.tenant_id, visitId);
        if (leadId) {
          // The raw Turso client, not getServiceSupabase() -- the dedupe is a
          // single conditional INSERT (see save-basin.ts), which the
          // Supabase-shim query builder cannot express.
          await recordSaveBasinEnrolled(db, {
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
