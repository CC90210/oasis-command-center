/**
 * lib/connections/oauth-live.ts - using a connection that was made through the
 * generic OAuth sign-in (QuickBooks, Xero, Zoom, WhatsApp) after it is made:
 * a valid access token on demand, the live health check, and revoking it at
 * the vendor when the owner disconnects.
 *
 * REFRESH ON USE. Access tokens last 30 minutes to an hour, so anything that
 * calls a vendor on a workspace's behalf asks getProviderAccessToken for one.
 * It reads the workspace's own live connection (tenant from the caller, never
 * a request), and lib/connections/token-store.ts getAccessToken refreshes under
 * a lease and saves the new token set in one fenced write, because the three
 * rotating vendors invalidate the old refresh token the moment a new one is
 * issued. A refresh the vendor REFUSES marks the connection expired (the card
 * then says so); a refresh the vendor could not be reached for never does.
 *
 * NEVER A TOKEN IN A RESULT. These functions return tokens only to the caller
 * that asked for one; nothing here logs, audits or returns a credential in a
 * status, an error or a health row.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { providerForEnv, type ProviderDef } from "@/lib/connections/registry";
import { credentialServiceFor } from "@/lib/connections/rules";
import { findActiveConnection, type ConnectionRow } from "@/lib/connections/store";
import { getAccessToken, TokenStoreError } from "@/lib/connections/token-store";
import { readTenantCredentialStrict } from "@/lib/tenant-integration-store";
import {
  oauthAdapterFor,
  type AdapterDeps,
  type OAuthAdapter,
  type OAuthClient,
  type OAuthProbeResult,
  type TokenGrant,
} from "@/lib/connections/oauth-adapters";

type Env = Readonly<Record<string, string | undefined>>;

/** Bound on one vendor call made by this module. */
export const OAUTH_CALL_TIMEOUT_MS = 10_000;

export type OAuthLiveDeps = { db: Client; fetchImpl?: typeof fetch; now: () => Date; probeTimeoutMs?: number; env?: Env };

export function adapterDeps(deps: Pick<OAuthLiveDeps, "fetchImpl" | "probeTimeoutMs" | "env">): AdapterDeps {
  return { fetchImpl: deps.fetchImpl ?? fetch, timeoutMs: deps.probeTimeoutMs ?? OAUTH_CALL_TIMEOUT_MS, env: deps.env ?? process.env };
}

