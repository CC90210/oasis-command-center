/**
 * lib/slack/install.ts - finish "Add to Slack": turn Slack's one-time code into
 * a connected workspace, or refuse and leave nothing behind.
 *
 * THE ORDER, each step refusing before the next can write:
 *   1. The consent state is verified and CONSUMED (lib/connections/oauth.ts:
 *      HMAC-signed, single-use, 10 minutes). Its tenant and user must be the
 *      signed-in person's own (the callback route checks), so nobody can finish
 *      a consent into someone else's workspace.
 *   2. The code is exchanged at oauth.v2.access with OASIS's app credentials
 *      (Worker secrets only). A bot token (xoxb-), a team id, and not an
 *      Enterprise Grid org install (v1 installs one workspace at a time).
 *   3. The team must not already belong to another OASIS workspace
 *      (provider_webhook_routes, unique per Slack team).
 *   4. The connection is CLAIMED for this tenant, pinned to the Slack team.
 *   5. The bot token is SAVED encrypted (token-store saveBotToken). A failed
 *      save undoes the claim: a connection is never "connected" without its
 *      token.
 *   6. The team is ROUTED to this tenant (registerWebhookRoute), which is how
 *      every later event finds its workspace. Losing that race undoes 4 and 5.
 *   7. A live auth.test is RECORDED as the connection's first health check:
 *      green means Slack answered, not that a token was saved.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { completeCallback, OAuthFlowError } from "@/lib/connections/oauth";
import type { ProviderDef } from "@/lib/connections/registry";
import { credentialServiceFor } from "@/lib/connections/rules";
import {
  claimConnection,
  findActiveConnection,
  getConnection,
  recordHealthCheck,
  registerWebhookRoute,
  resolveWebhookRoute,
  type ConnectionRow,
} from "@/lib/connections/store";
import { auditConnection, probeFor, type ConnectionsDeps } from "@/lib/connections/health";
import { undoUnsavedClaim } from "@/lib/connections/service";
import { saveBotToken } from "@/lib/connections/token-store";
import { deleteTenantIntegrationService } from "@/lib/tenant-integration-store";
import { exchangeInstallCode, type SlackFetch } from "@/lib/slack/client";

export type SlackInstallFailure =
  | "state_invalid"
  | "state_secret_missing"
  | "wrong_person"
  | "app_credentials_missing"
  | "exchange_failed"
  | "not_a_bot_token"
  | "enterprise_install_unsupported"
  | "team_connected_elsewhere"
  | "another_team_connected"
  | "token_save_failed";

export type SlackInstallResult =
  | { ok: true; tenantId: string; teamId: string; teamName: string | null; connection: ConnectionRow }
  | { ok: false; failure: SlackInstallFailure; detail?: string };

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Finish a Slack install for the signed-in person `session`. Every refusal is
 * a code; nothing about the token or the code is in it.
 */
