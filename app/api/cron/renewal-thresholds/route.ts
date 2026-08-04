import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { lenderContact, lenderRenewalMessage, notifyRenewalAgent, resolveAgentMailbox } from "@/lib/renewals/outreach";
import { formatTerm, isTermUnit } from "@/lib/renewals/derive";

export const runtime = "nodejs";
export const maxDuration = 60;

async function run(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  const db = getServiceSupabase();
  const queuedEvents = await db.from("renewal_outreach_events").select("id,scheduled_send_id")
    .eq("status", "queued").not("scheduled_send_id", "is", null).limit(100);
  for (const event of queuedEvents.data || []) {
    const send = await db.from("scheduled_sends").select("status,sent_at,last_error,attempts").eq("id", event.scheduled_send_id).maybeSingle();
    if (send.data?.status === "sent") await db.from("renewal_outreach_events").update({ status: "sent", sent_at: send.data.sent_at }).eq("id", event.id);
    if (send.data?.status === "failed") await db.from("renewal_outreach_events").update({ status: "failed", last_error: send.data.last_error, attempts: send.data.attempts }).eq("id", event.id);
  }
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const deals = await db.from("funded_deals").select("*").not("next_renewal_date", "is", null).lte("next_renewal_date", today).limit(100);
  if (deals.error) return NextResponse.json({ ok: false, error: deals.error.message }, { status: 500 });
  const summary = { discovered: 0, queued: 0, review_required: 0, blocked: 0 };
  for (const raw of deals.data || []) {
    const deal = raw as {
      id: string; tenant_id: string; lead_id: string | null; lender_id: string | null;
      merchant_name: string; lender_name: string | null; funded_amount_usd: number;
      funded_at: string; term_months: number | null; term_value: number | null;
      term_unit: string | null; next_renewal_date: string;
    };
    const existing = await db.from("renewal_outreach_events").select("id").eq("funded_deal_id", deal.id).eq("event_kind", "50_percent").maybeSingle();
    if (existing.data) continue;
    const [leadRes, lenderRes] = await Promise.all([
      deal.lead_id ? db.from("tenant_records").select("data").eq("tenant_id", deal.tenant_id).eq("id", deal.lead_id).eq("entity_type", "lead").maybeSingle() : null,
      deal.lender_id ? db.from("tenant_records").select("data").eq("tenant_id", deal.tenant_id).eq("id", deal.lender_id).eq("entity_type", "lender").maybeSingle() : null,
    ]);
    const lead = (leadRes?.data?.data || {}) as Record<string, unknown>;
    const lender = (lenderRes?.data?.data || {}) as Record<string, unknown>;
    const agentId = typeof lead.assigned_to === "string" ? lead.assigned_to : null;
    const lenderEmail = lenderContact(lender);
    const sender = agentId ? await resolveAgentMailbox(deal.tenant_id, agentId) : null;
    const historical = String(deal.next_renewal_date) < yesterday;
    let status = historical ? "review_required" : (!lenderEmail || !sender || !agentId ? "blocked" : "pending");
    const inserted = await db.from("renewal_outreach_events").insert({
      tenant_id: deal.tenant_id, funded_deal_id: deal.id, lead_id: deal.lead_id,
      lender_id: deal.lender_id, assigned_agent_id: agentId, threshold_date: deal.next_renewal_date,
      status, last_error: !lenderEmail ? "lender_email_missing" : !agentId ? "assigned_agent_missing" : !sender ? "agent_mailbox_missing" : null,
    }).select("id").single();
    if (inserted.error) continue;
    summary.discovered++;
    const notice = await notifyRenewalAgent({
      db, tenantId: deal.tenant_id, leadId: deal.lead_id, agentId,
      merchant: deal.merchant_name, lender: String(lender.name || deal.lender_name || "Unlinked"),
      amount: Number(deal.funded_amount_usd), fundedAt: deal.funded_at,
      termLabel: formatTerm(Number(deal.term_value ?? deal.term_months), isTermUnit(deal.term_unit) ? deal.term_unit : "months"),
      thresholdDate: deal.next_renewal_date, dealId: deal.id, status,
    });
    await db.from("renewal_outreach_events").update({
      internal_email_at: notice.email ? new Date().toISOString() : null,
      telegram_at: notice.telegram ? new Date().toISOString() : null,
    }).eq("id", inserted.data.id);
    if (status === "pending" && lenderEmail && sender && agentId) {
      const message = lenderRenewalMessage(deal.merchant_name);
      const queued = await db.from("scheduled_sends").insert({
        tenant_id: deal.tenant_id, lead_id: deal.lead_id, thread_key: `renewal-lender:${deal.id}`,
        channel: "email", to_email: lenderEmail, subject: message.subject, body: message.body,
        actor_user_id: agentId, from_identity: sender, scheduled_for: new Date().toISOString(), status: "pending",
      }).select("id").single();
      status = queued.error ? "failed" : "queued";
      await db.from("renewal_outreach_events").update({
        status, scheduled_send_id: queued.data?.id || null, last_error: queued.error?.message || null,
      }).eq("id", inserted.data.id);
    }
    if (status === "queued") summary.queued++;
    else if (status === "review_required") summary.review_required++;
    else if (status === "blocked") summary.blocked++;
  }
  return NextResponse.json({ ok: true, ...summary });
}
export const GET = run;
export const POST = run;
