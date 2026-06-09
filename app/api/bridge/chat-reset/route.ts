/**
 * POST /api/bridge/chat-reset
 *
 * Same-origin authed proxy for the bridge's /chat-reset endpoint. In proxy
 * mode the ChatWidget's reset POST would otherwise go cross-origin to the VPS
 * and fail — leaving the warm claude subprocess pinned in RAM until the idle
 * reaper catches it. chat-reset MUST work (it kills the warm process), so we
 * relay it here with the server-only bearer.
 *
 * Auth: same Supabase session + SunBiz tenant gate as /api/bridge/chat (via
 * authorizeBridgeRequest). Agent is pinned server-side to the SunBiz personas.
 */

import { authorizeBridgeRequest } from "@/lib/bridge-proxy";
import {
  SUNBIZ_BRIDGE_AGENTS,
  OASIS_BRIDGE_AGENTS,
  allowedBridgeAgentsForTenant,
} from "@/lib/agent-roots";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Universe of valid bridge slugs (defense-in-depth early reject). Per-tenant
// subset enforced after auth via allowedBridgeAgentsForTenant.
const KNOWN_BRIDGE_AGENTS: ReadonlySet<string> = new Set([
  ...SUNBIZ_BRIDGE_AGENTS,
  ...OASIS_BRIDGE_AGENTS,
]);
const MAX_BODY_BYTES = 16_000; // {agent, tab_id, session_id, cli_provider}

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
  if (!KNOWN_BRIDGE_AGENTS.has(agent)) {
    return new Response(JSON.stringify({ ok: false, error: "invalid_agent" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (!allowedBridgeAgentsForTenant(auth.tenantSlug).has(agent)) {
    return new Response(
      JSON.stringify({ ok: false, error: "agent_not_enabled_for_tenant" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  const forwardBody = { ...body, agent };

  try {
    const upstream = await fetch(`${auth.target.baseUrl}/chat-reset`, {
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
