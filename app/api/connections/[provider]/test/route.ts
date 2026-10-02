/**
 * POST /api/connections/[provider]/test — re-probe this workspace's live
 * connection now, with its own stored credential, and record the result
 * (connection_health_checks + tenant_connections status). The Settings card's
 * "Test again". Owner/admin only; the tenant is the session's.
 *
 * 404 when the provider is not connected here. A probe that finds a problem is
 * still a 200 — the problem is the answer, in `connection.status`.
 *
 * Slack made with the workspace's OWN Slack app is checkable even where
 * OASIS's Slack app is not set up (lib/slack/own-app.ts slackAppFor).
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
    if (slack && (await slackAppFor(resolved.actor.tenantId)) === "own") {
      return serviceResponse(await testConnection(resolved.deps, resolved.actor, slack));
    }
    const provider = resolveProvider(providerId);
    if (!provider.ok) return serviceResponse(provider.result);
    return serviceResponse(await testConnection(resolved.deps, resolved.actor, provider.provider));
  } catch (error) {
    return routeFailure("api/connections/test", error);
  }
}
