/**
 * /api/sequences/[id]/rotate-suggest — AI "give me a fresh version of this
 * drip email" (Adon 2026-07-20). Owner/admin only. Given a step index, returns
 * a compliant rewrite { subject, body } for the operator to review + apply in
 * the sequence editor. It does NOT write anything — the operator applies it in
 * the editor and Saves (which re-runs the same guard on the PATCH path).
 *
 * Fail-closed: the AI output is run through the positioning/lender guard before
 * it's returned. On a guard hit we regenerate once with the reason fed back;
 * if it still trips, we refuse (422) rather than hand back non-compliant copy.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getSessionContext, canManageTeam } from "@/lib/team";
import { parseDripSteps, type DripStep } from "@/lib/drips/types";
import { sanitizeBlastMessage, stripDashes } from "@/lib/integrations/blast-safety";
import { composeRotationSuggestion, type RotationComposeResult } from "@/lib/sequence-rotation-compose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ATTEMPTS = 2;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSessionContext();
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!canManageTeam(session.teamRole, session.adminAccess)) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Only owners/admins can rotate drip templates." },
      { status: 403 },
    );
  }
  const tenantId = session.tenantId;
  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const stepIndex = Number(body.step_index);
  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    return NextResponse.json({ ok: false, error: "invalid_step_index" }, { status: 400 });
  }

  const db = getServiceSupabase();
  const { data: seq, error } = await db
    .from("drip_sequences")
    .select("name, trigger_filter, steps")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!seq) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  let steps: DripStep[];
  try {
    steps = parseDripSteps(seq.steps);
  } catch {
    return NextResponse.json({ ok: false, error: "sequence_definition_invalid" }, { status: 409 });
  }
  const step = steps[stepIndex];
  if (!step || step.channel !== "email") {
    return NextResponse.json({ ok: false, error: "not_an_email_step" }, { status: 400 });
  }

  const trigger = (seq.trigger_filter && typeof seq.trigger_filter === "object")
    ? (seq.trigger_filter as Record<string, unknown>)
    : {};
  const stage = typeof trigger.to === "string" ? trigger.to : null;

  // Prefer the live (possibly-unsaved) editor copy the client sends, so the
  // operator rewrites what they're looking at; fall back to the stored step.
  const currentSubject =
    typeof body.current_subject === "string" && body.current_subject.trim()
      ? body.current_subject
      : step.subject || "";
  const currentBody =
    typeof body.current_body === "string" && body.current_body.trim()
      ? body.current_body
      : step.body || "";
  const instruction = typeof body.instruction === "string" ? body.instruction.slice(0, 500) : null;

  let correction: string | null = null;
  let lastGuardMessage = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let suggestion: RotationComposeResult;
    try {
      suggestion = await composeRotationSuggestion({
        stage,
        sequenceName: (seq.name as string) || "sequence",
        currentSubject,
        currentBody,
        instruction,
        correction,
      }, { tenantId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "compose_failed";
      const status = msg.startsWith("anthropic_key_missing") ? 503 : 502;
      return NextResponse.json(
        { ok: false, error: "compose_failed", message: `AI rewrite unavailable: ${msg}` },
        { status },
      );
    }

    const guard = await sanitizeBlastMessage(
      tenantId,
      `${suggestion.subject}\n\n${suggestion.body}`,
      { checkPositioning: true },
    );
    if (guard.ok) {
      return NextResponse.json({
        ok: true,
        subject: stripDashes(suggestion.subject).slice(0, 200),
        body: stripDashes(suggestion.body),
      });
    }
    lastGuardMessage = guard.message;
    // safety_check_failed == the lender-name DB lookup couldn't run. That's a
    // transient infra fault, not a bad suggestion — don't burn a regenerate on
    // it, just surface it fail-closed.
    if (guard.reason === "safety_check_failed") {
      return NextResponse.json({ ok: false, error: "safety_check_failed", message: guard.message }, { status: 503 });
    }
    correction = guard.message;
  }

  return NextResponse.json(
    {
      ok: false,
      error: "guard_blocked",
      message: `The AI suggestion kept tripping the compliance guard: ${lastGuardMessage} Try a different direction, or write it in manually.`,
    },
    { status: 422 },
  );
}
