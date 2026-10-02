/**
 * lib/slack/own-app.ts - which Slack app serves a workspace, and a workspace's
 * OWN Slack app end to end on the server (CC, 2026-10-01: a client brings its
 * own Slack app; OASIS's own workspace uses the OASIS app).
 *
 * THE RULE, in one place (slackAppKindFor): OASIS's own workspaces, the same
 * id allowlist that alone may use this deployment's env credentials
 * (tenantMayUseEnvFallback), use OASIS's Slack app (the Worker secrets) and
 * nothing else; every other workspace, a client, uses its OWN saved Slack app
 * and never OASIS's. Everything below follows from it:
 *   - the install (slackInstallEnv): an OASIS workspace installs OASIS's app
 *     (a Slack app it saved plays no part); a client installs its own complete
 *     saved app, or nothing, however OASIS's app is set up;
 *   - the requests (slackRequestScope, slackAppMaySpeakFor): Slack signs every
 *     event and button press with the signing secret of the app it came from.
 *     One with no ?workspace= is checked with OASIS's app's secret and may act
 *     only for an OASIS workspace; one with ?workspace=<id> is checked with
 *     that client's own signing secret and may act only for <id>. The events
 *     and interactivity handlers check the routed workspace on EVERY request;
 *   - a connection's app is its workspace's app by this rule, not a stored
 *     field: the install only ever uses the workspace's app, so the rule names
 *     the app every connection was installed with. A connection the rule no
 *     longer matches (its workspace moved on or off the allowlist) fails
 *     closed: its events are refused until it is installed again. (Production
 *     held no Slack connection, route or saved Slack app on 2026-10-02, so no
 *     row predates the rule.)
 *
 * THE CREDENTIALS are the workspace's "slack_app" values in the encrypted
 * credential store (client ID, client secret, signing secret), saved in the
 * Slack drawer (Settings > Connections). They are read strictly: a value that
 * will not decrypt, or a lookup that fails, is "unreadable", never "none", and
 * OASIS's own app (the Worker secrets) is never read as a workspace's app.
 *
 * THE INSTALL runs through the same routes, state and checks as OASIS's app
 * (lib/connections/oauth.ts, lib/slack/install.ts): the workspace's app is laid
 * over the env those already read (slackOwnAppEnv). A half-saved, unreadable or
 * missing app is refused, never quietly swapped for OASIS's.
 *
 * THE REQUESTS Slack sends to a client's own Request URLs carry
 * ?workspace=<id> (lib/slack/own-app-setup.ts), so a workspace's secret can
 * never sign for another's team, and OASIS's secret never for a client's.
 */
import "server-only";
import { OASIS_ENV_CREDENTIAL_TENANT_IDS, readTenantCredentialStrict, tenantMayUseEnvFallback } from "@/lib/tenant-integration-store";
import { providerAvailability, providerById } from "@/lib/connections/registry";
import { oauthStateSecret } from "@/lib/connections/oauth";
import { SLACK_SIGNING_SECRET_ENV } from "@/lib/slack/verify";

type Env = Readonly<Record<string, string | undefined>>;

export const SLACK_APP_SERVICE = "slack_app";
export const SLACK_APP_FIELDS = ["client_id", "client_secret", "signing_secret"] as const;

export type SlackOwnApp = { clientId: string; clientSecret: string; signingSecret: string };

export type SlackOwnAppRead =
  | { state: "saved"; app: SlackOwnApp }
  | { state: "incomplete"; missing: string[] }
  | { state: "none" }
  | { state: "unreadable" };

/** The Slack app a workspace uses: OASIS's ("oasis") or its own ("own"). */
export type SlackAppKind = "oasis" | "own";

/**
 * THE RULE (see the header): OASIS's own workspaces use OASIS's Slack app,
 * every other workspace its own. By workspace id, exact match, so an unknown
 * or malformed id is a client and can never reach OASIS's app.
 */
export function slackAppKindFor(tenantId: string): SlackAppKind {
  return tenantMayUseEnvFallback(tenantId) ? "oasis" : "own";
}

/** The workspaces slackAppKindFor gives OASIS's app, for a query that must leave them out. */
export function oasisSlackAppWorkspaceIds(): string[] {
  return [...OASIS_ENV_CREDENTIAL_TENANT_IDS];
}

/** The workspace's own Slack app, strictly: no env, and an unreadable value is not a missing one. */
export async function readSlackOwnApp(tenantId: string): Promise<SlackOwnAppRead> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of SLACK_APP_FIELDS) {
    const read = await readTenantCredentialStrict(tenantId, SLACK_APP_SERVICE, field);
    if (read.ok) values[field] = read.value.trim();
    else if (read.reason === "missing") missing.push(field);
    else return { state: "unreadable" };
  }
  if (missing.length === SLACK_APP_FIELDS.length) return { state: "none" };
  if (missing.length > 0) return { state: "incomplete", missing };
  return {
    state: "saved",
    app: { clientId: values.client_id, clientSecret: values.client_secret, signingSecret: values.signing_secret },
  };
}

