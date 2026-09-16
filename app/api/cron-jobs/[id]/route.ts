/**
 * /api/cron-jobs/[id] — per-row PATCH / DELETE for scheduled jobs.
 *
 * Both storage lanes are tenant-scoped. Empire writes additionally require a
 * recognized platform-operator email and are limited to enabled-state toggles.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { getSessionContext, canManageTeam } from "@/lib/team";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { getTenantEnabledAgents } from "@/lib/manifest/tenant-scope";
import {
  normalizeEmpireRow,
  normalizeTenantCronRow,
  type EmpireCronRow,
} from "@/lib/cron-empire-row";
import {
  toggleCronWithAudit,
  type CronToggleSource,
} from "@/lib/automations/cron-toggle-transaction";
import { toggleLegacyCronWithAudit } from "@/lib/automations/cron-toggle-legacy";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

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
  const user = await getSessionUser().catch(() => null);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const source = body.source as CronToggleSource | undefined;
  if (source !== "tenant" && source !== "empire") {
    return NextResponse.json({ ok: false, error: "source_required" }, { status: 400 });
  }
  if (source === "empire" && !isOperatorEmail(user?.email || undefined)) {
    return NextResponse.json({ ok: false, error: "not_found_or_forbidden" }, { status: 404 });
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
  if (source === "empire" && (Object.keys(update).length !== 1 || typeof update.enabled !== "boolean")) {
    return NextResponse.json(
      { ok: false, error: "empire_rows_only_accept_enabled_toggle" },
      { status: 400 },
    );
  }
  if (typeof update.enabled === "boolean" && Object.keys(update).length !== 1) {
    return NextResponse.json(
      { ok: false, error: "enabled_toggle_must_be_single_field" },
      { status: 400 },
    );
  }

  if (typeof body.enabled === "boolean") {
    // Match getServiceSupabase().from() exactly. That inventory adapter moves
    // table reads to Turso only for the live `turso_cloud` flag with usable
    // Turso credentials; every other accepted/legacy deployment reads the
    // Supabase lane. Dispatching from a broader parser here would split the
    // toggle write from the row the operator just read.
    const backendMode = process.env.EMPIRE_DATA_BACKEND === "turso_cloud"
      && tursoConfigured()
      ? "turso"
      : "supabase";
    try {
      const toggleInput = {
        source,
        id,
        tenantId,
        enabled: body.enabled,
        actorEmail: user?.email ?? null,
        actorUserId: session.authUserId,
      };
      // Both backends commit scheduler state + audit in one database
      // transaction. Supabase uses a service-role-only RPC because separate
      // REST requests cannot make that guarantee under transport failure.
      const result = backendMode === "turso"
        ? await toggleCronWithAudit(getTursoClient(), toggleInput)
        : await toggleLegacyCronWithAudit(getServiceSupabase(), toggleInput);
      if (!result.ok) {
        return NextResponse.json(result.body, { status: result.status });
      }
      const job = source === "empire"
        ? normalizeEmpireRow(result.row as unknown as EmpireCronRow)
        : normalizeTenantCronRow(result.row);
      return NextResponse.json({ ok: true, job });
    } catch (error) {
      console.error("[api/cron-jobs PATCH] atomic toggle failed", {
        source,
        id,
        tenantId,
        error,
      });
      return NextResponse.json(
        {
          ok: false,
          error: "atomic_toggle_failed",
          message: "The update could not be confirmed. Refresh the inventory before retrying.",
        },
        { status: 503 },
      );
    }
  }

  const db = getServiceSupabase();
  // Non-toggle edits exist only for the tenant lane; Empire definitions stay
  // code-owned. The write and its separate readback remain tenant-scoped.
  const updateResult = await db
    .from("tenant_cron_jobs")
    .update(update)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .select()
    .maybeSingle();
  if (updateResult.error) {
    return NextResponse.json({ ok: false, error: updateResult.error.message }, { status: 500 });
  }
  if (!updateResult.data) {
    return NextResponse.json({ ok: false, error: "not_found_or_forbidden" }, { status: 404 });
  }

  const persistedResult = await db
    .from("tenant_cron_jobs")
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (persistedResult.error || !persistedResult.data) {
    return NextResponse.json(
      {
        ok: false,
        error: "edit_readback_failed",
        message: persistedResult.error?.message,
      },
      { status: 503 },
    );
  }
  const persisted = persistedResult.data as unknown as Record<string, unknown>;
  const job = normalizeTenantCronRow(persisted);
  return NextResponse.json({ ok: true, job });
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
