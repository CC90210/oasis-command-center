/**
 * /api/cron-jobs — operator-facing CRUD for tenant cron jobs (Phase I).
 *
 * GET  → list this tenant's jobs (RLS-scoped via the authed user).
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
import { resolveTenantId } from "@/lib/api-auth";
import { isMissingTableError, missingTablePayload } from "@/lib/api-helpers";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { getTenantEnabledAgents } from "@/lib/manifest/tenant-scope";
import { classifyUrlForSsrf } from "@/lib/url-safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Action types we accept on create. Discriminator + payload-shape validation
// done in code (vs JSON-schema) because the shapes are small and clear.
const VALID_ACTION_TYPES = ["script_run", "snapshot_run", "agent_prompt", "webhook_post"] as const;
type ActionType = (typeof VALID_ACTION_TYPES)[number];

/**
 * Empire-cron row shape from public.cron_jobs.
 *
 * cron_jobs predates tenant_cron_jobs by ~3 months — it's a single-tenant
 * empire-wide queue scheduled by scripts/cron_engine.py + scripts/
 * bravo_scheduler. tenant_cron_jobs is the per-tenant Phase I table the
 * bridge daemon polls. Operators (CC) need visibility into BOTH on the
 * Automations page; client tenants only see their own tenant_cron_jobs.
 *
 * The two schemas differ — empire uses is_active + action_config + no
 * agent_key, tenant uses enabled + action_payload + agent_key. The GET
 * normalizes both to a single shape with a `source` discriminator and the
 * UI surfaces an "Empire" tag on cron_jobs rows.
 */
type EmpireCronRow = {
  id: string;
  name: string;
  description: string | null;
  schedule: string;
  action_type: string;
  action_config: Record<string, unknown> | null;
  is_active: boolean;
  last_run_at: string | null;
  last_result: string | null;
  next_run_at: string | null;
  run_count: number | null;
  created_at: string;
};

// Minimal cron-expression validator. Five fields, each one of:
//   *, N, N-M, */N, N,M,K
// More exotic forms (L, W, #, named months/dow) intentionally rejected — the
// bridge's cron_engine uses standard Python schedule semantics, and refusing
// the weird forms keeps validation simple. Operators who need them can drop
// down to bash from the agent chat.
const CRON_FIELD = /^(\*|\*\/\d+|\d+(-\d+)?(\/\d+)?(,\d+(-\d+)?(\/\d+)?)*)$/;
function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => CRON_FIELD.test(p));
}

async function resolveUserId(): Promise<string | null> {
  const user = await getSessionUser();
  return user?.id ?? null;
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const db = getServiceSupabase();
  const profile = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profile.data as { tenant_id: string | null } | null)?.tenant_id ?? null;
  if (!tenantId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  // Tenant lane — every authed user sees their tenant's jobs.
  const tenantQuery = await db
    .from("tenant_cron_jobs")
    .select(
      "id, agent_key, name, description, schedule, action_type, action_payload, enabled, last_run_at, last_run_status, last_run_output, last_run_error, run_count, created_at, updated_at",
    )
    .eq("tenant_id", tenantId)
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
  const tenantJobs = (tenantQuery.data || []).map((j) => ({ ...j, source: "tenant" as const }));

  // Empire lane — operator-only. cron_jobs is single-tenant (CC's empire);
  // exposing it to client tenants would leak unrelated automations. Match
  // by signed-in user email against OPERATOR_EMAIL / ADMIN_EMAILS.
  let empireJobs: ReturnType<typeof normalizeEmpireRow>[] = [];
  if (isOperatorEmail(user.email)) {
    const empireQuery = await db
      .from("cron_jobs")
      .select(
        "id, name, description, schedule, action_type, action_config, is_active, last_run_at, last_result, next_run_at, run_count, created_at",
      )
      .order("created_at", { ascending: false });
    // cron_jobs has predated the Phase I tenant table for months; if it's
    // missing the empire stack just isn't deployed in this env (e.g. a
    // fresh client deploy). Quietly skip rather than 503 — tenant lane
    // already returned.
    if (!empireQuery.error && empireQuery.data) {
      empireJobs = (empireQuery.data as EmpireCronRow[])
        .map(normalizeEmpireRow)
        // Suppress tenant-scoped rows that leaked into the empire table
        // so they never reach CC's UI. The bridge cron_runner is the
        // execution-side guard; this is the read-side guard.
        .filter((row) => EMPIRE_AGENT_ALLOWLIST.has(row.agent_key));
    }
  }

  return NextResponse.json({ ok: true, jobs: [...tenantJobs, ...empireJobs] });
}

