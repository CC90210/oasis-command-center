/**
 * fleet-data — the agent fleet for Admin › Fleet (/admin/agents), moved from
 * the old /agents page (git show 5c374a19:app/agents/page.tsx) when /agents
 * became the AI Team.
 *
 * Same roster rule as before and as the shell (tests/settings-agent-roster):
 * manifest-first through resolveEnabledAgentSlugs, the legacy
 * profile.agents_enabled column only for a workspace with no manifest, and
 * NEVER a fallback to the whole family — that once listed Bravo, Atlas, Maven,
 * Aura and Hermes to every fresh tenant.
 *
 * Liveness reads are done here rather than through lib/queries agentStates /
 * integrationsHealth because both drop `r.error`: a failed read came back as an
 * empty list and every agent rendered "never seen". A fleet page that cannot
 * read heartbeats has to say that, not declare the fleet dead.
 *
 * Dropped from the old page on purpose: the embedded ChatWidget (the power
 * chat is Admin › Agent console, /agent) and the repo stats line, which reads
 * the filesystem and prints zeros on the Worker, where there is no repo.
 */
import "server-only";

import { getActiveProfile } from "@/lib/queries";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTenantManifestForUser } from "@/lib/manifest/tenant-scope";
import { resolveEnabledAgentSlugs } from "@/lib/manifest/agent-roster";
import { FAMILY_AGENT_KEYS } from "@/lib/agents";

/** An agent is "live" if it ticked or pinged in the last 15 minutes. */
export const FLEET_FRESHNESS_MS = 15 * 60 * 1000;

export type FleetSignal = {
  name: string;
  live: boolean;
  lastSignalAt: string | null;
  tickCount: number | null;
};

export type Fleet = {
  agents: string[];
  signals: Map<string, FleetSignal>;
  /** False when either liveness read failed: the page says "unknown", not "never seen". */
  signalsKnown: boolean;
};

/**
 * PURE. Freshest of the state-snapshot tick and the integrations_health ping,
 * per agent. Exported for tests.
 */
export function fleetSignals(
  agents: readonly string[],
  states: ReadonlyArray<{ agent_name: string; last_tick_at: string | null; tick_count: number | null }>,
  pings: ReadonlyArray<{ service: string; last_ping_at: string | null }>,
  now: number,
): Map<string, FleetSignal> {
  const byState = new Map(states.map((s) => [s.agent_name, s]));
  const byPing = new Map(pings.map((p) => [p.service, p]));
  const out = new Map<string, FleetSignal>();
  for (const name of agents) {
    const state = byState.get(name);
    const tick = state?.last_tick_at ? Date.parse(state.last_tick_at) : 0;
    const pingAt = byPing.get(name)?.last_ping_at;
    const ping = pingAt ? Date.parse(pingAt) : 0;
    const freshest = Math.max(Number.isNaN(tick) ? 0 : tick, Number.isNaN(ping) ? 0 : ping);
    out.set(name, {
      name,
      live: freshest > 0 && now - freshest < FLEET_FRESHNESS_MS,
      lastSignalAt: freshest > 0 ? new Date(freshest).toISOString() : null,
      tickCount: state ? Number(state.tick_count ?? 0) : null,
    });
  }
  return out;
}

export async function loadFleet(): Promise<Fleet> {
  const profile = await getActiveProfile();
  const tenantId = profile?.tenant_id ?? null;
  const manifest = await getTenantManifestForUser(tenantId);
  const enabledSlugs = resolveEnabledAgentSlugs({
    manifestAgents: manifest ? manifest.agents || [] : null,
    legacyProfileAgents: profile?.agents_enabled,
  });
  const family = new Set<string>(FAMILY_AGENT_KEYS);
  // As the old page: roster slugs pass through verbatim so a tenant-only custom
  // agent still shows; only the bare legacy column is intersected with the
  // family registry.
  const agents = enabledSlugs.length > 0 ? enabledSlugs : (profile?.agents_enabled || []).filter((k) => family.has(k));
  if (agents.length === 0) return { agents, signals: new Map(), signalsKnown: true };

  const db = getServiceSupabase();
  const [states, pings] = await Promise.all([
    db.from("agent_state_snapshot").select("agent_name, tick_count, last_tick_at").in("agent_name", agents),
    tenantId
      ? db.from("integrations_health").select("service, last_ping_at").eq("tenant_id", tenantId).in("service", agents)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (states.error) console.error("[os.fleet.state_snapshot]", states.error.message);
  if (pings.error) console.error("[os.fleet.integrations_health]", pings.error.message);
  const signalsKnown = !states.error && !pings.error;
  return {
    agents,
    signals: signalsKnown
      ? fleetSignals(
          agents,
          (states.data || []) as Array<{ agent_name: string; last_tick_at: string | null; tick_count: number | null }>,
          (pings.data || []) as Array<{ service: string; last_ping_at: string | null }>,
          Date.now(),
        )
      : new Map(),
    signalsKnown,
  };
}
