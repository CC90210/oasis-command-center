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
import { bridgeCliPolicy, type BridgeCliProvider } from "@/lib/bridge-cli-policy";
import { authorizeBridgeRequest } from "@/lib/bridge-proxy";
import { validateBridgeAgent } from "@/lib/agent-roots";
import { teeBridgeChatPersistence } from "@/lib/bridge-chat-persistence";
import { teeBridgeDashboardActions } from "@/lib/admin/bridge-dashboard-actions";

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
  attachments?: Array<{
    id?: string;
    filename?: string;
    mime_type?: string;
    size_bytes?: number;
    parser?: string;
    text_excerpt?: string | null;
  }>;
  // tenant_id / team_role / user_id / disallowed_tools, if present, are
  // IGNORED — we always derive them server-side and let the server fields
  // win in the forwarded body.
  //
  // No catch-all index signature here on purpose (O1, security_rules #14):
  // this type is the allow-list. A client-supplied field this type does not
  // name (a `department` block, say) must fail TO TYPE-CHECK if anyone ever
  // tries to read it off `clientBody`, not silently pass through a spread.
};

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
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
  // Every entry is checked BEFORE the allow-listed projection below reads its
  // fields: `[null, {...}]` used to pass the checks above and then throw an
  // unhandled 500 when the projection read `m.role` (Codex review, O1).
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!messages.every((m) => isObject(m) && typeof m.role === "string" && typeof m.content === "string")) {
    return jsonError(400, "invalid_messages");
  }
  const attachments = Array.isArray(clientBody.attachments) ? clientBody.attachments : [];
  if (attachments.length > MAX_ATTACHMENTS) return jsonError(400, "too_many_attachments");
  if (!attachments.every((a) => isObject(a) && typeof a.id === "string" && a.id.length > 0)) {
    return jsonError(400, "invalid_attachments");
  }

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

  // ---- Role-derived runtime + disallowed tools (server-side) ----------------
  // Non-privileged roles run on Claude Code, the ONLY runtime whose
  // --disallowed-tools spawn flag enforces the no-shell wall (Codex audit P1);
  // owner/admin keep their choice and every tool. One rule shared with the
  // department turns on a CLI engine (lib/bridge-cli-policy.ts). The server
  // value wins in the forward body.
  const { cliProvider: effectiveCliProvider, disallowedTools } = bridgeCliPolicy(
    auth.teamRole,
    cliProvider as BridgeCliProvider,
  );

  // ---- HOP 3: forward to the VPS bridge ------------------------------------
  // ALLOW-LISTED, never a spread of clientBody (O1, security_rules #14: the
  // bridge decodes a `department` block the proxy never verifies). Every key
  // below is one this route already validated or derives itself; an unknown
  // client-supplied key (a `department` block, or anything else) is dropped
  // here, not forwarded to a trust boundary that does not check it. Server
  // fields (agent, cli_provider, tenant_id, user_id, team_role,
  // disallowed_tools) are this route's own values, never the client's.
  const forwardBody = {
    agent, // pinned
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    session_id: clientBody.session_id,
    tab_id: clientBody.tab_id,
    cli_provider: effectiveCliProvider, // forced to claude for non-owner/admin
    chat_mode: clientBody.chat_mode,
    // The six fields ChatWidget sends (components/ChatWidget.tsx attachmentPayload),
    // each kept only when it has its expected type. Before O1 the whole client
    // object was spread through, so the bridge has always received these; an
    // id-only projection silently dropped the file's name and text excerpt.
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: typeof a.filename === "string" ? a.filename : undefined,
      mime_type: typeof a.mime_type === "string" ? a.mime_type : undefined,
      size_bytes: typeof a.size_bytes === "number" ? a.size_bytes : undefined,
      parser: typeof a.parser === "string" ? a.parser : undefined,
      text_excerpt: typeof a.text_excerpt === "string" ? a.text_excerpt : null,
    })),
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

  // ---- SSE relay (+ history persistence tee) -------------------------------
  // The bytes still pass through byte-identical to the widget. On the happy
  // path we additionally TEE the stream (lib/bridge-chat-persistence) to write
  // chat_sessions/chat_messages scoped to (tenant_id, user_id, agent) — without
  // this, bridge/CLI chats (the path SunBiz employees use) never land in the
  // "Previous chats" drawer. The tee only OBSERVES a decoded copy; it never
  // alters the bytes and soft-fails so persistence can't break the relay. The
  // bearer is NOT echoed in any response header.
  const sseHeaders = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
  if (!upstream.ok || !upstream.body) {
    // Error responses (non-2xx) or empty bodies pass straight through — nothing
    // worth persisting, and we don't want to attach a tee to an error stream.
    return new Response(upstream.body, { status: upstream.status, headers: sseHeaders });
  }
  const persistedBody = teeBridgeChatPersistence(upstream.body, {
    tenantId: auth.tenantId,
    userId: auth.userId,
    agent,
    cliProvider: effectiveCliProvider,
    // Stable per-conversation key = the client's tab_id (NOT Claude's per-turn
    // session id, which forks every --resume turn and would shatter history).
    conversationId: String(clientBody.tab_id || ""),
    userMessage: String(lastUserMsg.content || ""),
    startedAt,
  });
  // <dashboard-action> markers in the reply become signed proposals here
  // (2026-09-30), never writes: markers inside code are ignored, and each
  // other one is written only when the operator clicks Apply, then Confirm
  // (POST /api/bridge/actions, which logs it for /runs). Tenant, user and role
  // are this route's own authorization, never the body.
  const withActions = teeBridgeDashboardActions(persistedBody, {
    tenantId: auth.tenantId,
    userId: auth.userId,
    agent,
    teamRole: auth.teamRole,
  });
  return new Response(withActions, { status: upstream.status, headers: sseHeaders });
}

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
