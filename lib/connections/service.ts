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
  deleteTenantIntegrationServiceWhile,
  setTenantIntegrationBundleWhile,
} from "@/lib/tenant-integration-store";
import { providerForEnv, type ProviderDef } from "@/lib/connections/registry";
import { checkJevApiKey, checkStripeRestrictedKey, credentialServiceFor } from "@/lib/connections/rules";
import {
  beginDisconnect,
  claimConnection,
  deleteUnprovenClaim,
  findActiveConnection,
  finishDisconnect,
  listRecentHealthChecks,
  markConnectionError,
  pendingClaimGuard,
  recordHealthCheck,
  restoreRevokedClaim,
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
import { readBotToken } from "@/lib/connections/token-store";
import { SLACK_TOKEN_ALREADY_DEAD, revokeToken as revokeSlackToken } from "@/lib/slack/client";

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
    if (claim.error === "connection_busy") return connectionBusy(provider);
    return fail(
      409,
      "provider_already_connected",
      `${provider.label} is already connected to ${claim.current.external_account_label ?? claim.current.external_account_id ?? "another account"}. Disconnect it first, then connect the other account.`,
    );
  }

  const conn = claim.connection;
  // Saved only while the row is still this claim (its generation): a
  // disconnect that started in between keeps the key out entirely.
  const saved = await setTenantIntegrationBundleWhile(deps.db, {
    tenantId: actor.tenantId,
    service: credentialServiceFor(conn.id),
    bundle: { [provider.restrictedKey.credentialField]: check.key },
    createdBy: actor.profileId,
    guard: pendingClaimGuard(actor.tenantId, conn.id, conn.token_version),
    now: deps.now(),
  });
  if (!saved.ok && saved.error === "guard_refused") return connectionBusy(provider);
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
    generation: conn.token_version,
  });
  // A disconnect took the row after the key went in: it owns it now, and its
  // own batch deletes the key. Never "connected" for a row that is going away.
  if (!recorded.recorded) return connectionBusy(provider);
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
 *
 * Every step is fenced on the claim's own generation: once a disconnect (or a
 * newer claim) has moved the row on, the undo touches nothing of theirs.
 */
export async function undoUnsavedClaim(
  deps: ConnectionsDeps,
  tenantId: string,
  claim: Extract<ClaimResult, { ok: true }>,
): Promise<void> {
  const connectionId = claim.connection.id;
  const generation = claim.connection.token_version;
  const reactivated = claim.previous?.revoked_at ? claim.previous : null;
  if (claim.created || reactivated) {
    let undone = false;
    try {
      undone = reactivated
        ? await restoreRevokedClaim(deps.db, { tenantId, previous: reactivated, now: deps.now(), generation })
        : await deleteUnprovenClaim(deps.db, tenantId, connectionId, generation);
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
    generation,
  });
}

