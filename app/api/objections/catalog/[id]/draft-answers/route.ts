/**
 * POST — ask a model for candidate answers to one objection.
 *
 * WRITES DRAFTS AND ONLY DRAFTS. This route has no path to an approved row:
 * it calls `draftAnswersFor`, which calls `createDraftResponse`, which
 * hardcodes `status = 'draft'`. Approval is a separate, deliberate act by
 * somebody with deal-closing rights at `/objections`.
 *
 * THE AUTHORING BAR, NOT THE CLOSER BAR, is correct here precisely because
 * nothing this produces is live. Asking for suggestions is cheap and
 * reversible; blessing one is not. Gating the draft behind the closer bar
 * would push reps back to writing answers in a chat window, which is the
 * habit this surface exists to replace.
 *
 * A failed draft writes NOTHING. Validation is all or nothing inside
 * `parseDraftAnswers`, so a model that broke the rules on its second answer
 * does not leave the first one behind.
 */

import { NextResponse, type NextRequest } from "next/server";

import { resolveSessionContext } from "@/lib/api-auth";
import { mayAuthorObjections } from "@/lib/web-leads/objections/admin-access";
import { ObjectionAdminError, ObjectionRejected } from "@/lib/web-leads/objections/admin";
import { DraftRejected, draftAnswersFor } from "@/lib/web-leads/objections/draft-answers";

export const dynamic = "force-dynamic";
/** The model call is queued and polled, so this outlives a default budget. */
export const maxDuration = 120;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [session, { id }] = await Promise.all([resolveSessionContext(), ctx.params]);
  if (!mayAuthorObjections(session)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let limit = 2;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.limit === "number" && Number.isFinite(body.limit)) {
      limit = Math.max(1, Math.min(3, Math.trunc(body.limit)));
    }
  } catch {
    // An unparseable body is not a reason to refuse: the only field is
    // optional and the default is the sensible one.
  }

  try {
    const { created } = await draftAnswersFor(id, limit);
    return NextResponse.json(
      {
        ok: true,
        created: created.length,
        answers: created,
        status: "draft",
        note: "Saved as drafts. Nothing here reaches a rep until somebody approves it.",
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof DraftRejected) {
      // 422: the request was fine, the model's output was not. Distinct from a
      // 409 refusal of something the caller did, and from a 500, so the UI can
      // offer "try again" rather than "something broke".
      return NextResponse.json(
        { error: "draft_rejected", message: err.message, violations: err.violations },
        { status: 422 },
      );
    }
    if (err instanceof ObjectionRejected) {
      const pending = err.reason === "drafting_pending";
      return NextResponse.json(
        { error: err.reason, message: err.message },
        { status: pending ? 202 : 409 },
      );
    }
    console.error(
      "[objections/draft-answers] failed",
      err instanceof ObjectionAdminError ? err.message : err instanceof Error ? err.message : "unknown",
    );
    return NextResponse.json({ error: "draft_failed" }, { status: 500 });
  }
}
