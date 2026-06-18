/**
 * GET /api/chat/sessions/[id]
 *
 * Load the full message thread for one chat session so the operator
 * can resume a past conversation from the /agents sidebar. Pairs
 * with GET /api/chat/sessions which lists the session metadata.
 *
 * Auth: session must belong to (caller's tenant_id, caller's user_id).
 * Cross-tenant or cross-user access returns 404, not 403 — we don't
 * want to leak the existence of someone else's session by error code.
 *
 * Response:
 *   {
 *     ok: true,
 *     session: { id, agent_key, title, created_at, updated_at },
 *     messages: [
 *       { role: "user"|"assistant", content, created_at }
 *     ]
 *   }
 *
 * Errors:
 *   401 unauthorized        — no session user
 *   404 session_not_found   — id invalid, or belongs to someone else
 *   500 messages_query_failed
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function bad(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Shared session->tenant resolution (same helper /api/chat/sessions
  // list uses). Any reason that isn't "no session" gets collapsed to
  // 404 so we don't leak the existence of other tenants' sessions via
  // a distinct error code.
  const ctx = await resolveSessionContext();
  if (!ctx.ok) {
    if (ctx.reason === "no_session") return bad(401, "unauthorized");
    return bad(404, "session_not_found");
  }
  const { userId, tenantId } = ctx;

  const { id } = await params;
  const sessionId = (id || "").trim();
  if (!sessionId) return bad(404, "session_not_found");

  const service = getServiceSupabase();
  const { data: sessionRow, error: sessionErr } = await service
    .from("chat_sessions")
    .select("id, agent_key, title, provider, created_at, updated_at")
    .eq("id", sessionId)
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();

  if (sessionErr) {
    console.error("[chat/sessions/[id].lookup]", sessionErr.message);
    return bad(500, "session_lookup_failed");
  }
  if (!sessionRow) return bad(404, "session_not_found");

  const session = sessionRow as {
    id: string;
    agent_key: string;
    title: string | null;
    // "bridge" for CLI/bridge-path threads, an LLM provider for cloud threads.
    // The client uses this to resume on the correct id (tab_id vs session_id).
    provider: string | null;
    created_at: string;
    updated_at: string | null;
  };

  const { data: messages, error: messagesErr } = await service
    .from("chat_messages")
    .select("role, content, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(500);

  if (messagesErr) {
    console.error("[chat/sessions/[id].messages]", messagesErr.message);
    return bad(500, "messages_query_failed");
  }

  return NextResponse.json({
    ok: true,
    session,
    messages: (messages || []) as Array<{
      role: string;
      content: string;
      created_at: string;
    }>,
  });
}
