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
import { saveConnectionTokensFenced } from "@/lib/connections/token-store";
import { OAuthExchangeError, oauthAdapterFor } from "@/lib/connections/oauth-adapters";
import { adapterDeps, grantToTokens, oauthClientFor } from "@/lib/connections/oauth-live";

export type OAuthConnectFailure =
  | "no_install_flow"
  | "state_invalid"
  | "state_secret_missing"
  | "wrong_person"
  | "app_credentials_missing"
  | "exchange_failed"
  | "account_unidentified"
  | "several_accounts"
  | "account_connected_elsewhere"
  | "another_account_connected"
  | "token_save_failed";

export type OAuthConnectResult =
  | { ok: true; tenantId: string; accountId: string; accountLabel: string | null; connection: ConnectionRow }
  | { ok: false; failure: OAuthConnectFailure; detail?: string };

type Env = Readonly<Record<string, string | undefined>>;

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
    vendorPrincipalId: identity.vendorPrincipalId,
    environment: identity.environment,
    grantedScopes: provider.scopes.base,
    scopeSetVersion: 1,
    connectedBy: consent.userId,
    now,
  });
  if (!claim.ok) {
    // Deliberately NOT revoked at the vendor: the account this refused grant
    // names is exactly the one already live elsewhere (claim.error says which
    // way), and Zoom, Intuit and Meta's revoke endpoints are not scoped to
    // this one token — they deauthorize the whole account (Zoom), company
    // (Intuit) or app-for-that-user (Meta). Revoking here could disconnect
    // the OTHER, working connection this same refusal just protected, and
    // anyone who can sign in to that vendor account could trigger it from
    // their own workspace (security review of 9f96a852, PR #574). These
    // tokens are never stored, so leaving the unused grant to lapse at the
    // vendor is the lesser harm.
    return claim.error === "account_connected_elsewhere"
      ? { ok: false, failure: "account_connected_elsewhere" }
      : { ok: false, failure: "another_account_connected", detail: claim.current.external_account_label ?? undefined };
  }
  const conn = claim.connection;

  // FENCED on the version THIS claim holds (and on the row still being
  // unrevoked), the same pattern the refresher already uses
  // (saveConnectionTokensFenced): if this callback paused here and a
  // Disconnect or a newer reconnect finished first, the row has moved past
  // conn.token_version, and the save lands nothing rather than overwrite or
  // resurrect a state that is no longer this callback's to write (Codex
  // review, PR #574).
  let saved: boolean;
  try {
    saved = await saveConnectionTokensFenced(deps.db, {
      tenantId,
      connectionId: conn.id,
      version: conn.token_version,
      tokens: grantToTokens(grant, now),
      now,
    });
  } catch (err) {
    console.error("[connections.oauth] token save failed", {
      provider: provider.id,
      tenantId,
      connectionId: conn.id,
      error: err instanceof Error ? err.message : String(err),
    });
    await undoUnsavedClaim(deps, tenantId, claim);
    // Same reasoning as the claim refusal above: this can be a reconnect of
    // an account that already has a live grant (its own, or another
    // workspace's survived a race); not revoking never risks disconnecting it.
    return { ok: false, failure: "token_save_failed" };
  }
  if (!saved) {
    // Fenced out: never undo this claim here. The row already belongs to
    // whatever finished the race (a Disconnect revoked it, or a newer
    // reconnect holds a newer version with its own tokens) — undoing based
    // on THIS callback's stale claim could revert that newer, real state.
    console.error("[connections.oauth] token save fenced out by a newer claim or a disconnect", {
      provider: provider.id,
      tenantId,
      connectionId: conn.id,
    });
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
