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
 *   connections        the tenant's live tenant_connections rows (state and
 *                      health only — lib/connections/store.ts
 *                      listActiveConnections). Before migration bravo__187 is
 *                      applied this read fails, and the cards it feeds say
 *                      "Status unavailable", not "Not connected".
 */

import "server-only";

import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient } from "@/lib/turso";
import { listTenantIntegrationStatus, tenantMayUseEnvFallback } from "@/lib/tenant-integration-store";
import { listUserIntegrationStatus } from "@/lib/user-integration-store";
import { listActiveConnections } from "@/lib/connections/store";
import { PROVIDERS, providerAvailability } from "@/lib/connections/registry";
import { SLACK_APP_FIELDS, SLACK_APP_SERVICE, slackAppKindFor, slackInstallsPossible } from "@/lib/slack/own-app";
import {
  CONNECTOR_CATALOG,
  resolveConnectorStatus,
  type ConnectionFact,
  type ConnectorFacts,
  type ConnectorStatus,
  type HeartbeatFact,
  type KeyRowFact,
} from "@/lib/os/connectors";

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
      // A test's code (Twilio's plain states) and whether the value is OASIS's
      // own deployment value; still never the value itself.
      last_test_error: r.last_test_error,
      source: r.source,
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

async function loadConnections(tenantId: string): Promise<ConnectionFact[] | null> {
  try {
    const rows = await listActiveConnections(getTursoClient(), tenantId);
    return rows.map((r) => ({
      provider: r.provider,
      status: r.status,
      account_id: r.external_account_id,
      account_label: r.external_account_label,
      environment: r.environment,
      last_health_at: r.last_health_at,
      last_health_verdict: r.last_health_verdict,
      last_health_code: r.last_health_code,
      last_health_detail: r.last_health_detail,
    }));
  } catch (error) {
    console.error("[connections.facts.connections]", error);
    return null;
  }
}

export async function loadConnectorFacts(input: {
  tenantId: string;
  userId: string;
}): Promise<ConnectorFacts> {
  const [keyRows, heartbeats, personalGoogleLinked, connections] = await Promise.all([
    loadKeyRows(input.tenantId),
    loadHeartbeats(input.tenantId),
    loadPersonalGoogle(input.tenantId, input.userId),
    loadConnections(input.tenantId),
  ]);
  // A workspace's own Slack app is read from the same key rows (presence only):
  // saved (every value), incomplete, or none; unknown when they could not be read.
  const ownApps = keyRows ? { slack: ownAppState(keyRows, SLACK_APP_SERVICE, SLACK_APP_FIELDS) } : null;
  const installUnavailable = slackInstallsPossible() ? [] : ["slack"];
  // A client's own app stands in for OASIS's (lib/slack/own-app.ts
  // slackAppKindFor); OASIS's own workspace has only OASIS's app, whatever it saved.
  const clientWorkspace = slackAppKindFor(input.tenantId) === "own";
  return {
    keyRows,
    heartbeats,
    personalGoogleLinked,
    connections,
    // A client whose own app is saved, where installs can run, has its app.
    appNotConfigured: appNotConfiguredProviders().filter(
      (p) => !(clientWorkspace && ownApps?.[p as keyof typeof ownApps] === "saved" && !installUnavailable.includes(p)),
    ),
    // OASIS's own workspaces, by id (the env-credential tenants): they connect
    // OASIS's apps; every other workspace is a client and is shown its own path.
    oasisWorkspace: tenantMayUseEnvFallback(input.tenantId),
    ownApps,
    installUnavailable,
  };
}

function ownAppState(rows: readonly KeyRowFact[], service: string, fields: readonly string[]): "saved" | "incomplete" | "none" {
  const saved = fields.filter((f) => rows.some((r) => r.service === service && r.field_key === f && r.has_value));
  return saved.length === fields.length ? "saved" : saved.length > 0 ? "incomplete" : "none";
}

/**
 * Every card's status for one workspace, from one read of its facts: what
 * Settings > Connections, the onboarding connections step and AI brain all
 * render, so a connection set up in any of them reads the same in the others.
 */
export async function loadConnectorStatuses(input: {
  tenantId: string;
  userId: string;
  nowMs?: number;
}): Promise<Record<string, ConnectorStatus>> {
  const facts = await loadConnectorFacts({ tenantId: input.tenantId, userId: input.userId });
  const now = input.nowMs ?? Date.now();
  return Object.fromEntries(CONNECTOR_CATALOG.map((def) => [def.slug, resolveConnectorStatus(def, facts, now)]));
}

/**
 * Providers that need OASIS's own app on this deployment and do not have it
 * (Slack without its Worker secrets). Names only, from the registry; the card
 * then says "app not configured yet" instead of offering a connect that
 * cannot work.
 */
export function appNotConfiguredProviders(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  return PROVIDERS.filter((p) => (p.liveWhenEnv?.length ?? 0) > 0 && providerAvailability(p, env) !== "live").map((p) => p.id);
}
