/**
 * GET /api/web-leads/territories
 *
 * Admin-only roster for the assignment control (components/web-leads/
 * TerritoryAssignment.tsx): every territory in the tenant with its current
 * owner and callable-lead count, so an admin can find a sheet and see who
 * (if anyone) already holds it.
 *
 * Same auth spine as the assign route (401 unauthenticated, 403 wrong
 * tenant, 403 non-admin — all before any read). Gated admin-only, not just
 * tenant-only: `assigned_to` across 1,600+ territories describes the shape
 * of the whole book, which is exactly the kind of leak #237 closed on the
 * lead-facing routes (see the doc comment on facets/route.ts).
 */

import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TerritoryRow = {
  id: string;
  region: string;
  locality: string;
  vertical: string;
  leads_callable: number | null;
  assigned_to: string | null;
};

export async function GET() {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  }
  if (session.tenantId !== WEBDEV_TENANT_ID) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (!session.isAdmin) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const db = getServiceSupabase();
  const territories = await db
    .from("leadgen_territories")
    .select("id,region,locality,vertical,leads_callable,assigned_to")
    .eq("tenant_id", WEBDEV_TENANT_ID);
  if (territories.error) {
    return NextResponse.json({ ok: false, error: territories.error.message }, { status: 500 });
  }

  const rows = ((territories.data || []) as TerritoryRow[])
    .filter((t) => (t.leads_callable || 0) > 0)
    .sort((a, b) => (b.leads_callable || 0) - (a.leads_callable || 0));
  return NextResponse.json({ ok: true, territories: rows });
}
