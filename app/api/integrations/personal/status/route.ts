/**
 * GET /api/integrations/personal/status — list of personal-scope
 * integrations connected for the signed-in user. Phase 4 of the
 * SunBiz multi-employee personalization plan (2026-05-29).
 *
 * Returns just presence + the few non-sensitive fields the Settings
 * UI needs to render the connected state. Tokens stay encrypted in
 * the DB; only the Google address and the resolved status surface
 * (lib/os/connectors.ts personalGoogleStatus): which account is linked,
 * and whether it is ready for client invitations.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/supabase-server";
import { resolveActiveProfileForUser } from "@/lib/active-profile-resolver";
import { listUserIntegrationStatus } from "@/lib/user-integration-store";
import { readPersonalGoogleFact, PERSONAL_GOOGLE_SERVICE } from "@/lib/integrations/personal-google";
import { personalGoogleStatus } from "@/lib/os/connectors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const profile = await resolveActiveProfileForUser(user);
  if (profile.error) {
    console.error("[personal-integrations.status.profile]", profile.error);
    return NextResponse.json(
      { ok: false, availability: "unavailable", error: "personal_status_unavailable" },
      { status: 503 },
    );
  }
  const tenantId = profile.profile?.tenant_id;
  if (!tenantId) {
    return NextResponse.json({ ok: true, availability: "available", statuses: [] });
  }

  let rows;
  try {
    rows = await listUserIntegrationStatus(tenantId, user.id);
  } catch (error) {
    console.error("[personal-integrations.status.rows]", error);
    return NextResponse.json(
      { ok: false, availability: "unavailable", error: "personal_status_unavailable" },
      { status: 503 },
    );
  }
  // Collapse field-key rows into per-service summaries. A service is
  // "connected" if any of its required fields are present (for
  // gmail_oauth, refresh_token is the load-bearing one).
  const services: Record<string, { connected: boolean }> = {};
  for (const row of rows) {
    if (!services[row.service]) services[row.service] = { connected: false };
    if (row.has_value) services[row.service].connected = true;
  }
  // Always return the work connection's readiness shape. A missing row means
  // disconnected; a refresh token without Calendar scope means reconnect once.
  if (!services[PERSONAL_GOOGLE_SERVICE]) services[PERSONAL_GOOGLE_SERVICE] = { connected: false };

  // The person's own Google account, through the one reader and resolver every
  // screen uses (lib/integrations/personal-google.ts, lib/os/connectors.ts
  // personalGoogleStatus): the panel, the Connections card and Today say the
  // same words. Every flag below is derived from that one state, so they can
  // never disagree with it. Non-secret fields only: never a token.
  let statuses;
  try {
    statuses = await Promise.all(
      Object.entries(services).map(async ([service, { connected }]) => {
        if (service === PERSONAL_GOOGLE_SERVICE) {
          const fact = await readPersonalGoogleFact(tenantId, user.id);
          const status = personalGoogleStatus(fact);
          return {
            service,
            connected: fact.linked,
            gmail_address: fact.address,
            calendar_connected: status.state === "ready",
            calendar_reconnect_required: status.state === "reconnect" || status.state === "wrong_account",
            calendar_identity_mismatch: status.state === "wrong_account",
            expected_work_email: fact.workEmail,
            status: { state: status.state, kind: status.kind, label: status.label, detail: status.detail ?? null },
          };
        }
        return { service, connected };
      }),
    );
  } catch (error) {
    console.error("[personal-integrations.status.hydrate]", error);
    return NextResponse.json(
      { ok: false, availability: "unavailable", error: "personal_status_unavailable" },
      { status: 503 },
    );
  }

  return NextResponse.json({ ok: true, availability: "available", statuses });
}
