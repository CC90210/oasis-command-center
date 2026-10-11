/**
 * /api/cron-jobs/[id] — per-row PATCH / DELETE for scheduled jobs.
 *
 * Both storage lanes are tenant-scoped. Empire (house) writes additionally
 * require the workspace's AGENTS OWNER (lib/agents-owner.ts — O2, 2026-10-11;
 * before that, any verified platform operator, which PR #576 made Adon too)
 * and are limited to enabled-state toggles.
 *
 * Tenant-lane writes are scoped to the row's owner_user_id (O2): every PATCH
 * and DELETE needs owner_user_id = the caller's auth id, EXCEPT an owner/admin
 * may switch someone else's automation OFF (never on, edit, reschedule or
 * delete it) — see refuseUnownedWrite below. owner_user_id itself is never in
 * the editable-fields list, so it can never change through this route.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { getSessionContext, canManageTeam } from "@/lib/team";
import { isAgentsOwner } from "@/lib/agents-owner";
import { isMissingColumnError } from "@/lib/api-helpers";
import { getTenantEnabledAgents, oasisOperatorAgents } from "@/lib/manifest/tenant-scope";
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
import { isDepartmentTask } from "@/lib/automations/action-types";
import { isValidCronExpr } from "@/lib/automations/cron-grammar";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TenantRowForWrite = { id: string; action_type: unknown; owner_user_id: string | null };

/**
 * A department task is never written through this route. Its switch, edits and
 * deletion go through /api/automations/department-tasks/[id], which re-signs
 * the brief, checks the owner and the admin lock, arms or clears the pending
 * run and writes the audit row. A direct write here would skip all of that.
 *
 * Reads the whole row (`select("*")`, not a named column list), scoped to the
 * session's workspace — a deployment whose owner_user_id migration has not
 * landed yet simply never sees that key on the returned object, rather than
 * failing the read with "no such column". Returns the response to send, or
 * the row this route may keep handling. A row that is not in this workspace
 * is the same 404 the write itself would give; a failed read fails closed.
 */
async function loadTenantRowForWrite(
  id: string,
  tenantId: string,
): Promise<{ ok: true; row: TenantRowForWrite } | { ok: false; response: NextResponse }> {
  const read = await getServiceSupabase()
    .from("tenant_cron_jobs")
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (read.error) {
    console.error("[api/cron-jobs/[id]] job type read failed", { id, tenantId, error: read.error.message });
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "job_lookup_failed", message: "We couldn't read this automation just now. Nothing was changed." },
        { status: 503 },
      ),
    };
  }
  if (!read.data) {
    return { ok: false, response: NextResponse.json({ ok: false, error: "not_found_or_forbidden" }, { status: 404 }) };
  }
  const data = read.data as Record<string, unknown>;
  if (isDepartmentTask(data.action_type)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error: "use_department_task_route",
          message: "This is a department task. Change, switch or delete it from its own page in Automations.",
        },
        { status: 409 },
      ),
    };
  }
  const ownerUserId = typeof data.owner_user_id === "string" && data.owner_user_id ? data.owner_user_id : null;
  return { ok: true, row: { id: String(data.id), action_type: data.action_type, owner_user_id: ownerUserId } };
}

/**
 * O2's ownership rule, as one refusal. `isPureSwitchOff` is true only for a
 * body that sets `enabled: false` and touches no other editable field — the
 * one write an owner/admin may make to someone else's automation. A legacy
 * row with no recorded owner (owner_user_id null) is everyone's to manage, so
 * this never fires for one.
 */
function refuseUnownedWrite(
  row: TenantRowForWrite,
  authUserId: string,
  isPureSwitchOff: boolean,
): NextResponse | null {
  if (!row.owner_user_id || row.owner_user_id === authUserId) return null;
  if (isPureSwitchOff) return null;
  return NextResponse.json(
    {
      ok: false,
      error: "not_your_automation",
      message: "This automation belongs to someone else. You can switch it off, but not turn it on, edit, reschedule or delete it.",
    },
    { status: 403 },
  );
}