/**
 * Map a public.cron_jobs row to the UI's CronJob shape with `source: "empire"`.
 *
 * Column translation:
 *   is_active     → enabled
 *   action_config → action_payload
 *   last_result   → last_run_status + last_run_output (best-effort parse)
 *   (no agent_key) → "bravo-scheduler" so the UI's per-row tag is honest
 *
 * Empire rows are read-only from the UI — the SEED_JOBS array in
 * scripts/cron_engine.py is the source of truth, edits there are how CC
 * adds/removes empire automations. The UI gates edit/delete on the source
 * tag.
 */
/**
 * Empire cron_jobs has no agent_key column — every row was historically
 * "Bravo's empire scheduler". Now that the dashboard groups by agent
 * (CEO/CFO/CMO), we infer the owning agent from the job name / action_type:
 *
 *   - "Atlas *" name OR action_type starting with "atlas_" → atlas (CFO)
 *   - "Maven *" name OR action_type starting with "maven_" → maven (CMO)
 *   - "Aura *" / "Morning Pow Wow" (Aura's voice note) → aura (life-coach)
 *   - "SunBiz *" / "Solara *" / "Helios *" → tenant-scoped (filtered out
 *     by EMPIRE_AGENT_ALLOWLIST below — these belong on the SunBiz portal,
 *     not CC's empire view)
 *   - everything else → bravo (CEO — business ops)
 */
function inferEmpireAgentKey(name: string, actionType: string | null): string {
  const n = (name || "").toLowerCase();
  const t = (actionType || "").toLowerCase();
  if (n.startsWith("atlas") || t.startsWith("atlas_")) return "atlas";
  if (n.startsWith("maven") || t.startsWith("maven_")) return "maven";
  if (n.startsWith("aura") || n.includes("pow wow") || t.startsWith("morning_powwow")) return "aura";
  if (n.startsWith("sunbiz") || n.startsWith("solara") || n.startsWith("helios")) return "sunbiz";
  return "bravo";
}

/**
 * Rows whose inferred agent isn't in this set are tenant-scoped automations
 * that leaked into the empire cron_jobs table (most commonly SunBiz crons
 * that predate the multi-root manifest split). They MUST NOT render in CC's
 * Automations tab — they belong to a different tenant's portal.
 *
 * If you add a new empire agent (rare), append it here.
 */
const EMPIRE_AGENT_ALLOWLIST = new Set(["bravo", "atlas", "maven", "aura"]);

function normalizeEmpireRow(row: EmpireCronRow) {
  // last_result is a free-form text column written by scripts/scheduler.py.
  // Observed patterns in scheduler.py:
  //   "ok"                            → success (lowercase, no prefix)
  //   "<stdout snippet>"              → success (raw script output)
  //   "stripe sync ok: ..."           → success
  //   "ERROR: <reason>"               → error
  //   "FAILED (exit N): <stderr>"     → error
  //
  // Match case-insensitively, prefix-only, so the success/error tag in the
  // UI matches what the scheduler actually wrote.
  const lastResult = row.last_result || "";
  const upper = lastResult.toUpperCase();
  const status: "success" | "error" | null = !lastResult
    ? null
    : upper.startsWith("ERROR") || upper.startsWith("FAILED")
      ? "error"
      : "success";
  return {
    id: row.id,
    agent_key: inferEmpireAgentKey(row.name, row.action_type),
    name: row.name,
    description: row.description,
    schedule: row.schedule,
    action_type: row.action_type,
    action_payload: row.action_config || {},
    enabled: row.is_active,
    last_run_at: row.last_run_at,
    last_run_status: status,
    last_run_output: status === "success" ? lastResult : null,
    last_run_error: status === "error" ? lastResult : null,
    run_count: row.run_count || 0,
    created_at: row.created_at,
    updated_at: row.created_at,
    source: "empire" as const,
  };
}

export async function POST(req: NextRequest) {
  const tenantId = await resolveTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const userId = await resolveUserId();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const name = String(body?.name || "").trim().slice(0, 80);
  if (!name) return NextResponse.json({ ok: false, error: "name_required" }, { status: 400 });

  const schedule = String(body?.schedule || "").trim();
  if (!isValidCron(schedule)) {
    return NextResponse.json(
      { ok: false, error: "invalid_cron_expression", hint: "Use 5-field cron syntax (m h dom mon dow)." },
      { status: 400 },
    );
  }

  const actionType = String(body?.action_type || "") as ActionType;
  if (!VALID_ACTION_TYPES.includes(actionType)) {
    return NextResponse.json(
      { ok: false, error: `invalid_action_type:${actionType}`, valid: VALID_ACTION_TYPES },
      { status: 400 },
    );
  }
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
  // repo runs.
  const allowedAgents = await getTenantEnabledAgents(tenantId);
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

  // `db` was opened above for the tenant-slug lookup — reuse it for the
  // insert. The service-role client is a process-singleton anyway.
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
    case "agent_prompt":
      if (typeof payload.prompt !== "string" || !payload.prompt.trim()) {
        return "agent_prompt requires action_payload.prompt (string)";
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
