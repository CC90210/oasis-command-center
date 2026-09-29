/**
 * POST /api/approvals/[id]/comment — a comment on an approval, in any status.
 *
 * Body: { body } (required, ≤ 2000 characters). The status is not changed. The
 * comment is an approval_events row (event "commented"), written through the
 * tenant-pinned parent, so a comment can only ever attach to an approval in
 * the session's own workspace. The author is the session user.
 *
 * Who may comment: whoever may decide this approval (the viewer's department
 * seats, and not read-only).
 */
import { NextResponse, type NextRequest } from "next/server";
import { commentOnApproval } from "@/lib/os/approvals/store";
import { viewApproval } from "@/lib/os/approvals/view";
import {
  approvalError,
  approvalServerError,
  decisionError,
  readJsonObject,
  resolveApprovalSession,
} from "@/lib/os/approvals/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const session = await resolveApprovalSession();
    if (!session.ok) return session.response;
    const { id } = await ctx.params;
    const parsed = await readJsonObject(req);
    if (!parsed.ok) return approvalError(400, parsed.error);

    const result = await commentOnApproval(session.db, session.scope, id, parsed.body.body, new Date());
    if (!result.ok) return decisionError(result);

    const approval = await viewApproval(session.db, session.scope, id, { tenantSlug: session.tenantSlug, now: new Date() });
    if (!approval) return approvalError(404, "not_found");
    return NextResponse.json({ ok: true, comment: result.comment, approval }, { status: 201 });
  } catch (err) {
    return approvalServerError("comment", err);
  }
}
