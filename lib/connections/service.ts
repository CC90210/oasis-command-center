/**
 * lib/connections/service.ts — connect, re-test, disconnect and read one
 * provider's connection for ONE tenant.
 *
 * The /api/connections/[provider]/* routes are thin: they resolve the session,
 * check lib/connections/access.ts, and hand this module the tenant id FROM THE
 * SESSION. Nothing here reads a tenant, user or account id from a request body,
 * so a caller can only ever act on its own workspace.
 *
 * Every result is a plain { status, body } so the routes stay one line and the
 * tests can read the same outcome the browser gets.
 */
import "server-only";
import {
  deleteTenantIntegrationService,
  setTenantIntegrationValue,
} from "@/lib/tenant-integration-store";
import { providerById, type ProviderDef } from "@/lib/connections/registry";
import { checkStripeRestrictedKey, credentialServiceFor } from "@/lib/connections/rules";
import {
  claimConnection,
  deleteUnprovenClaim,
  findActiveConnection,
  listRecentHealthChecks,
  markConnectionError,
  recordHealthCheck,
  revokeConnection,
  toPublicConnection,
  type PublicConnection,
} from "@/lib/connections/store";
import {
  auditConnection,
  probeFor,
  probeStoredConnection,
  type ConnectionsDeps,
} from "@/lib/connections/health";

export type ConnectionsActor = {
  tenantId: string;
  /** auth user id — recorded as connected_by / revoked_by and in the audit log. */
  userId: string;
  /** user_profiles.id — tenant_integration_credentials.created_by references it. */
  profileId: string | null;
  email: string | null;
};

export type ServiceResult = { status: number; body: Record<string, unknown> };

const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): ServiceResult => ({
  status,
  body: { ok: false, error, message, ...extra },
});

/**
 * Resolve a [provider] segment. Unknown → 404; known but not buildable yet →
 * 409 with the honest reason. Never a fake connect.
 */
export function resolveProvider(id: string): { ok: true; provider: ProviderDef } | { ok: false; result: ServiceResult } {
  const provider = providerById(id);
  if (!provider) return { ok: false, result: fail(404, "unknown_provider", "OASIS has no connection called that.") };
  if (provider.availability !== "live") {
    return {
      ok: false,
      result: fail(
        409,
        "coming_soon",
        `${provider.label} cannot be connected yet.${provider.blockedOn ? ` Waiting on ${provider.blockedOn}` : ""}`,
      ),
    };
  }
  return { ok: true, provider };
}

// ── Connect (restricted key) ──────────────────────────────────────────────

const PROBE_REFUSAL_STATUS: Record<string, number> = {
  key_rejected: 422,
  missing_permissions: 422,
  account_unidentified: 422,
  provider_unreachable: 502,
  unexpected_response: 502,
};

/**
 * Connect a provider that authenticates with a pasted restricted key (Stripe).
 *
 *   1. The key's FORMAT is checked (rk_ only; sk_ and pk_ refused with a
 *      reason). Nothing is stored or sent for a refused key.
 *   2. The key is PROBED live. Only a healthy probe continues: a dead key, a
 *      key missing permissions, or one whose account cannot be identified is
 *      refused before anything is written.
 *   3. The account is CLAIMED for this tenant (pending). An account live in
 *      another tenant, or a second account while one is live here, is refused.
 *   4. The key is SAVED encrypted under the connection's own credential
 *      service. If that fails, a brand-new claim is removed and a reused one is
 *      marked error — a connection is never "connected" without its key.
 *   5. The probe is RECORDED, which is what turns the connection (and the card)
 *      connected.
 */
