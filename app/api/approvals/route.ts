/**
 * GET /api/approvals — the session workspace's approvals, as this viewer may
 * see them.
 *
 *   ?view=pending   (default) the Needs-you queue: waiting, not expired
 *   ?view=decided   the last 7 days of decisions and their real outcomes
 *   ?view=all       every status
 *   ?department=<key>  one department (sales, marketing, ...)
 *
 * The tenant and the departments come from the session
 * (lib/os/approvals/session.ts); nothing in the query string can widen them.
 * Owners/admins see every department; anyone else sees only their own
 * department's approvals (rules.ts DEPARTMENT_SEATS ∩ the rail).
 *
 * Failures are loud: a broken read is a 500 with a sentence, never an empty list.
 */
import { NextResponse, type NextRequest } from "next/server";
import { DEPARTMENT_KEYS, isOneOf } from "@/lib/os/approvals/rules";
import { countPendingApprovals, listApprovals, type ApprovalListView } from "@/lib/os/approvals/store";
import { buildApprovalViews } from "@/lib/os/approvals/view";
import { approvalError, approvalServerError, resolveApprovalSession } from "@/lib/os/approvals/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VIEWS: readonly ApprovalListView[] = ["pending", "decided", "all"];

export async function GET(req: NextRequest) {
  try {
    const session = await resolveApprovalSession();
    if (!session.ok) return session.response;
    const sp = req.nextUrl.searchParams;
    const rawView = (sp.get("view") || "pending").trim().toLowerCase();
    if (!isOneOf(VIEWS, rawView)) return approvalError(400, "view_invalid");
    const rawDept = (sp.get("department") || "").trim().toLowerCase();
    if (rawDept && !isOneOf(DEPARTMENT_KEYS, rawDept)) return approvalError(400, "department_invalid");
    const department = isOneOf(DEPARTMENT_KEYS, rawDept) ? rawDept : null;
    const limit = Number(sp.get("limit") || "") || undefined;

    const now = new Date();
    const [listed, pending] = await Promise.all([
      listApprovals(session.db, session.scope, { view: rawView, department, limit }, now),
      countPendingApprovals(session.db, session.scope, now),
    ]);
    const approvals = await buildApprovalViews(session.db, session.scope, listed.rows, {
      tenantSlug: session.tenantSlug,
      now,
    });
    return NextResponse.json({ ok: true, view: rawView, approvals, truncated: listed.truncated, pending });
  } catch (err) {
    return approvalServerError("list", err);
  }
}
