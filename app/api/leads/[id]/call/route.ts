/**
 * POST /api/leads/[id]/call — initiate a Kixie alley-oop call to a lead.
 *
 * Phase 3 of the TT + Kixie full embedding plan (2026-06-01).
 *
 * Alley-oop flow:
 *   1. Kixie rings the acting employee's phone (per their kixie_agent_email).
 *   2. Once the employee picks up, Kixie bridges to the lead's phone.
 *   3. Kixie's webhooks (startcall, answeredcall, endcall, etc.) land back
 *      at /api/webhooks/kixie and populate lead_interactions for the timeline.
 *
 * Per-employee routing precedence (handled by lib/integrations/kixie.ts +
 * the resolution code below):
 *   1. user_integration_credentials.kixie.kixie_agent_email (Phase 5 override)
 *   2. user_profiles.email
 *   3. tenant's default_agent_email from tenant_integration_credentials.kixie
 *
 * Body: optional { display_name?: string }. Lead UUID + phone come from the
 * URL + the lead row.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { getUserIntegrationValue } from "@/lib/user-integration-store";
import { getKixieCredentials, makeCall } from "@/lib/integrations/kixie";
import { normalizePhoneE164 } from "@/lib/lead-interactions-queries";
import { isDryRun } from "@/lib/integrations/send-mode";
import { isReadOnlyRole } from "@/lib/role-gates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  req: NextRequest,
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

  let body: { display_name?: unknown };
  try {
    body = (await req.json().catch(() => ({}))) as { display_name?: unknown };
  } catch {
    body = {};
  }
  const displayName =
    typeof body.display_name === "string" && body.display_name.trim()
      ? body.display_name.trim()
      : "Outbound call";

  const db = getServiceSupabase();

  // Resolve the acting user's tenant + email.
  const profile = await db
    .from("user_profiles")
    .select("tenant_id,email,full_name,display_name,team_role")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profile.data as { tenant_id?: string | null } | null)?.tenant_id;
  const fallbackEmail = (profile.data as { email?: string | null } | null)?.email || "";
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });
  }
  // Role gate (2026-06-18): placing an outbound call is a member+ capability —
  // read_only members are denied, for parity with the SMS send path
  // (/api/conversations/reply) and the bridge/exec-tool wall.
  const teamRole = (profile.data as { team_role?: string | null } | null)?.team_role;
  if (isReadOnlyRole(teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't place calls." },
      { status: 403 },
    );
  }

  // Resolve the lead's phone from tenant_records (works for both lead +
  // application entities since both carry data.phone today).
  const leadRow = await db
    .from("tenant_records")
    .select("id,data")
    .eq("id", leadId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!leadRow.data) {
    return NextResponse.json({ ok: false, error: "lead_not_found" }, { status: 404 });
  }
  const leadData = (leadRow.data as { data?: Record<string, unknown> }).data || {};
  const rawPhone = typeof leadData.phone === "string" ? leadData.phone : "";
  const targetPhone = normalizePhoneE164(rawPhone);
  if (!targetPhone) {
    return NextResponse.json(
      {
        ok: false,
        error: "no_phone",
        message: "Lead record has no phone or the format is unrecognized.",
      },
      { status: 400 },
    );
  }

  // Resolve the agent email: per-user override → user_profiles.email →
  // tenant default (handled inside the kixie client's defaultAgentEmail).
  let agentEmail = fallbackEmail;
  try {
    const override = await getUserIntegrationValue(
      tenantId,
      user.id,
      "kixie",
      "kixie_agent_email",
    );
    if (override) agentEmail = override;
  } catch {
    // Soft-fail; fallback email is still valid.
  }

  // Pull tenant credentials. If the override + fallback are both empty,
  // the credentials' defaultAgentEmail wins; if THAT is also empty, the
  // Kixie API rejects the call. The error surfaces back to the operator.
  let creds;
  try {
    creds = await getKixieCredentials(tenantId);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "missing_credentials",
        message:
          err instanceof Error
            ? err.message
            : "Kixie credentials not configured for this workspace.",
      },
      { status: 400 },
    );
  }
  if (!agentEmail) agentEmail = creds.defaultAgentEmail || "";
  if (!agentEmail) {
    return NextResponse.json(
      {
        ok: false,
        error: "no_agent_email",
        message:
          "Couldn't resolve a Kixie agent email — set yours in Settings → Personal integrations or have your admin set the workspace default.",
      },
      { status: 400 },
    );
  }

  // Dry-run gate (2026-06-02): the dashboard defaults to dry-run so the
  // Call button can't place a live call the moment Kixie creds land. We
  // still validate everything above (phone, agent email, creds) and log
  // the attempt; we just skip the actual Kixie request.
  const dryRun = isDryRun("kixie");
  if (!dryRun) {
    try {
      await makeCall(creds, {
        target: targetPhone,
        agentEmail,
        displayName,
        leadId, // echoed back via customField1 on webhook events
      });
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: "kixie_call_failed",
          message: err instanceof Error ? err.message : "Kixie call request failed.",
        },
        { status: 502 },
      );
    }
  }

  // Log the initiation immediately so the drawer timeline reflects the
  // pending call even before the startcall webhook arrives (~1-3s).
  try {
    await db.from("lead_interactions").insert({
      tenant_id: tenantId,
      lead_id: leadId,
      type: "call_initiated",
      channel: "phone",
      direction: "outbound",
      agent_source: "dashboard_drawer",
      from_phone: null,
      to_phone: targetPhone,
      content_preview: dryRun
        ? `Dry-run call to ${targetPhone} (not placed)`
        : `Call initiated by ${agentEmail}`,
      actor_user_id: user.id,
      metadata: {
        kixie_agent_email: agentEmail,
        requested_by_email: fallbackEmail,
        display_name: displayName,
        dry_run: dryRun,
      },
    });
  } catch (err) {
    console.error("[leads.call] initial lead_interactions insert failed", err);
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    agent_email: agentEmail,
    target_phone: targetPhone,
    message: dryRun
      ? `Dry-run — would ring your line at ${agentEmail} then bridge to ${targetPhone}. No call placed (dashboard is in dry-run mode).`
      : `Ringing your line at ${agentEmail} — pick up to bridge to the lead.`,
  });
}
