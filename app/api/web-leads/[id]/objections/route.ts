/**
 * /api/web-leads/[id]/objections
 *
 *   GET  — the approved objection catalog, ranked for THIS lead, plus the
 *          events already logged against it so the console can show which
 *          cards were tapped on this call.
 *   POST — log one tap. Body: { objectionId, requestId (UUID), responseId?,
 *          usedVariant? }. Idempotent on requestId.
 *
 * Authorization mirrors app/api/web-leads/[id]/outcome/route.ts exactly: libSQL
 * has no row-level security, so this route is the boundary. 401 unresolved,
 * 403 wrong tenant, 404 out of the viewer's scope, all BEFORE any read.
 *
 * NOTHING HERE CALLS A MODEL. A rep taps this mid-sentence. The ranking is a
 * pure function and the wording is pre-generated (Phase 2), so the only cost is
 * two indexed reads (the catalog and the frequency map) plus the lead read
 * `authorize()` already had to do for the 404 check.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";
import { fetchLead, WEBDEV_TENANT_ID, type Viewer } from "@/lib/web-leads/data";
import { mayWorkWebsiteSalesLifecycle } from "@/lib/website-sales-workflow";
import { fetchApprovedCatalog, fetchObjectionFrequency } from "@/lib/web-leads/objections/catalog";
import { rankObjections, CONSOLE_OPEN_COUNT } from "@/lib/web-leads/objections/ranking";
import { buildObjectionFacts } from "@/lib/web-leads/objections/facts";
import { logObjectionEvent, fetchLeadEvents, ObjectionEventError } from "@/lib/web-leads/objections/events";
import { isRequestId } from "@/lib/web-leads/objections/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AuthorizedSession = Extract<Awaited<ReturnType<typeof resolveSessionContext>>, { ok: true }>;
type LoadedLead = NonNullable<Awaited<ReturnType<typeof fetchLead>>>;

/**
 * The leadgen_businesses pointer, when the lead carries one. Corresponds to
 * `data.webdev_source_business_id` (see lib/web-leads/outcome.ts and
 * lib/web-leads/audit.ts's header). CONFIRMED against lib/web-leads/data.ts's
 * toWebLead(): that function maps 20 named fields off the raw row and this
 * pointer is not one of them -- WebLead deliberately does not surface it (it
 * is research plumbing, not a rep-facing fact; audit.ts reads it directly off
 * the raw row for the same reason). So there is no in-type property to read
 * here, and this always returns null -- which is fine by design:
 * resolveEventKeys (lib/web-leads/objections/events.ts) applies its documented
 * tenant_records.id fallback exactly as lib/web-leads/outcome.ts does for the
 * identical situation. Never throws, because a missing pointer must not make
 * a real objection unloggable.
 */
function leadBusinessId(_lead: LoadedLead): string | null {
  return null;
}

/**
 * The audit facts the ranker needs, pulled off the lead. EVERY field degrades
 * to null or 0 rather than throwing: a lead with no audit at all still gets a
 * ranked console, just one ranked on family base rates alone. A rep mid-call
 * never loses the section because an enrichment field was missing.
 *
 * None of overallScore/dimensions/platform/competitorGap/priorNoAnswerCalls
 * are available on `WebLead` -- lib/web-leads/objections/facts.ts's own header
 * table confirms each one lives on AuditResult, CompetitorContext or the call
 * log, all separate fetches (fetchAudit, competitor lookup, outcome count).
 * Calling any of them here would add a database round trip this route does
 * not have: the GET path is documented above as two indexed reads plus the
 * lead read authorize() already did, and a rep taps this mid-sentence. So per
 * this route's own degrade-to-safe contract, those five are passed safe.
 * hasWebsite is the one exception: audit.ts's own state machine (comment atop
 * that file) computes AuditResult's "no_website" state from nothing more than
 * "no website_url on the lead", so `Boolean(lead.websiteUrl)` is that same
 * test, not a guess, and costs nothing extra because websiteUrl is already on
 * the WebLead this route already fetched.
 */
function factsInputFor(lead: LoadedLead): Parameters<typeof buildObjectionFacts>[0] {
  return {
    hasWebsite: Boolean(lead.websiteUrl),
    overallScore: null,
    dimensions: [],
    // No stored field anywhere in this codebase identifies a DIY site
    // builder (Wix/Squarespace/etc) by name -- facts.ts's own header says so
    // explicitly. The nearest available signal is
    // lib/web-leads/evidence.ts:136's `builderBadge`, a boolean ("a
    // site-builder badge left on the page"), not a platform name, so it
    // cannot fill this string field. Wiring real platform detection is
    // Phase 2 work.
    platform: null,
    competitorGap: null,
    priorNoAnswerCalls: 0,
  };
}

