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
 * NOTHING HERE CALLS A MODEL. GET runs the real audit read (fetchAudit,
 * ~3-4 indexed round trips per the reviewer's measurement) because ranking
 * without it collapses to two orderings total -- see factsInputFor below.
 * That cost is paid ONCE, when a rep opens the battle card, not per tap.
 * Tens of milliseconds on a page the rep is already waiting for buys a ranking
 * that actually ranks. A thrown audit read fails this route closed (500), same
 * as every other read failure here -- never a silently empty/unranked catalog.
 *
 * WHAT THE POST PATH ACTUALLY COSTS, stated accurately because an earlier
 * version of this comment claimed it "stays a single write" and it does not
 * (final review, M6): a tap is fetchApprovedCatalog() (two reads, to prove the
 * objection and any response id are approved -- without it a caller could log
 * events against a draft or retired id and poison every Phase 3 aggregate),
 * plus businessIdForLead() (one indexed read), plus the insert. Four round
 * trips, none of them the audit read, and the approval check is not optional.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";
import { fetchLead, WEBDEV_TENANT_ID, type Viewer } from "@/lib/web-leads/data";
import { mayWorkWebsiteSalesLifecycle } from "@/lib/website-sales-workflow";
import { fetchApprovedCatalog, fetchObjectionFrequency } from "@/lib/web-leads/objections/catalog";
import { rankObjections, CONSOLE_OPEN_COUNT } from "@/lib/web-leads/objections/ranking";
import { buildObjectionFacts } from "@/lib/web-leads/objections/facts";
import { fetchAudit, businessIdForLead } from "@/lib/web-leads/audit";
import { logObjectionEvent, fetchLeadEvents, ObjectionEventError } from "@/lib/web-leads/objections/events";
import { isRequestId } from "@/lib/web-leads/objections/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AuthorizedSession = Extract<Awaited<ReturnType<typeof resolveSessionContext>>, { ok: true }>;
type LoadedLead = NonNullable<Awaited<ReturnType<typeof fetchLead>>>;

/**
 * The leadgen_businesses pointer, when the lead carries one. Corresponds to
 * `data.webdev_source_business_id` (see lib/web-leads/outcome.ts and
 * lib/web-leads/audit.ts's header) -- NOT surfaced on `WebLead` itself
 * (confirmed against lib/web-leads/data.ts's toWebLead(), which maps 20 named
 * fields and this is not one of them; it is research plumbing, not a
 * rep-facing fact). It IS obtainable, though: `businessIdForLead(id)`
 * (lib/web-leads/audit.ts:193) is a plain one-column read of the same
 * tenant_records row `authorize()` already established is visible to this
 * viewer -- the identical pattern lib/web-leads/outcome.ts's
 * `leadRoutingInfo` uses on every call-outcome POST. (Fix round 1, finding
 * F1: this previously always returned null, which meant every objection
 * event this route ever wrote fell back to resolveEventKeys's `lead.id`
 * substitute and could never join to leadgen_businesses -- not the rare case
 * that fallback exists for.)
 *
 * Still returns null, never throws, when the lead genuinely carries no
 * pointer (not promoted through the leadgen pipeline): resolveEventKeys
 * (lib/web-leads/objections/events.ts) applies its documented
 * tenant_records.id fallback for that real case, same as outcome.ts. A read
 * failure here is a thrown Error, which the caller's try/catch turns into a
 * 500 -- never a silently-null business id standing in for a genuine DB
 * failure.
 */
function leadBusinessId(lead: LoadedLead): Promise<string | null> {
  return businessIdForLead(lead.id);
}

/**
 * The audit facts the ranker needs. EVERY field degrades to a safe value
 * rather than throwing: a lead with no audit at all still gets a ranked
 * console, just one ranked on family base rates alone. A rep mid-call never
 * loses the section because an enrichment field was missing.
 *
 * hasWebsite/overallScore/dimensions now come from a REAL fetchAudit(id, lead)
 * call (lib/web-leads/audit.ts:392) -- fix round 1, finding F2. Passing all
 * six as safe values (the original Task 8 instruction) made every rule keyed
 * on them dead code: every lead collapsed into one of two orderings, which
 * contradicts this route's own "ranked for THIS lead" claim. The reviewer's
 * ruling: this GET fires once per battle-card open, not per tap, so the
 * ~3-4 extra indexed round trips fetchAudit costs are the right trade, and
 * the POST tap path does not pay them at all (see this file's header for what
 * a tap actually costs -- it is not a single write, and never was).
 *
 * AuditResult is a closed union (lib/web-leads/audit.ts) and is read as one,
 * never assumed to be the "scored" branch: `no_website`, `not_scored`,
 * `unreachable` and `parked` all degrade to the same safe values a missing
 * audit would, so an audit read that resolves but isn't a finished score
 * still renders a valid, ranked console rather than throwing or guessing.
 */
async function factsInputFor(id: string, lead: LoadedLead): Promise<Parameters<typeof buildObjectionFacts>[0]> {
  const audit = await fetchAudit(id, lead);
  // AuditResult's own state machine (audit.ts's header, rule 1) derives
  // `no_website` from nothing more than "no website_url on the lead", so
  // this agrees with the same source the rest of these facts now come from
  // instead of re-deriving it from `lead.websiteUrl` separately.
  const hasWebsite = audit.state !== "no_website";
  // Only the "scored" branch carries `composite`/`dimensions` -- the field
  // is named `composite`, NOT `overall` (audit.ts's own docblock: an earlier
  // plan draft used `overall` and every downstream reference rendered
  // undefined).
  const scored = audit.state === "scored" ? audit : null;

  return {
    hasWebsite,
    overallScore: scored ? scored.composite : null,
    dimensions: scored ? scored.dimensions : [],
    // No stored field anywhere in this codebase identifies a DIY site
    // builder (Wix/Squarespace/etc) by name -- facts.ts's own header says so
    // explicitly. The nearest available signal is
    // lib/web-leads/evidence.ts:136's `builderBadge`, a boolean ("a
    // site-builder badge left on the page"), not a platform name, so it
    // cannot fill this string field. Wiring real platform detection is
    // Phase 2 work.
    platform: null,
    // Deliberately NOT derived (reviewer's ruling, fix round 1 F2): this is
    // `headToHead.composite - audit.composite` from a separate competitor
    // lookup (lib/web-leads/competitors.ts) -- a whole extra fetch beyond
    // the audit read this route now already pays for. Passing null here
    // only keeps ranking.ts's +10 "competitor ahead -> already_handled"
    // bump dormant; every other rule (including the +40 selected-angle bump
    // this audit read now revives) is unaffected.
    competitorGap: null,
    // Deliberately NOT derived (same ruling): a count of this lead's
    // call-log rows with outcome `no_answer` (lib/web-leads/outcome.ts),
    // which is its own query the audit read does not provide. Passing 0
    // only keeps ranking.ts's +25 "3+ no-answers -> brush_off" bump dormant.
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
    // businessId is resolved once and reused for the events read below; it
    // is NOT passed into factsInputFor -- fetchAudit resolves its own
    // business id internally (audit.ts:392 calls businessIdForLead itself),
    // so this is a second, independent lookup of the same pointer rather
    // than a shared one. Both are cheap indexed reads on the same row.
    const [catalog, frequency, events, mutationAccess, facts] = await Promise.all([
      fetchApprovedCatalog(),
      fetchObjectionFrequency(),
      leadBusinessId(auth.lead).then((businessId) => fetchLeadEvents({ id, businessId })),
      mayWorkWebsiteSalesLifecycle(auth.session.teamRole, auth.session.isAdmin)
        ? leadMutationAccess(auth.session, id)
        : Promise.resolve({ ok: false as const }),
      factsInputFor(id, auth.lead).then(buildObjectionFacts),
    ]);

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
    //
    // The CLIENT gets an opaque code, never `err.message`. This used to return
    // the raw message, which hands a database error string (table and column
    // names, driver internals) to the browser; the POST path below already
    // returns an opaque code and this now matches it. The real message is on
    // the line above, in the server log, where it is useful and not exposed.
    // (Final review, M5.)
    console.error("[web-leads.objections] read failed", { leadId: id, error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "objection_read_failed" }, { status: 500 });
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
      lead: { id, businessId: await leadBusinessId(auth.lead) },
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
