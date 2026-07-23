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
 */

import { NextResponse } from "next/server";
import { authorizeBridgeRequest, callBridgeExecTool } from "@/lib/bridge-proxy";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { clairEligibility } from "@/lib/clair/eligibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** CLEAR searches are slow — the vendor call itself can take ~30s. */
const BRIDGE_TIMEOUT_MS = 90_000;

/** Roles that may spend a billable, regulated lookup. Read-only and external
 * collaborator roles cannot. */
const ALLOWED_ROLES = new Set(["owner", "admin", "member", "loan_officer", "processor"]);

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id: leadId } = await ctx.params;
  const auth = await authorizeBridgeRequest();
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
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
  if (!ALLOWED_ROLES.has(auth.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "role_not_permitted", team_role: auth.teamRole },
      { status: 403 },
    );
  }

  const svc = getServiceSupabase();

  // Guard 1 — the lead must exist in THIS tenant. Without this, a valid session
  // could pull a regulated report against another tenant's merchant by id.
  const { data: lead } = await svc
    .from("tenant_records")
    .select("id,data")
    .eq("id", leadId)
    .eq("tenant_id", auth.tenantId)
    .maybeSingle();
  if (!lead) {
    return NextResponse.json({ ok: false, error: "lead_not_found" }, { status: 404 });
  }

  // Guard 2 — CLAIR is the FALLBACK. Refuse when the automated path has not run
  // or already produced a number. The UI hides the button in those cases; this
  // is the same rule enforced where it cannot be bypassed.
  const leadData = (lead.data ?? {}) as Record<string, unknown>;
  const gate = clairEligibility(leadData);
  if (!gate.eligible) {
    return NextResponse.json(
      { ok: false, error: "clair_not_applicable", message: gate.reason },
      { status: 409 },
    );
  }

  // Who asked. Recorded on the report row because a permissible-use assertion
  // is made on a person's behalf, so the row must name that person.
  const sessionUser = await getSessionUser();

  const result = await callBridgeExecTool(
    auth.target,
    {
      tool_name: "clair_report",
      tenant_id: auth.tenantId,
      lead_id: leadId,
      requested_by: auth.userId ?? null,
      requested_by_email: sessionUser?.email ?? null,
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

