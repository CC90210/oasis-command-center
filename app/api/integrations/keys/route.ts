/**
 * /api/integrations/keys — per-tenant integration key store CRUD.
 *
 *   GET     — list every stored (service, field_key) presence + test
 *             status. NEVER returns the plaintext or ciphertext value.
 *   POST    — upsert one field. Body: { service, field_key, value }.
 *   DELETE  — remove one field. Body: { service, field_key }.
 *
 * Auth: session-cookie → tenant. Only `owner` / `admin` team roles
 * can mutate; everyone in the tenant can read presence.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { canManageTeam, type TeamRole } from "@/lib/team";
import {
  setTenantIntegrationValue,
  deleteTenantIntegrationValue,
  listTenantIntegrationStatus,
} from "@/lib/tenant-integration-store";
import {
  findIntegrationSchema,
  validateIntegrationValue,
} from "@/lib/tenant-integration-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Re-uses the canonical `canManageTeam` helper from lib/team so the
// owner+admin gate stays in lockstep with the rest of the dashboard
// (Team management, Plan templates, Branding all use the same shape).
async function canManageTenant(tenantId: string, userId: string): Promise<boolean> {
  const db = getServiceSupabase();
  const r = await db
    .from("user_profiles")
    .select("team_role, is_owner")
    .eq("auth_user_id", userId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const row = r.data as { team_role: TeamRole | null; is_owner: boolean | null } | null;
  if (!row) return false;
  if (row.is_owner) return true;
  return canManageTeam(row.team_role || "member");
}

export async function GET() {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  const status = await listTenantIntegrationStatus(sess.tenantId);
  return NextResponse.json({ ok: true, rows: status });
}

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  if (!(await canManageTenant(sess.tenantId, sess.userId))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body: { service?: unknown; field_key?: unknown; value?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const service = typeof body.service === "string" ? body.service.toLowerCase() : "";
  const fieldKey = typeof body.field_key === "string" ? body.field_key.toLowerCase() : "";
  const value = typeof body.value === "string" ? body.value : "";

  const schema = findIntegrationSchema(service);
  if (!schema) {
    return NextResponse.json({ ok: false, error: "unknown_service" }, { status: 400 });
  }
  const fieldDef = schema.fields.find((f) => f.key === fieldKey);
  if (!fieldDef) {
    return NextResponse.json({ ok: false, error: "unknown_field" }, { status: 400 });
  }
  const validation = validateIntegrationValue(fieldDef, value);
  if (validation) {
    return NextResponse.json({ ok: false, error: validation }, { status: 422 });
  }

  const result = await setTenantIntegrationValue({
    tenantId: sess.tenantId,
    service,
    fieldKey,
    value,
    createdBy: sess.profileId,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, id: result.id });
}

export async function DELETE(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  if (!(await canManageTenant(sess.tenantId, sess.userId))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body: { service?: unknown; field_key?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const service = typeof body.service === "string" ? body.service.toLowerCase() : "";
  const fieldKey = typeof body.field_key === "string" ? body.field_key.toLowerCase() : "";
  if (!service || !fieldKey) {
    return NextResponse.json({ ok: false, error: "missing_service_or_field" }, { status: 400 });
  }
  const result = await deleteTenantIntegrationValue({
    tenantId: sess.tenantId,
    service,
    fieldKey,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
