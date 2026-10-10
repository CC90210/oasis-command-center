/**
 * lib/connections/oauth-connect.ts - finish a sign-in at the vendor's own
 * authorization page (QuickBooks, Xero, Zoom, WhatsApp): turn the one-time code
 * the vendor sent back into a connected account, or refuse and leave nothing
 * behind. The Slack install has its own, longer finish (lib/slack/install.ts).
 *
 * THE ORDER, each step refusing before the next can write:
 *   1. The consent state is verified and CONSUMED (lib/connections/oauth.ts:
 *      HMAC-signed, single-use, 10 minutes). Its tenant, user and provider
 *      must be the signed-in person's own and the route's own, so a consent
 *      started by someone else, or for another app, can never be finished
 *      into this workspace.
 *   2. The code is exchanged at the vendor with OASIS's app credentials
 *      (Worker secrets only).
 *   3. The grant is IDENTIFIED: which company, organisation, account or
 *      WhatsApp Business Account it opens. No answer, no connection.
 *   4. The account is CLAIMED for this tenant (an exclusive account live in
 *      another workspace is refused, as is a second account while one is live).
 *   5. The tokens are SAVED encrypted in one atomic write. A failed save undoes
 *      the claim: a connection is never "connected" without its tokens.
 *   6. A live check is RECORDED as the connection's first health check.
 *
 * Every refusal is a stable code the popup page turns into words; the code,
 * the state and the tokens are in no code, log or redirect.
 */
import "server-only";
import { completeCallback, OAuthFlowError } from "@/lib/connections/oauth";
import { providerById } from "@/lib/connections/registry";
import { claimConnection, getConnection, recordHealthCheck, type ConnectionRow } from "@/lib/connections/store";
import { auditConnection, type ConnectionsDeps } from "@/lib/connections/health";
import { undoUnsavedClaim } from "@/lib/connections/service";
import { saveConnectionTokens } from "@/lib/connections/token-store";
import {
  OAuthExchangeError,
  oauthAdapterFor,
  type AdapterDeps,
  type OAuthAdapter,
  type OAuthClient,
  type TokenGrant,
} from "@/lib/connections/oauth-adapters";
import { adapterDeps, grantToTokens, oauthClientFor } from "@/lib/connections/oauth-live";

export type OAuthConnectFailure =
  | "no_install_flow"
  | "state_invalid"
  | "state_secret_missing"
  | "wrong_person"
  | "app_credentials_missing"
  | "exchange_failed"
  | "account_unidentified"
  | "account_connected_elsewhere"
  | "another_account_connected"
  | "token_save_failed";

export type OAuthConnectResult =
  | { ok: true; tenantId: string; accountId: string; accountLabel: string | null; connection: ConnectionRow }
  | { ok: false; failure: OAuthConnectFailure; detail?: string };

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The vendor already issued tokens by the time OASIS can still refuse the
 * sign-in: claimConnection's account_connected_elsewhere / another_account_connected,
 * or a failed token save. Nothing is connected on OASIS's side either way, but
 * without this the grant stays live at the vendor for as long as a real
 * connection would have — 60-90 days for most of these (CodeRabbit, PR #574).
 *
 * Best-effort and bounded by the adapter's own deadline (AdapterDeps.timeoutMs,
 * the same send() every adapter call already uses): a revoke that fails is
 * logged by provider and reason only, never the tokens, and never changes
 * what the caller returns, so the ORIGINAL refusal is always what the caller sees.
 */
