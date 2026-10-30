/**
 * /api/cron-jobs — tenant-scoped scheduled-job inventory and creation.
 *
 * GET  → list the caller's own tenant jobs ("yours"), a `team` lane of
 *        everyone else's for owners/admins, and the Empire (house) lane for
 *        the workspace's agents owner only (O2, 2026-10-11). Service-role
 *        reads are explicitly constrained by the session tenant ID.
 * POST → create a new job. Body: { agent_key, name, description?, schedule,
 *        action_type, action_payload, enabled? }
 *
 * Per-row update / delete lives at /api/cron-jobs/[id].
 *
 * Bridge daemon's poll endpoint lives at /api/cron-jobs/poll — a separate
 * bearer-token-authed route so the daemon doesn't need a session cookie.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { canManageTeam, getSessionContext } from "@/lib/team";
import { isMissingTableError, jsonRoute, missingTablePayload } from "@/lib/api-helpers";
import { OASIS_OPERATOR_TENANT_ID } from "@/lib/platform-operator";
import { readAgentsOwner } from "@/lib/agents-owner";
import {
  DEPARTMENT_TASK,
  isScriptActionType,
  SCRIPT_ACTION_TYPES,
  type ScriptActionType,
} from "@/lib/automations/action-types";
import { isValidCronExpr } from "@/lib/automations/cron-grammar";
import { gateScriptAutomationCreate } from "@/lib/automations/script-access";
import { getTenantEnabledAgents, oasisOperatorAgents } from "@/lib/manifest/tenant-scope";
import { classifyUrlForSsrf } from "@/lib/url-safety";
import {
  activeDaemonBackedCronForName,
  deriveDaemonState,
  retiredDaemonCronStateForName,
  type DaemonHealthRow,
  type DaemonState,
  type RetiredCronState,
} from "@/lib/automations/daemon-backed-crons";
import {
  normalizeEmpireRow,
  normalizeTenantCronRow,
  type EmpireCronRow,
} from "@/lib/cron-empire-row";
import {
  AutomationInventoryError,
  buildAutomationInventoryMetadata,
  type CronInventoryJob,
} from "@/lib/automations/cron-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Action types we accept on create: the script types the bridge runs, from
// lib/automations/action-types.ts (the poll serves the same allowlist), so a
// department_task can never be created on this route. Discriminator +
// payload-shape validation done in code (vs JSON-schema) because the shapes are
// small and clear.
type ActionType = ScriptActionType;

/**
 * Empire-cron row shape from public.cron_jobs.
 *
 * cron_jobs predates tenant_cron_jobs by ~3 months — it's a single-tenant
 * empire-wide queue scheduled by scripts/cron_engine.py + scripts/
 * bravo_scheduler. tenant_cron_jobs is the per-tenant Phase I table the
 * bridge daemon polls. Operators (CC) need visibility into BOTH on the
 * Automations page; client tenants only see their own tenant_cron_jobs.
 *
 * The two schemas differ — empire uses is_active + action_config +
 * owner_agent_key, tenant uses enabled + action_payload + agent_key. The GET
 * normalizes both to a single shape with a `source` discriminator and the
 * UI surfaces an "Empire" tag on cron_jobs rows.
 */

// Cron expressions are validated by the one shared grammar,
// lib/automations/cron-grammar.ts: exactly the forms the bridge's
// cron_runner.py reads (no names, no L/W/#), each field in range.

