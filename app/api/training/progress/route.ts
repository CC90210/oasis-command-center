/**
 * A rep's own training progress.
 *
 * GET  — this rep's per-item counters and finished sections.
 * POST — record one answered question, or mark a section finished.
 *
 * ALWAYS THE CALLER'S OWN PROGRESS. There is no `repUserId` parameter, on
 * purpose: the id is taken from the session and nothing in the body can change
 * it. A rep's practice record is a list of what they are bad at, and an
 * endpoint that let one rep name another would turn a training tool into a
 * league table. The team view is a separate, manager-gated surface.
 */

import { NextResponse, type NextRequest } from "next/server";

import { resolveSessionContext } from "@/lib/api-auth";
import { mayViewTraining, repIdFor } from "@/lib/training/access";
import {
  TrainingProgressError,
  fetchCompletions,
  fetchProgress,
  recordAnswer,
  recordCompletion,
} from "@/lib/training/progress";
import { gradeAnswer } from "@/lib/training/session";
import { isSectionSlug } from "@/lib/training/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await resolveSessionContext();
  if (!mayViewTraining(session)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const repUserId = repIdFor(session as Parameters<typeof repIdFor>[0]);
  if (!repUserId) return NextResponse.json({ error: "no_user" }, { status: 403 });

  try {
    const [progress, completions] = await Promise.all([
      fetchProgress(repUserId),
      fetchCompletions(repUserId),
    ]);
    return NextResponse.json({ progress, completions });
  } catch (err) {
    console.error("[training/progress] read failed", err instanceof Error ? err.message : "unknown");
    return NextResponse.json({ error: "read_failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!mayViewTraining(session)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const repUserId = repIdFor(session as Parameters<typeof repIdFor>[0]);
  if (!repUserId) return NextResponse.json({ error: "no_user" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const payload = (body ?? {}) as Record<string, unknown>;

  try {
    if (payload.kind === "completion") {
      const section = payload.sectionSlug;
      if (!isSectionSlug(section)) {
        return NextResponse.json({ error: "bad_section" }, { status: 400 });
      }
      const right = Number(payload.rightCount);
      const wrong = Number(payload.wrongCount);
      await recordCompletion({
        repUserId,
        sectionSlug: section,
        rightCount: Number.isFinite(right) && right >= 0 ? Math.trunc(right) : 0,
        wrongCount: Number.isFinite(wrong) && wrong >= 0 ? Math.trunc(wrong) : 0,
      });
      return NextResponse.json({ ok: true });
    }

    const itemId = typeof payload.itemId === "string" ? payload.itemId : "";
    const sectionSlug = payload.sectionSlug;
    const chosenOptionId = typeof payload.chosenOptionId === "string" ? payload.chosenOptionId : "";
    if (!itemId.trim()) return NextResponse.json({ error: "missing_item_id" }, { status: 400 });
    if (!chosenOptionId.trim()) {
      return NextResponse.json({ error: "missing_choice" }, { status: 400 });
    }
    if (!isSectionSlug(sectionSlug)) {
      return NextResponse.json({ error: "bad_section" }, { status: 400 });
    }

    // Correctness is derived from the curriculum, never taken from the body.
    //
    // This is an INTEGRITY property, not an anti-cheat one, and the difference
    // is worth stating because the first version of this comment got it wrong.
    // It means correctness has one definition, living beside the curriculum, so
    // no client bug or retry can record a wrong answer as right. It does NOT
    // mean a determined rep cannot fake their own record: both ids come from
    // the client and the browser knows all of them. See `gradeAnswer` for why
    // nothing grading a client-built drill can prevent that, and what it would
    // cost to.
    const grade = gradeAnswer(itemId, sectionSlug, chosenOptionId);
    if (!grade.ok) {
      return NextResponse.json({ error: grade.reason }, { status: 400 });
    }

    await recordAnswer({
      repUserId,
      itemId,
      sectionSlug: grade.sectionSlug,
      correct: grade.correct,
    });
    return NextResponse.json({ ok: true, correct: grade.correct });
  } catch (err) {
    if (err instanceof TrainingProgressError) {
      console.error("[training/progress] write refused", err.message);
      return NextResponse.json({ error: "write_refused", message: err.message }, { status: 409 });
    }
    console.error("[training/progress] write failed", err instanceof Error ? err.message : "unknown");
    return NextResponse.json({ error: "write_failed" }, { status: 500 });
  }
}