export async function revokeAfterRefusal(
  adapter: OAuthAdapter,
  client: OAuthClient,
  grant: TokenGrant,
  deps: AdapterDeps,
  context: { providerId: string; tenantId: string; reason: string },
): Promise<void> {
  try {
    const revoked = await adapter.revoke(client, { accessToken: grant.accessToken, refreshToken: grant.refreshToken }, deps);
    if (!revoked) {
      console.error("[connections.oauth] vendor grant left live after a refused connect", {
        provider: context.providerId,
        tenantId: context.tenantId,
        reason: context.reason,
      });
    }
  } catch (err) {
    console.error("[connections.oauth] revoking after a refused connect threw", {
      provider: context.providerId,
      tenantId: context.tenantId,
      reason: context.reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function completeOAuthConnect(
  deps: ConnectionsDeps,
  input: {
    providerId: string;
    state: string;
    code: string;
    /** The callback's own query string: QuickBooks names the company there. */
    query: URLSearchParams;
    redirectUri: string;
    session: { tenantId: string; userId: string; email: string | null };
    env?: Env;
  },
): Promise<OAuthConnectResult> {
  const env = input.env ?? process.env;
  const provider = providerById(input.providerId);
  const adapter = oauthAdapterFor(input.providerId);
  if (!provider || !adapter) return { ok: false, failure: "no_install_flow" };

  let consent;
  try {
    consent = await completeCallback(deps.db, { state: input.state, now: deps.now(), env });
  } catch (err) {
    if (err instanceof OAuthFlowError && err.code === "state_secret_missing") return { ok: false, failure: "state_secret_missing" };
    return { ok: false, failure: "state_invalid", detail: err instanceof OAuthFlowError ? err.code : undefined };
  }
  if (consent.provider !== provider.id || consent.tenantId !== input.session.tenantId || consent.userId !== input.session.userId) {
    return { ok: false, failure: "wrong_person" };
  }
  const tenantId = consent.tenantId;

  const client = oauthClientFor(provider, env);
  if (!client) return { ok: false, failure: "app_credentials_missing" };
  const a = adapterDeps({ ...deps, env });

  let grant;
  let identity;
  try {
    grant = await adapter.exchange(client, { code: input.code, redirectUri: input.redirectUri }, a);
    identity = await adapter.identify(client, grant, input.query, a);
  } catch (err) {
    if (err instanceof OAuthExchangeError) {
      console.error("[connections.oauth] sign-in refused", { provider: provider.id, tenantId, code: err.code, detail: err.message });
      return { ok: false, failure: err.code, detail: err.message };
    }
    throw err;
  }

  const now = deps.now();
  const claim = await claimConnection(deps.db, {
    tenantId,
    provider: provider.id,
    authKind: provider.authKind,
    scopeKind: provider.scopeKind,
    userId: null,
    externalAccountId: identity.accountId,
    externalAccountLabel: identity.accountLabel,
    environment: identity.environment,
    grantedScopes: provider.scopes.base,
    scopeSetVersion: 1,
    connectedBy: consent.userId,
    now,
  });
  if (!claim.ok) {
    await revokeAfterRefusal(adapter, client, grant, a, { providerId: provider.id, tenantId, reason: claim.error });
    return claim.error === "account_connected_elsewhere"
      ? { ok: false, failure: "account_connected_elsewhere" }
      : { ok: false, failure: "another_account_connected", detail: claim.current.external_account_label ?? undefined };
  }
  const conn = claim.connection;

  try {
    await saveConnectionTokens(tenantId, conn.id, grantToTokens(grant, now));
  } catch (err) {
    console.error("[connections.oauth] token save failed", {
      provider: provider.id,
      tenantId,
      connectionId: conn.id,
      error: err instanceof Error ? err.message : String(err),
    });
    await undoUnsavedClaim(deps, tenantId, claim);
    await revokeAfterRefusal(adapter, client, grant, a, { providerId: provider.id, tenantId, reason: "token_save_failed" });
    return { ok: false, failure: "token_save_failed" };
  }

  // The first health check: a real read with the access token just issued.
  const probe = await adapter.probe(grant.accessToken, identity.accountId, a);
  const mismatch = probe.accountId !== null && probe.accountId !== identity.accountId;
  const recorded = await recordHealthCheck(deps.db, {
    tenantId,
    connectionId: conn.id,
    source: "connect",
    verdict: mismatch ? "down" : probe.verdict,
    code: mismatch ? "account_mismatch" : probe.code,
    detail: mismatch ? `${provider.label} answered for a different account than the one connected.` : probe.detail,
    latencyMs: probe.latencyMs,
    accountLabel: mismatch ? null : (probe.accountLabel ?? identity.accountLabel),
    environment: identity.environment,
    now: deps.now(),
  });
  await auditConnection({
    tenantId,
    actor: { userId: consent.userId, email: input.session.email },
    action: claim.created ? "connection.connected" : "connection.reconnected",
    connectionId: conn.id,
    after: { provider: provider.id, account_id: identity.accountId, auth_kind: provider.authKind, scopes: provider.scopes.base },
  });
  const final = (await getConnection(deps.db, tenantId, conn.id)) ?? recorded.connection;
  return { ok: true, tenantId, accountId: identity.accountId, accountLabel: identity.accountLabel, connection: final };
}
