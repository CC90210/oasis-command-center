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
 * Codex round-2 [critical] hardening: the proxy MUST enforce the same
 * role-based tool allowlist that /api/bridge/chat uses. Otherwise a
 * read-only / loan_officer / processor authenticated user can POST
 * directly to this route with tool_name='Bash' or 'Write' and execute
 * arbitrary operations on the operator's machine, bypassing the role
 * boundary that the chat dispatcher would have enforced. Same per-tenant
 * rate limit as the chat path so the tool surface can not be spammed.
 *
 * Auth: same Supabase session + SunBiz tenant gate as /api/bridge/chat,
 * plus role->disallowed-tool gate, plus per-tenant rate limit.
 */

import { authorizeBridgeRequest } from "@/lib/bridge-proxy";
import { bridgeDisallowedToolsForRole } from "@/lib/role-gates";
import { rateLimit } from "@/lib/rate-limit";

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

  // Per-tenant rate limit. Mirrors /api/bridge/chat to prevent a malicious
  // browser session from spamming long-running bridge tool calls.
  const limit = rateLimit({
    key: `bridge-exec-tool:${auth.tenantId}`,
    capacity: 30,
    refillPerSec: 1 / 15,
  });
  if (!limit.allowed) {
    return new Response(
      JSON.stringify({ ok: false, error: "rate_limited", retry_in_sec: limit.resetIn }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
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

  // Role-based tool gate. /api/bridge/chat computes the disallowed_tools list
  // from team_role and injects it into the bridge invocation; the bridge then
  // refuses those tools at spawn time. But a direct POST to /exec-tool would
  // bypass that gate, so we enforce the SAME allowlist here. Codex audit
  // 2026-06-09 round-2 [critical]: without this, a read-only employee can
  // call tool_name='Bash' / 'Write' / 'Edit' and run arbitrary operator-
  // machine ops despite not being able to use them through the chat path.
  const disallowedTools = bridgeDisallowedToolsForRole(auth.teamRole);
  if (disallowedTools.includes(toolName)) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "tool_disallowed_for_role",
        tool_name: toolName,
        team_role: auth.teamRole,
      }),
      { status: 403, headers: { "content-type": "application/json" } },
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
