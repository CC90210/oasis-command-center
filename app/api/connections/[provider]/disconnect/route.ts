/**
 * POST /api/connections/[provider]/disconnect — disconnect this workspace's
 * live connection: the stored credential is DELETED first, then the connection
 * is marked revoked (and its webhook routes dropped). Owner/admin only; the
 * tenant is the session's, so another workspace's connection cannot be named.
 *
 * Slack (either app, OASIS's or the workspace's own): before anything is
 * deleted, the bot token is switched off at Slack (auth.revoke). Until Slack
 * confirms it, or says the token is already dead, nothing is deleted and the
 * answer says Slack is still connected, so Disconnect can simply be pressed
 * again (lib/connections/service.ts switchOffSlackToken).
 *
 * Idempotent: nothing connected answers 200 { already_disconnected: true }.
 * If the key cannot be deleted, nothing is marked revoked and the answer is 500.
 *
 * Never gated on whether the provider can be INSTALLED here: a workspace can
 * always disconnect what it has (a client's own-app Slack connection on a
 * deployment without OASIS's Slack app, or an app whose secrets were removed).
 */
import { disconnectConnection } from "@/lib/connections/service";
import { providerById } from "@/lib/connections/registry";
import { resolveConnectionsActor, routeFailure, serviceResponse } from "@/lib/connections/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ provider: string }> }) {
  try {
    const { provider: providerId } = await ctx.params;
    const resolved = await resolveConnectionsActor();
    if (!resolved.ok) return resolved.response;
    const provider = providerById(providerId);
    if (!provider) {
      return serviceResponse({ status: 404, body: { ok: false, error: "unknown_provider", message: "OASIS has no connection called that." } });
    }
    return serviceResponse(await disconnectConnection(resolved.deps, resolved.actor, provider));
  } catch (error) {
    return routeFailure("api/connections/disconnect", error);
  }
}