export async function connectWithRestrictedKey(
  deps: ConnectionsDeps,
  actor: ConnectionsActor,
  provider: ProviderDef,
  rawKey: unknown,
): Promise<ServiceResult> {
  if (provider.authKind !== "restricted_key" || !provider.restrictedKey) {
    return fail(400, "wrong_connect_method", `${provider.label} does not connect with a pasted key.`);
  }
  // Stripe is the only restricted-key provider; its format rule is Stripe's.
  const check = checkStripeRestrictedKey(rawKey);
  if (!check.ok) return fail(422, check.error, check.message);

  const probe = probeFor(provider.id);
  if (!probe) return fail(500, "probe_missing", `OASIS has no live check for ${provider.label}.`);
  const result = await probe(check.key, deps.fetchImpl ?? fetch);
  if (result.verdict !== "healthy" || !result.accountId) {
    const code = result.code ?? "unexpected_response";
    return fail(PROBE_REFUSAL_STATUS[code] ?? 422, code, result.detail ?? "The key did not pass the connection check.");
  }

  const now = deps.now();
  const claim = await claimConnection(deps.db, {
    tenantId: actor.tenantId,
    provider: provider.id,
    authKind: provider.authKind,
    scopeKind: provider.scopeKind,
    userId: null,
    externalAccountId: result.accountId,
    externalAccountLabel: result.accountLabel,
    environment: result.environment,
    grantedScopes: provider.scopes.base,
    scopeSetVersion: 1,
    connectedBy: actor.userId,
    now,
  });
  if (!claim.ok) {
    if (claim.error === "account_connected_elsewhere") {
      return fail(
        409,
        "account_connected_elsewhere",
        `This ${provider.label} account is already connected to another OASIS workspace. It has to be disconnected there before it can be connected here.`,
      );
    }
    return fail(
      409,
      "provider_already_connected",
      `${provider.label} is already connected to ${claim.current.external_account_label ?? claim.current.external_account_id ?? "another account"}. Disconnect it first, then connect the other account.`,
    );
  }

  const conn = claim.connection;
  const saved = await setTenantIntegrationValue({
    tenantId: actor.tenantId,
    service: credentialServiceFor(conn.id),
    fieldKey: provider.restrictedKey.credentialField,
    value: check.key,
    createdBy: actor.profileId,
  });
  if (!saved.ok) {
    console.error("[connections.connect] credential save failed", {
      tenantId: actor.tenantId,
      provider: provider.id,
      connectionId: conn.id,
      error: saved.error,
    });
    if (claim.created) {
      await deleteUnprovenClaim(deps.db, actor.tenantId, conn.id);
    } else {
      await markConnectionError(deps.db, {
        tenantId: actor.tenantId,
        connectionId: conn.id,
        code: "credential_missing",
        detail: "OASIS could not save the new key. Paste it again.",
        now: deps.now(),
      });
    }
    return fail(500, "credential_save_failed", "OASIS could not save the key. Nothing was connected. Try again.");
  }

  const recorded = await recordHealthCheck(deps.db, {
    tenantId: actor.tenantId,
    connectionId: conn.id,
    source: "connect",
    verdict: result.verdict,
    code: result.code,
    detail: result.detail,
    latencyMs: result.latencyMs,
    accountLabel: result.accountLabel,
    environment: result.environment,
    now: deps.now(),
  });
  await auditConnection({
    tenantId: actor.tenantId,
    actor: { userId: actor.userId, email: actor.email },
    action: claim.created ? "connection.connected" : "connection.reconnected",
    connectionId: conn.id,
    after: {
      provider: provider.id,
      account_id: result.accountId,
      environment: result.environment,
      auth_kind: provider.authKind,
      scopes: provider.scopes.base,
    },
  });
  return {
    status: 200,
    body: { ok: true, connection: toPublicConnection(recorded.connection, deps.now().getTime()) },
  };
}

// ── Test again ────────────────────────────────────────────────────────────

export async function testConnection(
  deps: ConnectionsDeps,
  actor: ConnectionsActor,
  provider: ProviderDef,
): Promise<ServiceResult> {
  const row = await findActiveConnection(deps.db, actor.tenantId, provider.id);
  if (!row) return fail(404, "not_connected", `${provider.label} is not connected.`);
  const recorded = await probeStoredConnection(deps, row, "manual", { userId: actor.userId, email: actor.email });
  return {
    status: 200,
    body: { ok: true, connection: toPublicConnection(recorded.connection, deps.now().getTime()) },
  };
}

// ── Disconnect ────────────────────────────────────────────────────────────

/**
 * Delete the stored credential FIRST, then mark the connection revoked. If the
 * delete fails the connection stays as it was and the caller gets a 500: a
 * card must never say "disconnected" while the key is still stored.
 */
export async function disconnectConnection(
  deps: ConnectionsDeps,
  actor: ConnectionsActor,
  provider: ProviderDef,
): Promise<ServiceResult> {
  const row = await findActiveConnection(deps.db, actor.tenantId, provider.id);
  if (!row) return { status: 200, body: { ok: true, already_disconnected: true } };

  const removed = await deleteTenantIntegrationService({ tenantId: actor.tenantId, service: credentialServiceFor(row.id) });
  if (!removed.ok) {
    console.error("[connections.disconnect] credential delete failed", {
      tenantId: actor.tenantId,
      provider: provider.id,
      connectionId: row.id,
      error: removed.error,
    });
    return fail(500, "credential_delete_failed", "OASIS could not delete the stored key, so nothing was disconnected. Try again.");
  }
  const revoked = await revokeConnection(deps.db, {
    tenantId: actor.tenantId,
    connectionId: row.id,
    revokedBy: actor.userId,
    now: deps.now(),
  });
  if (!revoked) {
    // Revoked concurrently (another tab). The key is gone either way.
    return { status: 200, body: { ok: true, already_disconnected: true } };
  }
  await auditConnection({
    tenantId: actor.tenantId,
    actor: { userId: actor.userId, email: actor.email },
    action: "connection.revoked",
    connectionId: row.id,
    after: { provider: provider.id, account_id: row.external_account_id, credentials_deleted: removed.deleted },
  });
  return { status: 200, body: { ok: true, disconnected: true, credentials_deleted: removed.deleted } };
}

// ── Status ────────────────────────────────────────────────────────────────

export async function connectionStatus(
  deps: ConnectionsDeps,
  actor: ConnectionsActor,
  provider: ProviderDef,
): Promise<ServiceResult> {
  const nowMs = deps.now().getTime();
  const row = await findActiveConnection(deps.db, actor.tenantId, provider.id);
  const connection: PublicConnection | null = row ? toPublicConnection(row, nowMs) : null;
  const checks = row ? await listRecentHealthChecks(deps.db, actor.tenantId, row.id, 5) : [];
  return {
    status: 200,
    body: {
      ok: true,
      provider: { id: provider.id, label: provider.label, availability: provider.availability },
      connection,
      recent_checks: checks.map((c) => ({
        checked_at: c.checked_at,
        source: c.check_source,
        verdict: c.verdict,
        error_code: c.error_code,
        latency_ms: c.latency_ms,
      })),
    },
  };
}
