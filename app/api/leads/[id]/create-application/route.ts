/**
 * POST /api/leads/[id]/create-application — create (or reuse) the application
 * linked to a lead so underwriting can run from the lead's Bank tab.
 *
 * Used by the "Run underwriting" CTA in the lead drawer when the lead has no
 * application yet (manually-created lead, or a form-intake lead under the
 * lead-first lifecycle). The actual underwriting run is a separate POST to
 * /api/applications/[appId]/underwriting/run — this route just ensures the
 * application exists first. Idempotent (reuses an existing application).
 *
 * Auth: session-gated; member+ role (read_only denied, parity with the SMS
 * reply + call routes); lead-ownership verified against the caller's tenant.
 */

import { NextResponse, type NextRequest, after } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { createApplicationFromLead } from "@/lib/applications/create-from-lead";
import { generateApplicationDocumentFromRecord } from "@/lib/forms/application-document";
import { canWriteCrm } from "@/lib/role-gates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: leadId } = await ctx.params;
  if (!UUID_RE.test(leadId)) {
    return NextResponse.json({ ok: false, error: "invalid_lead_id" }, { status: 400 });
  }

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const db = getServiceSupabase();
  const profile = await db
    .from("user_profiles")
    .select("tenant_id,team_role")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profile.data as { tenant_id?: string | null } | null)?.tenant_id;
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });
  }
  // Member+ gate: any CRM-write role may create an application; read_only and
  // unknown roles are denied. canWriteCrm is allowlist-based (fail-closed).
  const teamRole = (profile.data as { team_role?: string | null } | null)?.team_role;
  if (!canWriteCrm(teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't start an application." },
      { status: 403 },
    );
  }

  // Ownership: the lead must belong to the caller's tenant (mirrors the Call route).
  const leadRow = await db
    .from("tenant_records")
    .select("id")
    .eq("id", leadId)
    .eq("tenant_id", tenantId)
    .eq("entity_type", "lead")
    .maybeSingle();
  if (!leadRow.data) {
    return NextResponse.json(
      { ok: false, error: "lead_not_found", message: "Lead not found for this workspace." },
      { status: 404 },
    );
  }

  const result = await createApplicationFromLead({ tenantId, leadId });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  // Best-effort, non-blocking: ensure the application has its app-form PDF filed
  // (the underwriting CTA creates the app without going through the form).
  after(() => generateApplicationDocumentFromRecord({ tenantId, applicationId: result.applicationId }));

  return NextResponse.json({
    ok: true,
    application_id: result.applicationId,
    created: result.created,
  });
}
