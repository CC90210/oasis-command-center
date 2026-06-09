/**
 * Shared types for /api/bridge/health.
 *
 * Both the route handler (server) and the ChatWidget probe (client) import
 * these so a rename or addition stays in lockstep across the boundary.
 * Without this file, the route can rename a reason code and the widget
 * silently keeps trying to display the old code (no compile error).
 *
 * The reason set is finite and meaningful — each value names a distinct
 * failure mode the operator can act on. Add new reasons in lockstep with
 * route changes; never inline a free-form string at the call site.
 */

export const BRIDGE_HEALTH_REASONS = [
  "ok",
  "unauthenticated",
  "no_profile",
  "no_tenant",
  "tenant_lookup_failed",
  "bridge_not_enabled_for_tenant",
  "bridge_not_configured",
  "vps_timeout",
  "vps_unauthorized",
  "vps_upstream_error",
  "vps_unreachable",
] as const;

export type BridgeHealthReason = (typeof BRIDGE_HEALTH_REASONS)[number];

export type BridgeHealthResponse = {
  ok: boolean;
  reason: BridgeHealthReason;
  detail: string | null;
};

export function isBridgeHealthReason(s: string): s is BridgeHealthReason {
  return (BRIDGE_HEALTH_REASONS as readonly string[]).includes(s);
}
