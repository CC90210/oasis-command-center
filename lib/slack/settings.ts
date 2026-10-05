/**
 * lib/slack/settings.ts - what Settings > Chat apps shows about Slack for one
 * workspace, read in one place so the page and its API say the same thing.
 *
 *   app        whether OASIS's Slack app is set up on this deployment (the
 *              Worker secrets, registry.providerAvailability). When it is not,
 *              the card says "Slack app not configured yet" and offers no
 *              button: an Install that cannot finish is a dead button.
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

export type SlackSettings = {
  appConfigured: boolean;
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
  const appConfigured = !!slack && providerAvailability(slack, env) === "live";
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
    appConfigured,
    missingSecrets: slack ? missingProviderEnv(slack, env) : [],
    connection: conn ? toPublicConnection(conn, opts.nowMs) : null,
    routes,
    routesNotInstalled,
    askedForSlack,
  };
}
