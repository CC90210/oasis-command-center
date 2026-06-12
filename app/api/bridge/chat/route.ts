/**
 * POST /api/bridge/chat
 *
 * Same-origin Supabase-authed proxy from the dashboard ChatWidget to the
 * PRIVATE VPS bridge (CLI tools). Lets SunBiz employees chat with the agents
 * via the bridge WITHOUT exposing the bridge to the public internet and with
 * per-role tool gating so a non-admin employee can NEVER get a shell.
 *
 * Trust model (3 hops, secret never reaches the browser):
 *   HOP 1 browser->Vercel: same-origin Supabase session cookie auths the
 *         proxy. The widget adds NO Authorization header.
 *   HOP 2 Vercel resolves identity server-side from user_profiles by
 *         user.id (tenant_id, team_role, is_owner, email). Browser-supplied
 *         tenant_id/team_role/user_id are IGNORED. FAIL CLOSED to read_only.
 *   HOP 3 Vercel->VPS: forwards to ${baseUrl}/chat with a server-only Bearer
 *         token (BRIDGE_BEARER_TOKEN, never NEXT_PUBLIC). The bridge proves
 *         the request came from the proxy via the bearer, then trusts the
 *         forwarded {tenant_id, user_id, team_role, disallowed_tools}.
 *
 * The disallowed_tools list (computed server-side from the DB role) becomes
 * the claude CLI `--disallowed-tools` spawn flag on the VPS — the hard wall.
 */

