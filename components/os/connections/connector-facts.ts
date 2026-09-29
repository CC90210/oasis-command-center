/**
 * The facts the Connections hub computes statuses from, read once per render.
 *
 * Three reads, each failing on its own: a failed read becomes `null`, which
 * lib/os/connectors.ts turns into "Status unavailable" for exactly the cards
 * that depend on it. None of them is ever turned into "not connected", and no
 * credential VALUE leaves this file — listTenantIntegrationStatus returns
 * presence and test state only.
 *
 *   keyRows            tenant_integration_credentials presence + last test
 *                      (listTenantIntegrationStatus — the same reader the
 *                      Credentials panel uses)
 *   heartbeats         integrations_health for the shared services, newest
 *                      first — the workspace-summary query, same ordering
 *   personalGoogle     the viewer's own gmail_oauth link
 *                      (listUserIntegrationStatus — the personal status API's
 *                      reader)
 */

import "server-only";

import { getServiceSupabase } from "@/lib/supabase-server";
import { listTenantIntegrationStatus } from "@/lib/tenant-integration-store";
import { listUserIntegrationStatus } from "@/lib/user-integration-store";
import type { ConnectorFacts, HeartbeatFact, KeyRowFact } from "@/lib/os/connectors";

const HEARTBEAT_SERVICES = ["gws", "telegram"] as const;

async function loadKeyRows(tenantId: string): Promise<KeyRowFact[] | null> {
  try {
    const rows = await listTenantIntegrationStatus(tenantId);
    return rows.map((r) => ({
      service: r.service,
      field_key: r.field_key,
      has_value: r.has_value,
      last_tested_at: r.last_tested_at,
      last_test_ok: r.last_test_ok,
    }));
  } catch (error) {
    console.error("[connections.facts.key_rows]", error);
    return null;
  }
}

async function loadHeartbeats(tenantId: string): Promise<HeartbeatFact[] | null> {
  try {
    const result = await getServiceSupabase()
      .from("integrations_health")
      .select("service,status,last_ping_at")
      .eq("tenant_id", tenantId)
      .in("service", [...HEARTBEAT_SERVICES])
      // Several profiles can report the same shared service. The newest
      // tenant-scoped heartbeat is the workspace truth, and a null timestamp
      // must not sort ahead of a real one.
      .order("last_ping_at", { ascending: false, nullsFirst: false });
    if (result.error) throw new Error(result.error.message);
    const seen = new Set<string>();
    const out: HeartbeatFact[] = [];
    for (const row of (result.data || []) as HeartbeatFact[]) {
      if (seen.has(row.service)) continue;
      seen.add(row.service);
      out.push({ service: row.service, status: row.status ?? null, last_ping_at: row.last_ping_at ?? null });
    }
    return out;
  } catch (error) {
    console.error("[connections.facts.heartbeats]", error);
    return null;
  }
}

async function loadPersonalGoogle(tenantId: string, userId: string): Promise<boolean | null> {
  try {
    const rows = await listUserIntegrationStatus(tenantId, userId);
    // The refresh token is the load-bearing field, as in the personal status API.
    return rows.some((r) => r.service === "gmail_oauth" && r.field_key === "refresh_token" && r.has_value);
  } catch (error) {
    console.error("[connections.facts.personal_google]", error);
    return null;
  }
}

export async function loadConnectorFacts(input: {
  tenantId: string;
  userId: string;
}): Promise<ConnectorFacts> {
  const [keyRows, heartbeats, personalGoogleLinked] = await Promise.all([
    loadKeyRows(input.tenantId),
    loadHeartbeats(input.tenantId),
    loadPersonalGoogle(input.tenantId, input.userId),
  ]);
  return { keyRows, heartbeats, personalGoogleLinked };
}
