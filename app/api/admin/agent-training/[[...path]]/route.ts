/**
 * Admin > Agent training, its one API module (2026-10-28).
 *
 *   POST /api/admin/agent-training/recall   ask a department's agent a question about one learned
 *                                           note, through the SAME turn its channel runs, and say
 *                                           whether the note was in its instructions for that question
 *
 * WHY. "Learn from a link" saved notes no one could check: there was no way to see that an agent had
 * actually learned anything. The recall test answers both halves: whether this note is picked for this
 * question (lib/os/training-notes.ts picks notes by relevance to the question), and what the agent says
 * with it. The note is never forced in: a test that always includes the note proves nothing.
 *
 * GATES. A platform operator only (resolveRunSession's isOperator, the same verdict every Admin page
 * reads), same-origin, a JSON body under 4 KB with known keys only. The question is scrubbed of secrets
 * before anything reads it: it often quotes a note's title or source link, and a link can carry a
 * credential (?token=...). A refused session keeps its own reason: no AI account, settings that could
 * not be read, or a computer that cannot take the turn each say so. The turn is the department's real
 * one (prepareAgentTurn: binding, account, budget, the notes block, the identity lock), filed under its
 * own usage surface, training.recall, so a recall test never counts as, or pages, a chat
 * (lib/health/department-chat-checks.ts NOT_CHAT_SURFACES). It runs on the workspace's AI account; an
 * agent that answers only on the paired computer is told so, in words, and nothing is spent.
 *
 * One module, not one per verb: each Next route compiles to its own server bundle and the Worker is
 * near Cloudflare's size limit (see app/api/automations/guided/[[...path]]/route.ts).
 */
