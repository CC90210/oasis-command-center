import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { isUniqueViolationError } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import { WEBSITE_PACKAGES, WEBSITE_SALES_STAGES, isSellableAutomation, validateQuote, type WebsitePackageId } from "@/lib/website-sales";
import { dispositionPatch, mayAgentBookFounder, mayAgentQualify, type RepDisposition } from "@/lib/website-sales-workflow";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok:false,error:"unauthorized" },{status:401});
  const { leadId } = await params;
  if (!UUID.test(leadId)) return NextResponse.json({ok:false,error:"invalid_lead_id"},{status:400});
  const db = getServiceSupabase();
  const lead = await db.from("tenant_records").select("id,data").eq("tenant_id", session.tenantId).eq("id",leadId).eq("entity_type","lead").maybeSingle();
  if (!lead.data) return NextResponse.json({ok:false,error:"lead_not_found"},{status:404});
  // The lead's fields live in the row's `data` JSON column — the row object
  // itself only has {id, data}. Reading sales_program/assigned_to off the row
  // (the pre-v2 shape of this line) made every request 404 as
  // not_website_sales_lead before any action could run.
  const row = lead.data as { id: string; data?: unknown };
  const current = (row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : {}) as Record<string,unknown>;
  if (current.sales_program !== "website_sales_v1") return NextResponse.json({ok:false,error:"not_website_sales_lead"},{status:404});
  const assignedToUser = String(current.assigned_to || "").toLowerCase() === session.userId.toLowerCase();
  const attributedToUser = String(current.attributed_rep_user_id || "").toLowerCase() === session.userId.toLowerCase();
  if (!session.isAdmin && !assignedToUser && !attributedToUser) {
    return NextResponse.json({ok:false,error:"lead_not_assigned_to_agent"},{status:403});
  }
  // Comp v2: reps (team_role='agent') may run proposal + close THEMSELVES on
  // their own leads (assigned or frozen-attributed). Founder approval still
  // gates the commission PAYOUT — closing only accrues.
  const repMayRunDeal = session.teamRole === "agent" && (assignedToUser || attributedToUser);
  const body = await req.json().catch(() => null) as Record<string,unknown>|null;
  if (!body || typeof body.action !== "string") return NextResponse.json({ok:false,error:"invalid_body"},{status:400});
  const repAction = ["disposition","qualify","book_founder"].includes(body.action);
  const requestId = typeof body.requestId === "string" && UUID.test(body.requestId) ? body.requestId : null;
  if (repAction && !requestId) return NextResponse.json({ok:false,error:"request_id_required"},{status:400});
  if (requestId) {
    const prior = await db.from("lead_interactions").select("id,metadata").eq("tenant_id",session.tenantId).eq("lead_id",leadId).order("created_at",{ascending:false}).limit(50);
    if (prior.error) return NextResponse.json({ok:false,error:"idempotency_check_failed",detail:prior.error.message,correlationId:requestId},{status:500});
    const duplicate = (prior.data || []).some((row: { metadata?: unknown }) => {
      const metadata = row.metadata as Record<string,unknown>|null;
      return metadata?.request_id === requestId;
    });
    if (duplicate) return NextResponse.json({ok:true,idempotent:true});
  }
  let patch: Record<string,unknown> = {};
  if (body.action === "disposition") {
    const disposition = String(body.disposition || "");
    const allowed = ["attempted", "voicemail", "connected", "lost"];
    if (!allowed.includes(disposition)) return NextResponse.json({ok:false,error:"invalid_disposition"},{status:400});
    if (!["assigned","attempting_contact","connected","qualified"].includes(String(current.stage || ""))) return NextResponse.json({ok:false,error:"invalid_stage_transition"},{status:409});
    const nextActionAt = typeof body.nextActionAt === "string" && body.nextActionAt ? body.nextActionAt : null;
    try { patch = dispositionPatch(disposition as RepDisposition,nextActionAt,new Date().toISOString(),String(body.lossReason || "")); }
    catch (error) { return NextResponse.json({ok:false,error:error instanceof Error ? error.message : "invalid_disposition"},{status:400}); }
  } else if (body.action === "qualify") {
    if (!mayAgentQualify(current.stage)) return NextResponse.json({ok:false,error:"connect_before_qualifying"},{status:409});
    const q = body.qualification as Record<string,unknown>|undefined;
    if (!q || !["authorityConfirmed","websiteProblemConfirmed","timingConfirmed","minimumInvestmentConfirmed"].every(k => q[k] === true)) return NextResponse.json({ok:false,error:"qualification_incomplete"},{status:400});
    patch = { qualification:q, stage:"qualified", qualified_at:new Date().toISOString() };
  } else if (body.action === "book_founder") {
    if (!mayAgentBookFounder(current.stage)) return NextResponse.json({ok:false,error:"qualify_before_booking"},{status:409});
    if (![body.founderUserId,body.meetingAt,body.promisedDemo].every(v => typeof v === "string" && v.length>0) || !UUID.test(String(body.founderUserId))) return NextResponse.json({ok:false,error:"invalid_handoff"},{status:400});
    if (!Number.isFinite(Date.parse(String(body.meetingAt))) || Date.parse(String(body.meetingAt)) <= Date.now()) return NextResponse.json({ok:false,error:"meeting_must_be_in_future"},{status:400});
    if (String(body.promisedDemo).trim().length > 500) return NextResponse.json({ok:false,error:"promised_demo_too_long"},{status:400});
    const founder = await db.from("user_profiles").select("id,is_owner,team_role").eq("tenant_id",session.tenantId).eq("auth_user_id",body.founderUserId).maybeSingle();
    if (!founder.data || (!founder.data.is_owner && !["owner","admin"].includes(String(founder.data.team_role)))) return NextResponse.json({ok:false,error:"founder_not_authorized"},{status:400});
    const existingRep = typeof current.attributed_rep_user_id === "string" && UUID.test(current.attributed_rep_user_id) ? current.attributed_rep_user_id : session.userId;
    patch = { stage:"founder_meeting_booked", booked_founder:body.founderUserId, founder_meeting_at:body.meetingAt, promised_demo:body.promisedDemo, attributed_rep_user_id:existingRep, attribution_frozen_at:current.attribution_frozen_at || new Date().toISOString() };
  } else if (body.action === "set_stage") {
    if (!WEBSITE_SALES_STAGES.includes(body.stage as never)) return NextResponse.json({ok:false,error:"invalid_stage"},{status:400});
    if (!session.isAdmin) return NextResponse.json({ok:false,error:"rep_stage_forbidden"},{status:403});
    patch = { stage:body.stage };
  } else if (body.action === "proposal") {
    if (!session.isTrueAdmin && !repMayRunDeal) return NextResponse.json({ok:false,error:"founder_only"},{status:403});
    const packageId = body.packageId as WebsitePackageId;
    const automationIds = Array.isArray(body.automationIds) ? body.automationIds : [];
    // Retired add-ons stay resolvable for historical deals but can never be
    // attached to a NEW quote — isSellableAutomation is the only gate.
    if (!WEBSITE_PACKAGES[packageId] || !automationIds.every(isSellableAutomation)) return NextResponse.json({ok:false,error:"invalid_offer"},{status:400});
    const check = validateQuote(packageId,Number(body.setupAmount),Number(body.monthlyAmount),session.isTrueAdmin);
    if (!check.ok) return NextResponse.json({ok:false,error:check.error},{status:400});
    patch = { stage:"proposal_sent", recommended_tier:packageId, automation_interests:automationIds, proposal_status:"sent", quoted_setup_amount:Number(body.setupAmount), quoted_monthly_amount:Number(body.monthlyAmount), currency:body.currency === "USD" ? "USD" : "CAD" };
  } else if (body.action === "close") {
    if (!session.isTrueAdmin && !repMayRunDeal) return NextResponse.json({ok:false,error:"founder_only"},{status:403});
    const rep = String(current.attributed_rep_user_id || current.assigned_to || "");
    if (!UUID.test(rep) || typeof body.paymentReference !== "string" || !body.paymentReference.trim()) return NextResponse.json({ok:false,error:"missing_attribution_or_payment"},{status:400});
    // Comp v2: the CLOSER decides the rate. A rep closing their own attributed
    // lead is the opener-closer path (30%); a founder close pays the attributed
    // rep the opener rate (20%). The RPC re-verifies both sides (agent role +
    // frozen attribution; owner/admin for founder closes) — this flag alone
    // never grants anything.
    const closedByRep = !session.isTrueAdmin && rep.toLowerCase() === session.userId.toLowerCase();
    // website_deals.founder_user_id: the founder who closed; on a rep-close,
    // the founder from the booked meeting when one exists, else the rep
    // themselves (self-run deal with no founder in the loop).
    const bookedFounder = typeof current.booked_founder === "string" && UUID.test(current.booked_founder) ? current.booked_founder : null;
    const founderUserId = closedByRep ? (bookedFounder ?? session.userId) : session.userId;
    const result = await db.rpc("close_website_deal", { p_tenant_id:session.tenantId,p_lead_id:leadId,p_rep_user_id:rep,p_founder_user_id:founderUserId,p_package_id:body.packageId,p_automation_ids:body.automationIds||[],p_currency:body.currency,p_setup_amount:body.setupAmount,p_monthly_amount:body.monthlyAmount,p_payment_reference:body.paymentReference,p_closed_by_rep:closedByRep });
    if (result.error) return NextResponse.json({ok:false,error:result.error.message},{status:500});
    return NextResponse.json({ok:true,result:result.data});
  } else return NextResponse.json({ok:false,error:"unknown_action"},{status:400});
  const updated = await db.rpc("patch_tenant_record_data",{p_id:leadId,p_tenant_id:session.tenantId,p_patch:patch});
  if (updated.error) return NextResponse.json({ok:false,error:updated.error.message},{status:500});
  if (repAction && requestId) {
    const interaction = await db.from("lead_interactions").insert({
      tenant_id:session.tenantId,
      lead_id:leadId,
      type:body.action === "disposition" ? "call_disposition" : body.action === "qualify" ? "qualification_completed" : "founder_handoff",
      channel:"system",
      direction:"outbound",
      agent_source:"website_sales_pipeline",
      subject:String(body.action).replaceAll("_"," "),
      content:body.action === "disposition" ? `Call result: ${String(body.disposition || "unknown")}` : body.action === "qualify" ? "Four website-sales qualification gates confirmed." : `Founder meeting booked. Promised demo: ${String(body.promisedDemo || "")}`,
      content_preview:String(body.action),
      metadata:{ request_id:requestId, action:body.action, changed_by:session.userId, correlation_id:requestId },
    });
    if (interaction.error) {
      if (isUniqueViolationError(interaction.error)) return NextResponse.json({ok:true,idempotent:true});
      return NextResponse.json({ok:false,error:"interaction_log_failed",detail:interaction.error.message,correlationId:requestId,stageUpdated:true},{status:500});
    }
  }
  return NextResponse.json({ok:true,data:updated.data});
}
