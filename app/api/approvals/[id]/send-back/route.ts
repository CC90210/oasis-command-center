/**
 * POST /api/approvals/[id]/send-back — "not like this", with a note.
 *
 * Body: { note } — REQUIRED (400 note_required when empty). The note is what
 * the requesting agent revises against: it is stored on the row
 * (decision_note) and in the audit log, and the agent reads it back with its
 * list_proposals tool. A revision is a NEW approval (revision + 1); this row
 * stays sent_back, so the note and the draft it was about stay together.
 *
 * Same session rules as approve: the session's tenant, the session's user as
 * the decider, 404 for a row outside the viewer's workspace or departments.
 */
import { NextResponse, type NextRequest } from "next/server";
import { decideApproval } from "@/lib/os/approvals/store";
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

    const decided = await decideApproval(session.db, session.scope, id, { kind: "send_back", note: parsed.body.note }, new Date());
    if (!decided.ok) return decisionError(decided);

    const approval = await viewApproval(session.db, session.scope, id, { tenantSlug: session.tenantSlug, now: new Date() });
    if (!approval) return approvalError(404, "not_found");
    return NextResponse.json({ ok: true, approval });
  } catch (err) {
    return approvalServerError("send_back", err);
  }
}
