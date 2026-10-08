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
 *   4. The connection is CLAIMED for this tenant, pinned to the Slack team: a
 *      NEW GENERATION of it (lib/connections/store.ts claimConnection). A row
 *      being disconnected is refused, never installed over.
 *   5. The bot token is SAVED encrypted (token-store saveBotTokenAt), only
 *      while the row is still this claim, atomically. A failed save undoes the
 *      claim: a connection is never "connected" without its token.
 *   6. The team is ROUTED to this tenant (registerWebhookRoute), which is how
 *      every later event finds its workspace, fenced on the claim the same
 *      way. Losing that race undoes 4 and 5.
 *   7. A live auth.test is RECORDED as the connection's first health check,
 *      fenced on the claim too: green means Slack answered, not that a token
 *      was saved.
 * An install that meets a disconnect of the same connection (or a newer
 * install) at 4, 5, 6 or 7 has lost: it writes nothing more, touches nothing
 * of theirs, and says so (connection_busy). A disconnect that began first
 * therefore never ends with a live token stored under a "disconnected" row.
 *
 * EVERY way out after Slack handed over a token, short of connected (a
 * refusal at any step, or a throw), runs one `finally` (giveUpInstall): the
 * token is given up before OASIS forgets it (abandonInstallToken: switched off
 * at Slack unless a live connection holds the same token, or a pending claim
 * may be about to store it; Slack hands one app the same bot token on every
 * install in a workspace), else kept as a cleanup record for the
 * connection-health cron to retry; then what the install still holds (its
 * token copy, the route it added, its claim) is removed, fenced on its claim.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { completeCallback, OAuthFlowError } from "@/lib/connections/oauth";
