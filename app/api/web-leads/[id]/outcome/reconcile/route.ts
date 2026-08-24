/**
 * /api/web-leads/[id]/outcome/reconcile
 *
 *   POST — repair the lead's queue fields from its own call history. No body.
 *
 * WHY THIS EXISTS. Logging a call is two writes that cannot be made atomic
 * through this data layer: an append-only row in leadgen_call_outcomes, and a
 * patch to tenant_records.data carrying the stage, `last_disposition` and
 * `next_action_at` that Rep Today ranks on. If the first succeeds and the
 * second fails, the call is recorded but the callback the rep promised is in
 * nobody's queue.
 *
 * The dishonest options were both available and both worse: return success
 * (the rep trusts a callback that will never surface, which is precisely the
 * failure this whole change exists to remove) or return a bare 500 (the rep
 * logs the same call again, producing two history rows for one conversation).
 * So POST /outcome answers 409 `schedule_not_applied` with `logged: true`, and
 * this route rebuilds the missing half.
 *
 * IT IS IDEMPOTENT BECAUSE THE HISTORY IS APPEND-ONLY. The patch is a pure
 * function of the most recent outcome row, and that row can no longer change,
 * so running this twice leaves the lead in the same state as running it once.
 * It appends nothing and asks the rep for nothing.
 *
 * WHY NOT A PATCH ON THE OUTCOME ROUTE. That route is the append-only history
 * door and carries a guard saying so -- tests/web-leads-outcome-guards.test.ts
 * asserts it exports no PUT, PATCH or DELETE. Repairing the lead's queue
 * fields is a different operation against a different table. Giving it its own
 * route keeps that guard exactly as strict as it was, instead of loosening a
 * proven check to make room for a new feature.
 *
 * AUTH IS THE SAME BOUNDARY, NOT A LIGHTER ONE. This route writes to
 * tenant_records, so it repeats the outcome route's gate verbatim: resolve the
 * caller, branch on session.ok, pin the tenant, and resolve the lead through
 * fetchLead so `agent`-role scoping applies and an out-of-scope id 404s rather
 * than 403s. A repair endpoint that trusted its caller more than the endpoint
 * it repairs for would be the way in.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { fetchLead, WEBDEV_TENANT_ID, type Viewer } from "@/lib/web-leads/data";
import { reconcileLeadFromHistory } from "@/lib/web-leads/outcome";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  }
  if (session.tenantId !== WEBDEV_TENANT_ID) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const viewer: Viewer = { userId: session.userId, teamRole: session.teamRole, isAdmin: session.isAdmin };
  const lead = await fetchLead(id, viewer);
  if (!lead) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  try {
    const result = await reconcileLeadFromHistory(id);
    if (!result) {
      // Nothing to repair is not a failure, and must not be reported as a
      // success either: a lead nobody has called has no history to rebuild
      // from, and answering "repaired" would be a lie the caller acts on.
      return NextResponse.json({ ok: true, repaired: false, reason: "no_history" });
    }
    return NextResponse.json({ ok: true, repaired: true, from: result.from });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "reconcile_failed" },
      { status: 500 },
    );
  }
}
