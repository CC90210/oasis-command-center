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
 * integrationsHealth because both dropped `r.error` when this was written (both
 * throw now): a failed read came back as an empty list and every agent
 * rendered "never seen". A fleet page that cannot read heartbeats has to say
 * that, not declare the fleet dead.
 *
 * Dropped from the old page on purpose: the embedded ChatWidget (the power
 * chat is Admin › Coding harness, /agent) and the repo stats line, which reads
 * the filesystem and prints zeros on the Worker, where there is no repo.
 *
 * RUNNING COMES FROM PROCESSES (2026-09-30). "Live" used to be the freshest of
 * the agent's reasoning tick (agent_state_snapshot) and an integrations_health
 * row named after the agent ("bravo"), within 15 minutes. Neither says the
 * agent's processes are up: a tick says its loop decided something. An agent is now Running when one of its processes
 * on the operator's machine checked in within 5 minutes: bravo = pm2.bravo-*,
 * atlas = pm2.atlas-*, maven = pm2.maven-* (the rows the bridge pushes every
 * minute). A fresh row that says the process is down, or that the operator
 * stopped it, is a check-in about a stopped process, not a running one. The
 * last tick is kept, as a separate "Last task" line.
 */
import "server-only";

import { getActiveProfile } from "@/lib/queries";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTenantManifestForUser } from "@/lib/manifest/tenant-scope";
import { resolveEnabledAgentSlugs } from "@/lib/manifest/agent-roster";
import { FAMILY_AGENT_KEYS } from "@/lib/agents";
import { SUPERVISOR_DISABLED } from "@/lib/automations/worker-status";

/** An agent is Running when one of its processes checked in within 5 minutes (the daemon window). */
export const FLEET_FRESHNESS_MS = 5 * 60 * 1000;

export type FleetSignal = {
  name: string;
  /** Running: at least one of the agent's processes checked in within FLEET_FRESHNESS_MS. */
  live: boolean;
  /** The agent's processes that have ever reported (pm2.<agent>-*), and how many are fresh. */
  processCount: number;
  runningCount: number;
  /** The freshest process check-in. */
  lastSignalAt: string | null;
  /** The agent's last task: its last reasoning tick (agent_state_snapshot). */
  lastTaskAt: string | null;
  tickCount: number | null;
};

/** The process-ping prefix for an agent: bravo -> "pm2.bravo-". */
export function processPrefixFor(agent: string): string {
  return `pm2.${agent}-`;
}

export type Fleet = {
  agents: string[];
  signals: Map<string, FleetSignal>;
  /** False when either liveness read failed: the page says "unknown", not "never seen". */
  signalsKnown: boolean;
};

/**
 * PURE. Per agent: its process pings decide Running; its last tick is the
 * separate "Last task". Exported for tests.
 */
export function fleetSignals(
  agents: readonly string[],
  states: ReadonlyArray<{ agent_name: string; last_tick_at: string | null; tick_count: number | null }>,
  pings: ReadonlyArray<{ service: string; last_ping_at: string | null; status?: string | null; metadata?: unknown }>,
  now: number,
): Map<string, FleetSignal> {
  const byState = new Map(states.map((s) => [s.agent_name, s]));
  // Newest ping per service: stale duplicate rows must not shadow a fresh one.
  const latest = new Map<string, { at: number; up: boolean }>();
  for (const p of pings) {
    const t = p.last_ping_at ? Date.parse(p.last_ping_at) : NaN;
    const at = Number.isFinite(t) ? t : 0;
    if (latest.has(p.service) && at <= (latest.get(p.service)?.at ?? 0)) continue;
    latest.set(p.service, { at, up: processIsUp(p.status, p.metadata) });
  }
  const out = new Map<string, FleetSignal>();
  for (const name of agents) {
    const prefix = processPrefixFor(name);
    const procs = [...latest.entries()].filter(([service]) => service.startsWith(prefix)).map(([, v]) => v);
    const running = procs.filter((p) => p.up && p.at > 0 && now - p.at < FLEET_FRESHNESS_MS).length;
    const freshest = procs.length > 0 ? Math.max(...procs.map((p) => p.at)) : 0;
    const state = byState.get(name);
    const tick = state?.last_tick_at ? Date.parse(state.last_tick_at) : NaN;
    out.set(name, {
      name,
      live: running > 0,
      processCount: procs.length,
      runningCount: running,
      lastSignalAt: freshest > 0 ? new Date(freshest).toISOString() : null,
      lastTaskAt: Number.isFinite(tick) ? new Date(tick).toISOString() : null,
      tickCount: state ? Number(state.tick_count ?? 0) : null,
    });
  }
  return out;
}

/** A row reports a process that is up: not "down", and not stopped by the operator. */
function processIsUp(status: string | null | undefined, metadata: unknown): boolean {
  if (status === "down") return false;
  let meta: unknown = metadata;
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta);
    } catch (err) {
      console.error("[os.fleet.metadata] not JSON", err instanceof Error ? err.message : err);
      meta = null;
    }
  }
  const pm2Status = meta && typeof meta === "object" ? (meta as Record<string, unknown>).pm2_status : undefined;
  return !(status === "degraded" && String(pm2Status ?? "") === SUPERVISOR_DISABLED);
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
      ? db.from("integrations_health").select("service, last_ping_at, status, metadata").eq("tenant_id", tenantId).like("service", "pm2.%")
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
          (pings.data || []) as Array<{ service: string; last_ping_at: string | null; status: string | null; metadata: unknown }>,
          Date.now(),
        )
      : new Map(),
    signalsKnown,
  };
}
