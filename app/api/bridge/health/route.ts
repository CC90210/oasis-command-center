/**
 * GET /api/bridge/health
 *
 * Authed health probe for the VPS bridge. The ChatWidget probes this
 * (same-origin) in proxy mode instead of hitting the VPS directly, so the
 * browser never touches the VPS and never needs the bearer.
 *
 * Auth: requires a logged-in Supabase user (an anon visitor must not be able
 * to fingerprint the VPS). Resolves the tenant + bridge target server-side,
 * forwards to ${baseUrl}/health WITH the server-only bearer, and returns an
 * empty 200/503. The widget only inspects r.ok (ChatWidget health probe), so
 * an empty body is sufficient. The bearer never leaves the server.
 *
 * When the bridge isn't configured (env unset) we return 503 so the widget
 * cleanly marks the bridge offline and falls back to the cloud path.
 */

import { authorizeBridgeRequest } from "@/lib/bridge-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const auth = await authorizeBridgeRequest();
  if (!auth.ok) {
    // 401 for anon (don't let them probe); for any other failure (no tenant,
    // not enabled, not configured) return 503 so the widget treats the bridge
    // as offline and degrades to cloud. r.ok is false in both cases.
    return new Response(null, { status: auth.status === 401 ? 401 : 503 });
  }
  try {
    const r = await fetch(`${auth.target.baseUrl}/health`, {
      headers: { authorization: `Bearer ${auth.target.bearerToken}` },
      signal: AbortSignal.timeout(1500),
    });
    return new Response(null, { status: r.ok ? 200 : 503 });
  } catch {
    return new Response(null, { status: 503 });
  }
}
