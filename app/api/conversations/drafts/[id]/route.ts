import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { checkPhoneOptOut, normalizePhoneE164 } from "@/lib/lead-interactions-queries";
import { sanitizeBlastMessage } from "@/lib/integrations/blast-safety";
import { canManageSunbizDraft, isSunbizDraftAction, isWithinSmsHours, normalizeDraftText } from "@/lib/sunbiz-draft-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DraftRow = {
  id: string; tenant_id: string; status: string; original_text: string; to_phone: string;
  lead_id: string | null; thread_key: string; conversation_state_id: string;
  agent_account_id: string;
  created_at: string;
};

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: session.reason }, { status: session.reason === "no_session" ? 401 : 400 });
  if (!canManageSunbizDraft(session.teamRole)) {
    return NextResponse.json({ ok: false, error: "forbidden_role" }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (!isSunbizDraftAction(body.action)) return NextResponse.json({ ok: false, error: "invalid_action" }, { status: 400 });

  const db = getServiceSupabase();
  const found = await db.from("sunbiz_reply_drafts")
    .select("id,tenant_id,status,original_text,to_phone,lead_id,thread_key,conversation_state_id,agent_account_id,created_at")
    .eq("id", id).eq("tenant_id", session.tenantId).maybeSingle();
  if (found.error) return NextResponse.json({ ok: false, error: "draft_lookup_failed" }, { status: 503 });
  const draft = found.data as DraftRow | null;
  if (!draft) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const accessAccount = await db.from("sunbiz_agent_accounts").select("user_id")
    .eq("id", draft.agent_account_id).eq("tenant_id", session.tenantId).maybeSingle();
  if (accessAccount.error || !accessAccount.data) return NextResponse.json({ ok: false, error: "account_lookup_failed" }, { status: 503 });
  if (!session.isAdmin && accessAccount.data.user_id !== session.userId) {
    return NextResponse.json({ ok: false, error: "not_assigned" }, { status: 403 });
  }

  if (body.action === "pause" || body.action === "resume") {
    const paused = body.action === "pause";
    const changed = await db.from("sunbiz_conversation_state")
      .update({ automation_paused: paused, last_action: body.action, updated_at: new Date().toISOString() })
      .eq("id", draft.conversation_state_id).eq("tenant_id", session.tenantId).select("id").maybeSingle();
    if (changed.error || !changed.data) return NextResponse.json({ ok: false, error: "state_update_failed" }, { status: 503 });
    return NextResponse.json({ ok: true, automation_paused: paused });
  }

  if (body.action === "handoff") {
    const handoffUserId = typeof body.handoff_user_id === "string" && UUID_RE.test(body.handoff_user_id) ? body.handoff_user_id : null;
    if (!handoffUserId) return NextResponse.json({ ok: false, error: "invalid_handoff_user" }, { status: 400 });
    const target = await db.from("user_profiles").select("auth_user_id").eq("tenant_id", session.tenantId)
      .eq("auth_user_id", handoffUserId).maybeSingle();
    if (target.error || !target.data) return NextResponse.json({ ok: false, error: "handoff_user_not_found" }, { status: 404 });
    const changed = await db.from("sunbiz_reply_drafts")
      .update({ handoff_user_id: handoffUserId, handoff_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", id).eq("tenant_id", session.tenantId).eq("status", "pending").select("id").maybeSingle();
    if (changed.error || !changed.data) return NextResponse.json({ ok: false, error: "draft_not_pending" }, { status: 409 });
    await db.from("sunbiz_conversation_state").update({ human_owner_id: handoffUserId, automation_paused: true, last_action: "handoff" })
      .eq("id", draft.conversation_state_id).eq("tenant_id", session.tenantId);
    return NextResponse.json({ ok: true, handoff_user_id: handoffUserId });
  }

  if (body.action === "reject") {
    const changed = await db.from("sunbiz_reply_drafts")
      .update({ status: "rejected", rejected_by: session.userId, rejected_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", id).eq("tenant_id", session.tenantId).eq("status", "pending").select("id").maybeSingle();
    if (changed.error || !changed.data) return NextResponse.json({ ok: false, error: "draft_not_pending" }, { status: 409 });
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  const message = body.action === "edit_send" ? normalizeDraftText(body.message) : normalizeDraftText(draft.original_text);
  if (!message) return NextResponse.json({ ok: false, error: "invalid_message" }, { status: 400 });
  const phone = normalizePhoneE164(draft.to_phone);
  if (!phone) return NextResponse.json({ ok: false, error: "invalid_phone" }, { status: 409 });

  if (Date.now() - Date.parse(draft.created_at) > 24 * 60 * 60 * 1000) {
    return NextResponse.json({ ok: false, error: "draft_stale" }, { status: 409 });
  }
  const account = await db.from("sunbiz_agent_accounts").select("id,user_id,mode,enabled,from_number,timezone")
    .eq("id", draft.agent_account_id).eq("tenant_id", session.tenantId).eq("provider", "texttorrent").maybeSingle();
  if (account.error || !account.data || !account.data.enabled || account.data.mode !== "semi") {
    return NextResponse.json({ ok: false, error: "account_not_sendable" }, { status: 409 });
  }
  if (!isWithinSmsHours(account.data.timezone)) {
    return NextResponse.json({ ok: false, error: "quiet_hours" }, { status: 409 });
  }
  const state = await db.from("sunbiz_conversation_state").select("automation_paused")
    .eq("id", draft.conversation_state_id).eq("tenant_id", session.tenantId).maybeSingle();
  if (state.error || !state.data || state.data.automation_paused) {
    return NextResponse.json({ ok: false, error: "conversation_paused" }, { status: 409 });
  }
  const suppression = await checkPhoneOptOut(session.tenantId, phone);
  if (suppression.checkFailed) return NextResponse.json({ ok: false, error: "suppression_check_failed" }, { status: 503 });
  if (suppression.optedOut) return NextResponse.json({ ok: false, error: "opted_out" }, { status: 409 });
  const safe = await sanitizeBlastMessage(session.tenantId, message, { checkPositioning: true });
  if (!safe.ok) return NextResponse.json({ ok: false, error: safe.reason, message: safe.message }, { status: 400 });

  // Conditional transition is the single-use claim. Only its winner may enqueue.
  const claimed = await db.from("sunbiz_reply_drafts").update({
    status: "approved", final_text: safe.cleaned, approved_by: session.userId,
    approved_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", id).eq("tenant_id", session.tenantId).eq("status", "pending").select("id").maybeSingle();
  if (claimed.error || !claimed.data) return NextResponse.json({ ok: false, error: "draft_not_pending" }, { status: 409 });

  const queued = await db.from("scheduled_sends").insert({
    tenant_id: session.tenantId, lead_id: draft.lead_id, thread_key: draft.thread_key,
    channel: "sms", to_phone: phone, body: safe.cleaned, actor_user_id: session.userId,
    from_identity: account.data.from_number, scheduled_for: new Date().toISOString(), status: "pending",
  }).select("id").single();
  if (queued.error || !queued.data) {
    await db.from("sunbiz_reply_drafts").update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", id).eq("tenant_id", session.tenantId).eq("status", "approved");
    return NextResponse.json({ ok: false, error: "enqueue_failed" }, { status: 503 });
  }
  await db.from("sunbiz_reply_drafts").update({ scheduled_send_id: queued.data.id, updated_at: new Date().toISOString() })
    .eq("id", id).eq("tenant_id", session.tenantId).eq("status", "approved");
  return NextResponse.json({ ok: true, status: "approved", scheduled_send_id: queued.data.id });
}
