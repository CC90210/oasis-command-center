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
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profile.data as { tenant_id?: string | null } | null)?.tenant_id;
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

  // Hydrate user-visible Gmail fields (address, expiry) for the panel
  // without leaking the tokens themselves. Bundle returns plaintext —
  // we filter down to just the non-sensitive bits.
  const statuses = await Promise.all(
    Object.entries(services).map(async ([service, { connected }]) => {
      if (service === "gmail_oauth" && connected) {
        const bundle = await getUserIntegrationBundle(tenantId, user.id, "gmail_oauth");
        return {
          service,
          connected: true,
          gmail_address: bundle.gmail_address || null,
          expires_at: bundle.expires_at || null,
        };
      }
      // Same treatment for the calendar connection: a rep with a personal and
      // a work Google account signed in needs to see WHICH calendar their
      // callbacks are landing on, or a missing reminder is unexplainable. Only
      // the address and expiry cross this boundary, never the tokens.
      if (service === "google_calendar" && connected) {
        const bundle = await getUserIntegrationBundle(tenantId, user.id, "google_calendar");
        return {
          service,
          connected: true,
          gmail_address: bundle.google_address || bundle.gmail_address || null,
          expires_at: bundle.expires_at || null,
        };
      }
      return { service, connected };
    }),
  );

  return NextResponse.json({ ok: true, statuses });
}
