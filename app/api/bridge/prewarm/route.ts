/**
 * POST /api/bridge/prewarm
 *
 * Same-origin authed proxy for the bridge's /prewarm endpoint. In proxy mode
 * the ChatWidget's prewarm POST would otherwise go cross-origin to the VPS
 * (no bearer, CORS-blocked) and silently fail — so we relay it here with the
 * server-only bearer. Keeps the warm-pool prewarm optimization working for
 * SunBiz employees.
 *
 * Auth: same Supabase session + SunBiz tenant gate as /api/bridge/chat (via
 * authorizeBridgeRequest). Agent is pinned server-side to the SunBiz personas.
 */

import { authorizeBridgeRequest } from "@/lib/bridge-proxy";
import { bridgeDisallowedToolsForRole } from "@/lib/role-gates";
import { validateBridgeAgent } from "@/lib/agent-roots";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 16_000; // prewarm body is tiny ({agent, tab_id})

export async function POST(req: Request) {
  const auth = await authorizeBridgeRequest();
  if (!auth.ok) {
    return new Response(JSON.stringify({ ok: false, error: auth.error }), {
      status: auth.status,
      headers: { "content-type": "application/json" },
    });
  }

  let body: Record<string, unknown> = {};
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ ok: false, error: "payload_too_large" }), {
        status: 413,
        headers: { "content-type": "application/json" },
      });
    }
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const agent = String(body.agent || "").trim().toLowerCase();
  const agentCheck = validateBridgeAgent(agent, auth.tenantSlug);
  if (!agentCheck.ok) {
    return new Response(JSON.stringify({ ok: false, error: agentCheck.error }), {
      status: agentCheck.status,
      headers: { "content-type": "application/json" },
    });
  }
  // Forward with the pinned agent + the SAME role-derived disallowed_tools the
  // first real /chat turn will request, so the bridge prewarms a process whose
  // role fingerprint matches — otherwise prewarm spawns a 'full' process the
  // member's locked-down turn can't reuse (wasted warm + extra cold start).
  const forwardBody = {
    ...body,
    agent,
    disallowed_tools: bridgeDisallowedToolsForRole(auth.teamRole),
  };

  try {
    const upstream = await fetch(`${auth.target.baseUrl}/prewarm`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth.target.bearerToken}`,
      },
      body: JSON.stringify(forwardBody),
      signal: AbortSignal.timeout(5000),
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "bridge_unreachable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}
