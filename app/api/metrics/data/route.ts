/**
 * GET /api/metrics/data?days=N — the Metrics payload for a chosen window, so the
 * dashboard's date-range selector (7/30/90) can re-fetch client-side without a
 * full page reload. Session-gated; reuses getEmailMetrics (capped at 90 days).
 */
import { NextRequest, NextResponse } from "next/server";
import { getActiveProfile } from "@/lib/queries";
import { getSessionUser } from "@/lib/supabase-server";
import { getEmailMetrics } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const profile = await getActiveProfile();
  const tenantId = profile?.tenant_id || "";
  const raw = Number(req.nextUrl.searchParams.get("days") || "30");
  const days = Math.min(90, Math.max(1, isFinite(raw) ? Math.round(raw) : 30));
  const payload = await getEmailMetrics(tenantId, days);
  return NextResponse.json({ ok: true, payload });
}
