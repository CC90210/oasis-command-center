/**
 * POST /api/approvals/[id]/approve — say yes to ONE exact draft, then carry it
 * out once and answer with what really happened.
 *
 * Body: { payload_hash } — the hash of the draft the card showed. The approval
 * binds to it: if the row's payload is not that one (a stale card, a newer
 * revision), the answer is 409 payload_mismatch and nothing is approved.
 *
 * The decider is the SESSION user; the tenant and the departments this viewer
 * may decide for come from the session too (lib/os/approvals/session.ts).
 * A row in another workspace, or in a department outside the viewer's seats,
 * answers 404 — the same answer for both.
 *
 * After the yes, lib/os/approvals/execute.ts claims the row
 * (approved → executing, compare-and-swap), re-checks the payload hash and the
 * workspace, and dispatches to the executor registry. The response carries the
 * approval with its REAL outcome: executed (sent / dry run / queued) or failed
 * with the reason. A click that loses the race to a concurrent approve gets
 * 409 not_pending, and nothing is sent twice.
 *
 * Pressing again on a row that is `approved` but never started (its approving
 * request died before the executor ran) carries it out — same hash required,
 * still exactly once through the executor's claim.
 */
import { NextResponse, type NextRequest } from "next/server";
import { decideApproval, getApproval } from "@/lib/os/approvals/store";
import { mayDecideApproval } from "@/lib/os/approvals/rules";
import { executeApproval } from "@/lib/os/approvals/execute";
import { viewApproval } from "@/lib/os/approvals/view";
import {
  approvalServerError,
  decisionError,
  readJsonObject,
  approvalError,
  resolveApprovalSession,
} from "@/lib/os/approvals/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One SMTP send (the executor's 10s/20s timeouts) plus the database writes.
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const session = await resolveApprovalSession();
    if (!session.ok) return session.response;
    const { id } = await ctx.params;
    const parsed = await readJsonObject(req);
    if (!parsed.ok) return approvalError(400, parsed.error);

    const payloadHash = String(parsed.body.payload_hash ?? "");
    const decided = await decideApproval(session.db, session.scope, id, { kind: "approve", payloadHash }, new Date());
    if (!decided.ok) {
      // RESUME, not re-approve: a row that is `approved` but was never claimed
      // (the request that approved it died before the executor ran) would
      // otherwise wait forever with nobody to carry it out. Pressing again
      // with the SAME payload hash runs it; the executor's claim still makes
      // it exactly once, and a row already executing or done is untouched.
      const current = decided.error === "not_pending" && decided.status === "approved" ? await getApproval(session.db, session.scope, id) : null;
      const resumable =
        !!current &&
        current.status === "approved" &&
        current.payload_hash === payloadHash &&
        mayDecideApproval(session.scope, current.department_key);
      if (!resumable) return decisionError(decided);
    }

    const executed = await executeApproval(session.db, {
      tenantId: session.scope.tenantId,
      approvalId: id,
      approver: { userId: session.scope.userId, email: session.email },
    });
    if (!executed.ok && executed.error === "not_claimable") {
      // Someone else's executor holds it. Not an error for this click: the
      // row below shows where it stands, and nothing ran twice.
      console.warn("[approvals:approve] execution already claimed", { id });
    }

    const approval = await viewApproval(session.db, session.scope, id, { tenantSlug: session.tenantSlug, now: new Date() });
    if (!approval) return approvalError(404, "not_found");
    return NextResponse.json({ ok: true, approval });
  } catch (err) {
    return approvalServerError("approve", err);
  }
}
