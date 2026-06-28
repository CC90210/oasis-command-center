/**
 * GET /api/campaigns/lists/intelligence — per-list outreach scoring for the
 * List Intelligence view. Reads list_intelligence (maintained by the collector);
 * instant (no live TT). Ranked by score desc.
 */

import { NextResponse } from "next/server";
import { resolveTenantId } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const db = getServiceSupabase();
  const r = await db
    .from("list_intelligence")
    .select("list_id,list_name,campaigns_count,total_sent,total_replies,total_conversions,reply_rate,conversion_rate,score,verdict,last_campaign_at,last_computed_at")
    .eq("tenant_id", tenantId)
    .order("score", { ascending: false })
    .limit(200);
  return NextResponse.json({ ok: true, lists: r.data || [] });
}