/** OASIS's app credentials for a provider, from Worker secrets only. Null when either is missing. */
export function oauthClientFor(provider: ProviderDef, env: Env): OAuthClient | null {
  const oauth = provider.oauth;
  if (!oauth) return null;
  const clientId = (env[oauth.clientIdEnv] || "").trim();
  const clientSecret = (env[oauth.clientSecretEnv] || "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** A TokenGrant as the token store keeps it (an absolute expiry in epoch ms). */
export function grantToTokens(grant: TokenGrant, now: Date): { access_token: string; refresh_token: string; expires_at: number } {
  return { access_token: grant.accessToken, refresh_token: grant.refreshToken, expires_at: now.getTime() + grant.expiresInSec * 1000 };
}

function requireLive(providerId: string, env: Env): { provider: ProviderDef; adapter: OAuthAdapter; client: OAuthClient } {
  const provider = providerForEnv(providerId, env);
  const adapter = oauthAdapterFor(providerId);
  const client = provider && provider.availability === "live" ? oauthClientFor(provider, env) : null;
  if (!provider || !adapter || !client) throw new TokenStoreError("not_connected", `${providerId} is not set up on this deployment`);
  return { provider, adapter, client };
}

/**
 * A valid access token for THIS tenant's live connection to `providerId`,
 * refreshed if it is about to expire. Throws TokenStoreError (not_connected,
 * refresh_failed, refresh_unavailable, ...); never returns an expired token.
 */
export async function getProviderAccessToken(
  deps: OAuthLiveDeps,
  input: { tenantId: string; providerId: string },
): Promise<{ accessToken: string; accountId: string | null; connectionId: string }> {
  const env = deps.env ?? process.env;
  const { adapter, client } = requireLive(input.providerId, env);
  const row = await findActiveConnection(deps.db, input.tenantId, input.providerId);
  if (!row) throw new TokenStoreError("not_connected", `${input.providerId} is not connected for this workspace`);
  const a = adapterDeps(deps);
  const accessToken = await getAccessToken(deps.db, {
    tenantId: input.tenantId,
    connectionId: row.id,
    now: deps.now,
    refresh: async (refreshToken, signal) => {
      const grant = await adapter.refresh(client, refreshToken, a, signal);
      return grantToTokens(grant, deps.now());
    },
  });
  return { accessToken, accountId: row.external_account_id, connectionId: row.id };
}

type Outcome = Pick<OAuthProbeResult, "verdict" | "code" | "detail" | "accountLabel" | "environment"> & { latencyMs: number | null };

const NONE = { accountLabel: null, environment: null, latencyMs: null } as const;

/**
 * The health check of a stored OAuth connection: a fresh access token (refreshed
 * if needed), then the vendor's cheap read for the pinned account. Returns the
 * outcome health.ts records. A database outage on the token read throws, like
 * the key providers' credential read: it is OASIS's fault, not a fact about the
 * connection.
 */
export async function oauthProbeOutcome(deps: OAuthLiveDeps, row: ConnectionRow): Promise<Outcome> {
  const env = deps.env ?? process.env;
  const adapter = oauthAdapterFor(row.provider);
  if (!adapter || !row.external_account_id) throw new Error(`provider_not_probeable:${row.provider}`);
  let accessToken: string;
  try {
    ({ accessToken } = await getProviderAccessToken(deps, { tenantId: row.tenant_id, providerId: row.provider }));
  } catch (err) {
    if (!(err instanceof TokenStoreError)) throw err;
    switch (err.code) {
      case "refresh_failed":
        return { verdict: "down", code: "refresh_failed", detail: "The vendor refused to renew OASIS's access. Reconnect it.", ...NONE };
      case "refresh_unavailable":
      case "refresh_busy":
        return { verdict: "unknown", code: "provider_unreachable", detail: "OASIS could not renew its access just now. It will try again.", ...NONE };
      case "not_connected":
        return { verdict: "down", code: "credential_missing", detail: "The saved sign-in is missing. Reconnect it.", ...NONE };
      default:
        throw err;
    }
  }
  const result = await adapter.probe(accessToken, row.external_account_id, adapterDeps({ ...deps, env }));
  if (result.accountId && result.accountId !== row.external_account_id) {
    return {
      verdict: "down",
      code: "account_mismatch",
      detail: `This sign-in now belongs to ${result.accountId}, not the connected account ${row.external_account_id}. OASIS stopped using it. Disconnect and connect the right account.`,
      accountLabel: null,
      environment: null,
      latencyMs: result.latencyMs,
    };
  }
  return {
    verdict: result.verdict,
    code: result.code,
    detail: result.detail,
    latencyMs: result.latencyMs,
    accountLabel: result.verdict === "healthy" ? result.accountLabel : null,
    environment: result.verdict === "healthy" ? result.environment : null,
  };
}

/**
 * Ask the vendor to forget this connection's grant, using the tokens as stored.
 * `true` when the vendor confirmed; `false` when it could not be asked or said
 * no (the owner is told to remove access in the vendor too). Reads the tokens
 * with the strict reader; a token that cannot be read is simply `false`.
 * Never throws: a disconnect must still delete OASIS's copy.
 */
export async function revokeAtVendor(deps: OAuthLiveDeps, row: ConnectionRow): Promise<boolean> {
  try {
    const env = deps.env ?? process.env;
    const adapter = oauthAdapterFor(row.provider);
    const provider = providerForEnv(row.provider, env);
    const client = provider ? oauthClientFor(provider, env) : null;
    if (!adapter || !client) return false;
    const service = credentialServiceFor(row.id);
    const [access, refresh] = await Promise.all([
      readTenantCredentialStrict(row.tenant_id, service, "access_token"),
      readTenantCredentialStrict(row.tenant_id, service, "refresh_token"),
    ]);
    const tokens = {
      accessToken: access.ok ? access.value : null,
      refreshToken: refresh.ok ? refresh.value : null,
    };
    if (!tokens.accessToken && !tokens.refreshToken) return false;
    return await adapter.revoke(client, tokens, adapterDeps({ ...deps, env }));
  } catch (err) {
    console.error("[connections.revoke] vendor revoke threw", { provider: row.provider, error: err instanceof Error ? err.name : "error" });
    return false;
  }
}
