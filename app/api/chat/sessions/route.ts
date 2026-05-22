/**
 * GET /api/chat/sessions
 *
 * List the operator's past chat sessions for a given agent so the
 * /agents page sidebar can show "your previous conversations."
 * Without this, every chat is a one-shot — the operator has no way
 * to go back to the strategy thread from yesterday and pick up
 * where they left off.
 *
 * Auth: standard session resolution. Sessions are scoped to
 * (tenant_id, user_id) so two operators on the same tenant don't
 * see each other's chats.
 *
 * Query params:
 *   ?agent=bravo          required — filters to this agent
 *   ?limit=50             optional, default 50, capped at 200
 *
 * Response:
 *   { ok: true, sessions: [
 *       { id, agent_key, title, created_at, last_message_at,
 *         message_count, preview }
 *     ]
 *   }
 *
 * Empty `sessions: []` is normal for a fresh tenant.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { isTenantChatAgent } from "@/lib/manifest/tenant-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function bad(status: number, error: string, code?: string) {
  const body: { ok: false; error: string; code?: string } = { ok: false, error };
  if (code) body.code = code;
  return NextResponse.json(body, { status });
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return bad(401, "unauthorized");

  const url = req.nextUrl;
  const agentKey = (url.searchParams.get("agent") || "").toLowerCase();
  if (!agentKey) return bad(400, "missing_agent");

  const rawLimit = parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 50));

  const service = getServiceSupabase();
  // Resolve tenant_id from the user profile so the session filter is
  // scoped to the right org. Without this any session row across the
  // platform could leak if RLS isn't perfectly aligned with the
  // service-role client (we use service role here for the count
  // join below).
  const { data: profile } = await service
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profile as { tenant_id: string | null } | null)?.tenant_id || null;
  if (!tenantId) return bad(403, "no_tenant");

  // Validate the agent_key against the tenant's manifest-aware allowlist —
  // same gate /api/chat uses. Custom marketplace agents are accepted via
  // the manifest path; unknown slugs return an empty list rather than
  // 400 so the UI degrades gracefully.
  if (!(await isTenantChatAgent(tenantId, agentKey))) {
    return NextResponse.json({ ok: true, sessions: [] });
  }

  // Fetch the operator's sessions for this agent, newest first by
  // last activity. The `updated_at` column reflects the most recent
  // append to the session; falls back to created_at for legacy rows
  // that pre-date the trigger.
  const { data: sessions, error: sessionsErr } = await service
    .from("chat_sessions")
    .select("id, agent_key, title, created_at, updated_at")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("agent_key", agentKey)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (sessionsErr) {
    console.error("[chat/sessions.list]", sessionsErr.message);
    return bad(500, "sessions_query_failed");
  }
  const rows = (sessions || []) as Array<{
    id: string;
    agent_key: string;
    title: string | null;
    created_at: string;
    updated_at: string | null;
  }>;

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, sessions: [] });
  }

  // For each session, find the last assistant message + count so the
  // sidebar can show preview text + how busy each thread is. One
  // round-trip per session would be N+1; instead pull all the
  // session_ids' messages in one query and group client-side.
  const sessionIds = rows.map((r) => r.id);
  const { data: latestMessages } = await service
    .from("chat_messages")
    .select("session_id, role, content, created_at")
    .in("session_id", sessionIds)
    .order("created_at", { ascending: false })
    .limit(sessionIds.length * 4); // grab the last ~4 messages per session

  // Group by session and pull the most recent message preview per id.
  const previewBySession = new Map<string, { preview: string; lastMessageAt: string }>();
  const countBySession = new Map<string, number>();
  for (const m of (latestMessages || []) as Array<{
    session_id: string;
    role: string;
    content: string;
    created_at: string;
  }>) {
    countBySession.set(m.session_id, (countBySession.get(m.session_id) || 0) + 1);
    if (!previewBySession.has(m.session_id)) {
      // Take the FIRST encountered message per session (which is the
      // latest in time because the query ordered desc) regardless of
      // role — the operator wants to see what the conversation was
      // about, user or assistant.
      const cleaned = m.content.replace(/\s+/g, " ").trim().slice(0, 140);
      previewBySession.set(m.session_id, {
        preview: cleaned,
        lastMessageAt: m.created_at,
      });
    }
  }

  const out = rows.map((r) => {
    const preview = previewBySession.get(r.id);
    return {
      id: r.id,
      agent_key: r.agent_key,
      title: r.title,
      created_at: r.created_at,
      last_message_at: preview?.lastMessageAt || r.updated_at || r.created_at,
      message_count: countBySession.get(r.id) || 0,
      preview: preview?.preview || "",
    };
  });

  return NextResponse.json({ ok: true, sessions: out });
}
