import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function adminSession() {
  const session = await resolveSessionContext();
  if (!session.ok) return { response: NextResponse.json({ ok: false, error: session.reason }, { status: 401 }) };
  if (session.tenantId !== WEBDEV_TENANT_ID || !session.isAdmin) {
    return { response: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  }
  return { session };
}

export async function GET() {
  const auth = await adminSession();
  if ("response" in auth) return auth.response;
  const db = getServiceSupabase();
  const [territories, agents] = await Promise.all([
    db.from("leadgen_territories")
      .select("id,name,region,locality,vertical,leads_callable,assigned_to")
      .eq("tenant_id", WEBDEV_TENANT_ID),
    db.from("user_profiles")
      .select("auth_user_id,display_name,full_name")
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("team_role", "agent"),
  ]);
  if (territories.error || agents.error) {
    return NextResponse.json({ ok: false, error: territories.error?.message || agents.error?.message || "assignment_read_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, territories: territories.data || [], agents: agents.data || [] });
}

export async function POST(req: NextRequest) {
  const auth = await adminSession();
  if ("response" in auth) return auth.response;
  let body: { territory_id?: unknown; assigned_to?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 }); }
  const territoryId = typeof body.territory_id === "string" ? body.territory_id.trim().toLowerCase() : "";
  const assignedTo = body.assigned_to == null || body.assigned_to === ""
    ? null
    : typeof body.assigned_to === "string" ? body.assigned_to.trim().toLowerCase() : "invalid";
  if (!UUID_RE.test(territoryId) || (assignedTo !== null && !UUID_RE.test(assignedTo))) {
    return NextResponse.json({ ok: false, error: "invalid_assignment" }, { status: 400 });
  }
  const db = getServiceSupabase();
  const result = await db.rpc("assign_web_lead_territory", {
    p_tenant_id: WEBDEV_TENANT_ID,
    p_territory_id: territoryId,
    p_assigned_to: assignedTo,
  });
  if (result.error) return NextResponse.json({ ok: false, error: result.error.message }, { status: 400 });
  return NextResponse.json({ ok: true, ...(result.data as Record<string, unknown>) });
}
