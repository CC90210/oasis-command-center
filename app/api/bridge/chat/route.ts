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
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { rateLimit } from "@/lib/rate-limit";
import { bridgeDisallowedToolsForRole } from "@/lib/role-gates";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { resolveBridgeTarget } from "@/lib/bridge-proxy";
import {
  SUNBIZ_BRIDGE_AGENTS,
  OASIS_BRIDGE_AGENTS,
  allowedBridgeAgentsForTenant,
} from "@/lib/agent-roots";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300; // 5 min — matches /api/chat + bridge watchdog ceiling

// Defense-in-depth: the *universe* of valid agent slugs across all tenants.
// Used for the early 400 (fast rejection of malformed/unknown slugs before any
// DB work). The TENANT-SPECIFIC subset is enforced after tenant resolution —
// see allowedBridgeAgentsForTenant. The 2026-06-09 bug: this was a global
// SunBiz-only set, so CC's Bravo chat from his personal OASIS tenant 400'd
// with invalid_agent even though the tenant gate would have admitted him.
const KNOWN_BRIDGE_AGENTS: ReadonlySet<string> = new Set([
  ...SUNBIZ_BRIDGE_AGENTS,
  ...OASIS_BRIDGE_AGENTS,
]);

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
  // ---- HOP 1: same-origin Supabase session ---------------------------------
  const user = await getSessionUser();
  if (!user) return jsonError(401, "unauthenticated");

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
  // Early reject for unknown slugs. The per-tenant subset is enforced after
  // tenant resolution below — that's where SunBiz gets locked to solara/helios
  // and CC's personal OASIS tenant gets the full operator family.
  const agent = String(clientBody.agent || "").trim().toLowerCase();
  if (!KNOWN_BRIDGE_AGENTS.has(agent)) {
    return jsonError(400, "invalid_agent");
  }

  // ---- HOP 2: resolve identity SERVER-SIDE (fail closed) -------------------
  // Mirrors app/api/chat/route.ts:390-457 — default teamRole='read_only'
  // on ANY error so a DB hiccup yields the full disallowed set, never a
  // shell. The browser CANNOT influence tenant/role: we read them from the
  // authenticated user.id only.
  const svc = getServiceSupabase();
  let tenantId = "";
  let teamRole = "read_only"; // fail-closed default (least privilege)
  let email: string | null = user.email ?? null;
  try {
    const opRow = await svc
      .from("user_profiles")
      .select("tenant_id, team_role, is_owner, email")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    const op = opRow.data as
      | {
          tenant_id: string | null;
          team_role: string | null;
          is_owner: boolean | null;
          email: string | null;
        }
      | null;
    if (!op) {
      // No profile row — don't guess a tenant. (Matches the spec: 403, not
      // a silent fallback.) teamRole stays read_only regardless.
      return jsonError(403, "no_profile");
    }
    tenantId = String(op.tenant_id || "");
    // Trust the DB row's team_role; null column on a valid profile means the
    // operator was never assigned a role -> read_only is the right default.
    teamRole = (op.team_role || "read_only").trim().toLowerCase();
    // is_owner promotes to owner power even if team_role column is unset.
    if (op.is_owner === true && teamRole !== "owner" && teamRole !== "admin") {
      teamRole = "owner";
    }
    if (op.email) email = op.email;
  } catch {
    // teamRole stays "read_only" — failure -> safe default. We still need a
    // tenant to gate on; without one we cannot proceed safely.
    return jsonError(403, "profile_lookup_failed");
  }
  if (!tenantId) return jsonError(403, "no_tenant");

  // ---- SunBiz tenant gate --------------------------------------------------
  // The shared VPS bridge is reachable ONLY by the SunBiz ('submissions')
  // tenant OR the platform operator (CC). Every other tenant -> 403, so the
  // bridge can never be reached cross-tenant.
  const isOperator = isOperatorEmail(email);
  let tenantRow: { slug: string; custom_fields: Record<string, unknown> | null };
  try {
    const r = await svc
      .from("tenants")
      .select("slug, custom_fields")
      .eq("id", tenantId)
      .maybeSingle();
    const t = r.data as { slug?: string; custom_fields?: Record<string, unknown> | null } | null;
    tenantRow = { slug: (t?.slug || "").toLowerCase(), custom_fields: t?.custom_fields ?? null };
  } catch {
    return jsonError(403, "tenant_lookup_failed");
  }
  if (tenantRow.slug !== "submissions" && !isOperator) {
    return jsonError(403, "bridge_not_enabled_for_tenant");
  }

  // ---- Per-tenant agent allowlist ------------------------------------------
  // SunBiz tenant is restricted to solara/helios; operator's personal OASIS
  // tenant gets the full operator family (bravo/atlas/maven/aura/hermes/
  // life-preservation). The tenant gate above guarantees only CC reaches the
  // OASIS branch, so widening the allowlist here is safe.
  const tenantAgents = allowedBridgeAgentsForTenant(tenantRow.slug);
  if (!tenantAgents.has(agent)) {
    return jsonError(400, "agent_not_enabled_for_tenant");
  }

  // ---- Resolve the VPS target (server-only secret) -------------------------
  const target = resolveBridgeTarget(tenantRow);
  if (!target) return jsonError(503, "bridge_not_configured");

  // ---- Per-tenant rate limit (same shape as /api/chat) ---------------------
  const limit = rateLimit({ key: `bridge-chat:${tenantId}`, capacity: 30, refillPerSec: 1 / 15 });
  if (!limit.allowed) {
    return new Response(
      JSON.stringify({ ok: false, error: "rate_limited", retry_in_sec: limit.resetIn }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": String(limit.resetIn) } },
    );
  }

  // ---- Compute role-derived disallowed tools (server-side) -----------------
  const disallowedTools = bridgeDisallowedToolsForRole(teamRole);

  // Confine non-privileged roles to Claude Code — the ONLY runtime whose
  // --disallowed-tools spawn flag enforces the no-shell wall. Codex/Gemini
  // have no equivalent spawn-time tool boundary, so a member who selected them
  // could bypass the gate entirely (Codex audit P1). Force claude for anyone
  // who isn't owner/admin; owner/admin already get the full toolset, so their
  // runtime choice is unrestricted. The server value wins in the forward body.
  const isPrivileged = teamRole === "owner" || teamRole === "admin";
  const effectiveCliProvider = isPrivileged ? cliProvider : "claude";

  // ---- HOP 3: forward to the VPS bridge ------------------------------------
  // Server fields WIN in the spread — any tenant_id/team_role/user_id/
  // disallowed_tools the browser tried to inject is overwritten here.
  const forwardBody = {
    ...clientBody,
    agent, // pinned
    cli_provider: effectiveCliProvider, // forced to claude for non-owner/admin
    tenant_id: tenantId,
    user_id: user.id,
    team_role: teamRole,
    disallowed_tools: disallowedTools,
  };

  // Tie the upstream fetch to the client connection so a browser disconnect
  // aborts the VPS spawn (the bridge's emit() then hits a broken pipe and
  // stops). req.signal fires on client abort.
  let upstream: Response;
  try {
    upstream = await fetch(`${target.baseUrl}/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${target.bearerToken}`,
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
