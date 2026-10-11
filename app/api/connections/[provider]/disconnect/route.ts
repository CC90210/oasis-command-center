/**
 * POST /api/connections/[provider]/disconnect — disconnect this workspace's
 * live connection: the stored credential is DELETED first, then the connection
 * is marked revoked (and its webhook routes dropped). Owner/admin only; the
 * tenant is the session's, so another workspace's connection cannot be named.
 *
 * Idempotent: nothing connected answers 200 { already_disconnected: true }.
 * If the key cannot be deleted, nothing is marked revoked and the answer is 500.
 *
 * Resolved WITHOUT the "is OASIS's app configured on this deployment" gate
 * (resolveProviderForDisconnect, not resolveProvider): a connection made
 * earlier, or on a deployment that still holds the vendor's Worker secrets,
 * must always be removable here even when this deployment does not. The
 * vendor revoke that follows is best-effort regardless.
 */
import { disconnectConnection, resolveProviderForDisconnect } from "@/lib/connections/service";
import { resolveConnectionsActor, routeFailure, serviceResponse } from "@/lib/connections/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ provider: string }> }) {
  try {
    const { provider: providerId } = await ctx.params;
    const resolved = await resolveConnectionsActor();
    if (!resolved.ok) return resolved.response;
    const provider = resolveProviderForDisconnect(providerId);
    if (!provider.ok) return serviceResponse(provider.result);
    return serviceResponse(await disconnectConnection(resolved.deps, resolved.actor, provider.provider));
  } catch (error) {
    return routeFailure("api/connections/disconnect", error);
  }
}
