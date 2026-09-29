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
 *   4. A REFUSED refresh fails CLOSED: the connection goes `expired` (with a
 *      health row), the lease is released, and the caller gets an error — never
 *      a stale token and never a silent success. Refused means the provider
 *      said so (RefreshRefusedError: invalid_grant / invalid_client /
 *      unauthorized_client, or a 400/401 answer). Anything else — a timeout, a
 *      DNS or network failure, an abort, a 5xx — says nothing about the grant,
 *      so it releases the lease and throws `refresh_unavailable` WITHOUT
 *      expiring: one blip must never disconnect an account. No health row is
 *      written for a blip either; the providers behind this store have no
 *      health probe, so nothing would ever clear the "degraded" it would lead
 *      to. The lease is released on every path, even when writing the health
 *      row throws.
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
import { alertConnectionWorsened } from "@/lib/connections/health";
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
/**
 * How long a holder WAITS for its token save. Refresh plus this stay well
 * inside REFRESH_LEASE_MS (tests/os-connections.test.ts holds the sum under
 * it). It stops the wait, not the write: a save stalled past the lease could
 * still land after a newer holder's. The fix is a write fenced by the holder's
 * token_version; until then the "[gate]" test keeps every OAuth provider from
 * going live (nothing calls getAccessToken while they are all coming_soon).
 */
export const TOKEN_SAVE_TIMEOUT_MS = 30_000;

/** `work`, or `onTimeout()` thrown once `ms` pass first. The timer never outlives the race. */
async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class TokenStoreError extends Error {
  code:
    | "connection_not_found"
    | "connection_revoked"
    | "not_connected"
    | "refresh_failed"
    | "refresh_unavailable"
    | "refresh_busy"
    | "save_failed";
  constructor(code: TokenStoreError["code"], message?: string) {
    super(message ?? code);
    this.name = "TokenStoreError";
    this.code = code;
  }
}

/** OAuth token-endpoint errors (RFC 6749 §5.2) that mean the grant itself is refused. */
export const REFRESH_REFUSAL_OAUTH_ERRORS: readonly string[] = ["invalid_grant", "invalid_client", "unauthorized_client"];

/**
 * What a provider's refresh function throws when the PROVIDER refused the
 * refresh — it answered, and the answer was no. Anything else it throws is
 * treated as "could not ask" (see getAccessToken).
 */
export class RefreshRefusedError extends Error {
  /** The token endpoint's `error` field, e.g. "invalid_grant". */
  oauthError: string | null;
  /** The token endpoint's HTTP status. */
  httpStatus: number | null;
  constructor(input: { oauthError?: string | null; httpStatus?: number | null; message?: string }) {
    super(input.message ?? input.oauthError ?? `refresh refused (HTTP ${input.httpStatus ?? "?"})`);
    this.name = "RefreshRefusedError";
    this.oauthError = input.oauthError ?? null;
    this.httpStatus = input.httpStatus ?? null;
  }
}

/** Only a refusal the provider confirmed. A 5xx or a rate limit wrapped in RefreshRefusedError is still not one. */
export function isConfirmedRefreshRefusal(err: unknown): boolean {
  if (!(err instanceof RefreshRefusedError)) return false;
  if (err.oauthError && REFRESH_REFUSAL_OAUTH_ERRORS.includes(err.oauthError)) return true;
  return err.httpStatus === 400 || err.httpStatus === 401;
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
  /**
   * The provider's refresh call. Receives the current refresh token and an
   * abort signal. When the provider ANSWERS and refuses (invalid_grant,
   * invalid_client, unauthorized_client, or a 400/401), throw
   * RefreshRefusedError: only that expires the connection. Anything else it
   * throws is treated as "could not reach the provider" and never expires it.
   */
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

  const leaseTakenAt = now();
  const version = await takeRefreshLease(db, {
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    expectedVersion: conn.token_version,
    now: leaseTakenAt,
    leaseMs: REFRESH_LEASE_MS,
  });
  const leaseEndsMs = leaseTakenAt.getTime() + REFRESH_LEASE_MS;

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
    const refused = isConfirmedRefreshRefusal(err);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[connections.token_store] refresh ${refused ? "refused" : "could not reach the provider"}`, {
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      error: message.slice(0, 300),
    });
    try {
      if (refused) {
        const recorded = await recordHealthCheck(db, {
          tenantId: input.tenantId,
          connectionId: input.connectionId,
          source: "refresh",
          verdict: "down",
          code: "refresh_failed",
          detail: "The provider refused to refresh this connection. Reconnect it.",
          latencyMs: null,
          now: now(),
        });
        if (recorded.worsened) {
          await alertConnectionWorsened({}, {
            tenantId: input.tenantId,
            connectionId: input.connectionId,
            provider: recorded.connection.provider,
            from: recorded.previousStatus,
            to: recorded.connection.status,
            code: "refresh_failed",
            detail: recorded.connection.last_health_detail,
            source: "refresh",
          });
        }
      }
    } finally {
      await releaseRefreshLease(db, { tenantId: input.tenantId, connectionId: input.connectionId, version, now: now() });
    }
    if (refused) throw new TokenStoreError("refresh_failed", "The provider refused the refresh. Reconnect.");
    throw new TokenStoreError("refresh_unavailable", "The provider could not be reached to refresh. Try again shortly.");
  }
  clearTimeout(timer);

  // The lease must cover the save too (CodeRabbit #472): past it, another
  // caller may already have taken the lease and refreshed with the old refresh
  // token. So the wait for the save is bounded, the save only starts while the
  // lease still covers it, and a lease that turns out to be lost returns no
  // token. (The write itself is not fenced yet: see TOKEN_SAVE_TIMEOUT_MS.)
  let saved = false;
  try {
    if (now().getTime() + TOKEN_SAVE_TIMEOUT_MS >= leaseEndsMs) {
      throw new TokenStoreError("refresh_busy", "The refresh ran past its lease, so its tokens were not saved over a newer refresh.");
    }
    await withTimeout(
      saveConnectionTokens(input.tenantId, input.connectionId, refreshed),
      TOKEN_SAVE_TIMEOUT_MS,
      () => new TokenStoreError("save_failed", "Saving the refreshed tokens timed out."),
    );
    saved = true;
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
      // Another refresh took the lease while this one ran: its outcome, not
      // this token, is the connection's now.
      if (saved) throw new TokenStoreError("refresh_busy", "Another refresh took over this connection while this one was saving.");
    }
  }
  return refreshed.access_token;
}
