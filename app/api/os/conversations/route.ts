/**
 * GET /api/os/conversations?department=<key> - your saved conversations in one
 * department channel, newest first (the channel's "Past chats").
 *
 * Yours only: every query carries the workspace AND you
 * (lib/os/runs/store.ts). An owner or admin does not see a member's chats.
 * `active_runs` above 0 marks a chat that is still working.
 */
import { type NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { RunsUnavailableError, listConversations } from "@/lib/os/runs/store";
import { resolveRunScope, json } from "@/lib/os/runs/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const department = (req.nextUrl.searchParams.get("department") ?? "").trim();
  if (!OS_DEPARTMENTS.some((d) => d.key === department)) return json(400, { ok: false, error: "unknown_department" });
  const scoped = await resolveRunScope();
  if (!scoped.ok) return json(scoped.status, { ok: false, error: scoped.error });
  if (!tursoConfigured()) return json(503, { ok: false, error: "database_not_configured" });
  try {
    const list = await listConversations(getTursoClient(), scoped.scope, department);
    return json(200, {
      ok: true,
      conversations: list.map((c) => ({
        id: c.id,
        title: c.title,
        last_message_at: c.lastMessageAt,
        created_at: c.createdAt,
        active_runs: c.activeRuns,
      })),
    });
  } catch (err) {
    if (err instanceof RunsUnavailableError) return json(503, { ok: false, error: "chat_history_unavailable" });
    console.error("[os.conversations.list]", { department, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    return json(500, { ok: false, error: "list_failed" });
  }
}
