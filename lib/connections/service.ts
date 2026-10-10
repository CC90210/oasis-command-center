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
import { isGenericOAuthProvider, providerById, providerForEnv, type ProviderDef } from "@/lib/connections/registry";
import { revokeAtVendor } from "@/lib/connections/oauth-live";
import { checkJevApiKey, checkStripeRestrictedKey, credentialServiceFor } from "@/lib/connections/rules";
import {
  claimConnection,
  deleteUnprovenClaim,
  fenceConnectionForDisconnect,
  findActiveConnection,
  isAccountHeldByAnotherTenant,
  isPrincipalHeldByAnotherTenant,
  listRecentHealthChecks,
  markConnectionError,
  recordHealthCheck,
  restoreRevokedClaim,
  revokeConnection,
  toPublicConnection,
  type ClaimResult,
  type PublicConnection,
} from "@/lib/connections/store";
import {
  auditConnection,
  probeFor,
  probeStoredConnection,
  type ConnectionsDeps,
} from "@/lib/connections/health";
import { slackDisconnectStatements } from "@/lib/slack/routing";

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
export function resolveProvider(
  id: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { ok: true; provider: ProviderDef } | { ok: false; result: ServiceResult } {
  // As THIS deployment sees it: Slack is live only where OASIS's Slack app
  // secrets are set (registry.providerAvailability).
  const provider = providerForEnv(id, env);
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

/**
 * Resolve a [provider] segment for Disconnect only: unknown → 404, but NOT
 * gated on whether OASIS's app for it is configured on THIS deployment.
 * Disconnect's job is removing OASIS's own copy of an EXISTING connection
 * (made when the app was configured here, or made on a deployment that still
 * has it) — a workspace must always be able to do that, even from a
 * deployment missing the vendor's Worker secrets or CONNECTIONS_OAUTH_STATE_SECRET
 * (Codex review, PR #574: Disconnect was answering 409 coming_soon for an
 * owner trying to remove a connection that already existed). The vendor
 * revoke that follows is already best-effort (revokeAtVendor returns false,
 * never throws, when the app has no client configured here).
 */
export function resolveProviderForDisconnect(id: string): { ok: true; provider: ProviderDef } | { ok: false; result: ServiceResult } {
  const provider = providerById(id);
  if (!provider) return { ok: false, result: fail(404, "unknown_provider", "OASIS has no connection called that.") };
  return { ok: true, provider };
}

// ── Connect (restricted key) ──────────────────────────────────────────────

type KeyFormatCheck = { ok: true; key: string } | { ok: false; error: string; message: string };

/** The format rule per pasted-key provider. A provider missing here cannot connect. */
const KEY_FORMAT: Readonly<Record<string, (raw: unknown) => KeyFormatCheck>> = {
  stripe: checkStripeRestrictedKey,
  jev: checkJevApiKey,
};

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
 *      service. If that fails, the claim is undone (undoUnsavedClaim) — a
 *      connection is never "connected" without its key.
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
  // Each pasted-key provider has its own format rule, checked before anything
  // is sent anywhere.
  const check = KEY_FORMAT[provider.id]?.(rawKey) ?? null;
  if (!check) return fail(500, "key_rule_missing", `OASIS has no key rule for ${provider.label}.`);
  if (!check.ok) return fail(422, check.error, check.message);

  const probe = probeFor(provider.id);
  if (!probe) return fail(500, "probe_missing", `OASIS has no live check for ${provider.label}.`);
  const result = await probe(check.key, deps.fetchImpl ?? fetch, deps.probeTimeoutMs);
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
    await undoUnsavedClaim(deps, actor.tenantId, claim);
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

/**
 * Test a pasted key WITHOUT connecting it: the same format rule and the same
 * live probe as connectWithRestrictedKey, and nothing else. No claim, no saved
 * key, no health row, no audit entry: the owner learns whether the key works
 * (and, for Stripe, which permissions are missing) before deciding to connect.
 * The key is never echoed back; only the probe's own words and the account's
 * name are.
 */
export async function checkRestrictedKey(
  deps: ConnectionsDeps,
  provider: ProviderDef,
  rawKey: unknown,
): Promise<ServiceResult> {
  if (provider.authKind !== "restricted_key" || !provider.restrictedKey) {
    return fail(400, "wrong_connect_method", `${provider.label} does not connect with a pasted key.`);
  }
  const check = KEY_FORMAT[provider.id]?.(rawKey) ?? null;
  if (!check) return fail(500, "key_rule_missing", `OASIS has no key rule for ${provider.label}.`);
  if (!check.ok) return fail(422, check.error, check.message);
  const probe = probeFor(provider.id);
  if (!probe) return fail(500, "probe_missing", `OASIS has no live check for ${provider.label}.`);
  const result = await probe(check.key, deps.fetchImpl ?? fetch, deps.probeTimeoutMs);
  const passed = result.verdict === "healthy" && !!result.accountId;
  return {
    status: 200,
    body: {
      ok: true,
      check: {
        passed,
        code: passed ? null : (result.code ?? "unexpected_response"),
        detail: passed ? null : (result.detail ?? "The key did not pass the connection check."),
        account_label: passed ? result.accountLabel : null,
        environment: passed ? result.environment : null,
        saved: false,
      },
    },
  };
}

/**
 * Put back a claim whose credential could not be saved, so no connection is
 * ever left looking set up without its key:
 *   - a brand-new claim is deleted;
 *   - a revoked row this connect REACTIVATED goes back to revoked, exactly as
 *     the disconnect left it, with its history (never deleted);
 *   - a live row (a new key for the same account) is marked error; its old key
 *     is still the one stored.
 * When the delete or restore does not happen — it throws, or the row has moved
 * on — the row is marked error instead of staying pending: a pending orphan
 * would refuse every later connect with provider_already_connected and tell
 * the owner nothing, while an errored one says what happened and can be
 * disconnected from its card.
 */
export async function undoUnsavedClaim(
  deps: ConnectionsDeps,
  tenantId: string,
  claim: Extract<ClaimResult, { ok: true }>,
): Promise<void> {
  const connectionId = claim.connection.id;
  const reactivated = claim.previous?.revoked_at ? claim.previous : null;
  if (claim.created || reactivated) {
    let undone = false;
    try {
      undone = reactivated
        ? await restoreRevokedClaim(deps.db, { tenantId, previous: reactivated, now: deps.now() })
        : await deleteUnprovenClaim(deps.db, tenantId, connectionId);
    } catch (err) {
      console.error("[connections.connect] undoing the claim threw", {
        tenantId,
        connectionId,
        error: err instanceof Error ? err.stack : err,
      });
    }
    if (undone) return;
    console.error("[connections.connect] claim could not be undone; marking it error", { tenantId, connectionId });
  }
  await markConnectionError(deps.db, {
    tenantId,
    connectionId,
    code: "credential_missing",
    detail: "OASIS could not save the new key. Paste it again.",
    now: deps.now(),
  });
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

  // FENCE first, before anything slow starts (the vendor revoke below can
  // take up to ~10 s): a save already in flight for the version this row held
  // a moment ago — the OAuth callback's fenced save, or a refresher's — now
  // lands nothing once it finally runs, instead of racing the delete and the
  // revoke that follow (Codex review, PR #574).
  await fenceConnectionForDisconnect(deps.db, { tenantId: actor.tenantId, connectionId: row.id });

  // What the provider kept that must go with the connection (Slack: the
  // channel map and the people it looked up). Worked out before anything is
  // deleted, and deleted in the revoke's own batch.
  const alsoDelete = provider.id === "slack" ? await slackDisconnectStatements(deps.db, actor.tenantId, row.external_account_id) : [];

  // A sign-in made at the vendor's own page (QuickBooks, Xero, Zoom, WhatsApp):
  // the vendor is told to forget the grant BEFORE OASIS's copy of the tokens is
  // deleted (they are what proves the request). A vendor that cannot be asked
  // never blocks the disconnect: OASIS's copy still goes, and the answer says
  // the owner should also remove OASIS in the vendor's own settings.
  //
  // UNLESS another workspace's live connection shares the same vendor-side
  // ACCOUNT, or (for a provider whose revoke acts on the whole vendor USER,
  // not the account — WhatsApp's DELETE /me/permissions de-authorizes every
  // WhatsApp Business Account that Facebook user ever approved, for ANY
  // workspace) the same vendor PRINCIPAL. Zoom's revoke deauthorizes the
  // whole account and Intuit's the whole company — for them the account IS
  // the right boundary, already covered by the account check. For WhatsApp,
  // if the principal could not even be read at connect time, OASIS has no
  // way to rule out another workspace sharing it, so it is not asked either
  // (security review, PR #574). This workspace's own copy is always deleted
  // either way; the vendor is just never told to forget access someone else
  // is still relying on.
  let vendorRevoked: boolean | null = null;
  let vendorRevokeSkippedReason: "shared_with_another_workspace" | "vendor_principal_unknown" | null = null;
  if (isGenericOAuthProvider(provider)) {
    const accountShared = !!row.external_account_id && (await isAccountHeldByAnotherTenant(deps.db, actor.tenantId, provider.id, row.external_account_id));
    const principalShared = !!row.vendor_principal_id && (await isPrincipalHeldByAnotherTenant(deps.db, actor.tenantId, provider.id, row.vendor_principal_id));
    if (accountShared || principalShared) {
      vendorRevokeSkippedReason = "shared_with_another_workspace";
    } else if (provider.id === "whatsapp" && !row.vendor_principal_id) {
      vendorRevokeSkippedReason = "vendor_principal_unknown";
    } else {
      vendorRevoked = await revokeAtVendor(deps, row);
    }
  }

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
    alsoDelete,
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
    after: {
      provider: provider.id,
      account_id: row.external_account_id,
      credentials_deleted: removed.deleted,
      ...(vendorRevoked === null ? {} : { vendor_revoked: vendorRevoked }),
      // Never names the other workspace — just that this one was not alone.
      ...(vendorRevokeSkippedReason ? { vendor_revoked: false, vendor_revoke_skipped_reason: vendorRevokeSkippedReason } : {}),
    },
  });
  return {
    status: 200,
    body: {
      ok: true,
      disconnected: true,
      credentials_deleted: removed.deleted,
      ...(vendorRevoked === null ? {} : { vendor_revoked: vendorRevoked }),
      ...(vendorRevokeSkippedReason ? { vendor_revoked: false, vendor_revoke_skipped_reason: vendorRevokeSkippedReason } : {}),
    },
  };
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
