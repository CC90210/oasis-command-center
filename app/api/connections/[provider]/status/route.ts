/**
 * GET /api/connections/[provider]/status — this workspace's connection for one
 * provider: state, pinned account, last health and the five latest checks.
 * Never a credential. Owner/admin only; the tenant is the session's.
 *
 * A provider that is not live yet answers 200 with availability "coming_soon",
 * the reason, and connection: null — honest, not a 404.
 */
import { providerById } from "@/lib/connections/registry";
import { connectionStatus } from "@/lib/connections/service";
import { resolveConnectionsActor, routeFailure, serviceResponse } from "@/lib/connections/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ provider: string }> }) {
  try {
    const { provider: providerId } = await ctx.params;
    const resolved = await resolveConnectionsActor();
    if (!resolved.ok) return resolved.response;
    const provider = providerById(providerId);
    if (!provider) {
      return serviceResponse({
        status: 404,
        body: { ok: false, error: "unknown_provider", message: "OASIS has no connection called that." },
      });
    }
    const result = await connectionStatus(resolved.deps, resolved.actor, provider);
    if (provider.availability !== "live") {
      result.body = { ...result.body, blocked_on: provider.blockedOn ?? null };
    }
    return serviceResponse(result);
  } catch (error) {
    return routeFailure("api/connections/status", error);
  }
}
