/**
 * GET /api/bridge/health
 *
 * Authed health probe for the VPS bridge. The ChatWidget probes this
 * (same-origin) in proxy mode instead of hitting the VPS directly, so the
 * browser never touches the VPS and never needs the bearer.
 *
 * Auth: requires a logged-in Supabase user (an anon visitor must not be able
 * to fingerprint the VPS). Resolves the tenant + bridge target server-side,
 * forwards to ${baseUrl}/health WITH the server-only bearer, returns a
 * structured JSON body that names the exact failure mode when degraded.
 *
 * Response shape (always JSON, always 200 OR 401):
 *   {
 *     ok: boolean,
 *     reason: string,        // "ok" on success, machine-readable cause on failure
 *     detail: string | null, // human-readable hint pointing at the fix
 *   }
 *
 * Failure modes (reason values):
 *   - "unauthenticated"      — no session cookie (anon hit). HTTP 401.
 *   - "no_profile"           — session exists but no user_profiles row.
 *   - "no_tenant"            — profile exists but profile.tenant_id is empty.
 *   - "tenant_lookup_failed" — Supabase blew up on tenant fetch.
 *   - "bridge_not_enabled_for_tenant" — tenant.slug !== 'submissions' and
 *                              the user isn't an operator. By design.
 *   - "bridge_not_configured" — BRIDGE_VPS_URL or BRIDGE_BEARER_TOKEN unset.
 *                              THIS is the encryption-rotation footgun.
 *   - "vps_timeout"          — Vercel reached the URL but the VPS didn't
 *                              respond within 1500ms (Cloudflare Tunnel
 *                              flapping, daemon hung, etc).
 *   - "vps_unauthorized"     — VPS returned 401. Bearer mismatch.
 *   - "vps_upstream_error"   — VPS returned non-2xx other than 401.
 *   - "vps_unreachable"      — fetch threw (DNS, TCP RST, TLS error).
 *
 * Why the shape change: a bare 503 with no body forced operators to guess
 * which leg of (auth → env → network → upstream) was broken. Surfacing the
 * exact reason lets the dropdown tooltip name the fix and lets future
 * Bravo / Codex / VPS-agent rounds skip the diagnostic guessing.
 *
 * The widget treats `ok=true` as "use the bridge"; anything else as offline.
 * The reason field is also exposed to the dropdown so the operator can see
 * "bridge_not_configured" instead of just "(bridge offline)".
 */

import { authorizeBridgeRequest } from "@/lib/bridge-proxy";
import {
  type BridgeHealthReason,
  isBridgeHealthReason,
} from "@/lib/bridge-health-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REASON_DETAIL: Record<BridgeHealthReason, string | null> = {
  ok: null,
  unauthenticated: "Sign in to probe the bridge.",
  no_profile:
    "Your user has no profile row. Contact the operator to provision one.",
  no_tenant:
    "Your profile has no tenant binding. Contact the operator.",
  profile_lookup_failed:
    "Supabase user_profiles lookup failed. Check the Vercel function logs and Supabase project health — this is a database availability issue, not a VPS networking issue.",
  tenant_lookup_failed:
    "Supabase tenant lookup failed. Check the Vercel function logs.",
  bridge_not_enabled_for_tenant:
    "This tenant doesn't have bridge access. Operator-only by default.",
  bridge_not_configured:
    "BRIDGE_VPS_URL and/or BRIDGE_BEARER_TOKEN env vars are unset on Vercel. Set both in Project Settings -> Environment Variables (Production), then redeploy.",
  vps_timeout:
    "VPS didn't answer the proxy in 1500ms. Check Cloudflare Tunnel status on the VPS and pm2 status of the claude-bridge daemon.",
  vps_unauthorized:
    "VPS returned 401 — Vercel's BRIDGE_BEARER_TOKEN doesn't match the value the daemon expects. Re-sync the two .env values.",
  vps_upstream_error:
    "VPS returned a 5xx — the daemon is running but unhealthy. Tail the pm2 logs for claude-bridge.",
  vps_unreachable:
    "Couldn't reach the VPS at all (DNS, TCP, or TLS error). Verify BRIDGE_VPS_URL points at a live hostname.",
};

function payload(reason: BridgeHealthReason) {
  return {
    ok: reason === "ok",
    reason,
    detail: REASON_DETAIL[reason],
  };
}

function json(reason: BridgeHealthReason, status: number = 200) {
  return new Response(JSON.stringify(payload(reason)), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export async function GET() {
  const auth = await authorizeBridgeRequest();
  if (!auth.ok) {
    // 401 for anon; structured body for every other failure so the UI can
    // surface the exact reason. r.ok is false either way.
    // Validated narrow via isBridgeHealthReason so a renamed auth.error
    // string can't sneak past the type. Unknown errors collapse to
    // vps_unreachable, which is the closest "generic upstream failure" code.
    const errStr = auth.error;
    const reason: BridgeHealthReason = isBridgeHealthReason(errStr)
      ? errStr
      : "vps_unreachable";
    return json(reason, auth.status === 401 ? 401 : 200);
  }
  try {
    const r = await fetch(`${auth.target.baseUrl}/health`, {
      headers: { authorization: `Bearer ${auth.target.bearerToken}` },
      signal: AbortSignal.timeout(1500),
    });
    if (r.ok) return json("ok");
    if (r.status === 401) return json("vps_unauthorized");
    return json("vps_upstream_error");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    // AbortSignal.timeout throws DOMException with name 'TimeoutError'.
    // node-fetch throws an Error with name 'AbortError' for the same case.
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError" || /timeout/i.test(msg)) {
      return json("vps_timeout");
    }
    return json("vps_unreachable");
  }
}
