/**
 * Mirror of bravo_cli/agent_roots.py for dashboard awareness.
 *
 * The dashboard doesn't need to RESOLVE these paths (the bridge does that
 * locally). It just needs to know the canonical layout so it can show the
 * operator which agents would be paired locally if they ran the bridge.
 */

export const AGENT_REPO_HINTS: Record<string, string> = {
  bravo: "~/Business-Empire-Agent",
  atlas: "~/APPS/CFO-Agent",
  maven: "~/CMO-Agent",
  aura: "~/AURA",
  hermes: "~/hermes",
  "life-preservation": "~/life-preservation",
  // SunBiz: the chat targets the `solara`/`helios` personas; both live in the
  // SunBiz repo (~/SunBiz-Agent dev, /srv/sunbiz/sunbiz-agent on the VPS).
  sunbiz: "~/SunBiz-Agent",
  solara: "~/SunBiz-Agent",
  helios: "~/SunBiz-Agent",
};

/**
 * Agent allowlist for the same-origin /api/bridge/* proxy routes.
 *
 * SunBiz tenant (slug='submissions') only ever speaks to the two SunBiz
 * personas — locking the allowlist here prevents a SunBiz employee from
 * requesting `agent:'bravo'` and reaching a co-deployed agent repo if any
 * ever ends up on the shared VPS.
 *
 * Every other tenant — today: the operator's personal OASIS tenant (CC,
 * conaugh@oasisai.work) — gets the full operator-family allowlist. The
 * 2026-06-09 bug this fixes: CC selected Bravo + Gemini CLI from his
 * personal OASIS Command Center, the proxy 400'd with `invalid_agent`
 * because the constant was hardcoded SunBiz-only.
 */
export const SUNBIZ_BRIDGE_AGENTS: ReadonlySet<string> = new Set([
  "solara",
  "helios",
]);

export const OASIS_BRIDGE_AGENTS: ReadonlySet<string> = new Set([
  "bravo",
  "atlas",
  "maven",
  "aura",
  "hermes",
  "life-preservation",
]);

/**
 * Return the allowlist for the authenticated request's tenant.
 *
 * Tenant gating BEFORE this allowlist already ensures only CC (the
 * operator) can hit non-SunBiz bridges, so widening the allowlist for
 * non-SunBiz tenants is safe — a random tenant cannot request agent=bravo
 * because the upstream `slug==='submissions' OR isOperator` gate rejects
 * them before this allowlist is consulted.
 */
export function allowedBridgeAgentsForTenant(
  tenantSlug: string,
): ReadonlySet<string> {
  if (tenantSlug === "submissions") return SUNBIZ_BRIDGE_AGENTS;
  return OASIS_BRIDGE_AGENTS;
}

/**
 * Universe of valid bridge agent slugs across all tenants. Defense-in-depth
 * before tenant resolution: a malformed/unknown slug fails fast without a
 * tenant DB lookup. Per-tenant restriction is enforced separately via
 * allowedBridgeAgentsForTenant.
 */
export const KNOWN_BRIDGE_AGENTS: ReadonlySet<string> = new Set([
  ...SUNBIZ_BRIDGE_AGENTS,
  ...OASIS_BRIDGE_AGENTS,
]);

export type BridgeAgentValidation =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Validate that an agent slug is BOTH (a) known to the proxy at all AND
 * (b) permitted for this tenant. Centralizes the two-tier security check
 * the /api/bridge/* routes (chat, chat-reset, prewarm) all need to apply
 * identically — extracting it here prevents divergence between routes
 * (which would be a privilege-escalation bug class).
 */
export function validateBridgeAgent(
  agent: string,
  tenantSlug: string,
): BridgeAgentValidation {
  if (!KNOWN_BRIDGE_AGENTS.has(agent)) {
    return { ok: false, status: 400, error: "invalid_agent" };
  }
  if (!allowedBridgeAgentsForTenant(tenantSlug).has(agent)) {
    return { ok: false, status: 400, error: "agent_not_enabled_for_tenant" };
  }
  return { ok: true };
}

/** Endpoint the bridge serves chat from. Defaults to the local desktop bridge,
 *  but reads NEXT_PUBLIC_BRIDGE_CHAT_BASE so a hosted deploy (e.g. the SunBiz
 *  VPS bridge behind nginx/TLS) can point every employee's browser at the shared
 *  always-on bridge instead of their own localhost. Mirrors BridgeCliPanel.tsx. */
export const BRIDGE_CHAT_BASE =
  process.env.NEXT_PUBLIC_BRIDGE_CHAT_BASE || "http://127.0.0.1:9100";
