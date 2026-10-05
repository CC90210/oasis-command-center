/**
 * GET    /api/devices             — list paired machines for the authed tenant
 * DELETE /api/devices?id=<uuid>   — revoke a pairing (sets revoked_at, the
 *                                   bridge daemon will see 403 on next ping
 *                                   and self-stop)
 */

import { NextResponse, type NextRequest } from "next/server";
import { bad } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canAccessSharedTenantResource } from "@/lib/shared-tenant-resource-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await resolveSessionContext();
  if (!session.ok) return bad(401, "unauthorized");
  if (!(await canAccessSharedTenantResource(session))) return bad(403, "forbidden");
  const tenantId = session.tenantId;
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("bridge_pairings")
    .select("id, label, machine_fingerprint, last_seen_at, last_seen_ip, created_at, revoked_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  if (error) return bad(500, error.message);
  return NextResponse.json({ ok: true, devices: data || [] });
}

export async function DELETE(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) return bad(401, "unauthorized");
  if (!(await canAccessSharedTenantResource(session))) return bad(403, "forbidden");
  const tenantId = session.tenantId;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return bad(400, "id required");
  const db = getServiceSupabase();
  // Tenant-scope the update — operator can't revoke another tenant's pairing
  const { error } = await db
    .from("bridge_pairings")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId);
  if (error) return bad(500, error.message);
  return NextResponse.json({ ok: true });
}