/** Fields a write other than a plain enabled-toggle may carry. */
const OTHER_EDITABLE_FIELDS = ["name", "description", "schedule", "agent_key"] as const;

/** True only for a body that switches a row OFF and touches nothing else —
 *  the one write O2 lets an owner/admin make to someone else's automation. */
function isPureSwitchOffBody(body: Record<string, unknown>): boolean {
  return body.enabled === false && !OTHER_EDITABLE_FIELDS.some((field) => field in body);
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  // Admin-only: editing/enabling a scheduled job. Owners pass canManageTeam,
  // so the house-row (empire) fallback below still works for the agents owner.
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
  // O2: the house lane's toggle needs the agents owner, not merely a verified
  // operator — Adon is one (PR #576) but CCPC is not his computer.
  if (source === "empire" && !(await isAgentsOwner(tenantId, session.authUserId))) {
    return NextResponse.json({ ok: false, error: "not_found_or_forbidden" }, { status: 404 });
  }
  // Department tasks live only in the tenant lane, refused before any field is
  // read so a toggle and an edit are both stopped. O2 also enforces row
  // ownership here: everyone but the row's owner may only switch it OFF.
  let tenantRow: TenantRowForWrite | null = null;
  if (source === "tenant") {
    const loaded = await loadTenantRowForWrite(id, tenantId);
    if (!loaded.ok) return loaded.response;
    tenantRow = loaded.row;
    const ownershipRefusal = refuseUnownedWrite(tenantRow, session.authUserId, isPureSwitchOffBody(body));
    if (ownershipRefusal) return ownershipRefusal;
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
    if (!isValidCronExpr(body.schedule)) {
      return NextResponse.json({ ok: false, error: "invalid_cron_expression" }, { status: 400 });
    }
    update.schedule = body.schedule.trim();
  }
  if (typeof body.enabled === "boolean") {
    update.enabled = body.enabled;
  }
  if (typeof body.agent_key === "string") {
    const nextAgentKey = body.agent_key.toLowerCase();
    // OASIS's own workspace: the agents its bridge runs (W4a review R4).
    const allowedAgents = oasisOperatorAgents(tenantId) ?? (await getTenantEnabledAgents(tenantId));
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

  // A reschedule sets last_scheduled_for = now (requirement B), same reason
  // the toggle path stamps it on enable: O5's due-time evaluator then waits
  // for the job's NEXT real occurrence instead of reading the edit itself as
  // a missed run. Column added by bravo__211_automation_owner.sql — a
  // deployment that has not applied it yet gets "no such column" below,
  // caught and retried without the stamp, never a raw 500.
  if (typeof update.schedule === "string") {
    update.last_scheduled_for = new Date().toISOString();
  }

  const db = getServiceSupabase();
  // Non-toggle edits exist only for the tenant lane; Empire definitions stay
  // code-owned. The write and its separate readback remain tenant-scoped.
  let updateResult = await db
    .from("tenant_cron_jobs")
    .update(update)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .select()
    .maybeSingle();
  if (updateResult.error && "last_scheduled_for" in update && isMissingColumnError(updateResult.error, "last_scheduled_for")) {
    const { last_scheduled_for: _dropped, ...withoutStamp } = update;
    updateResult = await db
      .from("tenant_cron_jobs")
      .update(withoutStamp)
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .select()
      .maybeSingle();
  }
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

  const loaded = await loadTenantRowForWrite(id, tenantId);
  if (!loaded.ok) return loaded.response;
  // O2: delete is never the admin's "switch off" exception — only the row's
  // own owner (or a legacy row with no recorded owner) may delete it.
  const ownershipRefusal = refuseUnownedWrite(loaded.row, session.authUserId, false);
  if (ownershipRefusal) return ownershipRefusal;

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