/** A connect that met a disconnect of the same connection (or another connect) mid-way: nothing was connected. */
function connectionBusy(provider: ProviderDef): ServiceResult {
  return fail(
    409,
    "connection_busy",
    `${provider.label} was being disconnected or connected at the same moment, so nothing was connected. Wait a moment, then try again.`,
  );
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

type SlackTokenOff = { ok: true; slackToken: "revoked" | "already_invalid" | "not_stored" } | { ok: false; result: ServiceResult };

/**
 * Switch a Slack connection's bot token off AT SLACK (auth.revoke) before
 * OASIS forgets it: deleting OASIS's copy alone would leave a live token, and
 * an active bot user, in the client's Slack. A token Slack already refuses
 * (invalid_auth, token_revoked, account_inactive) counts as off. Anything else
 * (a timeout, a network failure, a rate limit, any other answer) is not known
 * to be off, so nothing is deleted. So is a stored token that cannot be read:
 * it may become readable again (a missing encryption key), and only then can
 * it be switched off. The token is never logged.
 *
 * Runs after beginDisconnect, so the token read here is the generation's own:
 * no install can store another under a disconnecting row. When it fails the
 * row stays disconnecting (OASIS no longer uses it) and the owner is told so.
 */
async function switchOffSlackToken(deps: ConnectionsDeps, tenantId: string, connectionId: string): Promise<SlackTokenOff> {
  const token = await readBotToken(tenantId, connectionId);
  if (!token.ok) {
    // No token stored: OASIS holds nothing that could still reach Slack.
    if (token.reason === "missing") return { ok: true, slackToken: "not_stored" };
    console.error("[connections.disconnect] the Slack token could not be read, so it was not switched off", { tenantId, connectionId, reason: token.reason });
    return {
      ok: false,
      result:
        token.reason === "lookup_failed"
          ? unfinished(503, "slack_token_unavailable", "OASIS could not read its Slack token just now, so it could not switch it off in Slack yet. OASIS has stopped using this Slack workspace. Press Disconnect again in a minute to finish.")
          : unfinished(500, "slack_token_unreadable", "OASIS could not read its saved Slack token, so it could not switch it off in Slack. OASIS has stopped using this Slack workspace. Tell OASIS support."),
    };
  }
  const r = await revokeSlackToken(token.token, { fetchImpl: deps.fetchImpl });
  if (r.ok && r.data.revoked === true) return { ok: true, slackToken: "revoked" };
  if (!r.ok && SLACK_TOKEN_ALREADY_DEAD.has(r.error)) return { ok: true, slackToken: "already_invalid" };
  console.error("[connections.disconnect] Slack did not confirm the token was switched off; nothing deleted", {
    tenantId,
    connectionId,
    error: r.ok ? "not_revoked" : r.error,
    status: r.ok ? null : r.status,
  });
  return {
    ok: false,
    result: unfinished(
      502,
      "slack_revoke_failed",
      "Slack did not confirm it switched off OASIS's access. OASIS has stopped using this Slack workspace, but the disconnect is not finished. Press Disconnect again in a minute to finish.",
    ),
  };
}

/** A disconnect that began and could not finish: the row stays disconnecting, and the next press finishes it. */
function unfinished(status: number, error: string, message: string): ServiceResult {
  return fail(status, error, message, { disconnecting: true });
}

/**
 * Disconnect this workspace's live connection, in three steps:
 *   1. beginDisconnect: claim the connection's next generation and mark it
 *      disconnecting (compare-and-set on the generation read). From here
 *      nothing uses it, no install may store a token under it, and work bound
 *      to the old generation writes nothing. A connect in between moved the
 *      generation, so this refuses (connection_busy) rather than race it.
 *   2. Slack only: switch the bot token off at Slack (switchOffSlackToken).
 *   3. finishDisconnect: ONE batch revokes the row (compare-and-set on the
 *      claimed generation), drops its routes, and deletes its credential and
 *      the provider's own data, each fenced on that revocation. A card never
 *      says "disconnected" while a key is stored, nor "connected" after the
 *      token was switched off.
 * A failure after step 1 leaves the row disconnecting, durably: the card says
 * the disconnect did not finish, and the next Disconnect takes the next
 * generation and finishes it (a token Slack already refuses counts as off).
 */
export async function disconnectConnection(
  deps: ConnectionsDeps,
  actor: ConnectionsActor,
  provider: ProviderDef,
): Promise<ServiceResult> {
  const row = await findActiveConnection(deps.db, actor.tenantId, provider.id);
  if (!row) return { status: 200, body: { ok: true, already_disconnected: true } };

  const generation = await beginDisconnect(deps.db, {
    tenantId: actor.tenantId,
    connectionId: row.id,
    generation: row.token_version,
    now: deps.now(),
  });
  if (generation === null) {
    return fail(409, "connection_busy", `${provider.label} changed while it was being disconnected. Try Disconnect again.`);
  }

  // Whichever Slack app it was installed with (OASIS's or the workspace's
  // own), the bot token is the connection's own, and goes off the same way.
  let slackToken: "revoked" | "already_invalid" | "not_stored" | null = null;
  if (provider.id === "slack") {
    const off = await switchOffSlackToken(deps, actor.tenantId, row.id);
    if (!off.ok) return off.result;
    slackToken = off.slackToken;
  }

  let finished: Awaited<ReturnType<typeof finishDisconnect>>;
  try {
    // The credential, and what the provider kept that must go with the
    // connection (Slack: the channel map and the people it looked up), all in
    // the revoke's own batch and fenced on it.
    finished = await finishDisconnect(deps.db, {
      tenantId: actor.tenantId,
      connectionId: row.id,
      generation,
      revokedBy: actor.userId,
      now: deps.now(),
      alsoDelete: async (revoked) => [
        deleteTenantIntegrationServiceWhile({ tenantId: actor.tenantId, service: credentialServiceFor(row.id), guard: revoked }),
        ...(provider.id === "slack" ? await slackDisconnectStatements(deps.db, actor.tenantId, row.external_account_id, revoked) : []),
      ],
    });
  } catch (err) {
    console.error("[connections.disconnect] the finishing batch failed; the connection stays disconnecting", {
      tenantId: actor.tenantId,
      provider: provider.id,
      connectionId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return unfinished(
      500,
      "disconnect_unfinished",
      slackToken === "revoked" || slackToken === "already_invalid"
        ? "Slack's access is switched off, but OASIS could not finish removing the connection here. Press Disconnect again to finish."
        : "OASIS could not finish removing the connection. It is no longer used. Press Disconnect again to finish.",
    );
  }
  if (!finished.revoked) {
    // Another Disconnect took the next generation and finished (or is
    // finishing) it: this one changed nothing.
    const now = await findActiveConnection(deps.db, actor.tenantId, provider.id);
    return now
      ? fail(409, "connection_busy", `${provider.label} changed while it was being disconnected. Try Disconnect again.`)
      : { status: 200, body: { ok: true, already_disconnected: true } };
  }
  const credentialsDeleted = finished.deleted[0] ?? 0;
  await auditConnection({
    tenantId: actor.tenantId,
    actor: { userId: actor.userId, email: actor.email },
    action: "connection.revoked",
    connectionId: row.id,
    after: {
      provider: provider.id,
      account_id: row.external_account_id,
      credentials_deleted: credentialsDeleted,
      ...(slackToken ? { slack_token: slackToken } : {}),
    },
  });
  return {
    status: 200,
    body: { ok: true, disconnected: true, credentials_deleted: credentialsDeleted, ...(slackToken ? { slack_token: slackToken } : {}) },
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
