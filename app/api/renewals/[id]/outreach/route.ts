import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canWriteCrm } from "@/lib/role-gates";
import { getServiceSupabase } from "@/lib/supabase-server";
import { lenderContact, lenderRenewalMessage, resolveAgentMailbox } from "@/lib/renewals/outreach";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!canWriteCrm(session.teamRole)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => ({})) as { action?: string };
  if (!["approve", "retry", "cancel"].includes(body.action || "")) return NextResponse.json({ ok: false, error: "invalid_action" }, { status: 400 });
  const db = getServiceSupabase();
  const eventRes = await db.from("renewal_outreach_events").select("*").eq("tenant_id", session.tenantId).eq("funded_deal_id", id).eq("event_kind", "50_percent").maybeSingle();
  if (!eventRes.data) return NextResponse.json({ ok: false, error: "event_not_found" }, { status: 404 });
  const event = eventRes.data as Record<string, unknown>;
  if (body.action === "cancel") {
    if (event.scheduled_send_id) await db.from("scheduled_sends").update({ status: "cancelled" }).eq("tenant_id", session.tenantId).eq("id", event.scheduled_send_id).in("status", ["pending", "failed"]);
    await db.from("renewal_outreach_events").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", event.id);
    return NextResponse.json({ ok: true, status: "cancelled" });
  }
  if (event.status === "sent" || event.status === "queued") return NextResponse.json({ ok: false, error: "already_dispatched" }, { status: 409 });
  const dealRes = await db.from("funded_deals").select("*").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
  if (!dealRes.data) return NextResponse.json({ ok: false, error: "deal_not_found" }, { status: 404 });
  const deal = dealRes.data as Record<string, unknown>;
  const lenderRes = await db.from("tenant_records").select("data").eq("tenant_id", session.tenantId).eq("entity_type", "lender").eq("id", deal.lender_id).maybeSingle();
  const lenderEmail = lenderContact((lenderRes.data?.data || {}) as Record<string, unknown>);
  const agentId = typeof event.assigned_agent_id === "string" ? event.assigned_agent_id : null;
  const sender = agentId ? await resolveAgentMailbox(session.tenantId, agentId) : null;
  if (!lenderEmail || !agentId || !sender) {
    const reason = !lenderEmail ? "lender_email_missing" : !agentId ? "assigned_agent_missing" : "agent_mailbox_missing";
    await db.from("renewal_outreach_events").update({ status: "blocked", last_error: reason }).eq("id", event.id);
    return NextResponse.json({ ok: false, error: reason }, { status: 409 });
  }
  const message = lenderRenewalMessage(String(deal.merchant_name || "the merchant"));
  const queued = await db.from("scheduled_sends").insert({
    tenant_id: session.tenantId, lead_id: deal.lead_id, thread_key: `renewal-lender:${id}`,
    channel: "email", to_email: lenderEmail, subject: message.subject, body: message.body,
    actor_user_id: agentId, from_identity: sender, scheduled_for: new Date().toISOString(), status: "pending",
  }).select("id").single();
  if (queued.error) {
    await db.from("renewal_outreach_events").update({ status: "failed", last_error: queued.error.message, attempts: Number(event.attempts || 0) + 1 }).eq("id", event.id);
    return NextResponse.json({ ok: false, error: "queue_failed" }, { status: 500 });
  }
  await db.from("renewal_outreach_events").update({ status: "queued", scheduled_send_id: queued.data.id, last_error: null, updated_at: new Date().toISOString() }).eq("id", event.id);
  return NextResponse.json({ ok: true, status: "queued" });
}
