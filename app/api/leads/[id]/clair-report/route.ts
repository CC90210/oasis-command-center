/**
 * /api/leads/[id]/clair-report — CLAIR (Thomson Reuters CLEAR) reports for a lead.
 *
 *   GET  — list the reports already pulled for this lead (newest first).
 *   POST — pull a NEW report. Billable, regulated, and strictly manual.
 *
 * WHY THE CALL RUNS ON THE VPS, NOT HERE:
 * CLEAR S2S requires mutual TLS with a client certificate issued to Breeze
 * Advance. That certificate (and its passphrase) lives in the VPS .env.agents
 * and deliberately does not exist in Vercel — a regulated credential should sit
 * in one place. This route therefore authenticates the operator, gates the
 * action, and forwards to the VPS bridge's `clair_report` tool over the same
 * hardened path every other VPS proxy uses (authorizeBridgeRequest →
 * callBridgeExecTool), exactly like background-workers/control.
 *
 * MANUAL-ONLY IS ENFORCED HERE, NOT JUST IN THE UI. Every POST is attributable
 * to a signed-in operator whose id and email are recorded on the report row,
 * because each CLEAR query asserts a DPPA/GLB permissible use on the account.
 * There is no service-to-service caller, no cron, and no retry-on-failure: a
 * failed CLEAR call returns the error and stops. If you are adding an automated
 * caller, you are breaking a compliance boundary, not a code style rule.
 *
 * NOT A FALLBACK ANY MORE (Adon, 2026-07-27). CLEAR used to 409 when the
 * automated TruePeopleSearch path had not run, or had already produced a
 * number. That coupling is gone: the two enrichments are independent and an
 * operator may run CLEAR on a lead TruePeopleSearch already enriched. Cost and
 * redundancy are now an operator judgement (the UI states both), not a lock.
 * The manual/attributed/role/tenant constraints above are untouched.
 */

import { NextResponse } from "next/server";
import { authorizeBridgeRequest, callBridgeExecTool } from "@/lib/bridge-proxy";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { clairEnabledForTenantSlug } from "@/lib/clair/tenant-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** CLEAR searches are slow — the vendor call itself can take ~30s. */
const BRIDGE_TIMEOUT_MS = 90_000;

/** Roles that may spend a billable, regulated lookup. Read-only and external
 * collaborator roles cannot. */
const ALLOWED_ROLES = new Set(["owner", "admin", "member", "loan_officer", "processor"]);

type Ctx = { params: Promise<{ id: string }> };

async function clairAvailableForTenant(tenantId: string): Promise<boolean> {
  const svc = getServiceSupabase();
  const { data: tenant } = await svc
    .from("tenants")
    .select("slug, custom_fields")
    .eq("id", tenantId)
    .maybeSingle();
  return clairEnabledForTenantSlug(resolveClientProfileSlug(tenant));
}

export async function GET(_req: Request, ctx: Ctx) {
  const { id: leadId } = await ctx.params;
  const auth = await authorizeBridgeRequest();
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  if (!(await clairAvailableForTenant(auth.tenantId))) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const svc = getServiceSupabase();
  const { data, error } = await svc
    .from("clair_reports")
    // raw_report is deliberately NOT selected: it is the unparsed vendor payload
    // and is service-role-only reference data, not something the drawer renders.
    .select(
      "id,status,error_message,result_count,people,phones,query_name,query_address," +
        "query_city,query_state,query_zip,query_dob,permissible_dppa,permissible_glb," +
        "permissible_voter,clear_environment,requested_by_email,created_at,completed_at",
    )
    .eq("tenant_id", auth.tenantId)
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, reports: data ?? [] });
}

export async function POST(_req: Request, ctx: Ctx) {
  const { id: leadId } = await ctx.params;
  const auth = await authorizeBridgeRequest();
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  if (!(await clairAvailableForTenant(auth.tenantId))) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (!ALLOWED_ROLES.has(auth.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "role_not_permitted", team_role: auth.teamRole },
      { status: 403 },
    );
  }

  const svc = getServiceSupabase();

  // Tenant guard — the lead must exist in THIS tenant. Without this, a valid
  // session could pull a regulated report against another tenant's merchant by
  // id. This is the only precondition on a pull; there is deliberately no
  // second guard tying CLEAR to the state of the automated lookup.
  const { data: lead } = await svc
    .from("tenant_records")
    .select("id")
    .eq("id", leadId)
    .eq("tenant_id", auth.tenantId)
    .maybeSingle();
  if (!lead) {
    return NextResponse.json({ ok: false, error: "lead_not_found" }, { status: 404 });
  }

  // MANUAL GUARD — who asked, and a refusal if the answer is "nobody".
  //
  // A CLEAR query asserts a DPPA/GLB permissible use on a named person's
  // behalf, so an unattributed pull is not a logging gap, it is an
  // impermissible query. These fields used to fall back to null, which meant a
  // caller that reached this line without a human behind it would still spend
  // the query and write an anonymous report row — exactly the shape an
  // automated caller produces. Both identifiers are now required and the route
  // fails CLOSED without them, so "automated" cannot happen by accident: it
  // would have to be a deliberate act of forging an operator identity.
  const sessionUser = await getSessionUser();
  const requestedBy = auth.userId?.trim() ?? "";
  const requestedByEmail = sessionUser?.email?.trim() ?? "";
  if (!requestedBy || !requestedByEmail) {
    return NextResponse.json(
      {
        ok: false,
        error: "manual_operator_required",
        message:
          "A CLEAR report must be pulled by a signed-in operator. No permissible-use query runs without one.",
      },
      { status: 403 },
    );
  }

  const result = await callBridgeExecTool(
    auth.target,
    {
      tool_name: "clair_report",
      tenant_id: auth.tenantId,
      lead_id: leadId,
      requested_by: requestedBy,
      requested_by_email: requestedByEmail,
    },
    { timeoutMs: BRIDGE_TIMEOUT_MS },
  );

  // The bridge tool returns a JSON string in `output` either way.
  let parsed: Record<string, unknown> = {};
  try {
    parsed = result.output ? (JSON.parse(result.output) as Record<string, unknown>) : {};
  } catch {
    parsed = { message: result.output };
  }

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: (parsed.error as string) ?? result.error ?? "clair_failed",
        message: (parsed.message as string) ?? result.output ?? "CLEAR lookup failed",
        report_id: parsed.report_id ?? null,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, ...parsed });
}

