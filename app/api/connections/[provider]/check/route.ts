/**
 * POST /api/connections/[provider]/check -- Test a pasted key without
 * connecting it (Stripe's restricted key, Jev's TypeSafe key).
 *
 * Body: { key }
 *
 * The same format rule and live check as /connect, and nothing is saved: no
 * connection, no stored key, no health row. The answer says whether the key
 * works and, when it does not, why in plain words (for Stripe, which Read
 * permissions are missing). Owner/admin only, like /connect; the key is never
 * echoed or logged. See lib/connections/service.ts checkRestrictedKey.
 */
import type { NextRequest } from "next/server";
import { checkRestrictedKey, resolveProvider } from "@/lib/connections/service";
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
    return serviceResponse(await checkRestrictedKey(resolved.deps, provider.provider, body?.key));
  } catch (error) {
    return routeFailure("api/connections/check", error);
  }
}
