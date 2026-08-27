/**
 * GET /api/integrations/personal/status — list of personal-scope
 * integrations connected for the signed-in user. Phase 4 of the
 * SunBiz multi-employee personalization plan (2026-05-29).
 *
 * Returns just presence + the few non-sensitive fields the Settings
 * UI needs to render the connected state. Tokens stay encrypted in
 * the DB; only the gmail_address + expires_at surface (so the operator
 * can see which account is linked + that it hasn't expired).
 */

import { NextResponse } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import {
  getUserIntegrationBundle,
  listUserIntegrationStatus,
} from "@/lib/user-integration-store";
import { hasRequiredScope } from "@/lib/integrations/google-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const db = getServiceSupabase();
  const profile = await db
    .from("user_profiles")
    .select("tenant_id,email")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profile.data as { tenant_id?: string | null } | null)?.tenant_id;
  const expectedWorkEmail = String(
    (profile.data as { email?: string | null } | null)?.email || "",
  ).trim().toLowerCase();
  if (!tenantId) {
    return NextResponse.json({ ok: true, statuses: [] });
  }

  const rows = await listUserIntegrationStatus(tenantId, user.id);
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
  if (!services.gmail_oauth) services.gmail_oauth = { connected: false };

  // Hydrate user-visible Gmail fields (address, expiry) for the panel
  // without leaking the tokens themselves. Bundle returns plaintext —
  // we filter down to just the non-sensitive bits.
  const statuses = await Promise.all(
    Object.entries(services).map(async ([service, { connected }]) => {
      if (service === "gmail_oauth") {
        const bundle = await getUserIntegrationBundle(tenantId, user.id, "gmail_oauth");
        const workspaceConnected = Boolean(bundle.refresh_token);
        const calendarConnected =
          workspaceConnected &&
          // Same predicate the booking uses: the broader auth/calendar scope
          // contains calendar.events, and reporting a more-privileged
          // connection as not-connected is the #331 defect on another surface.
          hasRequiredScope(bundle.scope) &&
          Boolean(expectedWorkEmail) &&
          String(bundle.gmail_address || "").trim().toLowerCase() === expectedWorkEmail;
        const calendarIdentityMismatch =
          workspaceConnected &&
          Boolean(expectedWorkEmail) &&
          Boolean(bundle.gmail_address) &&
          String(bundle.gmail_address).trim().toLowerCase() !== expectedWorkEmail;
        return {
          service,
          connected: workspaceConnected,
          gmail_address: bundle.gmail_address || null,
          expires_at: bundle.expires_at || null,
          calendar_connected: calendarConnected,
          calendar_reconnect_required: workspaceConnected && !calendarConnected,
          calendar_identity_mismatch: calendarIdentityMismatch,
          expected_work_email: expectedWorkEmail || null,
        };
      }
      return { service, connected };
    }),
  );

  return NextResponse.json({ ok: true, statuses });
}
