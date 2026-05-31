/**
 * lib/role-agent-defaults.ts — per-team-role default agent palette.
 *
 * SunBiz product decision #5 (TOMORROW.md). When a new user is
 * provisioned (invite redeem, profile bootstrap) and the seeded
 * agents_enabled is empty, the role-based default kicks in instead
 * of giving everyone the full palette.
 *
 * Rationale:
 *   - owner / admin     full visibility, both Solara + Helios
 *   - loan_officer      both — does outreach AND funding ops
 *   - processor         Solara only — funding ops, no sales voice
 *   - read_only         Solara (read-only mode at runtime)
 *   - member            Solara only (conservative default)
 *
 * Tenants without a per-role policy fall through to the manifest's
 * "enabled and primary" agent slug as a single-agent default — keeps
 * legacy / non-SunBiz tenants working without per-tenant config.
 */

import type { TeamRole } from "@/lib/team";
import type { TenantManifest } from "@/lib/manifest/schema";

const SUNBIZ_BY_ROLE: Record<TeamRole, string[]> = {
  owner: ["solara", "helios"],
  admin: ["solara", "helios"],
  loan_officer: ["solara", "helios"],
  processor: ["solara"],
  read_only: ["solara"],
  member: ["solara"],
};

const OASIS_BY_ROLE: Record<TeamRole, string[]> = {
  owner: ["bravo", "atlas", "maven", "aura"],
  admin: ["bravo", "atlas", "maven", "aura"],
  loan_officer: ["bravo"],
  processor: ["bravo"],
  read_only: ["bravo"],
  member: ["bravo"],
};

const POLICY_BY_TENANT_SLUG: Record<string, Record<TeamRole, string[]>> = {
  sun: SUNBIZ_BY_ROLE,
  submissions: SUNBIZ_BY_ROLE,
  "oasis-ai-cc": OASIS_BY_ROLE,
};

/**
 * Returns the default agent palette for (tenantSlug, role). Empty
 * array means "fall through to the tenant manifest's primary agent."
 * Callers that already have agents_enabled set on the profile should
 * keep that — this helper is for the FIRST-time provisioning path.
 */
export function defaultAgentsForRole(args: {
  tenantSlug: string | null;
  role: TeamRole | null;
  manifest: TenantManifest | null;
}): string[] {
  const slug = (args.tenantSlug || "").toLowerCase();
  const role = args.role || "member";
  const policy = POLICY_BY_TENANT_SLUG[slug];
  if (policy) {
    return policy[role] || [];
  }
  // No per-tenant policy: fall back to manifest's enabled primary or
  // the first enabled agent if no primary marked.
  if (args.manifest) {
    const agents = args.manifest.agents || [];
    const primary = agents.find((a) => a.enabled && a.primary);
    if (primary) return [primary.slug];
    const firstEnabled = agents.find((a) => a.enabled);
    if (firstEnabled) return [firstEnabled.slug];
  }
  return [];
}
