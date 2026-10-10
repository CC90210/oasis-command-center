/**
 * /api/os/conversations/<id> - one of your saved department conversations.
 *
 *   GET     the transcript: every message in order, each finished one with its
 *           activity trail and answer (lib/os/runs/transcript.ts);
 *   PATCH   { title } rename it (a renamed chat keeps its name);
 *   DELETE  remove it and everything in it (a run still working is stopped).
 *
 * Yours only: the workspace and you are in every query. Someone else's
 * conversation, or a workspace you are not in, is a plain 404.
 */
import { type NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { RunsUnavailableError, deleteConversation, renameConversation } from "@/lib/os/runs/store";
import { buildTranscript } from "@/lib/os/runs/transcript";
import { resolveRunScope, json } from "@/lib/os/runs/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function guarded(label: string, id: string, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RunsUnavailableError) return json(503, { ok: false, error: "chat_history_unavailable" });
    console.error(`[os.conversations.${label}]`, { conversationId: id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    return json(500, { ok: false, error: `${label}_failed` });
  }
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const scoped = await resolveRunScope();
  if (!scoped.ok) return json(scoped.status, { ok: false, error: scoped.error });
  if (!tursoConfigured()) return json(503, { ok: false, error: "database_not_configured" });
  return guarded("read", id, async () => {
    const t = await buildTranscript(getTursoClient(), scoped.scope, id);
    if (!t) return json(404, { ok: false, error: "conversation_not_found" });
    return json(200, {
      ok: true,
      conversation: { id: t.conversation.id, department: t.conversation.department, title: t.conversation.title },
      runs: t.runs,
    });
  });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const scoped = await resolveRunScope();
  if (!scoped.ok) return json(scoped.status, { ok: false, error: scoped.error });
  if (!tursoConfigured()) return json(503, { ok: false, error: "database_not_configured" });
  let body: { title?: unknown };
  try {
    body = (await req.json()) as { title?: unknown };
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }
  if (typeof body.title !== "string" || !body.title.trim()) return json(400, { ok: false, error: "title_required" });
  const title = body.title;
  return guarded("rename", id, async () => {
    const ok = await renameConversation(getTursoClient(), scoped.scope, id, title, new Date());
    return ok ? json(200, { ok: true }) : json(404, { ok: false, error: "conversation_not_found" });
  });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const scoped = await resolveRunScope();
  if (!scoped.ok) return json(scoped.status, { ok: false, error: scoped.error });
  if (!tursoConfigured()) return json(503, { ok: false, error: "database_not_configured" });
  return guarded("delete", id, async () => {
    const ok = await deleteConversation(getTursoClient(), scoped.scope, id);
    return ok ? json(200, { ok: true }) : json(404, { ok: false, error: "conversation_not_found" });
  });
}
