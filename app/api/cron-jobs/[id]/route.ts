/**
 * /api/cron-jobs/[id] — per-row PATCH / DELETE for tenant cron jobs.
 *
 * RLS-scoped via the session cookie (same model as /api/cron-jobs GET/POST).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { getSessionContext, canManageTeam } from "@/lib/team";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { getTenantEnabledAgents } from "@/lib/manifest/tenant-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reuse the validators from the parent route by re-declaring inline
// (don't want to expand the export surface of /api/cron-jobs unnecessarily).
const CRON_FIELD = /^(\*|\*\/\d+|\d+(-\d+)?(\/\d+)?(,\d+(-\d+)?(\/\d+)?)*)$/;
function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => CRON_FIELD.test(p));
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  // Admin-only: editing/enabling a scheduled job. Owners pass canManageTeam,
  // so the operator empire-row fallback below still works for CC.
  const session = await getSessionContext();
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!canManageTeam(session.teamRole, session.adminAccess)) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Only owners/admins can edit automations." },
      { status: 403 },
    );
  }
  const tenantId = session.tenantId;
  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  // Patch is intentionally narrow — only the fields operators commonly toggle.
  // Changing action_type / action_payload on an existing row is rare enough
  // that "delete and recreate" is the right UX; keeps validation simple.
  const update: Record<string, unknown> = {};
  if (typeof body.name === "string") {
    update.name = body.name.trim().slice(0, 80);
    if (!update.name) {
      return NextResponse.json({ ok: false, error: "name_cannot_be_empty" }, { status: 400 });
    }
  }
  if (typeof body.description === "string" || body.description === null) {
    update.description = body.description ? String(body.description).slice(0, 500) : null;
  }
  if (typeof body.schedule === "string") {
    if (!isValidCron(body.schedule)) {
      return NextResponse.json({ ok: false, error: "invalid_cron_expression" }, { status: 400 });
    }
    update.schedule = body.schedule.trim();
  }
  if (typeof body.enabled === "boolean") {
    update.enabled = body.enabled;
  }
  if (typeof body.agent_key === "string") {
    const nextAgentKey = body.agent_key.toLowerCase();
    const allowedAgents = await getTenantEnabledAgents(tenantId);
    if (allowedAgents.length > 0 && !allowedAgents.includes(nextAgentKey)) {
      return NextResponse.json(
        {
          ok: false,
          error: `agent_key_not_allowed_for_tenant:${nextAgentKey}`,
          allowed: allowedAgents,
        },
        { status: 403 },
      );
    }
    update.agent_key = nextAgentKey;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: false, error: "no_editable_fields_supplied" }, { status: 400 });
  }

  const db = getServiceSupabase();
  const { data, error } = await db
    .from("tenant_cron_jobs")
    .update(update)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .select()
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (data) return NextResponse.json({ ok: true, job: data });

  // Empire fallback — operators pause/resume SEED_JOBS rows without code
  // edits. Only enabled is honoured; schedule/action_config would drift
  // from cron_engine.SEED_JOBS which re-asserts every bridge tick.
  // isOperatorEmail gate matches the GET route's empire-lane filter.
  const user = await getSessionUser().catch(() => null);
  if (!isOperatorEmail(user?.email || undefined)) {
    return NextResponse.json({ ok: false, error: "not_found_or_forbidden" }, { status: 404 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ ok: false, error: "empire_rows_only_accept_enabled_toggle" }, { status: 400 });
  }
  const empireRes = await db
    .from("cron_jobs")
    .update({ is_active: body.enabled })
    .eq("id", id)
    .select()
    .maybeSingle();
  if (empireRes.error) {
    return NextResponse.json({ ok: false, error: empireRes.error.message }, { status: 500 });
  }
  if (!empireRes.data) {
    return NextResponse.json({ ok: false, error: "not_found_or_forbidden" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, job: empireRes.data, source: "empire" });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSessionContext();
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!canManageTeam(session.teamRole, session.adminAccess)) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Only owners/admins can delete automations." },
      { status: 403 },
    );
  }
  const tenantId = session.tenantId;
  const { id } = await ctx.params;

  const db = getServiceSupabase();
  const { error, count } = await db
    .from("tenant_cron_jobs")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("tenant_id", tenantId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!count) return NextResponse.json({ ok: false, error: "not_found_or_forbidden" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
