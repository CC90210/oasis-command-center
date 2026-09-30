/**
 * POST /api/connections/[provider]/connect — connect a provider that
 * authenticates with a pasted key. Today: Stripe, with a RESTRICTED key only.
 *
 * Body: { key: "rk_live_…" | "rk_test_…" }
 *
 * Owner/admin only (lib/connections/access.ts). The tenant is the session's;
 * the body carries the key and nothing else that is read. A full secret key
 * (sk_) is refused with a reason; the key is probed live against Stripe, the
 * Stripe account is pinned, an account already connected to another workspace
 * is refused, and the key is stored encrypted (lib/tenant-integration-store).
 * See lib/connections/service.ts connectWithRestrictedKey for every step.
 *
 * Providers that are not live (every OAuth provider until OASIS holds its app
 * credentials) answer 409 "coming_soon". The key is never echoed or logged.
 */
import type { NextRequest } from "next/server";
import { connectWithRestrictedKey, resolveProvider } from "@/lib/connections/service";
import { resolveConnectionsActor, routeFailure, serviceResponse } from "@/lib/connections/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  try {
    const { provider: providerId } = await ctx.params;
    const resolved = await resolveConnectionsActor();
    if (!resolved.ok) return resolved.response;
    const provider = resolveProvider(providerId);
    if (!provider.ok) return serviceResponse(provider.result);

    let body: { key?: unknown };
    try {
      body = (await req.json()) as { key?: unknown };
    } catch {
      return serviceResponse({ status: 400, body: { ok: false, error: "invalid_json", message: "Send the key as JSON." } });
    }
    return serviceResponse(
      await connectWithRestrictedKey(resolved.deps, resolved.actor, provider.provider, body?.key),
    );
  } catch (error) {
    return routeFailure("api/connections/connect", error);
  }
}
