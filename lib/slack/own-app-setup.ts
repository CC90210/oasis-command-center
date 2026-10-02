/**
 * lib/slack/own-app-setup.ts - exactly what a client creates in its own Slack
 * (CC, 2026-10-01: "the client is responsible for obtaining the API key"),
 * generated from the code that will receive it, never hand-written:
 *
 *   redirect URL      where Slack sends the browser back after Add to Slack
 *                     (the same /api/connections/slack/callback the install
 *                     route names as redirect_uri);
 *   Request URLs      Event Subscriptions and Interactivity, each carrying the
 *                     workspace's id, so OASIS checks Slack's signature with THAT
 *                     workspace's signing secret (lib/slack/own-app.ts);
 *   bot scopes        the Slack provider's own scope list (lib/connections/
 *                     registry.ts), the same list the install asks for;
 *   bot events        the two events lib/slack/events.ts acts on;
 *   manifest          all of the above as one Slack app manifest to paste into
 *                     Slack's "Create an app from a manifest".
 *
 * PURE AND CLIENT-SAFE: no server import, no env read, no fetch. The origin and
 * workspace id come from the server (GET /api/integrations/slack/app).
 */
import { providerById } from "@/lib/connections/registry";

export const SLACK_CALLBACK_PATH = "/api/connections/slack/callback";
export const SLACK_EVENTS_PATH = "/api/webhooks/slack/events";
export const SLACK_INTERACTIVITY_PATH = "/api/webhooks/slack/interactivity";
/** The query parameter that names the workspace whose own Slack app signed a request. */
export const SLACK_WORKSPACE_PARAM = "workspace";
/** What lib/slack/events.ts acts on: a mention of the app, and messages in public channels it is in. */
export const SLACK_BOT_EVENTS: readonly string[] = ["app_mention", "message.channels"];
/** The app's name in the client's Slack (the manifest's display name). */
export const SLACK_OWN_APP_NAME = "OASIS";

export type SlackOwnAppSetup = {
  redirectUrl: string;
  eventsUrl: string;
  interactivityUrl: string;
  botScopes: string[];
  botEvents: string[];
  /** A Slack app manifest (JSON), for api.slack.com/apps > Create New App > From a manifest. */
  manifest: Record<string, unknown>;
};

export function slackOwnAppSetup(origin: string, workspaceId: string): SlackOwnAppSetup {
  const base = origin.replace(/\/+$/, "");
  const scope = `?${SLACK_WORKSPACE_PARAM}=${encodeURIComponent(workspaceId)}`;
  const redirectUrl = `${base}${SLACK_CALLBACK_PATH}`;
  const eventsUrl = `${base}${SLACK_EVENTS_PATH}${scope}`;
  const interactivityUrl = `${base}${SLACK_INTERACTIVITY_PATH}${scope}`;
  const botScopes = [...(providerById("slack")?.scopes.base ?? [])];
  const botEvents = [...SLACK_BOT_EVENTS];
  return {
    redirectUrl,
    eventsUrl,
    interactivityUrl,
    botScopes,
    botEvents,
    manifest: {
      display_information: { name: SLACK_OWN_APP_NAME },
      features: { bot_user: { display_name: SLACK_OWN_APP_NAME, always_online: false } },
      oauth_config: { redirect_urls: [redirectUrl], scopes: { bot: botScopes } },
      settings: {
        event_subscriptions: { request_url: eventsUrl, bot_events: botEvents },
        interactivity: { is_enabled: true, request_url: interactivityUrl },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    },
  };
}
