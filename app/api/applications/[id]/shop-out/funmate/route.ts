import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { canViewLead, leadScopingEnabled } from "@/lib/lead-scope";
import { buildShopOutPlan, autoAdvanceToShopping, type ShopOutAttachment } from "@/lib/lenders/shop-out";
import { complianceProfileInputs, type ApplicationProfile } from "@/lib/lenders/match-fitness";
import { transformSunbizApplicationForFunmate, renderFunmateSubmission } from "@/lib/lenders/funmate-transform";
import { sendFunmateMail } from "@/lib/integrations/funmate-mail-send";
import { verifyFunmateSmtp } from "@/lib/integrations/funmate-mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UUID_RE = /^[0-9a-f-]{36}$/i;
const MAX_LENDERS = 12;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: applicationId } = await ctx.params;
  if (!UUID_RE.test(applicationId)) return NextResponse.json({ ok: false, error: "invalid_application_id" }, { status: 400 });
  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });

  let body: {
    lender_ids?: string[];
    cc_emails?: string[];
    attachments?: ShopOutAttachment[];
    notes?: string;
    dry_run?: boolean;
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 }); }

  const lenderIds = Array.isArray(body.lender_ids) ? [...new Set(body.lender_ids.filter((v) => typeof v === "string"))] : [];
  if (!lenderIds.length || lenderIds.length > MAX_LENDERS) {
    return NextResponse.json({ ok: false, error: lenderIds.length ? "too_many_lenders" : "lender_ids_required", max: MAX_LENDERS }, { status: 400 });
  }
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (attachments.some((a) => !a.storage_path?.startsWith(`${sess.tenantId}/`) || a.storage_path.includes(".."))) {
    return NextResponse.json({ ok: false, error: "attachment_outside_tenant" }, { status: 400 });
  }

  const db = getServiceSupabase();
  const [appResult, lenderResult] = await Promise.all([
    db.from("tenant_records").select("id,data").eq("tenant_id", sess.tenantId).eq("entity_type", "application").eq("id", applicationId).maybeSingle(),
    db.from("tenant_records").select("id,data").eq("tenant_id", sess.tenantId).eq("entity_type", "lender").in("id", lenderIds),
  ]);
  if (!appResult.data) return NextResponse.json({ ok: false, error: "application_not_found" }, { status: 404 });
  if ((lenderResult.data || []).length !== lenderIds.length) return NextResponse.json({ ok: false, error: "lender_not_found" }, { status: 404 });
  const appData = (appResult.data as { data: Record<string, unknown> }).data || {};
  if (!canViewLead({ isAdmin: sess.isAdmin, userId: sess.userId }, appData, leadScopingEnabled(), "isolate")) {
    return NextResponse.json({ ok: false, error: "application_not_found" }, { status: 404 });
  }
  const wrongNetwork = (lenderResult.data || []).filter((row) => {
    const data = (row as { data: Record<string, unknown> }).data || {};
    return String(data.lender_network || "sunbiz") !== "funmate";
  });
  if (wrongNetwork.length) {
    return NextResponse.json({ ok: false, error: "funmate_route_requires_funmate_lenders" }, { status: 409 });
  }

  let transformed;
  try { transformed = transformSunbizApplicationForFunmate(applicationId, appData); }
  catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "funmate_transform_failed" }, { status: 422 });
  }
  const application: ApplicationProfile = {
    id: applicationId,
    monthly_revenue: transformed.funding.monthlyRevenue ?? undefined,
    time_in_business_months: transformed.business.timeInBusinessMonths ?? undefined,
    applicant_fico: transformed.owner.fico ?? undefined,
    requested_amount: transformed.funding.requestedAmount ?? undefined,
    desired_product: transformed.funding.desiredProduct ?? undefined,
    ...complianceProfileInputs(appData),
  };
  const planResult = await buildShopOutPlan({
    tenant_id: sess.tenantId,
    application,
    lender_ids: lenderIds,
    cc_emails: Array.isArray(body.cc_emails) ? body.cc_emails.filter((v) => typeof v === "string" && v.includes("@")) : [],
    attachments,
  });
  if (!planResult.ok) return NextResponse.json({ ok: false, error: planResult.error }, { status: 500 });
  const rendered = renderFunmateSubmission(transformed, typeof body.notes === "string" ? body.notes.slice(0, 2000) : "");
  if (body.dry_run) {
    return NextResponse.json({ ok: true, dry_run: true, identity: "funmate", transformed, plan: planResult.plan.map((p) => ({ ...p, rendered_subject: rendered.subject, rendered_body: rendered.text })) });
  }

  const connection = await verifyFunmateSmtp();
  if (!connection.ok) return NextResponse.json({ ok: false, error: "funmate_mail_unreachable", detail: connection.error }, { status: 503 });

  const results: Array<Record<string, unknown>> = [];
  for (const row of planResult.plan) {
    if (!row.recipient_email) {
      results.push({ lender_id: row.lender_id, lender_name: row.lender_name, status: "failed", error: "missing_recipient" });
      continue;
    }
    const inserted = await db.from("application_lender_threads").insert({
      tenant_id: sess.tenantId,
      application_id: applicationId,
      lender_id: row.lender_id,
      subject: rendered.subject,
      body_template: rendered.text,
      attachments,
      cc_emails: row.recipient_cc_emails,
      email_identity: "funmate",
      status: "sending",
      last_error: null,
    }).select("id").single();
    if (inserted.error || !inserted.data) {
      results.push({ lender_id: row.lender_id, lender_name: row.lender_name, status: "failed", error: "thread_insert_failed" });
      continue;
    }
    const threadId = String((inserted.data as { id: unknown }).id);
    const sent = await sendFunmateMail({
      to: row.recipient_email,
      cc: row.recipient_cc_emails,
      subject: rendered.subject,
      text: rendered.text,
      tenantId: sess.tenantId,
      attachments,
    });
    await db.from("application_lender_threads").update(sent.ok ? {
      status: "sent",
      sent_at: new Date().toISOString(),
      gmail_thread_id: sent.rfc822MessageId,
      last_message_id: sent.rfc822MessageId,
      message_id_history: [sent.rfc822MessageId],
      last_error: null,
    } : { status: "error", last_error: sent.error }).eq("tenant_id", sess.tenantId).eq("id", threadId);
    results.push({ lender_id: row.lender_id, lender_name: row.lender_name, status: sent.ok ? "sent" : "failed", error: sent.ok ? null : sent.error });
  }
  const sentCount = results.filter((r) => r.status === "sent").length;
  if (sentCount) await autoAdvanceToShopping(sess.tenantId, applicationId);
  return NextResponse.json({ ok: true, identity: "funmate", transformed, sent: sentCount, failed: results.length - sentCount, results });
}

