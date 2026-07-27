/**
 * Server-only bridge proxy resolver.
 *
 * SECURITY: this module is the single server-side home for the VPS bridge
 * bearer secret. It is imported ONLY by the /api/bridge/* route handlers
 * (chat, health, prewarm, chat-reset) which all run on the Node.js runtime.
 * It MUST NOT be imported by any client component.
 *
 * The secret reads from process.env.BRIDGE_BEARER_TOKEN (NOT NEXT_PUBLIC_*),
 * so Next.js never inlines it into the client bundle. NEXT_PUBLIC_BRIDGE_CHAT_BASE
 * (lib/agent-roots.ts) is a separate, public, build-time mode-switch label that
 * carries NO secret — see docs in that file.
 *
 * Companion enforcement lives in CEO-Agent/bravo_cli/bridge_chat_server.py:
 * when BRIDGE_BEARER_TOKEN is set on the VPS the bridge requires a matching
 * `Authorization: Bearer <token>` on EVERY endpoint (constant-time compare).
 */

import "server-only";

// Pure resolution rules + types live in bridge-target-resolver.ts so tests
// can import them without triggering this file's server-only guard. The
// re-exports here mean route handlers continue to import from "@/lib/bridge-proxy"
// exactly as before.
import {
  resolveBridgeTarget as _resolveBridgeTarget,
  type BridgeTarget as _BridgeTarget,
} from "./bridge-target-resolver";
import { bridgeExecToolAllowedForRole } from "./role-gates";
import { CLAIR_TOOL_NAME, clairCapabilityError, type ClairSession } from "./clair/capability";

export type BridgeTarget = _BridgeTarget;
export const resolveBridgeTarget = _resolveBridgeTarget;

/** True when the server is configured to proxy to a VPS bridge (global default). */
export function isBridgeProxyEnabled(): boolean {
  return Boolean(process.env.BRIDGE_VPS_URL && process.env.BRIDGE_BEARER_TOKEN);
}

/**
 * Single source of truth for "can this user control VPS daemons for this tenant"
 * — used by BOTH the read path (GET background-workers, to decide whether to
 * show Start/Stop/Restart) and conceptually mirrors the write path (POST
 * .../control, which gates on authorizeBridgeRequest → resolveBridgeTarget +
 * bridgeExecToolAllowedForRole(role,"bash")).
 *
 * Codex audit 2026-06-17 [medium]: the GET path previously decided eligibility
 * with `isBridgeProxyEnabled()` (global env only) + a hand-rolled owner/admin
 * check, while POST resolved the actual target via resolveBridgeTarget(). For
 * SunBiz ('submissions') those coincide today, but the predicates could drift
 * (e.g. a future per-tenant bridge_url tenant), showing buttons that 503 or
 * hiding buttons POST would allow. Routing both through this helper makes the
 * displayed control state provably match what POST will accept.
 *
 *   - targetConfigured: the SAME resolveBridgeTarget() POST uses (handles both
 *     the global SunBiz env AND a per-tenant bridge_url + BRIDGE_BEARER_TOKEN_<SLUG>).
 *   - roleAllowed: the SAME bridgeExecToolAllowedForRole(role,"bash") gate POST
 *     applies (owner/admin only — bouncing a prod daemon is shell-tier).
 */
export function bridgeControlEligibility(
  tenant: { slug: string; custom_fields: Record<string, unknown> | null } | null,
  teamRole: string | null | undefined,
): { targetConfigured: boolean; roleAllowed: boolean } {
  return {
    targetConfigured: tenant ? resolveBridgeTarget(tenant) !== null : false,
    roleAllowed: bridgeExecToolAllowedForRole(teamRole, "bash"),
  };
}

export type BridgeExecResult = {
  /** True when the HTTP call succeeded AND the bridge tool did not error. */
  ok: boolean;
  /** The bridge's is_error flag. */
  isError: boolean;
  /** The bridge tool's `output` string (callers parse this — e.g. the
   *  send_gateway JSON blob, or pm2's stdout). Empty string when absent. */
  output: string;
  /** The bridge's structured error, if any. */
  error?: string;
  /** Upstream HTTP status (0 when the fetch threw before a response). */
  httpStatus: number;
};

/**
 * Single transport for the VPS bridge `/exec-tool` endpoint from trusted
 * server code. Callers pass an already-resolved target (from
 * authorizeBridgeRequest for session routes, or resolveBridgeTarget for public
 * server-to-server sends) plus the full tool body; this POSTs it with the
 * server bearer and normalizes the bridge's response envelope so each caller
 * only interprets `output`. Never throws — failures return { ok:false, ... }.
 *
 * This is the ONE home for the "POST the raw bridge with the bearer" shape,
 * shared by the worker-control proxy (bash / pm2) and the form handoff email
 * (send_email). NOT used by /api/bridge/exec-tool, which is the session-gated
 * BROWSER proxy (role gate + rate limit + raw response passthrough).
 */
