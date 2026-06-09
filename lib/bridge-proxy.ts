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

export type BridgeTarget = {
  /** e.g. "http://10.0.0.5:9100" or the internal nginx TLS hostname. No trailing slash. */
  baseUrl: string;
  /** Shared secret; transmitted ONLY on the Vercel->VPS leg. Never returned to a browser. */
  bearerToken: string;
};

/**
 * Resolve the bridge target for a tenant.
 *
 * Resolution precedence (per-tenant first, then global fallback):
 *   1. tenant.custom_fields.bridge_url is set → that tenant has its own
 *      bridge (e.g. CC's home machine via Cloudflare Tunnel for the OASIS
 *      tenant). Bearer token is read from a tenant-scoped env var whose
 *      name comes from tenant.custom_fields.bridge_bearer_token_env (or
 *      defaults to BRIDGE_BEARER_TOKEN_<SLUG_UPPER>).
 *   2. Otherwise → falls back to the global BRIDGE_VPS_URL + BRIDGE_BEARER_TOKEN
 *      env vars (today's SunBiz VPS path; backward compatible).
 *
 * Security: secrets never go in tenants.custom_fields directly. We store
 * the env var NAME there so the dashboard can be configured by ops, but
 * the actual bearer value lives only in Vercel's encrypted env vars.
 *
 * Returns null when no URL+token pair resolves — callers map null to a
 * 503 (chat) or {ok:false} fallback (health) so the widget degrades to
 * the cloud path instead of hanging.
 */
export function resolveBridgeTarget(
  tenant: { slug: string; custom_fields: Record<string, unknown> | null },
): BridgeTarget | null {
  // Per-tenant override path (the OASIS-portal-targets-CC's-home case).
  const cf = tenant.custom_fields ?? {};
  const tenantUrl = typeof cf.bridge_url === "string" ? cf.bridge_url.trim() : "";
  if (tenantUrl) {
    const tokenEnvName =
      typeof cf.bridge_bearer_token_env === "string" && cf.bridge_bearer_token_env.trim()
        ? cf.bridge_bearer_token_env.trim()
        : `BRIDGE_BEARER_TOKEN_${tenant.slug.toUpperCase()}`;
    const tenantToken = process.env[tokenEnvName];
    if (tenantToken) {
      const baseUrl = tenantUrl.replace(/\/+$/, "");
      if (baseUrl) return { baseUrl, bearerToken: tenantToken };
    }
    // Per-tenant override declared but token env missing → DO NOT fall
    // through to the global default. The operator was explicit that this
    // tenant uses its own bridge; silently failing to a different VPS
    // would route this tenant's traffic to the wrong place. Return null
    // so callers surface bridge_not_configured.
    return null;
  }

  // Global fallback (default SunBiz/operator path).
  const rawUrl = process.env.BRIDGE_VPS_URL;
  const bearerToken = process.env.BRIDGE_BEARER_TOKEN;
  if (!rawUrl || !bearerToken) return null;
  const baseUrl = rawUrl.replace(/\/+$/, ""); // strip trailing slash(es)
  if (!baseUrl) return null;
  return { baseUrl, bearerToken };
}

/** True when the server is configured to proxy to a VPS bridge (global default). */
export function isBridgeProxyEnabled(): boolean {
  return Boolean(process.env.BRIDGE_VPS_URL && process.env.BRIDGE_BEARER_TOKEN);
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
      .select("tenant_id, team_role, is_owner, email")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    const op = opRow.data as
      | { tenant_id: string | null; team_role: string | null; is_owner: boolean | null; email: string | null }
      | null;
    if (!op) return { ok: false, status: 403, error: "no_profile" };
    tenantId = String(op.tenant_id || "");
    teamRole = (op.team_role || "read_only").trim().toLowerCase();
    if (op.is_owner === true && teamRole !== "owner" && teamRole !== "admin") {
      teamRole = "owner";
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
  };
}