import { NextResponse } from "next/server";
import { departmentChannelFor } from "@/components/os/department/config";
import { sameOrigin } from "@/lib/calendar/http";
import { failureCopy } from "@/lib/os/channel/outcome";
import { prepareAgentTurn, runAgentTurnToText } from "@/lib/os/department-agent";
import { resolveRunSession, type SessionRefusal } from "@/lib/os/runs/session";
import { redactAll } from "@/lib/secret-redaction";
import { isTrains, TRAINS_ALL } from "@/lib/training/trains";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4_000;
const MAX_QUESTION_CHARS = 600;
const RECALL_MAX_TOKENS = 500;
const NOTE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function reply(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** Plain words for every refusal a person can meet here. */
const MESSAGES: Record<string, string> = {
  unauthorized: "Sign in again, then try once more.",
  forbidden: "Only a platform operator can run a recall test.",
  viewer_unconfirmed: "We could not confirm your access to this workspace just now. Try again in a moment.",
  bad_request: "That request could not be read. Reload the page and try again.",
  note_not_found: "That note was not found, or it has not finished being read.",
  agent_unbound: "No agent answers for this department in your workspace.",
  computer_only:
    "This agent answers on your computer, and the recall test runs on the workspace AI account. Ask it in the department's channel instead, or choose the AI account in Settings > AI brain.",
  turn_failed: "The agent did not answer this time. Nothing was saved; try again.",
  unavailable: "The training notes could not be read right now. Try again in a minute.",
};

function refuse(status: number, error: string, extra: Record<string, unknown> = {}): NextResponse {
  return reply(status, { ok: false, error, message: MESSAGES[error] ?? MESSAGES.turn_failed, ...extra });
}

/** resolveRunSession's refusals that are about the workspace (its account or its settings), not a computer. */
const WORKSPACE_REFUSALS: ReadonlySet<string> = new Set([
  "unknown_department",
  "profile_unavailable",
  "no_tenant",
  "unknown_tenant",
  "config_unavailable",
  "engine_snapshot_unavailable",
  "agent_not_configured",
]);

/**
 * A refused session, kept as itself (Codex review, 2026-10-28). A workspace with no AI account (412) or
 * settings that could not be read (503) keeps its status and the channel's own words for it; every
 * refusal about a paired computer (offline, not approved, not this person's, no owner set) gets the
 * computer guidance, because a recall test never runs on a computer. Only a missing sign-in is 401, and
 * only the operator gate says "operator".
 */
function sessionRefusal(refusal: SessionRefusal): NextResponse {
  if (refusal.status === 401) return refuse(401, "unauthorized");
  if (!WORKSPACE_REFUSALS.has(refusal.error)) return refuse(409, "computer_only", { code: refusal.error });
  return reply(refusal.status, {
    ok: false,
    error: refusal.error,
    message: failureCopy(refusal.error, { canManageAi: true }).sentence,
  });
}

async function recall(req: Request): Promise<NextResponse> {
  if (!sameOrigin(req)) return refuse(403, "forbidden");
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return refuse(400, "bad_request");
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return refuse(400, "bad_request");
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return refuse(400, "bad_request");
    body = parsed as Record<string, unknown>;
  } catch {
    return refuse(400, "bad_request");
  }
  for (const key of Object.keys(body)) if (!["note_id", "department", "question"].includes(key)) return refuse(400, "bad_request");
  const noteId = typeof body.note_id === "string" ? body.note_id.trim() : "";
  const department = typeof body.department === "string" ? body.department.trim() : "";
  const typed = typeof body.question === "string" ? body.question.replace(/\s+/g, " ").trim() : "";
  if (!NOTE_ID_RE.test(noteId) || !isTrains(department) || department === TRAINS_ALL || !typed || typed.length > MAX_QUESTION_CHARS) {
    return refuse(400, "bad_request");
  }
  // Scrubbed before the notes are ranked by it or the model sees it, the way trainingBlock scrubs notes.
  const question = redactAll(typed);

  const resolved = await resolveRunSession({ department });
  if (!resolved.ok) return sessionRefusal(resolved);
  const session = resolved.session;
  if (!session.isOperator) return refuse(403, "forbidden");
  if (!session.viewer.ok) return refuse(403, "viewer_unconfirmed");
  const tenantId = session.scope.tenantId;

  // The note must exist in this workspace and be finished: the recall test is about a learned note.
  if (!tursoConfigured()) return refuse(503, "unavailable");
  try {
    const found = await getTursoClient().execute({
      sql: "SELECT id FROM marketing_corpus WHERE tenant_id = ? AND id = ? AND state = 'indexed' LIMIT 1",
      args: [tenantId, noteId],
    });
    if (found.rows.length === 0) return refuse(404, "note_not_found");
  } catch (err) {
    console.error("[agent-training.recall.note]", { tenantId, error: err instanceof Error ? err.message : String(err) });
    return refuse(503, "unavailable");
  }

  const binding = departmentChannelFor(session.dept.key, { oasis: session.viewer.oasis, manifest: session.viewer.manifest });
  if (binding.kind !== "agent") return refuse(409, "agent_unbound");

  const prepared = await prepareAgentTurn({
    tenantId,
    tenantSlug: session.tenantSlug,
    agentSlug: binding.agentSlug,
    department: session.dept,
    operator: { name: session.operatorName, email: session.email },
    platformFallback: session.fallback,
    revealModel: session.isOperator,
    localModelAllowed: session.isOperator,
    userId: session.scope.userId,
    chatMode: "plan",
    surface: "training.recall",
    engineChoice: session.apiEngineChoice,
    apiAccountSnapshot: session.apiAccountSnapshot,
    // A device engine is never reached from here: say so rather than spend a fallback key.
    failClosedWithoutComputerDispatch: true,
    trainingQuery: question,
  });
  if (!prepared.ok) {
    // The two refusals prepareAgentTurn gives an engine that answers only on a paired computer.
    const computerOnly = prepared.error === "computer_choice_needs_pairing" || prepared.error === "engine_dispatch_unavailable";
    return refuse(computerOnly ? 409 : prepared.status, computerOnly ? "computer_only" : "turn_failed", { code: prepared.error });
  }
  const turn = prepared.turn;
  const included = turn.trainingNoteIds.includes(noteId);
  const answer = await runAgentTurnToText(turn, [{ role: "user", content: question }], RECALL_MAX_TOKENS);
  if (!answer.ok) return refuse(502, "turn_failed", { code: answer.code, included });
  return reply(200, {
    ok: true,
    included,
    picked: turn.trainingNoteIds.length,
    answer: answer.text,
    runsOn: turn.engine.runsOn,
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ path?: string[] }> }): Promise<NextResponse> {
  const path = (await ctx.params).path ?? [];
  if (path.length === 1 && path[0] === "recall") return recall(req);
  return reply(404, { ok: false, error: "not_found" });
}
