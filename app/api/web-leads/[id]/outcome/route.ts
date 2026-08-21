/**
 * /api/web-leads/[id]/outcome
 *
 *   POST — log a call outcome. Body: { outcome: "no_answer" | "connected" |
 *     "interested" | "not_interested", note?: string }. Writes an
 *     APPEND-ONLY row to leadgen_call_outcomes (who logged it and when),
 *     and as a byproduct of the outcome -- never a separate action --
 *     advances the lead's stage through lib/web-leads/outcome.ts's
 *     nextStage(). See that module's header for the real schema this writes
 *     against and the constrained stage logic. There is no PUT/PATCH/DELETE
 *     on this route and no update() call anywhere in this file or
 *     lib/web-leads/outcome.ts -- a mis-click is corrected by logging a
 *     later outcome, not by editing history.
 *
 *   GET — this lead's recent outcome history, most recent first. Read-only.
 *
 * Auth mirrors app/api/web-leads/[id]/audit/route.ts EXACTLY: libSQL has no
 * row-level security, so this route is the authorization boundary, not a
 * convenience. An unresolved caller gets a 401, never the record. A caller
 * resolved to a DIFFERENT tenant gets a 403 -- both checks happen BEFORE any
 * read or write. fetchLead() applies the identical `agent`-role scoping
 * (isScopedContractor in lib/web-leads/data.ts) that the sibling routes use,
 * and returns null for a lead outside the viewer's scope exactly as it does
 * for one that doesn't exist at all -- so a scoped-out id 404s here too,
 * never 403, and cannot be used to probe what exists.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { fetchLead, WEBDEV_TENANT_ID, type Viewer } from "@/lib/web-leads/data";
import { isCallOutcome, logCallOutcome, fetchRecentOutcomes } from "@/lib/web-leads/outcome";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorize(id: string) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return { ok: false as const, res: NextResponse.json({ ok: false, error: session.reason }, { status: 401 }) };
  }
  // Resolving a caller and then not constraining them to a tenant is the same
  // class of bug as an auth check that can never fire. libSQL has no
  // row-level security, so this is the ONLY thing standing between a SunBiz
  // rep's normal login and any Web Studio lead's call history.
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
    const outcomes = await fetchRecentOutcomes(id);
    return NextResponse.json({ ok: true, outcomes });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "outcome_history_failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await authorize(id);
  if (!auth.ok) return auth.res;

  let body: { outcome?: unknown; note?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  if (!isCallOutcome(body.outcome)) {
    return NextResponse.json({ ok: false, error: "invalid_outcome" }, { status: 400 });
  }

  try {
    const { record, stageChangedTo } = await logCallOutcome({
      leadId: id,
      lead: auth.lead,
      outcome: body.outcome,
      note: body.note,
      repUserId: auth.session.userId,
    });
    return NextResponse.json({ ok: true, outcome: record, stageChangedTo });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "outcome_log_failed" },
      { status: 500 },
    );
  }
}