import type { ProviderDef } from "@/lib/connections/registry";
import { OAUTH_STATE_TTL_MS, credentialServiceFor } from "@/lib/connections/rules";
import {
  claimConnection,
  deleteWebhookRoutesWhile,
  findActiveConnection,
  getConnection,
  listLiveConnectionsForAccount,
  pendingClaimGuard,
  recordHealthCheck,
  registerWebhookRoute,
  resolveWebhookRoute,
  type ClaimResult,
  type ConnectionRow,
} from "@/lib/connections/store";
import { auditConnection, probeFor, type ConnectionsDeps } from "@/lib/connections/health";
import { undoUnsavedClaim } from "@/lib/connections/service";
import { readBotToken, saveBotTokenAt } from "@/lib/connections/token-store";
import {
  countTenantIntegrationServicesByPrefix,
  deleteTenantIntegrationServiceWhile,
  listTenantIntegrationServicesByPrefix,
  markTenantIntegrationServiceTried,
  setTenantIntegrationBundle,
} from "@/lib/tenant-integration-store";
import { SLACK_TOKEN_ALREADY_DEAD, exchangeInstallCode, revokeToken, type SlackFetch } from "@/lib/slack/client";

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
  | "token_save_failed"
  | "connection_busy";

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
  const token = typeof install.access_token === "string" ? install.access_token : "";
  const teamId = typeof install.team?.id === "string" ? install.team.id : "";
  const tenantId = consent.tenantId;
  // Slack has handed this install a token. However it ends short of connected,
  // by a refusal or by a throw, the `finally` below gives the token up and
  // removes what this install still holds (giveUpInstall): no exit can skip it.
  const own: InstallHold = { claim: null, holds: false, routeAdded: false, committed: false };
  try {
    if (install.is_enterprise_install === true) return refused("enterprise_install_unsupported");
    if (!token.startsWith("xoxb-") || !teamId) return refused("not_a_bot_token");
    const teamName = typeof install.team?.name === "string" && install.team.name.trim() ? install.team.name.trim() : null;

    const routed = await resolveWebhookRoute(db, "slack", teamId);
    if (routed && routed.tenantId !== tenantId) return refused("team_connected_elsewhere");

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
      if (claim.error === "connection_busy") return refused("connection_busy");
      return claim.error === "account_connected_elsewhere"
        ? refused("team_connected_elsewhere")
        : refused("another_team_connected", claim.current.external_account_label ?? undefined);
    }
    own.claim = claim;
    own.holds = true;
    const conn = claim.connection;
    const generation = conn.token_version;

    const saved = await saveBotTokenAt(db, {
      tenantId,
      connectionId: conn.id,
      generation,
      token: { bot_token: token, bot_user_id: install.bot_user_id ?? null },
      now: deps.now(),
    });
    if (!saved.ok) {
      // A disconnect (or a newer install) took the row first: nothing was
      // stored, and the row is theirs now, not this install's to undo.
      if (saved.reason === "connection_changed") {
        own.holds = false;
        return refused("connection_busy");
      }
      console.error("[slack.install] bot token save failed", { tenantId, connectionId: conn.id, error: saved.error ?? null });
      return refused("token_save_failed");
    }

    // A route this install adds is its own to remove; one that already pointed
    // at this connection (installed again over a live one) stays.
    const routeExisted = routed !== null && routed.tenantId === tenantId && routed.connectionId === conn.id;
    const route = await registerWebhookRoute(db, {
      tenantId,
      provider: "slack",
      externalKey: teamId,
      connectionId: conn.id,
      now: deps.now(),
      generation,
    });
    if (!route.ok) {
      // A disconnect took the row after the token went in: it owns the token
      // now (switches it off and deletes it with the row).
      if (route.error === "connection_changed" || route.error === "connection_not_found") {
        own.holds = false;
        return refused("connection_busy");
      }
      // Another workspace routed this team between the check and here. Nothing
      // of this install may stay: it still holds its claim and its copy of the
      // token, and the `finally` removes both.
      return refused("team_connected_elsewhere");
    }
    own.routeAdded = !routeExisted;

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
      generation,
    });
    // A disconnect took the row after the route went in: it owns the row and
    // its token now. Never "connected" for a connection that is going away.
    if (!recorded.recorded) {
      own.holds = false;
      return refused("connection_busy");
    }
    // Installed: from here nothing is given up, whatever happens next.
    own.committed = true;
    await auditConnection({
      tenantId,
      actor: { userId: consent.userId, email: input.session.email },
      action: claim.created ? "connection.connected" : "connection.reconnected",
      connectionId: conn.id,
      after: { provider: "slack", account_id: teamId, auth_kind: input.provider.authKind, scopes: input.provider.scopes.base },
    });
    const final = (await getConnection(db, tenantId, conn.id)) ?? recorded.connection;
    return { ok: true, tenantId, teamId, teamName, connection: final };
  } finally {
    if (!own.committed) await giveUpInstall(deps, { tenantId, teamId, token, own });
  }
}

function refused(failure: SlackInstallFailure, detail?: string): SlackInstallResult {
  return { ok: false, failure, ...(detail ? { detail } : {}) };
}

// -- Giving up a token -------------------------------------------------------

/** Where a token Slack did not confirm switching off waits for the cron (lib/tenant-integration-store.ts). */
export const SLACK_TOKEN_CLEANUP_PREFIX = "slack-token-cleanup:";
/** A cleanup record this old is reported as overdue in the cron's answer, for alerting. */
export const SLACK_TOKEN_CLEANUP_OVERDUE_MS = 3 * 24 * 60 * 60 * 1000;

type Deps = { db: Client; fetchImpl?: SlackFetch; now: () => Date };

/** What an install holds while it runs, so an install that ends short of connected can give it all back. */
type InstallHold = {
  /** Its claim, once made. */
  claim: Extract<ClaimResult, { ok: true }> | null;
  /** The claim is still its own to undo (false once a disconnect or a newer install took the row). */
  holds: boolean;
  /** It added the team's route (one that already pointed at this connection is not its own). */
  routeAdded: boolean;
  /** Its first check was recorded: installed, nothing to give back. */
  committed: boolean;
};

/**
 * An install that will not end connected: its token is given up
 * (abandonInstallToken), then what it still holds is removed, each step fenced
 * on its own claim so nothing of a disconnect's or a newer install's is
 * touched: its copy of the token, the route it added, and the claim itself
 * (undoUnsavedClaim). The removal runs even if giving the token up throws.
 */