// Wrapped so a throw cannot escape as an empty body — see jsonRoute in
// lib/api-helpers.ts for why the Automations tab kept reporting a JSON parser
// error instead of the actual fault.
export const GET = jsonRoute("api/cron-jobs GET", async () => {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  // The workspace is the session's ACTIVE profile, resolved the way every other
  // route resolves it. This read used to be its own
  // `user_profiles.eq("auth_user_id").maybeSingle()`, which errors for anyone
  // with a seat in two workspaces, so the tab answered 401 to a signed-in member.
  const ctx = await getSessionContext();
  if (!ctx) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const db = getServiceSupabase();
  const tenantId = ctx.tenantId;
  const authUserId = ctx.authUserId;
  // Owner/admin: may see everyone else's rows in the `team` lane (switch-off
  // only — see the [id] route) and the agents-owner-gated workers panel.
  const isOwnerOrAdmin = canManageTeam(ctx.teamRole, ctx.adminAccess);
  // The bridge writes its pm2 snapshot to integrations_health keyed by
  // profile_id (same scope the background-workers route reads). Needed below
  // to tell a parked cron twin whether its daemon is actually up.
  const profileId = ctx.profileId;

  // Tenant lane. `select("*")` on purpose, not an explicit column list: this
  // table predates owner_user_id (database/turso/bravo__211_automation_owner.sql)
  // and a workspace whose migration has not landed yet must still answer 200
  // with every row visible (the pre-O2 rule), not "no such column". Rows are
  // split below into "yours" (the caller's own, or a legacy row with no
  // recorded owner — same visibility as before O2) and, for owners/admins
  // only, "team" (everyone else's, read-only but for the switch).
  const tenantQuery = await db
    .from("tenant_cron_jobs")
    .select("*")
    .eq("tenant_id", tenantId)
    .neq("action_type", DEPARTMENT_TASK)
    .order("created_at", { ascending: false });
  if (tenantQuery.error) {
    if (isMissingTableError(tenantQuery.error, "public.tenant_cron_jobs")) {
      return NextResponse.json(
        missingTablePayload({
          migration: "database/041_tenant_cron_jobs.sql",
          feature: "Automations",
        }),
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: tenantQuery.error.message }, { status: 500 });
  }
  const allTenantRows = (tenantQuery.data || []) as Array<Record<string, unknown>>;
  const yoursRaw: Record<string, unknown>[] = [];
  const teamRaw: Record<string, unknown>[] = [];
  for (const row of allTenantRows) {
    const ownerUserId = typeof row.owner_user_id === "string" && row.owner_user_id ? row.owner_user_id : null;
    if (!ownerUserId || ownerUserId === authUserId) {
      yoursRaw.push(row);
    } else if (isOwnerOrAdmin) {
      teamRaw.push(row);
    }
    // A member who is not an owner/admin never sees another person's row at
    // all — not even a count of it.
  }
  // Display names for the team lane's owners — read only for an owner/admin,
  // and only for the distinct owners actually present, so a plain member (who
  // never sees `team`) never pays this read.
  const teamOwnerIds = Array.from(
    new Set(
      teamRaw
        .map((row) => (typeof row.owner_user_id === "string" ? row.owner_user_id : null))
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const ownerNameById = new Map<string, string>();
  if (teamOwnerIds.length > 0) {
    const ownerProfiles = await db
      .from("user_profiles")
      .select("auth_user_id, display_name, full_name, email")
      .eq("tenant_id", tenantId)
      .in("auth_user_id", teamOwnerIds);
    if (!ownerProfiles.error) {
      for (const row of (ownerProfiles.data || []) as Array<{
        auth_user_id: string | null;
        display_name: string | null;
        full_name: string | null;
        email: string;
      }>) {
        if (row.auth_user_id) {
          ownerNameById.set(row.auth_user_id, row.display_name || row.full_name || row.email);
        }
      }
    }
  }
  const tenantJobs = yoursRaw.map((j) => normalizeTenantCronRow(j)) as CronInventoryJob[];
  const teamJobs = teamRaw.map((j) => {
    const normalized = normalizeTenantCronRow(j) as CronInventoryJob;
    const ownerUserId = typeof j.owner_user_id === "string" ? j.owner_user_id : null;
    return { ...normalized, owner_name: ownerUserId ? ownerNameById.get(ownerUserId) ?? null : null };
  });

  // Empire (house) lane — the workspace's AGENTS OWNER only (O2, 2026-10-11).
  // cron_jobs is tenant-scoped (migration 084), so the agents owner's tenantId
  // is the canonical filter.
  //
  // Evaluated ONCE and reported on the wire, because every Empire guarantee in
  // this route is armed by this one predicate: the query itself, the fail-loud
  // 500 on an Empire read error, and the non-empty contract in
  // buildAutomationInventoryMetadata. Before O2 the predicate was "is a
  // verified platform operator" — but PR #576 made Adon one too, so that
  // predicate would have handed him CC's house lane the moment it covered him.
  // "Is literally the one auth user CCPC's computer belongs to"
  // (lib/agents-owner.ts, database/turso/bravo__210_workspace_agents_owner.sql)
  // is the narrower, correct question.
  //
  // A read that FAILS, or OASIS's own workspace with no live owner row, is
  // answered 500 here — never a workspace-only 200 that looks healthy, which
  // Adon (a non-owner, valid) and "every house schedule just vanished"
  // (invalid) would otherwise be indistinguishable. Outside OASIS, a tenant
  // that has never had an owner row falls through untouched (not_set is
  // simply "not this tenant's owner"), the same posture
  // lib/bridge-proxy.ts:authorizeBridgeRequest takes for the SAME reason: this
  // concept does not exist for a tenant that was never given one.
  const isOasisOperatorTenant = tenantId === OASIS_OPERATOR_TENANT_ID;
  const ownerLookup = await readAgentsOwner(tenantId);
  if (isOasisOperatorTenant) {
    if (ownerLookup.state === "unavailable") {
      return NextResponse.json(
        { ok: false, error: "agents_owner_unavailable", message: "Could not confirm this workspace's computer owner just now. Reload in a moment." },
        { status: 500 },
      );
    }
    if (ownerLookup.state === "not_set" || ownerLookup.state === "revoked") {
      return NextResponse.json(
        { ok: false, error: "agents_owner_not_set", message: "No one is set as this workspace's computer owner, so the house schedules have no one to show them to." },
        { status: 500 },
      );
    }
  }
  const isAgentsOwner = ownerLookup.state === "set" && ownerLookup.authUserId === authUserId;
  // The non-empty Empire-lane contract (below, requireEmpireRows) only means
  // something in OASIS's own workspace: cron_jobs is tenant-scoped (migration
  // 084), so a tenant with its own (future) agents owner queries THAT
  // tenant's empire rows, and a client ordinarily has none at all. Zero there
  // is the correct, boring answer, not the 4/41 outage this contract exists
  // to catch — demanding non-empty for every agents owner turned a client's
  // empty list into a false 503. OASIS itself keeps the fail-loud 503: that is
  // the one tenant where "empty Empire lane" really did mean the schedules
  // vanished.
  let empireJobs: Array<
    ReturnType<typeof normalizeEmpireRow> & {
      daemon: DaemonState | null;
      retired: RetiredCronState | null;
    }
  > = [];
  if (isAgentsOwner) {
    const empireQuery = await db
      .from("cron_jobs")
      .select(
        "id, name, description, schedule, action_type, action_config, owner_agent_key, is_active, last_run_at, last_result, next_run_at, run_count, fail_count, created_at",
      )
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });
    if (empireQuery.error) {
      // A tenant-only list is plausible but dangerously incomplete for the
      // operator. The previous silent fallback produced the exact 4/1 outage:
      // the page looked healthy while hiding every Empire schedule.
      return NextResponse.json(
        { ok: false, error: "empire_inventory_unavailable", message: empireQuery.error.message },
        { status: 500 },
      );
    }
    // The daemon field is decorated HERE, not in lib/cron-empire-row.ts —
    // the shared normalizer stays daemon-agnostic; only this route knows
    // which parked rows a PM2 daemon has taken over. Null for the ordinary
    // rows the shared scheduler still runs; filled in below.
    empireJobs = ((empireQuery.data || []) as EmpireCronRow[]).map((row) => ({
      ...normalizeEmpireRow(row),
      daemon: null as DaemonState | null,
      retired: null as RetiredCronState | null,
    }));
  }

  // Parked process rows: mark retired copies as reference-only, and attach
  // live health only when a dedicated process is still an active owner.
  //
  // These rows sit at is_active=0 on purpose — a dedicated PM2 daemon took the
  // work over and the parked flag is what stops a second runner from
  // double-messaging real prospects. Reporting `enabled: false` and stopping
  // there is how the tab came to show the setter as OFF while it was answering
  // people. Active process rows carry live status; retired computer copies
  // carry a lifecycle marker with no control. `enabled` remains the honest DB
  // value; nothing here rewrites the flag.
  //
  // A failed or empty read yields `unknown`, never a green. See
  // lib/automations/daemon-backed-crons.ts for the freshness rule.
  for (const job of empireJobs) {
    const retired = retiredDaemonCronStateForName(job.name);
    const active = activeDaemonBackedCronForName(job.name);
    if ((retired || active) && job.enabled) {
      console.error("[api/cron-jobs GET] parked process cron is armed", {
        tenantId,
        id: job.id,
        name: job.name,
      });
      return NextResponse.json(
        {
          ok: false,
          error: "parked_cron_armed",
          message:
            `"${job.name}" is a parked process-owned row but is_active is on. ` +
            "The Automations inventory is withheld until the duplicate-runner interlock is restored.",
        },
        { status: 503 },
      );
    }
    job.retired = retired;
  }

  const daemonRows = empireJobs.filter((j) => activeDaemonBackedCronForName(j.name));
  if (daemonRows.length > 0) {
    const healthByService = new Map<string, DaemonHealthRow>();
    if (profileId) {
      const services = daemonRows.map((j) => activeDaemonBackedCronForName(j.name)!.service);
      const healthQuery = await db
        .from("integrations_health")
        .select("service, status, last_ping_at")
        .eq("tenant_id", tenantId)
        .eq("profile_id", profileId)
        .in("service", services);
      if (!healthQuery.error && Array.isArray(healthQuery.data)) {
        for (const r of healthQuery.data as Array<{
          service: string;
          status: string | null;
          last_ping_at: string | null;
        }>) {
          healthByService.set(r.service, { status: r.status, last_ping_at: r.last_ping_at });
        }
      }
    }
    for (const job of daemonRows) {
      const def = activeDaemonBackedCronForName(job.name)!;
      job.daemon = deriveDaemonState(def, healthByService.get(def.service) ?? null);
    }
  }

  try {
    const inventory = buildAutomationInventoryMetadata({
      tenantJobs,
      teamJobs,
      teamQueried: isOwnerOrAdmin,
      empireJobs,
      empireQueried: isAgentsOwner,
      requireEmpireRows: isAgentsOwner && isOasisOperatorTenant,
      isAgentsOwner,
    });
    return NextResponse.json({ ok: true, jobs: [...tenantJobs, ...empireJobs], team: teamJobs, inventory });
    // Bound as `cause`, not `error`: this is the catch binding for a contract
    // violation, never a destructured driver error. tests/db-error-contract
    // counts every bare `throw error` in a file that destructures `error` off a
    // query result anywhere (POST does, below), so reusing the name here would
    // report debt that does not exist -- and set this file's ratchet to 1, so a
    // genuine bare driver throw appearing later would pass unnoticed.
  } catch (cause) {
    if (cause instanceof AutomationInventoryError) {
      console.error("[api/cron-jobs GET] inventory contract failed", {
        error: cause.code,
        message: cause.message,
        tenantCount: tenantJobs.length,
        empireCount: empireJobs.length,
      });
      return NextResponse.json(
        { ok: false, error: cause.code, message: cause.message },
        { status: cause.status },
      );
    }
    throw cause;
  }
});

