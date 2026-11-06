import { resolveAgentKey } from "@/lib/agents";

export type AgentRosterBinding = {
  slug: string;
  enabled?: boolean;
  core?: boolean;
};

function normalizeAgentSlugs(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = resolveAgentKey(value.trim().toLowerCase());
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Resolve the one enabled-agent roster used throughout a tenant.
 *
 * A resolved tenant manifest is authoritative even when it enables zero
 * agents. `user_profiles.agents_enabled` is only a legacy fallback for a
 * tenant that has no manifest at all; it must never override or re-enable a
 * manifest binding. Core bindings are treated as enabled because the mutation
 * API forbids disabling them and a stale flag should not make an "always on"
 * agent disappear from one surface only.
 */
export function resolveEnabledAgentSlugs(args: {
  manifestAgents: readonly AgentRosterBinding[] | null;
  legacyProfileAgents?: readonly string[] | null;
}): string[] {
  if (args.manifestAgents !== null) {
    return normalizeAgentSlugs(
      args.manifestAgents
        .filter((agent) => agent.core === true || agent.enabled === true)
        .map((agent) => agent.slug),
    );
  }

  return normalizeAgentSlugs(args.legacyProfileAgents || []);
}

/**
 * Resolve the agents one authenticated employee may use.
 *
 * The manifest is the tenant-wide ceiling; `user_profiles.agents_enabled` is
 * the employee's personal allowlist. A normal user receives the intersection
 * of those two lists. This is deliberately different from
 * resolveEnabledAgentSlugs(), which answers the workspace-level question and
 * must not be used as an employee authorization check.
 *
 * A legacy tenant with no manifest remains profile-only. An empty profile is
 * an empty permission set (fail closed). The optional operator bypass is an
 * explicit, pre-authenticated platform-operator lane; callers must only pass
 * it after `isOperatorEmail()` succeeds.
 */
export function resolveUserEnabledAgentSlugs(args: {
  manifestAgents: readonly AgentRosterBinding[] | null;
  profileAgents: readonly string[] | null | undefined;
  operatorBypassAgents?: readonly string[] | null;
}): string[] {
  const profileAgents = normalizeAgentSlugs(args.profileAgents || []);
  const manifestAgents = resolveEnabledAgentSlugs({
    manifestAgents: args.manifestAgents,
  });

  if (args.operatorBypassAgents) {
    return normalizeAgentSlugs([...manifestAgents, ...args.operatorBypassAgents]);
  }

  if (args.manifestAgents === null) return profileAgents;
  const profileAllowed = new Set(profileAgents);
  return manifestAgents.filter((agent) => profileAllowed.has(agent));
}
