/**
 * POST /api/bridge/exec-tool
 *
 * Same-origin authed proxy for the bridge's /exec-tool endpoint. In proxy
 * mode the ChatWidget's deferred tool-execution POST would otherwise go
 * cross-origin to the VPS and fail — so the cloud chat path returns a
 * tool_use, the browser tries to run it on the bridge, and gets
 * "bridge_unreachable" because the browser can't talk to a remote VPS
 * daemon directly. This route relays the call with the server-only
 * bearer so the tool actually runs.
 *
 * Filed as Codex audit 2026-06-09 [medium]: the prior commit (637dce0)
 * fixed the browser-side proxy detection for the dropdown labels but
 * left this single direct-fetch call to ${BRIDGE_CHAT_BASE}/exec-tool
 * outside the proxy gate, meaning cloud_bridge_tools mode appeared
 * online (dropdown enabled, isProxyModeRuntime=true on health) but
 * tool execution failed silently for every non-localhost user.
 *
 * Auth: same Supabase session + SunBiz tenant gate as /api/bridge/chat.
 * Tool calls are server-relayed; the browser never touches the VPS.
 */

import { authorizeBridgeRequest } from "@/lib/bridge-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Tools larger than this would mean the model is shipping a large blob
// (likely a write_file payload). 256KB ceiling matches BRIDGE_TOOL_TIMEOUT_MS
// (60s) — large enough for any sane tool input, small enough to bound
// abuse from a malicious browser session.
const MAX_BODY_BYTES = 256_000;
// Proxy timeout slightly longer than the bridge tool timeout (60s) so we
// surface the bridge's own timeout error rather than racing it.
const PROXY_TIMEOUT_MS = 65_000;

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
      return new Response(
        JSON.stringify({ ok: false, error: "payload_too_large" }),
        { status: 413, headers: { "content-type": "application/json" } },
      );
    }
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const toolName = typeof body.tool_name === "string" ? body.tool_name : null;
  if (!toolName) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing_tool_name" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  try {
    const upstream = await fetch(`${auth.target.baseUrl}/exec-tool`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth.target.bearerToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "bridge_unreachable" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