export async function POST(req: NextRequest) {
  // Creating a scheduled SCRIPT job (script_run / webhook_post / snapshot_run)
  // is for verified platform operators, who must also manage this workspace
  // (lib/automations/script-access.ts). Members view (GET) only; client owners
  // keep toggle and edit on their existing rows at /api/cron-jobs/[id].
  const gate = await gateScriptAutomationCreate("Only owners/admins can create automations.");
  if (!gate.ok) return gate.response;
  const ctx = gate.ctx;
  const tenantId = ctx.tenantId;
  const userId = ctx.authUserId;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const name = String(body?.name || "").trim().slice(0, 80);
  if (!name) return NextResponse.json({ ok: false, error: "name_required" }, { status: 400 });

  const schedule = String(body?.schedule || "").trim();
  if (!isValidCronExpr(schedule)) {
    return NextResponse.json(
      { ok: false, error: "invalid_cron_expression", hint: "Use 5-field cron syntax (m h dom mon dow)." },
      { status: 400 },
    );
  }

  const rawActionType = String(body?.action_type || "");
  if (!isScriptActionType(rawActionType)) {
    return NextResponse.json(
      { ok: false, error: `invalid_action_type:${rawActionType}`, valid: SCRIPT_ACTION_TYPES },
      { status: 400 },
    );
  }
  const actionType: ActionType = rawActionType;
  const rawActionPayload: Record<string, unknown> =
    body?.action_payload && typeof body.action_payload === "object" && !Array.isArray(body.action_payload)
      ? (body.action_payload as Record<string, unknown>)
      : {};

  // Without this gate a tenant operator could set action_payload.root
  // to a sibling-repo slug (e.g. "bravo" from SunBiz) and the bridge
  // would dispatch CEO-Agent scripts from inside their tenant bridge.
  const db = getServiceSupabase();
  const tenantRow = await db
    .from("tenants")
    .select("slug")
    .eq("id", tenantId)
    .maybeSingle();
  const tenantSlug = (tenantRow.data as { slug: string | null } | null)?.slug?.toLowerCase() ?? null;
  const rootCheck = validateAndScopeRoot(rawActionPayload, tenantSlug);
  if (!rootCheck.ok) {
    return NextResponse.json({ ok: false, error: rootCheck.error }, { status: 403 });
  }
  const actionPayload = rootCheck.payload;

  // Per-type payload validation. Keeps malformed payloads from reaching the
  // bridge where they'd just error silently in cron_engine.
  const payloadErr = validateActionPayload(actionType, actionPayload);
  if (payloadErr) {
    return NextResponse.json({ ok: false, error: payloadErr }, { status: 400 });
  }

  const agentKey = String(body?.agent_key || "bravo").toLowerCase();
  // Same privilege-escalation class as action_payload.root: the bridge
  // maps agent_key → repo root via SIBLING_ROOT_BY_AGENT_KEY, so an
  // unfiltered agent_key lets a tenant operator pick which sibling
  // repo runs. OASIS's own workspace: the agents its bridge runs, not its
  // business roster of department leads (W4a review R4).
  const allowedAgents = oasisOperatorAgents(tenantId) ?? (await getTenantEnabledAgents(tenantId));
  if (allowedAgents.length > 0 && !allowedAgents.includes(agentKey)) {
    return NextResponse.json(
      {
        ok: false,
        error: `agent_key_not_allowed_for_tenant:${agentKey}`,
        allowed: allowedAgents,
      },
      { status: 403 },
    );
  }
  const description = body?.description ? String(body.description).slice(0, 500) : null;
  const enabled = body?.enabled !== false;
  const nowIso = new Date().toISOString();

  // `db` was opened above for the tenant-slug lookup — reuse it for the
  // insert. The service-role client is a process-singleton anyway.
  //
  // owner_user_id = the session's auth id, same identity created_by already
  // used here (unlike save-draft, which wrote the PROFILE id — the drift
  // bravo__211_automation_owner.sql's backfill exists to fix). Never the
  // request body: tenant and person come from the session, never the body.
  // last_scheduled_for = now: O5's due-time evaluator reads it as "already
  // accounted for up to here", so a brand-new job waits for its next real
  // occurrence instead of firing at once or reading as a missed run before
  // it has ever been due.
  const { data, error } = await db
    .from("tenant_cron_jobs")
    .insert({
      tenant_id: tenantId,
      agent_key: agentKey,
      name,
      description,
      schedule,
      action_type: actionType,
      action_payload: actionPayload,
      enabled,
      created_by: userId,
      owner_user_id: userId,
      last_scheduled_for: nowIso,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, job: data });
}

