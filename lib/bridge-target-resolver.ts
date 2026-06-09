/**
 * Pure (no Supabase, no server-only) bridge target resolution.
 *
 * Extracted from lib/bridge-proxy.ts so the resolution rules (which are
 * the security-critical boundary between tenants) can be unit-tested
 * without importing the `server-only` shim that throws at runtime
 * outside Next.js's webpack alias.
 *
 * lib/bridge-proxy.ts re-exports resolveBridgeTarget + BridgeTarget from
 * here AFTER its `import "server-only"` directive — so route handlers
 * still get the boundary protection, while tests can import directly
 * from this file.
 */

export type BridgeTarget = {
  /** e.g. "https://bridge.oasisai.work". No trailing slash. */
  baseUrl: string;
  /** Shared secret; transmitted ONLY on the Vercel->VPS leg. Never returned to a browser. */
  bearerToken: string;
};

/**
 * Tenants whose bridge can use the global BRIDGE_VPS_URL/BRIDGE_BEARER_TOKEN
 * env vars. Today: only SunBiz ('submissions'). Every other tenant must
 * have an explicit tenant.custom_fields.bridge_url, otherwise this
 * resolver fails closed (no silent SunBiz fallback).
 *
 * Codex finding 2026-06-10 [high]: prior to this restriction, a non-
 * SunBiz operator tenant (e.g. CC's personal OASIS) with no per-tenant
 * bridge_url would silently get forwarded to the SunBiz VPS using the
 * SunBiz bearer. That accidentally worked for Bravo (CEO-Agent is
 * cohabited at /srv/sunbiz/ceo-agent) but is architecturally wrong —
 * the SunBiz bearer is a SunBiz secret. Tightening this surfaces 503
 * bridge_not_configured instead of silently bleeding tenants.
 */
const GLOBAL_FALLBACK_TENANT_SLUGS: ReadonlySet<string> = new Set(["submissions"]);

/**
 * Resolve the bridge target for a tenant.
 *
 * Resolution precedence:
 *   1. tenant.custom_fields.bridge_url is set:
 *      - URL must be https:// (defense-in-depth — never POST a bearer
 *        over plaintext)
 *      - Bearer is read ONLY from `BRIDGE_BEARER_TOKEN_<SLUG_UPPER>`.
 *        The env-var name is NOT configurable from tenants.custom_fields
 *        (Codex finding 2026-06-10 [high]: a tenant-controllable
 *        `bridge_bearer_token_env` could otherwise point at the SunBiz
 *        bearer and exfiltrate it to the tenant's URL).
 *      - If the token env var is missing → fail closed (null). Caller
 *        surfaces bridge_not_configured. Do NOT silently fall through
 *        to the global default.
 *   2. Otherwise (no per-tenant URL):
 *      - Only `submissions` (SunBiz) can use the global BRIDGE_VPS_URL
 *        + BRIDGE_BEARER_TOKEN. Every other tenant fails closed here.
 *      - This is the boundary that keeps the SunBiz bearer from being
 *        used as cross-tenant glue.
 *
 * Security: secrets never go in tenants.custom_fields. Only the URL.
 * The bearer name is derived from the slug, not from the row, so a
 * compromised row cannot redirect which env var is consulted.
 *
 * Returns null when no URL+token pair resolves — callers map null to a
 * 503 (chat) or {ok:false} fallback (health).
 */
export function resolveBridgeTarget(
  tenant: { slug: string; custom_fields: Record<string, unknown> | null },
  env: NodeJS.ProcessEnv = process.env,
): BridgeTarget | null {
  // Per-tenant override path (the OASIS-portal-targets-CC's-home case).
  const cf = tenant.custom_fields ?? {};
  const tenantUrl = typeof cf.bridge_url === "string" ? cf.bridge_url.trim() : "";
  if (tenantUrl) {
    // Defense-in-depth: HTTPS only. Without this, a misconfigured
    // bridge_url=http://... would send the bearer token in plaintext
    // over the public internet. fail-closed on the typo.
    if (!/^https:\/\//i.test(tenantUrl)) return null;

    // Bearer env var name is SERVER-DERIVED from the slug — never read
    // from tenants.custom_fields. Codex finding 2026-06-10: letting the
    // row name the env var lets a corrupted row pair its bridge_url with
    // another tenant's bearer (or the global SunBiz bearer), making the
    // proxy send that secret to a tenant-chosen URL.
    //
    // Slug sanitization: any non-[A-Z0-9_] character is replaced with an
    // underscore. POSIX env var names + the Vercel UI's env var form both
    // restrict to that set. Today the upstream slug grammar (SLUG_RE in
    // lib/manifest/wizard-finalize.ts) is [a-z0-9_-], so the only char
    // that actually changes is '-' → '_'. The broader pattern is
    // defense-in-depth: if SLUG_RE is ever loosened (e.g. to allow
    // dots), this code still produces a valid POSIX name. Collision
    // risk between e.g. 'foo-bar' and 'foo.bar' would be the upstream
    // PR's problem to think about — but at least the resolver never
    // produces a malformed env var name silently.
    const tokenEnvName = `BRIDGE_BEARER_TOKEN_${tenant.slug
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "_")}`;
    const tenantToken = env[tokenEnvName];
    if (tenantToken) {
      const baseUrl = tenantUrl.replace(/\/+$/, "");
      if (baseUrl) return { baseUrl, bearerToken: tenantToken };
    }
    // Per-tenant override declared but token env missing → fail closed.
    // The operator was explicit that this tenant uses its own bridge;
    // silently falling back to the global SunBiz bridge would misroute
    // this tenant's traffic AND leak the SunBiz bearer.
    return null;
  }

  // No per-tenant override. ONLY SunBiz can use the global fallback —
  // every other tenant fails closed here. See GLOBAL_FALLBACK_TENANT_SLUGS.
  if (!GLOBAL_FALLBACK_TENANT_SLUGS.has(tenant.slug)) return null;

  const rawUrl = env.BRIDGE_VPS_URL;
  const bearerToken = env.BRIDGE_BEARER_TOKEN;
  if (!rawUrl || !bearerToken) return null;
  const baseUrl = rawUrl.replace(/\/+$/, ""); // strip trailing slash(es)
  if (!baseUrl) return null;
  return { baseUrl, bearerToken };
}
