import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { AUTOMATION_ADD_ONS, WEBSITE_PACKAGES, WEBSITE_SALES_STAGES, validateQuote, type WebsitePackageId } from "@/lib/website-sales";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok:false,error:"unauthorized" },{status:401});
  const { leadId } = await params;
  if (!UUID.test(leadId)) return NextResponse.json({ok:false,error:"invalid_lead_id"},{status:400});
  const db = getServiceSupabase();
  const lead = await db.from("tenant_records").select("id,data").eq("tenant_id", session.tenantId).eq("id",leadId).eq("entity_type","lead").maybeSingle();
  if (!lead.data) return NextResponse.json({ok:false,error:"lead_not_found"},{status:404});
  const body = await req.json().catch(() => null) as Record<string,unknown>|null;
  if (!body || typeof body.action !== "string") return NextResponse.json({ok:false,error:"invalid_body"},{status:400});
  let patch: Record<string,unknown> = {};
  if (body.action === "qualify") {
    const q = body.qualification as Record<string,unknown>|undefined;
    if (!q || !["authorityConfirmed","websiteProblemConfirmed","timingConfirmed","minimumInvestmentConfirmed"].every(k => q[k] === true)) return NextResponse.json({ok:false,error:"qualification_incomplete"},{status:400});
    patch = { qualification:q, stage:"qualified", qualified_at:new Date().toISOString() };
  } else if (body.action === "book_founder") {
    if (![body.founderUserId,body.meetingAt,body.promisedDemo].every(v => typeof v === "string" && v.length>0) || !UUID.test(String(body.founderUserId))) return NextResponse.json({ok:false,error:"invalid_handoff"},{status:400});
    const current = lead.data as Record<string,unknown>;
    const existingRep = typeof current.attributed_rep_user_id === "string" && UUID.test(current.attributed_rep_user_id) ? current.attributed_rep_user_id : session.userId;
    patch = { stage:"founder_meeting_booked", booked_founder:body.founderUserId, founder_meeting_at:body.meetingAt, promised_demo:body.promisedDemo, attributed_rep_user_id:existingRep, attribution_frozen_at:current.attribution_frozen_at || new Date().toISOString() };
  } else if (body.action === "set_stage") {
    if (!WEBSITE_SALES_STAGES.includes(body.stage as never)) return NextResponse.json({ok:false,error:"invalid_stage"},{status:400});
    if (!session.isTrueAdmin && !["researched","assigned","attempting_contact","connected"].includes(String(body.stage))) return NextResponse.json({ok:false,error:"rep_stage_forbidden"},{status:403});
    patch = { stage:body.stage };
  } else if (body.action === "proposal") {
    if (!session.isTrueAdmin) return NextResponse.json({ok:false,error:"founder_only"},{status:403});
    const packageId = body.packageId as WebsitePackageId;
    const automationIds = Array.isArray(body.automationIds) ? body.automationIds : [];
    if (!WEBSITE_PACKAGES[packageId] || automationIds.some(id => !AUTOMATION_ADD_ONS.some(a => a.id === id))) return NextResponse.json({ok:false,error:"invalid_offer"},{status:400});
    const check = validateQuote(packageId,Number(body.setupAmount),Number(body.monthlyAmount),session.isTrueAdmin);
    if (!check.ok) return NextResponse.json({ok:false,error:check.error},{status:400});
    patch = { stage:"proposal_sent", recommended_tier:packageId, automation_interests:automationIds, proposal_status:"sent", quoted_setup_amount:Number(body.setupAmount), quoted_monthly_amount:Number(body.monthlyAmount), currency:body.currency === "USD" ? "USD" : "CAD" };
  } else if (body.action === "close") {
    if (!session.isTrueAdmin) return NextResponse.json({ok:false,error:"founder_only"},{status:403});
    const data = lead.data as Record<string,unknown>;
    const rep = String(data.attributed_rep_user_id || data.assigned_to || "");
    if (!UUID.test(rep) || typeof body.paymentReference !== "string" || !body.paymentReference.trim()) return NextResponse.json({ok:false,error:"missing_attribution_or_payment"},{status:400});
    const result = await db.rpc("close_website_deal", { p_tenant_id:session.tenantId,p_lead_id:leadId,p_rep_user_id:rep,p_founder_user_id:session.userId,p_package_id:body.packageId,p_automation_ids:body.automationIds||[],p_currency:body.currency,p_setup_amount:body.setupAmount,p_monthly_amount:body.monthlyAmount,p_payment_reference:body.paymentReference });
    if (result.error) return NextResponse.json({ok:false,error:result.error.message},{status:500});
    return NextResponse.json({ok:true,result:result.data});
  } else return NextResponse.json({ok:false,error:"unknown_action"},{status:400});
  const updated = await db.rpc("patch_tenant_record_data",{p_id:leadId,p_tenant_id:session.tenantId,p_patch:patch});
  if (updated.error) return NextResponse.json({ok:false,error:updated.error.message},{status:500});
  return NextResponse.json({ok:true,data:updated.data});
}
