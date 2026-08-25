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