import { NextRequest } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { bridgeDisallowedToolsForRole } from "@/lib/role-gates";
import { authorizeBridgeRequest } from "@/lib/bridge-proxy";
import { validateBridgeAgent } from "@/lib/agent-roots";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Vercel plan caps maxDuration as a HARD validation at build time (not
// a silent runtime cap). Hobby = 60s, Pro = 300s, Pro+Fluid Compute =
// 800s. CC upgraded to Fluid Compute 2026-06-11, so this can ride at
// 800s — ~13 min — which covers every Solara operation observed
// in production so far (Mamaws underwriting + exploration sequence
// took ~10 min in the VPS-side test). For anything genuinely longer
// than 13 min, route the chat SSE directly through the Cloudflare
// tunnel to the VPS bridge, bypassing this Vercel function entirely.
export const maxDuration = 800;

// Body-size + attachment caps — an authed employee must not be able to push
// unbounded payloads to the VPS spawn. Mirrors the /api/chat attachment cap
// (MAX_ATTACHMENTS_PER_TURN=5 in ChatWidget) and adds a hard byte ceiling
// (/api/chat has no explicit one but is bounded by Vercel's 4.5MB request
// limit; we pull it in tighter for the spawn path).
const MAX_BODY_BYTES = 1_000_000; // 1 MB of JSON
const MAX_ATTACHMENTS = 5;
const MAX_MESSAGES = 200;

type IncomingBody = {
  agent?: string;
  messages?: Array<{ role?: string; content?: string }>;
  session_id?: string | null;
  tab_id?: string;
  cli_provider?: string;
  chat_mode?: string;
  attachments?: Array<{ id?: string }>;
  // tenant_id / team_role / user_id / disallowed_tools, if present, are
  // IGNORED — we always derive them server-side and let the server fields
  // win in the forwarded body.
  [k: string]: unknown;
};

export async function POST(req: NextRequest) {
  // ---- Body-size guard BEFORE parse ----------------------------------------
  // content-length is advisory (a client can lie / omit it) but it's a cheap
  // first cut; the post-parse structural caps below are the real backstop.
  const declaredLen = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return jsonError(413, "payload_too_large");
  }

  let clientBody: IncomingBody;
  let rawText: string;
  try {
    rawText = await req.text();
  } catch {
    return jsonError(400, "invalid_body");
  }
  if (rawText.length > MAX_BODY_BYTES) {
    return jsonError(413, "payload_too_large");
  }
  try {
    clientBody = JSON.parse(rawText) as IncomingBody;
  } catch {
    return jsonError(400, "invalid_json");
  }

  // ---- Validate the client-supplied shape (same checks as /api/chat) -------
  const messages = Array.isArray(clientBody.messages) ? clientBody.messages : [];
  if (messages.length === 0) return jsonError(400, "no_messages");
  if (messages.length > MAX_MESSAGES) return jsonError(400, "too_many_messages");
  const lastUserMsg = [...messages].reverse().find((m) => m && m.role === "user");
  if (!lastUserMsg || !String(lastUserMsg.content || "").trim()) {
    return jsonError(400, "no_user_message");
  }
  const attachments = Array.isArray(clientBody.attachments) ? clientBody.attachments : [];
  if (attachments.length > MAX_ATTACHMENTS) return jsonError(400, "too_many_attachments");

  // cli_provider gate — same allowlist /api/chat (and the bridge) enforce.
  const cliProvider = String(clientBody.cli_provider || "claude").toLowerCase();
  if (!["claude", "codex", "gemini"].includes(cliProvider)) {
    return jsonError(400, "invalid_cli_provider");
  }

  // ---- Pin the agent server-side -------------------------------------------
  // Slug is validated AFTER tenant resolution below (one helper, both gates).
  // The body-size + cli_provider checks above already filter the bulk of
  // malformed requests, so deferring agent validation past the auth path
  // costs nothing measurable and keeps the security check centralized.
  const agent = String(clientBody.agent || "").trim().toLowerCase();

  // ---- HOPs 1-3: auth + tenant gate + bridge target (shared helper) --------
  // Consolidated 2026-06-10 — used to inline ~60 lines duplicating
  // authorizeBridgeRequest. Same gate logic, single source of truth. Any
  // change to the security boundary (slug==='submissions' OR isOperator,
  // fail-closed teamRole='read_only', etc.) now lives in one file —
  // lib/bridge-proxy.ts — instead of two. The /chat-reset + /prewarm
  // routes already use this helper; bringing /chat into line eliminates
  // the privilege-escalation-via-drift bug class.
  const auth = await authorizeBridgeRequest();
  if (!auth.ok) return jsonError(auth.status, auth.error);

  // ---- Agent allowlist (both gates: known-universe + tenant-specific) ------
  const agentCheck = validateBridgeAgent(agent, auth.tenantSlug);
  if (!agentCheck.ok) return jsonError(agentCheck.status, agentCheck.error);

  // ---- Per-tenant rate limit (same shape as /api/chat) ---------------------
  const limit = rateLimit({ key: `bridge-chat:${auth.tenantId}`, capacity: 30, refillPerSec: 1 / 15 });
  if (!limit.allowed) {
    return new Response(
      JSON.stringify({ ok: false, error: "rate_limited", retry_in_sec: limit.resetIn }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": String(limit.resetIn) } },
    );
  }

  // ---- Compute role-derived disallowed tools (server-side) -----------------
  const disallowedTools = bridgeDisallowedToolsForRole(auth.teamRole);

  // Confine non-privileged roles to Claude Code — the ONLY runtime whose
  // --disallowed-tools spawn flag enforces the no-shell wall. Codex/Gemini
  // have no equivalent spawn-time tool boundary, so a member who selected them
  // could bypass the gate entirely (Codex audit P1). Force claude for anyone
  // who isn't owner/admin; owner/admin already get the full toolset, so their
  // runtime choice is unrestricted. The server value wins in the forward body.
  const isPrivileged = auth.teamRole === "owner" || auth.teamRole === "admin";
  const effectiveCliProvider = isPrivileged ? cliProvider : "claude";

  // ---- HOP 3: forward to the VPS bridge ------------------------------------
  // Server fields WIN in the spread — any tenant_id/team_role/user_id/
  // disallowed_tools the browser tried to inject is overwritten here.
  const forwardBody = {
    ...clientBody,
    agent, // pinned
    cli_provider: effectiveCliProvider, // forced to claude for non-owner/admin
    tenant_id: auth.tenantId,
    user_id: auth.userId,
    team_role: auth.teamRole,
    disallowed_tools: disallowedTools,
  };

  // Tie the upstream fetch to the client connection so a browser disconnect
  // aborts the VPS spawn (the bridge's emit() then hits a broken pipe and
  // stops). req.signal fires on client abort.
  let upstream: Response;
  try {
    upstream = await fetch(`${auth.target.baseUrl}/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth.target.bearerToken}`,
      },
      body: JSON.stringify(forwardBody),
      signal: req.signal,
    });
  } catch {
    return jsonError(502, "bridge_unreachable");
  }

  // ---- Transparent SSE relay ----------------------------------------------
  // Pass upstream.body (a ReadableStream) straight through — no JSON parse,
  // no re-encode, so every bridge SSE frame reaches the widget byte-identical.
  // The bearer is NOT echoed in any response header.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
