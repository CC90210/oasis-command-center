/**
 * POST /api/connections/[provider]/test — re-probe this workspace's live
 * connection now, with its own stored credential, and record the result
 * (connection_health_checks + tenant_connections status). The Settings card's
 * "Test again". Owner/admin only; the tenant is the session's.
 *
 * 404 when the provider is not connected here. A probe that finds a problem is
 * still a 200 — the problem is the answer, in `connection.status`.
 *
 * Slack is checkable through the app its workspace uses, and only that
 * (lib/slack/own-app.ts slackAppFor): a client's own app wherever OASIS's app
 * is or is not set up, OASIS's app for OASIS's own workspace. OASIS's app being
 * live never makes a client's Slack checkable.
 */
import { resolveProvider, testConnection } from "@/lib/connections/service";
import { providerById } from "@/lib/connections/registry";
import { resolveConnectionsActor, routeFailure, serviceResponse } from "@/lib/connections/route-helpers";
import { slackAppFor } from "@/lib/slack/own-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ provider: string }> }) {
  try {
    const { provider: providerId } = await ctx.params;
    const resolved = await resolveConnectionsActor();
    if (!resolved.ok) return resolved.response;
    const slack = providerId === "slack" ? providerById("slack") : null;
    if (slack) {
      const app = await slackAppFor(resolved.actor.tenantId);
      if (app === "own" || app === "oasis") return serviceResponse(await testConnection(resolved.deps, resolved.actor, slack));
      return serviceResponse(
        app === "unknown"
          ? { status: 503, body: { ok: false, error: "slack_app_unavailable", message: "This workspace's Slack app details could not be read just now. Try again in a minute." } }
          : { status: 409, body: { ok: false, error: "slack_app_not_set_up", message: "Slack cannot be checked here: the Slack app this workspace uses is not set up." } },
      );
    }
    const provider = resolveProvider(providerId);
    if (!provider.ok) return serviceResponse(provider.result);
    return serviceResponse(await testConnection(resolved.deps, resolved.actor, provider.provider));
  } catch (error) {
    return routeFailure("api/connections/test", error);
  }
}