async function giveUpInstall(
  deps: ConnectionsDeps,
  input: { tenantId: string; teamId: string; token: string; own: InstallHold },
): Promise<void> {
  const claim = input.own.holds ? input.own.claim : null;
  const mine = claim ? { connectionId: claim.connection.id, generation: claim.connection.token_version } : undefined;
  try {
    await abandonInstallToken(deps, { tenantId: input.tenantId, teamId: input.teamId, token: input.token, except: mine });
  } finally {
    if (claim && mine) {
      const guard = pendingClaimGuard(input.tenantId, mine.connectionId, mine.generation);
      try {
        await deps.db.batch(
          [
            deleteTenantIntegrationServiceWhile({ tenantId: input.tenantId, service: credentialServiceFor(mine.connectionId), guard }),
            ...(input.own.routeAdded ? [deleteWebhookRoutesWhile({ tenantId: input.tenantId, connectionId: mine.connectionId, guard })] : []),
          ],
          "write",
        );
      } catch (err) {
        console.error("[slack.install] removing a lost install's token copy and route failed", {
          tenantId: input.tenantId,
          connectionId: mine.connectionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await undoUnsavedClaim(deps, input.tenantId, claim);
    }
  }
}

/**
 * Who holds `token` among this Slack team's live connections (any workspace,
 * not revoked, not being disconnected), apart from `except`: the giving-up
 * install's own claim, at its own generation only (once a newer install claims
 * the row, the row is theirs and counts). Slack returns the SAME bot token
 * whenever an app already installed in a workspace is installed again, so a
 * token an install gives up may be one another connection uses, or is about
 * to store:
 *   "held"      a connection (past its install) stores this very token;
 *   "unknown"   a pending claim (an install mid-way: whatever its row stores
 *               now, it may store this token next), or a stored token that
 *               could not be read: nothing may be switched off now;
 *   "not_held"  otherwise.
 */
async function slackTokenHolder(
  db: Client,
  teamId: string,
  token: string,
  except?: { connectionId: string; generation: number },
): Promise<"held" | "not_held" | "unknown"> {
  if (!teamId) return "not_held";
  let unknown = false;
  for (const c of await listLiveConnectionsForAccount(db, "slack", teamId)) {
    if (except && c.id === except.connectionId && c.generation === except.generation) continue;
    if (c.status === "pending") {
      unknown = true;
      continue;
    }
    const stored = await readBotToken(c.tenantId, c.id);
    if (stored.ok && stored.token === token) return "held";
    if (!stored.ok && stored.reason !== "missing") unknown = true;
  }
  return unknown ? "unknown" : "not_held";
}

/** auth.revoke: true once Slack confirms it, or says the token is already dead. Never logs the token. */
async function switchedOffAtSlack(deps: Deps, token: string): Promise<boolean> {
  const off = await revokeToken(token, { fetchImpl: deps.fetchImpl });
  if ((off.ok && off.data.revoked === true) || (!off.ok && SLACK_TOKEN_ALREADY_DEAD.has(off.error))) return true;
  console.error("[slack.install] Slack did not confirm a given-up token was switched off; kept for the cron", { error: off.ok ? "not_revoked" : off.error });
  return false;
}

/**
 * Give up a token Slack handed an install that will not end connected. It is
 * switched off at Slack only when no live connection holds it or may be about
 * to (slackTokenHolder; the install's own claim, about to be undone, does not
 * count). When Slack does not confirm the switch-off, or a holder cannot be
 * ruled out, a cleanup record keeps the encrypted token (unusable: nothing
 * reads that service) and the connection-health cron retries it
 * (retrySlackTokenCleanups), so the only copy of a live token is never simply
 * forgotten. Never throws: an install's own clean-up runs after it.
 */
async function abandonInstallToken(
  deps: Deps,
  input: { tenantId: string; teamId: string; token: string; except?: { connectionId: string; generation: number } },
): Promise<"none" | "held" | "switched_off" | "kept_for_retry" | "not_kept"> {
  if (!input.token) return "none";
  let holder: "held" | "not_held" | "unknown" = "unknown";
  try {
    holder = await slackTokenHolder(deps.db, input.teamId, input.token, input.except);
  } catch (err) {
    console.error("[slack.install] could not check who holds a given-up Slack token; keeping it for the cron", {
      tenantId: input.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (holder === "held") return "held";
  if (holder === "not_held" && (await switchedOffAtSlack(deps, input.token))) return "switched_off";
  try {
    const kept = await setTenantIntegrationBundle({
      tenantId: input.tenantId,
      service: `${SLACK_TOKEN_CLEANUP_PREFIX}${randomUUID()}`,
      bundle: { bot_token: input.token, team_id: input.teamId || "none" },
    });
    if (kept.ok) return "kept_for_retry";
    console.error("[slack.install] a given-up Slack token could not be kept for the cron; it may stay live at Slack", { tenantId: input.tenantId, error: kept.error });
  } catch (err) {
    console.error("[slack.install] a given-up Slack token could not be kept for the cron; it may stay live at Slack", {
      tenantId: input.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return "not_kept";
}

/**
 * The connection-health cron's retry of given-up tokens (abandonInstallToken).
 * A record younger than the consent window (OAUTH_STATE_TTL_MS) waits: the
 * install that gave it up may have raced another install of the same team
 * still in flight. Each older one is switched off at Slack (or dropped, when a
 * live connection holds it again) and deleted once that is settled. One Slack
 * does not confirm, whose holder cannot be ruled out, or whose stored token
 * will not decrypt is kept, never dropped unrevoked, and goes to the back of
 * the line (the least recently tried go first), so records that cannot be
 * settled never starve one that can. `overdue` counts every record older than
 * SLACK_TOKEN_CLEANUP_OVERDUE_MS, for alerting. Counts only: the cron's answer
 * is printed to a public log.
 */
export async function retrySlackTokenCleanups(
  deps: Deps,
  opts: { limit?: number } = {},
): Promise<{ retried: number; switched_off: number; held: number; kept: number; unreadable: number; overdue: number }> {
  const now = deps.now();
  const records = await listTenantIntegrationServicesByPrefix(deps.db, {
    prefix: SLACK_TOKEN_CLEANUP_PREFIX,
    createdBefore: new Date(now.getTime() - OAUTH_STATE_TTL_MS),
    limit: opts.limit ?? 20,
  });
  const out = { retried: 0, switched_off: 0, held: 0, kept: 0, unreadable: 0, overdue: 0 };
  for (const r of records) {
    out.retried += 1;
    const tried = (error: string) => markTenantIntegrationServiceTried(deps.db, { tenantId: r.tenantId, service: r.service, error, now });
    if (r.unreadable) {
      out.unreadable += 1;
      await tried("unreadable");
      continue;
    }
    const token = r.values.bot_token ?? "";
    const teamId = r.values.team_id && r.values.team_id !== "none" ? r.values.team_id : "";
    // A record that holds no token has nothing left to switch off.
    let settled = !token;
    let why = "not_confirmed";
    if (token) {
      const holder = await slackTokenHolder(deps.db, teamId, token);
      if (holder === "held") {
        out.held += 1;
        settled = true;
      } else if (holder === "not_held" && (await switchedOffAtSlack(deps, token))) {
        out.switched_off += 1;
        settled = true;
      } else if (holder === "unknown") {
        why = "holder_unknown";
      }
    }
    if (settled) {
      await deps.db.execute(deleteTenantIntegrationServiceWhile({ tenantId: r.tenantId, service: r.service, guard: { sql: "1", args: [] } }));
    } else {
      out.kept += 1;
      await tried(why);
    }
  }
  out.overdue = await countTenantIntegrationServicesByPrefix(deps.db, {
    prefix: SLACK_TOKEN_CLEANUP_PREFIX,
    createdBefore: new Date(now.getTime() - SLACK_TOKEN_CLEANUP_OVERDUE_MS),
  });
  if (out.overdue > 0) {
    console.error("[slack.install] given-up Slack tokens still not switched off after days; check them", { overdue: out.overdue });
  }
  return out;
}

/** The tenant's live Slack connection, or null. */
export function findSlackConnection(db: Client, tenantId: string): Promise<ConnectionRow | null> {
  return findActiveConnection(db, tenantId, "slack");
}