/** The env the install and the signature check read, with this workspace's app in place of OASIS's. */
export function slackOwnAppEnv(env: Env, app: SlackOwnApp): Env {
  const oauth = providerById("slack")?.oauth;
  if (!oauth) throw new Error("slack.own-app: the Slack provider has no OAuth config");
  return {
    ...env,
    [oauth.clientIdEnv]: app.clientId,
    [oauth.clientSecretEnv]: app.clientSecret,
    [SLACK_SIGNING_SECRET_ENV]: app.signingSecret,
  };
}

/**
 * Which Slack app makes this workspace's Slack work here, for a connection it
 * already has, by the rule: an OASIS workspace OASIS's app, while it is live on
 * this deployment; a client its own saved app (never OASIS's). Either verifies
 * its events and leaves the connection's own token to check, so the connection
 * can be shown, re-checked and used. "none": the workspace's app is not set up
 * here, so a connection cannot work; "unknown": a client's app could not be read.
 */
export async function slackAppFor(tenantId: string, env: Env = process.env): Promise<"oasis" | "own" | "none" | "unknown"> {
  if (slackAppKindFor(tenantId) === "oasis") {
    const slack = providerById("slack");
    return slack && providerAvailability(slack, env) === "live" ? "oasis" : "none";
  }
  const own = await readSlackOwnApp(tenantId);
  return own.state === "saved" ? "own" : own.state === "unreadable" ? "unknown" : "none";
}

/**
 * Whether any Slack install can run on this deployment: every consent state is
 * signed with OASIS's own CONNECTIONS_OAUTH_STATE_SECRET (no fallback), a
 * workspace's own app included.
 */
export function slackInstallsPossible(env: Env = process.env): boolean {
  try {
    oauthStateSecret(env);
    return true;
  } catch {
    return false;
  }
}

export type SlackInstallEnv =
  | { ok: true; app: SlackAppKind; env: Env }
  | { ok: false; reason: "own_app_missing" | "own_app_incomplete" | "own_app_unreadable" };

/**
 * The env Add to Slack (and its callback) runs with for this workspace, by the
 * rule: an OASIS workspace OASIS's app (the env as it is; a Slack app it saved
 * plays no part), a client its own complete saved app laid over the env. A
 * client with no app, part of one, or one that cannot be read is refused, and
 * is never given OASIS's app, whether or not OASIS's app is set up here.
 */
export async function slackInstallEnv(tenantId: string, env: Env = process.env): Promise<SlackInstallEnv> {
  if (slackAppKindFor(tenantId) === "oasis") return { ok: true, app: "oasis", env };
  const own = await readSlackOwnApp(tenantId);
  if (own.state === "saved") return { ok: true, app: "own", env: slackOwnAppEnv(env, own.app) };
  return {
    ok: false,
    reason: own.state === "none" ? "own_app_missing" : own.state === "incomplete" ? "own_app_incomplete" : "own_app_unreadable",
  };
}

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The app whose signing secret checked a Slack request: OASIS's, or one client's own. */
export type SlackRequestApp = { kind: "oasis" } | { kind: "own"; tenantId: string };

/**
 * May a request checked with `app`'s signing secret act for `tenantId`, the
 * workspace its Slack team is routed to? Only when that workspace uses that
 * app (slackAppKindFor): OASIS's app for OASIS's own workspaces only, a
 * client's own app for that one client only. The events and interactivity
 * handlers ask this on every request they act on.
 */
export function slackAppMaySpeakFor(app: SlackRequestApp, tenantId: string): boolean {
  const kind = slackAppKindFor(tenantId);
  return app.kind === "oasis" ? kind === "oasis" : kind === "own" && app.tenantId === tenantId;
}

export type SlackRequestScope =
  | { ok: true; env: Env; app: SlackRequestApp }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Which app a Slack request is checked as, from the URL Slack sent it to:
 *   no ?workspace=   OASIS's app: SLACK_SIGNING_SECRET, and the request may
 *                    act only for an OASIS workspace;
 *   ?workspace=<id>  that client's own app's signing secret ONLY, and the
 *                    request may act only for <id>.
 * An unknown workspace, an OASIS one (it uses OASIS's app, so it has no such
 * URL), or a client with no complete saved app is 404; a credential that
 * cannot be read is 503, so Slack retries instead of losing the event.
 */
export async function slackRequestScope(workspace: string | null, env: Env = process.env): Promise<SlackRequestScope> {
  if (workspace === null) return { ok: true, env, app: { kind: "oasis" } };
  const id = workspace.trim();
  if (!TENANT_ID.test(id) || slackAppKindFor(id) !== "own") {
    return { ok: false, status: 404, body: { ok: false, error: "workspace_app_not_found" } };
  }
  const own = await readSlackOwnApp(id);
  if (own.state === "unreadable") return { ok: false, status: 503, body: { ok: false, error: "workspace_app_unavailable" } };
  if (own.state !== "saved") return { ok: false, status: 404, body: { ok: false, error: "workspace_app_not_found" } };
  return { ok: true, env: slackOwnAppEnv(env, own.app), app: { kind: "own", tenantId: id } };
}