function leadMutationAccess(session: AuthorizedSession, leadId: string) {
  return assertMayWorkLead({
    teamRole: session.teamRole,
    userId: session.userId,
    tenantId: WEBDEV_TENANT_ID,
    leadId,
    isOwner: session.isTrueAdmin,
    adminAccess: session.adminAccess,
    accessMode: "owned_oasis_sales",
  });
}

async function authorize(id: string) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return { ok: false as const, res: NextResponse.json({ ok: false, error: session.reason }, { status: 401 }) };
  }
  if (session.tenantId !== WEBDEV_TENANT_ID) {
    return { ok: false as const, res: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  }
  const viewer: Viewer = { userId: session.userId, teamRole: session.teamRole, isAdmin: session.isAdmin };
  const lead = await fetchLead(id, viewer);
  if (!lead) {
    return { ok: false as const, res: NextResponse.json({ ok: false, error: "not_found" }, { status: 404 }) };
  }
  return { ok: true as const, session, lead };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await authorize(id);
  if (!auth.ok) return auth.res;

  try {
    const [catalog, frequency, events, mutationAccess] = await Promise.all([
      fetchApprovedCatalog(),
      fetchObjectionFrequency(),
      fetchLeadEvents({ id, businessId: leadBusinessId(auth.lead) }),
      mayWorkWebsiteSalesLifecycle(auth.session.teamRole, auth.session.isAdmin)
        ? leadMutationAccess(auth.session, id)
        : Promise.resolve({ ok: false as const }),
    ]);

    const facts = buildObjectionFacts(factsInputFor(auth.lead));
    const objections = rankObjections(catalog, facts, frequency);

    return NextResponse.json({
      ok: true,
      objections,
      events,
      canMutate: mutationAccess.ok,
      openCount: CONSOLE_OPEN_COUNT,
    });
  } catch (err) {
    // FAIL CLOSED and loudly. Returning an empty catalog here would render a
    // calm "no objections yet" over a broken database, and a rep would believe
    // it mid-call.
    console.error("[web-leads.objections] read failed", { leadId: id, error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "objection_read_failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await authorize(id);
  if (!auth.ok) return auth.res;

  if (!mayWorkWebsiteSalesLifecycle(auth.session.teamRole, auth.session.isAdmin)) {
    return NextResponse.json({ ok: false, error: "sales_role_required" }, { status: 403 });
  }
  const mutationAccess = await leadMutationAccess(auth.session, id);
  if (!mutationAccess.ok) {
    return NextResponse.json(
      { ok: false, error: mutationAccess.error, message: mutationAccess.message },
      { status: mutationAccess.status },
    );
  }

  let body: { objectionId?: unknown; requestId?: unknown; responseId?: unknown; usedVariant?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  if (typeof body.objectionId !== "string" || !body.objectionId.trim()) {
    return NextResponse.json({ ok: false, error: "invalid_objection_id" }, { status: 400 });
  }
  if (!isRequestId(body.requestId)) {
    return NextResponse.json({ ok: false, error: "invalid_request_id" }, { status: 400 });
  }
  const responseId = typeof body.responseId === "string" && body.responseId.trim() ? body.responseId.trim() : null;

  // The objection must exist in the APPROVED catalog. Without this a caller
  // could log events against a draft or a retired id and quietly poison every
  // Phase 3 aggregate.
  try {
    const catalog = await fetchApprovedCatalog();
    const entry = catalog.find((o) => o.id === body.objectionId);
    if (!entry) {
      return NextResponse.json({ ok: false, error: "unknown_objection" }, { status: 400 });
    }
    if (responseId && !entry.answers.some((a) => a.id === responseId)) {
      return NextResponse.json({ ok: false, error: "unknown_response" }, { status: 400 });
    }

    const { event, idempotent } = await logObjectionEvent({
      lead: { id, businessId: leadBusinessId(auth.lead) },
      objectionId: body.objectionId,
      responseId,
      usedVariant: body.usedVariant === true,
      repUserId: auth.session.userId,
      requestId: body.requestId,
    });
    return NextResponse.json({ ok: true, event, idempotent });
  } catch (err) {
    if (err instanceof ObjectionEventError) {
      const terminal = err.code === "request_id_conflict";
      console.error("[web-leads.objections] tap write failed", { leadId: id, code: err.code, error: err.message });
      return NextResponse.json(
        { ok: false, error: err.code, retrySafe: !terminal },
        { status: terminal ? 409 : 503 },
      );
    }
    console.error("[web-leads.objections] tap failed", { leadId: id, error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "objection_log_failed" }, { status: 500 });
  }
}
