/**
 * GET /api/lenders/[id]/intelligence — the LEARNED profile for one lender:
 * approval/decline rates, decline-reason histogram, by-paper-grade breakdown,
 * avg approved amount/factor, and recent outcomes. Powers the per-lender
 * intelligence view (turns the static common_decline_reasons into learned ones).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { getLenderIntelligence } from "@/lib/lenders/lender-intelligence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const db = getServiceSupabase();
  const profileRes = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profileRes.data as { tenant_id: string | null } | null)?.tenant_id ?? null;
  if (!tenantId) return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 401 });

  const { id: lenderId } = await ctx.params;
  const intelligence = await getLenderIntelligence(tenantId, lenderId);
  return NextResponse.json({ ok: true, intelligence });
}
