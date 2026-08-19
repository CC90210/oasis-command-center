import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";

export async function GET() {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ok:false,error:"unauthorized"},{status:401});
  const db = getServiceSupabase();
  let query = db.from("website_sales_commissions").select("id,deal_id,rep_user_id,payment_reference,entry_type,collected_setup_amount,rate,amount,status,approved_at,paid_at,created_at").eq("tenant_id", session.tenantId).order("created_at",{ascending:false});
  if (!session.isAdmin) query = query.eq("rep_user_id", session.userId);
  const result = await query;
  if (result.error) return NextResponse.json({ok:false,error:result.error.message},{status:500});
  return NextResponse.json({ok:true,data:result.data});
}

export async function PATCH(req: Request) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ok:false,error:"unauthorized"},{status:401});
  if (!session.isTrueAdmin) return NextResponse.json({ok:false,error:"founder_only"},{status:403});
  const body = await req.json().catch(()=>null) as {id?:string;status?:string}|null;
  if (!body?.id || !["approved","paid","voided"].includes(body.status||"")) return NextResponse.json({ok:false,error:"invalid_body"},{status:400});
  const patch: Record<string,unknown> = {status:body.status,updated_at:new Date().toISOString()};
  if (body.status === "approved") Object.assign(patch,{approved_by:session.userId,approved_at:new Date().toISOString()});
  if (body.status === "paid") patch.paid_at = new Date().toISOString();
  const result = await getServiceSupabase().from("website_sales_commissions").update(patch).eq("tenant_id", session.tenantId).eq("id",body.id).select("id,status").maybeSingle();
  if (result.error) return NextResponse.json({ok:false,error:result.error.message},{status:500});
  if (!result.data) return NextResponse.json({ok:false,error:"not_found"},{status:404});
  return NextResponse.json({ok:true,data:result.data});
}
