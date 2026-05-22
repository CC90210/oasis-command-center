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
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function bad(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return bad(401, "unauthorized");

  const { id } = await params;
  const sessionId = (id || "").trim();
  if (!sessionId) return bad(404, "session_not_found");

  const service = getServiceSupabase();

  // Resolve tenant_id so the session lookup can enforce
  // (tenant_id, user_id) ownership. Empty profile -> tenant missing
  // -> we can't validate ownership -> deny.
  const { data: profile } = await service
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profile as { tenant_id: string | null } | null)?.tenant_id || null;
  if (!tenantId) return bad(404, "session_not_found");

  const { data: sessionRow, error: sessionErr } = await service
    .from("chat_sessions")
    .select("id, agent_key, title, created_at, updated_at")
    .eq("id", sessionId)
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
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
