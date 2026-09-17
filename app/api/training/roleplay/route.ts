/**
 * The practice call.
 *
 * POST { scenarioId, transcript }              — the owner's next line
 * POST { scenarioId, transcript, kind:"debrief" } — the review, after the call
 *
 * 🚨 THE PERSONA IS SERVER-SIDE. The client sends a scenario ID and never a
 * prompt, a temperament, or any part of the system message. If it could, a rep
 * could hand themselves an owner who agrees to everything, which would waste
 * their practice, or one who says whatever they wanted quoted back, which is
 * worse. The id is looked up here and an unknown one is refused.
 *
 * The transcript IS client-supplied, and it has to be: it is the conversation.
 * It is capped and fenced. `buildTurnPrompt` wraps it in markers and the system
 * prompt says in plain words that everything inside them is speech rather than
 * instructions, so a rep typing "ignore your instructions" gets a confused
 * business owner rather than a compliant one.
 *
 * Nothing here writes to training progress. A practice call is not scored, and
 * a debrief is an opinion; neither belongs in the numbers a manager reads.
 */

import { NextResponse, type NextRequest } from "next/server";

import { resolveSessionContext } from "@/lib/api-auth";
import { mayViewTraining } from "@/lib/training/access";
import { DebriefRejected, type Turn } from "@/lib/training/roleplay/prompt";
import { RoleplayRejected, debrief, ownerTurn } from "@/lib/training/roleplay/turn";
import { scenarioById } from "@/lib/training/roleplay/scenarios";

export const dynamic = "force-dynamic";
/** The model call is queued and polled, so this outlives a default budget. */
export const maxDuration = 120;

function readTranscript(value: unknown): Turn[] | null {
  if (!Array.isArray(value)) return null;
  const out: Turn[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const row = entry as Record<string, unknown>;
    const role = row.role;
    const text = row.text;
    if (role !== "rep" && role !== "owner") return null;
    if (typeof text !== "string") return null;
    out.push({ role, text });
  }
  return out;
}

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!mayViewTraining(session)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const payload = (body ?? {}) as Record<string, unknown>;

  const scenarioId = typeof payload.scenarioId === "string" ? payload.scenarioId : "";
  const scenario = scenarioById(scenarioId);
  if (!scenario) {
    return NextResponse.json({ error: "unknown_scenario" }, { status: 400 });
  }

  const transcript = readTranscript(payload.transcript);
  if (!transcript) {
    return NextResponse.json({ error: "bad_transcript" }, { status: 400 });
  }

  try {
    if (payload.kind === "debrief") {
      const review = await debrief(scenario, transcript);
      return NextResponse.json({ ok: true, debrief: review });
    }
    const reply = await ownerTurn(scenario, transcript);
    return NextResponse.json({ ok: true, reply: reply.text, ended: reply.ended });
  } catch (err) {
    if (err instanceof DebriefRejected) {
      // 422: the request was fine, the model's output was not. Distinct from a
      // refusal of something the caller did, so the UI can offer a retry.
      return NextResponse.json(
        { error: "debrief_rejected", message: err.message, violations: err.violations },
        { status: 422 },
      );
    }
    if (err instanceof RoleplayRejected) {
      const waiting = err.reason === "owner_thinking" || err.reason === "review_pending";
      return NextResponse.json(
        { error: err.reason, message: err.message },
        { status: waiting ? 202 : 409 },
      );
    }
    console.error("[training/roleplay] failed", err instanceof Error ? err.message : "unknown");
    return NextResponse.json({ error: "roleplay_failed" }, { status: 500 });
  }
}
