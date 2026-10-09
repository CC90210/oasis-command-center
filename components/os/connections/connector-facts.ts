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
 *   personalGoogle     the viewer's own Google connection
 *                      (lib/integrations/personal-google.ts — the one reader
 *                      Settings and Today use for it too)
 *   connections        the tenant's live tenant_connections rows (state and
 *                      health only — lib/connections/store.ts
 *                      listActiveConnections). Before migration bravo__187 is
 *                      applied this read fails, and the cards it feeds say
 *                      "Status unavailable", not "Not connected".
 *   serverChecks       OASIS's own workspaces only: the real checks of the
 *                      values OASIS sets on its server, which have no saved
 *                      row (lib/integrations/server-checks.ts — the latest Test
 *                      of each app, and the mailbox's last send).
 *
 * A heartbeat that only says a key NAME is in an env file on OASIS's computer
 * is never read as a check (2026-10-08): it proved nothing and showed
 * "Connected, verified just now". The one heartbeat read is OASIS's own email
 * sender's report of a real Gmail sign-in, through server-checks.ts.
 */

import "server-only";

import { getTursoClient } from "@/lib/turso";
import { listTenantIntegrationStatus, tenantMayUseEnvFallback } from "@/lib/tenant-integration-store";
import { readPersonalGoogleFact } from "@/lib/integrations/personal-google";
import { listServerChecks } from "@/lib/integrations/server-checks";
import { listActiveConnections } from "@/lib/connections/store";
import { PROVIDERS, providerAvailability } from "@/lib/connections/registry";
import {
  CONNECTOR_CATALOG,
  connectorBySlug,
  resolveConnectorStatus,
  type ConnectionFact,
  type ConnectorFacts,
  type ConnectorStatus,
  type KeyRowFact,
  type PersonalGoogleFact,
  type ServerCheckFact,
} from "@/lib/os/connectors";

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

async function loadPersonalGoogle(tenantId: string, userId: string): Promise<PersonalGoogleFact | null> {
  try {
    return await readPersonalGoogleFact(tenantId, userId);
  } catch (error) {
    console.error("[connections.facts.personal_google]", error);
    return null;
  }
}

/**
 * The real checks of the values OASIS sets on its own server. A client
 * workspace never reads a server value, so it has none and costs no read.
 */
async function loadServerChecks(tenantId: string): Promise<ServerCheckFact[] | null> {
  if (!tenantMayUseEnvFallback(tenantId)) return [];
  try {
    return await listServerChecks(tenantId);
  } catch (error) {
    console.error("[connections.facts.server_checks]", error);
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
  const [keyRows, personalGoogle, connections, serverChecks] = await Promise.all([
    loadKeyRows(input.tenantId),
    loadPersonalGoogle(input.tenantId, input.userId),
    loadConnections(input.tenantId),
    loadServerChecks(input.tenantId),
  ]);
  return {
    keyRows,
    serverChecks,
    personalGoogle,
    connections,
    appNotConfigured: appNotConfiguredProviders(),
    // OASIS's own workspaces, by id (the env-credential tenants): they connect
    // OASIS's apps; every other workspace is a client and is shown its own path.
    oasisWorkspace: tenantMayUseEnvFallback(input.tenantId),
  };
}

/**
 * One workspace card's status, for a line elsewhere that must agree with that
 * card (the department tab's Slack line, the AI Team rows). The same resolver,
 * fed only the reads the card's source needs (a key card in an OASIS
 * workspace also reads its server checks): no card's state depends on the
 * viewer's own accounts, and fewer reads keep a busy page's database reads
 * bounded. Null for a slug the catalog does not have.
 */
export async function loadWorkspaceConnectorStatus(
  tenantId: string,
  slug: string,
  nowMs: number = Date.now(),
): Promise<ConnectorStatus | null> {
  const def = connectorBySlug(slug);
  if (!def) return null;
  const framework = def.live?.source.kind === "tenant_connection";
  const [keyRows, connections, serverChecks] = await Promise.all([
    framework ? Promise.resolve([] as KeyRowFact[]) : loadKeyRows(tenantId),
    framework ? loadConnections(tenantId) : Promise.resolve([] as ConnectionFact[]),
    framework ? Promise.resolve([] as ServerCheckFact[]) : loadServerChecks(tenantId),
  ]);
  return resolveConnectorStatus(
    def,
    {
      keyRows,
      serverChecks,
      personalGoogle: null,
      connections,
      appNotConfigured: appNotConfiguredProviders(),
      oasisWorkspace: tenantMayUseEnvFallback(tenantId),
    },
    nowMs,
  );
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