// Tenants allowed to set action_payload.root, mapped to the sibling-agent
// slug their bridge may dispatch into. Hardcoded for now; long-term home
// is manifest.allowed_roots so adding a tenant is a manifest edit, not a
// code change. Must stay in sync with bravo_cli/cron_runner.py
// SIBLING_ROOT_BY_AGENT_KEY.
const TENANT_ROOT_ALLOWLIST: Record<string, string> = {
  submissions: "sunbiz",
  sun: "sunbiz",
  "oasis-ai-cc": "bravo",
};

/**
 * Server-side `action_payload.root` validation. Returns the same payload
 * with an unknown / unauthorized `root` field stripped, OR an error string.
 *
 * The root field is what tells `bravo_cli/cron_runner.py:_exec_script_run`
 * which sibling agent root to resolve the script against. An operator who
 * could set it freely could escalate from tenant scope to empire scope
 * (run CEO-Agent scripts inside SunBiz's bridge). This function gates
 * by the caller's tenant.
 */
function validateAndScopeRoot(
  payload: Record<string, unknown>,
  tenantSlug: string | null,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const root = payload.root;
  if (root === undefined || root === null) {
    // No root field — implicit bravo, fine for empire-tenant jobs. Other
    // tenants' bridges resolve "bravo" against their local agent root by
    // default; the cron_runner handles the slug -> path mapping.
    return { ok: true, payload };
  }
  if (typeof root !== "string") {
    return { ok: false, error: "action_payload.root must be a string" };
  }
  const rootSlug = root.trim().toLowerCase();
  const allowed = tenantSlug ? TENANT_ROOT_ALLOWLIST[tenantSlug] : null;
  if (!allowed) {
    return {
      ok: false,
      error: `tenant ${tenantSlug ?? "(unknown)"} is not allowed to set action_payload.root`,
    };
  }
  if (rootSlug !== allowed) {
    return {
      ok: false,
      error: `tenant ${tenantSlug} cannot dispatch into root=${rootSlug} (allowed: ${allowed})`,
    };
  }
  return { ok: true, payload: { ...payload, root: rootSlug } };
}

/**
 * Per-action-type payload shape check. Returns an error string on failure,
 * null on success. Kept loose — the bridge is the real validator (it
 * resolves paths, runs subprocesses, etc.) and there's no point being
 * strict here at the API edge.
 */
function validateActionPayload(type: ActionType, payload: Record<string, unknown>): string | null {
  switch (type) {
    case "script_run":
      if (typeof payload.script !== "string" || !payload.script.trim()) {
        return "script_run requires action_payload.script (string)";
      }
      if (payload.args !== undefined && !Array.isArray(payload.args)) {
        return "script_run.args must be an array if provided";
      }
      return null;
    case "snapshot_run":
      if (typeof payload.snapshot !== "string" || !payload.snapshot.trim()) {
        return "snapshot_run requires action_payload.snapshot (string)";
      }
      return null;
    case "webhook_post": {
      if (typeof payload.url !== "string" || !/^https?:\/\//.test(payload.url)) {
        return "webhook_post requires action_payload.url (http/https URL)";
      }
      const ssrf = classifyUrlForSsrf(payload.url);
      return ssrf ? `webhook_post ${ssrf}` : null;
    }
  }
}
