/**
 * POST /api/os/runs - send a message into a department channel.
 *
 * Body: { department, agent_slug, text, conversation_id?, chat_mode? }
 *   conversation_id absent: a new conversation is started with this message.
 *
 * WHAT HAPPENS (lib/os/runs/send.ts). The message becomes a RUN in the
 * person's conversation (lib/os/runs/store.ts), queued behind any run already
 * working there. Then:
 *
 *   - If nothing in the conversation is being driven, THIS request becomes the
 *     driver: it starts the conversation's driver (lib/os/runs/executor.ts),
 *     registers it with the platform so it survives the browser leaving
 *     (lib/os/runs/keepalive.ts), and answers with a stream that follows the
 *     run from the database, and then any message queued behind it, until the
 *     queue is empty. The browser leaving only ends the FOLLOWING.
 *   - If a run in the conversation is already being driven, the message is
 *     queued and this answers 202 JSON; its driver runs it next, and the
 *     browser follows it with GET /api/os/runs/<id>/stream.
 *
 * Response (stream): event: conversation, then run / ev / end frames
 * (lib/os/runs/sse.ts). A refusal before anything is saved is JSON { ok, error }.
 *
 * The workspace, the person and the department binding come from the session
 * and the manifest (lib/os/runs/session.ts), exactly as the channel route
 * always resolved them; the body names none of them.
 */
import { type NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { RunsUnavailableError } from "@/lib/os/runs/store";
import { resolveRunSession, mayWatchThinking } from "@/lib/os/runs/session";
import { executorDepsFor } from "@/lib/os/runs/turn-starter";
import { sendMessage } from "@/lib/os/runs/send";
import { json } from "@/lib/os/runs/scope";
import { MAX_MESSAGE_CHARS } from "@/lib/os/runs/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Body = {
  department?: unknown;
  agent_slug?: unknown;
  text?: unknown;
  conversation_id?: unknown;
  chat_mode?: unknown;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }
  const department = typeof body.department === "string" ? body.department.trim() : "";
  const agentSlug = typeof body.agent_slug === "string" ? body.agent_slug.trim().toLowerCase() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!department) return json(400, { ok: false, error: "department_required" });
  if (!agentSlug) return json(400, { ok: false, error: "agent_slug_required" });
  if (!text) return json(400, { ok: false, error: "no_user_message" });
  if (text.length > MAX_MESSAGE_CHARS) return json(413, { ok: false, error: "message_too_long" });
  if (!tursoConfigured()) return json(503, { ok: false, error: "database_not_configured" });

  const resolved = await resolveRunSession({ department });
  if (!resolved.ok) return json(resolved.status, { ok: false, error: resolved.error });
  const { session } = resolved;

  try {
    const db = getTursoClient();
    return await sendMessage({
      db,
      deps: executorDepsFor(session, db),
      showThinking: mayWatchThinking(session),
      input: {
        department,
        agentSlug,
        text,
        conversationId: typeof body.conversation_id === "string" ? body.conversation_id.trim() : "",
        chatMode: body.chat_mode === "plan" ? "plan" : "build",
      },
    });
  } catch (err) {
    if (err instanceof RunsUnavailableError) return json(503, { ok: false, error: "chat_history_unavailable" });
    console.error("[os.runs.send]", { tenantId: session.scope.tenantId, department, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    return json(500, { ok: false, error: "send_failed" });
  }
}
