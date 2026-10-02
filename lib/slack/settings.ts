/**
 * lib/slack/settings.ts - what Settings > Chat apps shows about Slack for one
 * workspace, read in one place so the page and its API say the same thing.
 *
 *   app        which Slack app this workspace installs (CC, 2026-10-01): a
 *              client its OWN app, once saved (lib/slack/own-app.ts); OASIS's
 *              own workspace the OASIS app (the Worker secrets,
 *              registry.providerAvailability). A saved own app counts as
 *              configured wherever installs can run. With no app to install,
 *              the page says why and offers no button: an Install that cannot
 *              finish is a dead button.
 *   connection the workspace's live Slack connection (team, status, verified).
 *   routes     the channel map (slack_channel_routes); null when migration
 *              bravo__197 is not applied (said as such, never as "no channels").
 *   asked      whether the owner said in onboarding that the team uses Slack
 *              (manifest.integrations.chat_apps, written by track T7; absent
 *              reads as "not said").
 *
 * Tenant from the caller's session only.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { findActiveConnection, toPublicConnection, type PublicConnection } from "@/lib/connections/store";
import { missingProviderEnv, providerAvailability, providerById } from "@/lib/connections/registry";
import { chatAppsFrom, readManifestIntegrations } from "@/lib/jev/mode";
import { isSlackSchemaMissing, listChannelRoutes, type ChannelRoute } from "@/lib/slack/routing";
import { readSlackOwnApp, slackInstallsPossible, type SlackOwnAppRead } from "@/lib/slack/own-app";
import { tenantMayUseEnvFallback } from "@/lib/tenant-integration-store";

export type SlackSettings = {
  /** There is an app this workspace can install here (`installApp` is not null). */
  appConfigured: boolean;
  /** The app Add to Slack installs for this workspace: its own, OASIS's, or none yet. */
  installApp: "own" | "oasis" | null;
  /** This workspace's own Slack app: saved, partly saved, not saved, or unreadable. */
  ownApp: SlackOwnAppRead["state"];
  /** OASIS's own workspace (it installs the OASIS app); every other is a client. */
  oasisWorkspace: boolean;
  /** No install of any app can run on this deployment (no consent-state secret). */
  installsUnavailable: boolean;
  /** Worker secret NAMES still missing (never values); shown to the platform operator only. */
  missingSecrets: string[];
  connection: PublicConnection | null;
  routes: ChannelRoute[] | null;
  routesNotInstalled: boolean;
  /** The owner said in onboarding that the team talks in Slack. */
  askedForSlack: boolean;
};

export async function loadSlackSettings(
  db: Client,
  tenantId: string,
  opts: { env?: Readonly<Record<string, string | undefined>>; nowMs: number },
): Promise<SlackSettings> {
  const env = opts.env ?? process.env;
  const slack = providerById("slack");
  const oasisAppReady = !!slack && providerAvailability(slack, env) === "live";
  const oasisWorkspace = tenantMayUseEnvFallback(tenantId);
  const own = await readSlackOwnApp(tenantId);
  const installsPossible = slackInstallsPossible(env);
  // A saved own app is this workspace's app wherever installs can run; with
  // none, OASIS's own workspace installs the OASIS app, and a client has none
  // until it saves its own (CC: the client brings its own Slack app).
  const installApp: SlackSettings["installApp"] =
    own.state === "saved" && installsPossible ? "own" : own.state === "none" && oasisWorkspace && oasisAppReady ? "oasis" : null;
  const conn = await findActiveConnection(db, tenantId, "slack");
  let routes: ChannelRoute[] | null = null;
  let routesNotInstalled = false;
  try {
    routes = await listChannelRoutes(db, tenantId);
  } catch (err) {
    if (!isSlackSchemaMissing(err)) throw err;
    routesNotInstalled = true;
  }
  let askedForSlack = false;
  try {
    askedForSlack = chatAppsFrom(await readManifestIntegrations(db, tenantId)).includes("slack");
  } catch (err) {
    // The prompt is a nudge; a manifest that cannot be read only hides it.
    console.error("[slack.settings] manifest integrations unreadable", { tenantId, error: err instanceof Error ? err.message : String(err) });
  }
  return {
    appConfigured: installApp !== null,
    installApp,
    ownApp: own.state,
    oasisWorkspace,
    installsUnavailable: !installsPossible,
    missingSecrets: slack ? missingProviderEnv(slack, env) : [],
    connection: conn ? toPublicConnection(conn, opts.nowMs) : null,
    routes,
    routesNotInstalled,
    askedForSlack,
  };
}