export async function completeSlackInstall(
  deps: ConnectionsDeps & { fetchImpl?: SlackFetch },
  input: {
    provider: ProviderDef;
    state: string;
    code: string;
    redirectUri: string;
    session: { tenantId: string; userId: string; email: string | null };
    env?: Env;
  },
): Promise<SlackInstallResult> {
  const env = input.env ?? process.env;
  const db: Client = deps.db;

  let consent;
  try {
    consent = await completeCallback(db, { state: input.state, now: deps.now(), env });
  } catch (err) {
    if (err instanceof OAuthFlowError && err.code === "state_secret_missing") return { ok: false, failure: "state_secret_missing" };
    return { ok: false, failure: "state_invalid", detail: err instanceof OAuthFlowError ? err.code : undefined };
  }
  if (consent.provider !== "slack" || consent.tenantId !== input.session.tenantId || consent.userId !== input.session.userId) {
    return { ok: false, failure: "wrong_person" };
  }

  const oauth = input.provider.oauth;
  const clientId = oauth ? (env[oauth.clientIdEnv] || "").trim() : "";
  const clientSecret = oauth ? (env[oauth.clientSecretEnv] || "").trim() : "";
  if (!clientId || !clientSecret) return { ok: false, failure: "app_credentials_missing" };

  const exchanged = await exchangeInstallCode(
    { clientId, clientSecret, code: input.code, redirectUri: input.redirectUri },
    { fetchImpl: deps.fetchImpl },
  );
  if (!exchanged.ok) return { ok: false, failure: "exchange_failed", detail: exchanged.error };
  const install = exchanged.data;
  if (install.is_enterprise_install === true) return { ok: false, failure: "enterprise_install_unsupported" };
  const token = typeof install.access_token === "string" ? install.access_token : "";
  const teamId = typeof install.team?.id === "string" ? install.team.id : "";
  if (!token.startsWith("xoxb-") || !teamId) return { ok: false, failure: "not_a_bot_token" };
  const teamName = typeof install.team?.name === "string" && install.team.name.trim() ? install.team.name.trim() : null;
  const tenantId = consent.tenantId;

  const routed = await resolveWebhookRoute(db, "slack", teamId);
  if (routed && routed.tenantId !== tenantId) return { ok: false, failure: "team_connected_elsewhere" };

  const claim = await claimConnection(db, {
    tenantId,
    provider: "slack",
    authKind: input.provider.authKind,
    scopeKind: input.provider.scopeKind,
    userId: null,
    externalAccountId: teamId,
    externalAccountLabel: teamName,
    environment: null,
    grantedScopes: String(install.scope ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    scopeSetVersion: 1,
    connectedBy: consent.userId,
    now: deps.now(),
  });
  if (!claim.ok) {
    return claim.error === "account_connected_elsewhere"
      ? { ok: false, failure: "team_connected_elsewhere" }
      : { ok: false, failure: "another_team_connected", detail: claim.current.external_account_label ?? undefined };
  }
  const conn = claim.connection;

  try {
    await saveBotToken(tenantId, conn.id, { bot_token: token, bot_user_id: install.bot_user_id ?? null });
  } catch (err) {
    console.error("[slack.install] bot token save failed", { tenantId, connectionId: conn.id, error: err instanceof Error ? err.message : String(err) });
    await undoUnsavedClaim(deps, tenantId, claim);
    return { ok: false, failure: "token_save_failed" };
  }

  const route = await registerWebhookRoute(db, {
    tenantId,
    provider: "slack",
    externalKey: teamId,
    connectionId: conn.id,
    now: deps.now(),
  });
  if (!route.ok) {
    // Another workspace routed this team between the check and here. Nothing
    // of this install may stay: the token goes, then the claim.
    const removed = await deleteTenantIntegrationService({ tenantId, service: credentialServiceFor(conn.id) });
    if (!removed.ok) console.error("[slack.install] token delete after a lost route failed", { tenantId, connectionId: conn.id, error: removed.error });
    await undoUnsavedClaim(deps, tenantId, claim);
    return { ok: false, failure: "team_connected_elsewhere" };
  }

  const probe = probeFor("slack");
  const result = probe
    ? await probe(token, deps.fetchImpl ?? fetch, deps.probeTimeoutMs)
    : { verdict: "unknown" as const, code: null, detail: null, latencyMs: 0, accountId: null, accountLabel: null, environment: null };
  const mismatch = result.accountId !== null && result.accountId !== teamId;
  const recorded = await recordHealthCheck(db, {
    tenantId,
    connectionId: conn.id,
    source: "connect",
    verdict: mismatch ? "down" : result.verdict,
    code: mismatch ? "account_mismatch" : result.code,
    detail: mismatch ? "Slack answered for a different workspace than the one installed." : result.detail,
    latencyMs: result.latencyMs,
    accountLabel: mismatch ? null : result.accountLabel ?? teamName,
    now: deps.now(),
  });
  await auditConnection({
    tenantId,
    actor: { userId: consent.userId, email: input.session.email },
    action: claim.created ? "connection.connected" : "connection.reconnected",
    connectionId: conn.id,
    after: { provider: "slack", account_id: teamId, auth_kind: input.provider.authKind, scopes: input.provider.scopes.base },
  });
  const final = (await getConnection(db, tenantId, conn.id)) ?? recorded.connection;
  return { ok: true, tenantId, teamId, teamName, connection: final };
}

/** The tenant's live Slack connection, or null. */
export function findSlackConnection(db: Client, tenantId: string): Promise<ConnectionRow | null> {
  return findActiveConnection(db, tenantId, "slack");
}
