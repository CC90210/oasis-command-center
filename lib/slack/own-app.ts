/**
 * lib/slack/own-app.ts - a workspace's OWN Slack app, end to end on the server
 * (CC, 2026-10-01: a client brings its own Slack app; OASIS's own workspace
 * uses the OASIS app).
 *
 * THE CREDENTIALS are the workspace's "slack_app" values in the encrypted
 * credential store (client ID, client secret, signing secret), saved in the
 * Slack drawer (Settings > Connections). They are read strictly: a value that
 * will not decrypt, or a lookup that fails, is "unreadable", never "none", and
 * OASIS's own app (the Worker secrets) is never read as a workspace's app.
 *
 * THE INSTALL runs through the same routes, state and checks as OASIS's app
 * (lib/connections/oauth.ts, lib/slack/install.ts): the workspace's app is laid
 * over the env those already read (slackOwnAppEnv). A workspace with a saved
 * app always installs THAT app; one with nothing saved uses OASIS's app exactly
 * as before; a half-saved or unreadable one is refused, never quietly swapped.
 *
 * THE REQUESTS Slack sends to a workspace's own Request URLs carry
 * ?workspace=<id> (lib/slack/own-app-setup.ts). Each is checked with THAT
 * workspace's signing secret only, and may speak only for the Slack team routed
 * to that workspace (the events and interactivity handlers check
 * expectTenantId), so a workspace's secret can never sign for another's team.
 * A request with no ?workspace= is OASIS's app's, checked as before.
 */
import "server-only";
import { readTenantCredentialStrict } from "@/lib/tenant-integration-store";
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
 * already has: OASIS's app (live on this deployment) or its own saved app.
 * Either verifies its events and leaves the connection's own token to check,
 * so the connection can be shown, re-checked and used. "none": neither, so a
 * connection cannot work here; "unknown": its app could not be read.
 */
export async function slackAppFor(tenantId: string, env: Env = process.env): Promise<"oasis" | "own" | "none" | "unknown"> {
  const slack = providerById("slack");
  if (slack && providerAvailability(slack, env) === "live") return "oasis";
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
  | { ok: true; app: "own" | "oasis"; env: Env }
  | { ok: false; reason: "own_app_incomplete" | "own_app_unreadable" };

/**
 * The env Add to Slack (and its callback) runs with for this workspace: its own
 * app when one is saved, OASIS's app when nothing is saved (unchanged).
 */
export async function slackInstallEnv(tenantId: string, env: Env = process.env): Promise<SlackInstallEnv> {
  const own = await readSlackOwnApp(tenantId);
  if (own.state === "saved") return { ok: true, app: "own", env: slackOwnAppEnv(env, own.app) };
  if (own.state === "none") return { ok: true, app: "oasis", env };
  return { ok: false, reason: own.state === "incomplete" ? "own_app_incomplete" : "own_app_unreadable" };
}

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SlackRequestScope =
  | { ok: true; env: Env; expectTenantId?: string }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Which signing secret checks a Slack request, from the URL Slack sent it to:
 *   no ?workspace=   OASIS's app (SLACK_SIGNING_SECRET), exactly as before;
 *   ?workspace=<id>  that workspace's own app's signing secret ONLY, and the
 *                    request may speak only for the team routed to <id>.
 * An unknown workspace, or one with no saved app, is 404; a credential that
 * cannot be read is 503, so Slack retries instead of losing the event.
 */
export async function slackRequestScope(workspace: string | null, env: Env = process.env): Promise<SlackRequestScope> {
  if (workspace === null) return { ok: true, env };
  const id = workspace.trim();
  if (!TENANT_ID.test(id)) return { ok: false, status: 404, body: { ok: false, error: "workspace_app_not_found" } };
  const own = await readSlackOwnApp(id);
  if (own.state === "unreadable") return { ok: false, status: 503, body: { ok: false, error: "workspace_app_unavailable" } };
  if (own.state !== "saved") return { ok: false, status: 404, body: { ok: false, error: "workspace_app_not_found" } };
  return { ok: true, env: slackOwnAppEnv(env, own.app), expectTenantId: id };
}
