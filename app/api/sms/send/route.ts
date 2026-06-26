import { NextResponse } from "next/server";
import { dispatchSmsThroughClientAgent } from "@/lib/client-agent";
import {
  DEMO_CLIENT_PROFILE_COOKIE,
  getClientCommandCenterProfile,
  getClientCommandCenterProfileById,
  resolveClientProfileSlug,
} from "@/lib/client-profiles";
import { getActiveProfile, getTenant } from "@/lib/queries";
import {
  tenantHasDirectTwilio,
  sendSmsDirectTwilio,
} from "@/lib/sms-direct-twilio";
import { cookies } from "next/headers";
import { isDryRun } from "@/lib/integrations/send-mode";

/**
 * POST /api/sms/send — client-agent SMS dispatch.
 *
 * The dashboard never holds Twilio credentials directly. It resolves the
 * active client's command-center profile and then:
 *   1. prefers a hosted client-agent HTTP endpoint (Vercel/Fly/Render-safe)
 *   2. falls back to the local sms_engine.py only in non-production dev
 *
 * This lets the shared command-center shell drive separate client agents
 * without hardcoding Sun-specific process-spawn behavior into Vercel paths.
 *
 * Auth: gated on the active operator profile. Only client profiles with
 * sms.enabled=true can dispatch through this route.
 */
export async function POST(req: Request) {
  const profile = await getActiveProfile().catch(() => null);
  if (!profile) {
    return NextResponse.json(
      { ok: false, error: "No active operator profile", status: "auth_error" },
      { status: 401 }
    );
  }
  const tenant = profile.tenant_id ? await getTenant(profile.tenant_id).catch(() => null) : null;
  const tenantProfileSlug = resolveClientProfileSlug(tenant);
  const rawDemoProfileSlug = (await cookies()).get(DEMO_CLIENT_PROFILE_COOKIE)?.value || null;
  const demoProfileSlug = profile.tenant_id ? null : rawDemoProfileSlug;
  const demoProfile = getClientCommandCenterProfileById(demoProfileSlug);
  const clientProfile =
    demoProfile.id === "default"
      ? getClientCommandCenterProfile(tenantProfileSlug)
      : demoProfile;
  if (!clientProfile.sms?.enabled) {
    return NextResponse.json(
      {
        ok: false,
        error: `SMS is not enabled for client profile ${clientProfile.id}`,
        status: "unsupported",
      },
      { status: 403 }
    );
  }

  let payload: { to?: string; body?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body", status: "bad_request" },
      { status: 400 }
    );
  }

  const to = (payload.to || "").trim();
  const body = (payload.body || "").trim();

  if (!to || !body) {
    return NextResponse.json(
      { ok: false, error: "Both 'to' and 'body' are required", status: "validation_error" },
      { status: 400 }
    );
  }
  // Mirror sms_engine.py's E.164 check so we fail fast without spawning Python.
  if (!/^\+[1-9]\d{6,14}$/.test(to)) {
    return NextResponse.json(
      { ok: false, error: "to must be E.164, e.g. +14165551212", status: "validation_error" },
      { status: 400 }
    );
  }
  if (body.length > 1600) {
    return NextResponse.json(
      { ok: false, error: "body exceeds 1600 chars", status: "validation_error" },
      { status: 400 }
    );
  }

  // Dry-run gate (2026-06-02): the dashboard defaults to dry-run so no SMS
  // route can send live before DASHBOARD_LIVE_SEND=1 is set. Short-circuit
  // after validation, before either the direct-Twilio or client-agent path.
  if (isDryRun("twilio")) {
    return NextResponse.json(
      { ok: true, dry_run: true, status: "dry_run", would_send: { to, body } },
      { status: 200 }
    );
  }

  // Per-tenant direct-Twilio path. When the operator has pasted
  // (account_sid + auth_token + from_number) into Settings →
  // Integration Keys, skip the hosted-client-agent indirection and
  // POST straight to Twilio's Messages API. Profile.tenant_id is
  // guaranteed present at this point — we resolved it above.
  if (profile.tenant_id && (await tenantHasDirectTwilio(profile.tenant_id))) {
    const direct = await sendSmsDirectTwilio({
      tenantId: profile.tenant_id,
      to,
      body,
    });
    if (direct.ok) {
      return NextResponse.json(
        {
          ok: true,
          status: "sent",
          provider: direct.provider,
          message_sid: direct.message_sid,
          twilio_status: direct.status,
        },
        { status: 200 },
      );
    }
    // Direct path failed — log and fall through to the hosted
    // dispatch so the operator isn't blocked if (say) Twilio's API
    // is having a moment but the hosted gateway is up.
    console.error("[sms/send] direct twilio failed, falling back to client-agent", direct.error);
  }

  const result = await dispatchSmsThroughClientAgent({
    clientProfile,
    tenantSlug: demoProfile.id === "default" ? tenantProfileSlug : demoProfile.id,
    to,
    body,
  });
  return NextResponse.json(result.body, { status: result.status });
}
