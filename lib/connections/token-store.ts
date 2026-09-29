/**
 * lib/connections/token-store.ts — OAuth tokens for a connection: saved
 * atomically, refreshed by exactly one caller at a time, failed closed.
 *
 * WHY A LEASE. QuickBooks, Xero and GoHighLevel ROTATE their refresh token on
 * every refresh: the old one dies the moment the new one is issued. Two workers
 * that notice the same expired token and both refresh will each send the same
 * refresh token; one wins, the other's refresh is refused, and a naive store
 * then marks a perfectly healthy connection expired — or worse, the loser
 * overwrites the winner's fresh tokens with nothing. So:
 *
 *   1. A caller that finds the access token expired takes a compare-and-set
 *      lease (store.takeRefreshLease): it succeeds only for the holder of the
 *      current token_version while no unexpired lease exists, and it bumps the
 *      version so every other caller's CAS fails.
 *   2. The winner refreshes (aborted after REFRESH_TIMEOUT_MS, well inside
 *      the lease, so it can never outlive its lease), saves the whole token
 *      set in ONE statement (setTenantIntegrationBundle) and releases.
 *   3. A loser waits for the lease to clear and re-reads the tokens the winner
 *      saved. It never refreshes.
 *   4. A refused refresh fails CLOSED: the connection goes `expired` (with a
 *      health row), the lease is released, and the caller gets an error — never
 *      a stale token and never a silent success.
 *
 * Tokens live in tenant_integration_credentials under the connection's own
 * credential service (rules.credentialServiceFor). No env fallback can apply
 * to that service.
 */
import "server-only";
import type { Client } from "@libsql/client";
import {
  getTenantIntegrationBundle,
  setTenantIntegrationBundle,
} from "@/lib/tenant-integration-store";
import { REFRESH_LEASE_MS, REFRESH_SKEW_MS, credentialServiceFor } from "@/lib/connections/rules";
import {
  getConnection,
  recordHealthCheck,
  releaseRefreshLease,
  takeRefreshLease,
} from "@/lib/connections/store";

export type OAuthTokens = {
  access_token: string;
  refresh_token: string;
  /** epoch ms */
  expires_at: number;
};

/** A refresh call must finish well inside the lease. */
export const REFRESH_TIMEOUT_MS = 30_000;

export class TokenStoreError extends Error {
  code: "connection_not_found" | "connection_revoked" | "not_connected" | "refresh_failed" | "refresh_busy" | "save_failed";
  constructor(code: TokenStoreError["code"], message?: string) {
    super(message ?? code);
    this.name = "TokenStoreError";
    this.code = code;
  }
}

/** Save a whole token set atomically. */
export async function saveConnectionTokens(tenantId: string, connectionId: string, tokens: OAuthTokens): Promise<void> {
  const saved = await setTenantIntegrationBundle({
    tenantId,
    service: credentialServiceFor(connectionId),
    bundle: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: String(tokens.expires_at),
    },
  });
  if (!saved.ok) throw new TokenStoreError("save_failed", saved.error);
}

async function loadTokens(tenantId: string, connectionId: string): Promise<OAuthTokens | null> {
  const b = await getTenantIntegrationBundle(tenantId, credentialServiceFor(connectionId), { allowEnvFallback: false });
  if (!b.access_token || !b.refresh_token) return null;
  return { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: Number(b.expires_at) || 0 };
}

export type GetAccessTokenInput = {
  tenantId: string;
  connectionId: string;
  /** The provider's refresh call. Receives the current refresh token and an abort signal. */
  refresh: (refreshToken: string, signal: AbortSignal) => Promise<OAuthTokens>;
  now?: () => Date;
  /** How long a loser waits for the winner, and how often it looks. */
  waitMs?: number;
  pollMs?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A valid access token for one of THIS tenant's connections, refreshing it
 * under the lease if needed. Throws TokenStoreError; never returns a token it
 * knows to be expired.
 */
export async function getAccessToken(db: Client, input: GetAccessTokenInput): Promise<string> {
  const now = input.now ?? (() => new Date());
  const waitMs = input.waitMs ?? 10_000;
  const pollMs = input.pollMs ?? 150;

  const conn = await getConnection(db, input.tenantId, input.connectionId);
  if (!conn) throw new TokenStoreError("connection_not_found");
  if (conn.revoked_at) throw new TokenStoreError("connection_revoked");
  if (conn.status === "expired") throw new TokenStoreError("refresh_failed", "The provider refused the last refresh. Reconnect.");

  const tokens = await loadTokens(input.tenantId, input.connectionId);
  if (!tokens) throw new TokenStoreError("not_connected", "No tokens are stored for this connection.");
  if (now().getTime() < tokens.expires_at - REFRESH_SKEW_MS) return tokens.access_token;

  const version = await takeRefreshLease(db, {
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    expectedVersion: conn.token_version,
    now: now(),
    leaseMs: REFRESH_LEASE_MS,
  });

  if (version === null) {
    // Someone else holds (or just took) the lease. Wait for their tokens.
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const current = await getConnection(db, input.tenantId, input.connectionId);
      if (!current || current.revoked_at) throw new TokenStoreError("connection_revoked");
      if (current.status === "expired") throw new TokenStoreError("refresh_failed", "The provider refused the refresh. Reconnect.");
      if (current.refresh_lease_until !== null) continue;
      const fresh = await loadTokens(input.tenantId, input.connectionId);
      if (fresh && now().getTime() < fresh.expires_at - REFRESH_SKEW_MS) return fresh.access_token;
      // Lease cleared but the token is still stale: the holder gave up without
      // marking the connection. Do not refresh from here — report it.
      throw new TokenStoreError("refresh_busy", "Another refresh finished without a fresh token.");
    }
    throw new TokenStoreError("refresh_busy", "Another refresh is still running.");
  }

  // This caller holds the lease.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  let refreshed: OAuthTokens;
  try {
    refreshed = await input.refresh(tokens.refresh_token, controller.signal);
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    console.error("[connections.token_store] refresh refused", {
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      error: message.slice(0, 300),
    });
    await recordHealthCheck(db, {
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      source: "refresh",
      verdict: "down",
      code: "refresh_failed",
      detail: "The provider refused to refresh this connection. Reconnect it.",
      latencyMs: null,
      now: now(),
    });
    await releaseRefreshLease(db, { tenantId: input.tenantId, connectionId: input.connectionId, version, now: now() });
    throw new TokenStoreError("refresh_failed", "The provider refused the refresh. Reconnect.");
  }
  clearTimeout(timer);

  try {
    await saveConnectionTokens(input.tenantId, input.connectionId, refreshed);
  } finally {
    const released = await releaseRefreshLease(db, {
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      version,
      now: now(),
    });
    if (!released) {
      console.error("[connections.token_store] lease release found a newer version", {
        tenantId: input.tenantId,
        connectionId: input.connectionId,
        version,
      });
    }
  }
  return refreshed.access_token;
}
