import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { canManageSunbizDraft } from "@/lib/sunbiz-draft-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: session.reason }, { status: session.reason === "no_session" ? 401 : 400 });
  if (!canManageSunbizDraft(session.teamRole)) return NextResponse.json({ ok: false, error: "forbidden_role" }, { status: 403 });
  const threadKey = (req.nextUrl.searchParams.get("thread_key") || "").trim();
  if (!threadKey || threadKey.length > 500) return NextResponse.json({ ok: false, error: "invalid_thread_key" }, { status: 400 });

  const db = getServiceSupabase();
  let query = db.from("sunbiz_reply_drafts")
    .select("id,conversation_state_id,agent_account_id,lead_id,thread_key,to_phone,original_text,status,intent,confidence,model_id,model_version,knowledge_version,created_at")
    .eq("tenant_id", session.tenantId).eq("thread_key", threadKey).eq("status", "pending")
    .order("created_at", { ascending: false }).limit(1);
  const found = await query.maybeSingle();
  if (found.error) return NextResponse.json({ ok: false, error: "draft_lookup_failed" }, { status: 503 });
  if (!found.data) return NextResponse.json({ ok: true, draft: null });

  const account = await db.from("sunbiz_agent_accounts").select("user_id,display_name,mode")
    .eq("id", found.data.agent_account_id).eq("tenant_id", session.tenantId).maybeSingle();
  if (account.error || !account.data) return NextResponse.json({ ok: false, error: "account_lookup_failed" }, { status: 503 });
  if (!session.isAdmin && account.data.user_id !== session.userId) {
    return NextResponse.json({ ok: true, draft: null });
  }
  const state = await db.from("sunbiz_conversation_state").select("automation_paused")
    .eq("id", found.data.conversation_state_id).eq("tenant_id", session.tenantId).maybeSingle();
  if (state.error || !state.data) return NextResponse.json({ ok: false, error: "state_lookup_failed" }, { status: 503 });

  return NextResponse.json({
    ok: true,
    draft: {
      ...found.data,
      agent_display_name: account.data.display_name,
      agent_mode: account.data.mode,
      automation_paused: state.data.automation_paused,
    },
  });
}
