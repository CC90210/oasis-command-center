/**
 * lib/integrations/personal-google.ts - the ONE reader of a person's own Google
 * connection (user_integration_credentials, service gmail_oauth), for every
 * screen that reports it: Settings (the "Your own Google account" panel, via
 * /api/integrations/personal/status), the Google card in Connections
 * (components/os/connections/connector-facts.ts), Today's calendar line
 * (components/os/today/loaders.ts) and the handoff form's host list
 * (app/api/team/members). The handoff form alone also spends the token against
 * Google, and only for a connection this reader calls ready, because a booking
 * is about to use it: a token revoked at Google reads "Reconnect once" there,
 * while the other screens, which do not call Google on every visit, say what
 * the saved grant shows (and say that they do not re-check it).
 *
 * They used to answer from three different rules, so the same account read
 * "Wrong Google account" in Settings, "Connected" on Today and "Your account
 * linked" on the Connections card. Now each reads this fact and turns it into
 * words with lib/os/connectors.ts personalGoogleStatus, the booking path's own
 * predicate (a refresh token, the Calendar events scope, and the connected
 * address equal to the person's work email).
 *
 * Presence and non-secret fields only leave this file: never a token. A read
 * that fails THROWS, so a caller says "Status unavailable", never "Not
 * connected".
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getUserIntegrationBundleForStatus } from "@/lib/user-integration-store";
import { hasRequiredScope } from "@/lib/integrations/google-calendar";
import type { PersonalGoogleFact } from "@/lib/os/connectors";

/** The service a person's own work Google connection is stored under. */
export const PERSONAL_GOOGLE_SERVICE = "gmail_oauth";

/** The person's work email in this workspace: the address client invitations must come from. */
async function workEmailFor(tenantId: string, userId: string): Promise<string | null> {
  const r = await getServiceSupabase()
    .from("user_profiles")
    .select("email")
    .eq("auth_user_id", userId)
    .eq("tenant_id", tenantId)
    .limit(1);
  if (r.error) throw new Error(r.error.message || "personal_google_profile_read_failed");
  const row = ((r.data || []) as Array<{ email: string | null }>)[0];
  return row?.email?.trim().toLowerCase() || null;
}

export async function readPersonalGoogleFact(tenantId: string, userId: string): Promise<PersonalGoogleFact> {
  const [bundle, workEmail] = await Promise.all([
    getUserIntegrationBundleForStatus(tenantId, userId, PERSONAL_GOOGLE_SERVICE),
    workEmailFor(tenantId, userId),
  ]);
  const linked = Boolean(bundle.refresh_token);
  return {
    linked,
    calendarScope: linked && hasRequiredScope(bundle.scope),
    address: bundle.gmail_address?.trim() || null,
    workEmail,
  };
}