export async function callBridgeExecTool(
  target: BridgeTarget,
  body: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<BridgeExecResult> {
  // CLEAR CAPABILITY GATE — fails closed BEFORE the network call, so a
  // regulated, billable query cannot be spent by a caller with no operator
  // behind it. This is deliberately here, in the one transport every bridge
  // caller shares, rather than only in the clair-report route: the session-less
  // resolveBridgeTarget() + callBridgeExecTool() shape is already used by
  // lib/underwriting/run.ts and lib/forms/next-steps-email.ts, and a future cron
  // copying it is exactly how CLEAR would become automatic by accident. It
  // matches on the resolved tool_name, so it holds regardless of how the caller
  // spelled it (Codex review 2026-07-27 [P2]).
  //
  // The identity is resolved HERE, from the request cookies — never read out of
  // `body`. Attribution a caller writes about itself is not authorization
  // (Codex review 2026-07-27 [P1]); a cron passing requested_by:"system" must
  // not be able to satisfy this. Anything that throws (no request scope, no
  // cookie store, a broken auth call) is treated as "no operator" and denied.
  if (body?.tool_name === CLAIR_TOOL_NAME) {
    let session: ClairSession = null;
    try {
      const { getSessionUser } = await import("@/lib/supabase-server");
      const user = await getSessionUser();
      session = user ? { userId: user.id, email: user.email ?? null } : null;
    } catch {
      session = null; // fail closed
    }
    const clairError = clairCapabilityError(body, session);
    if (clairError) {
      return { ok: false, isError: true, output: "", error: clairError, httpStatus: 0 };
    }
  }
  try {
    const res = await fetch(`${target.baseUrl}/exec-tool`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${target.bearerToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 20_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      output?: string;
      is_error?: boolean;
      error?: string;
    };
    return {
      ok: res.ok && data.ok !== false && data.is_error !== true,
      isError: data.is_error === true,
      output: typeof data.output === "string" ? data.output : "",
      error: data.error,
      httpStatus: res.status,
    };
  } catch (e) {
    return {
      ok: false,
      isError: true,
      output: "",
      error: e instanceof Error ? e.message : "bridge_unreachable",
      httpStatus: 0,
    };
  }
}

/**
 * Shared authorization for ALL bridge proxy routes (chat, health, prewarm,
 * chat-reset). Resolves the authenticated user's tenant SERVER-SIDE, applies
 * the SunBiz tenant gate (slug==='submissions' OR operator), and resolves the
 * VPS target. /chat was inlined for "visibility in one file" until 2026-06-10
 * when it was consolidated through this helper — divergence-prevention beats
 * inline visibility for a security-critical path.
 *
 * Returns a discriminated result so callers can map each outcome to the right
 * status. FAIL CLOSED on any lookup error (treated as 403, not "allow").
 */
export type BridgeAuthResult =
  | {
      ok: true;
      target: BridgeTarget;
      tenantId: string;
      tenantSlug: string;
      userId: string;
      teamRole: string;
      /** True for the empire operator (CC) bypassing the tenant gate — as
       *  opposed to an authenticated SunBiz tenant member. B4 (2026-07-23):
       *  the worker-owner control gate (background-workers/control/route.ts)
       *  uses this to resolve "cc" vs "adon" actor side when neither party
       *  has a per-user identity column on this table. */
      isOperator: boolean;
    }
  | { ok: false; status: number; error: string };

export async function authorizeBridgeRequest(): Promise<BridgeAuthResult> {
  // Imported lazily to keep this module's import graph small for the /chat
  // route, which does not call this function.
  const { getServiceSupabase, getSessionUser } = await import("@/lib/supabase-server");
  const { isOperatorEmail } = await import("@/lib/operator-credentials");

  const user = await getSessionUser();
  if (!user) return { ok: false, status: 401, error: "unauthenticated" };

  const svc = getServiceSupabase();
  let tenantId = "";
  let teamRole = "read_only"; // fail-closed default (least privilege)
  let email: string | null = user.email ?? null;
  try {
    const opRow = await svc
      .from("user_profiles")
      .select("tenant_id, team_role, is_owner, admin_access, email")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    const op = opRow.data as
      | {
          tenant_id: string | null;
          team_role: string | null;
          is_owner: boolean | null;
          admin_access: boolean | null;
          email: string | null;
        }
      | null;
    if (!op) return { ok: false, status: 403, error: "no_profile" };
    tenantId = String(op.tenant_id || "");
    teamRole = (op.team_role || "read_only").trim().toLowerCase();
    if (op.is_owner === true && teamRole !== "owner" && teamRole !== "admin") {
      teamRole = "owner";
    }
    // admin_access toggle → promote to admin-equivalent so every downstream
    // role gate (bridgeExecToolAllowedForRole, bridgeDisallowedToolsForRole:
    // bash/write/pm2) treats a toggled agent as a full admin. Mirrors the
    // is_owner promotion above. Admin-toggle design, 2026-07-07.
    if (op.admin_access === true && teamRole !== "owner" && teamRole !== "admin") {
      teamRole = "admin";
    }
    if (op.email) email = op.email;
  } catch {
    return { ok: false, status: 403, error: "profile_lookup_failed" };
  }
  if (!tenantId) return { ok: false, status: 403, error: "no_tenant" };

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
    return { ok: false, status: 403, error: "tenant_lookup_failed" };
  }
  if (tenantRow.slug !== "submissions" && !isOperator) {
    return { ok: false, status: 403, error: "bridge_not_enabled_for_tenant" };
  }

  const target = resolveBridgeTarget(tenantRow);
  if (!target) return { ok: false, status: 503, error: "bridge_not_configured" };
  return {
    ok: true,
    target,
    tenantId,
    tenantSlug: tenantRow.slug,
    userId: user.id,
    teamRole,
    isOperator,
  };
}
