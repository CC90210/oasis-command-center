/**
 * fleet-data — the agent fleet for Admin › Fleet (/admin/agents), moved from
 * the old /agents page (git show 5c374a19:app/agents/page.tsx) when /agents
 * became the AI Team.
 *
 * THE FLEET IS CC'S FOUR AGENTS (2026-10-28): Bravo (CEO · COO · CTO), Atlas
 * (CFO), Maven (CMO) and Aura (life and home), the house agents OASIS's own
 * bridge runs (OASIS_RUNTIME_AGENT_KEYS). Hermes, Lumen and Lex stay in the
 * agent catalog but leave this view; the former partner's agent is not here.
 * The page is operator-only (requireOperator in app/admin/agents/page.tsx).
 *
 * WHAT "ALIVE" IS MADE OF, only facts the dashboard holds:
 *   - process check-ins: integrations_health rows pm2.<agent>-*, pushed by the
 *     bridge every minute (a process "Running" within 5 minutes);
 *   - the agent's own heartbeat: agent_state_snapshot, written forward-only by
 *     the agents owner's computer (lib/bridge/fleet-ticks.ts) with its name,
 *     time, count and health ONLY. What an agent is working on stays on the Mac
 *     (CC, 2026-10-28), so no mission text is read or shown here;
 *   - the computer: the agents owner's paired computer's last check-in;
 *   - the agent's last Coding harness job, its status and time only.
 * fleetLiveness folds them into one of four states (grey, green, amber, red).
 *
 * Liveness reads are done here rather than through lib/queries because both
 * dropped `r.error` when this was written: a failed read came back as an empty
 * list and every agent rendered "never seen". A fleet page that cannot read
 * heartbeats has to say that, not declare the fleet dead.
 */
import "server-only";

import { getActiveProfile } from "@/lib/queries";
import { getServiceSupabase } from "@/lib/supabase-server";
import { OASIS_RUNTIME_AGENT_KEYS } from "@/lib/agents";
import { readAgentsOwner } from "@/lib/agents-owner";
import { SUPERVISOR_DISABLED } from "@/lib/automations/worker-status";

/** An agent is Running when one of its processes checked in within 5 minutes (the daemon window). */
export const FLEET_FRESHNESS_MS = 5 * 60 * 1000;
/** An agent's own heartbeat counts as alive for 15 minutes. */
export const TICK_FRESH_MS = 15 * 60 * 1000;
/** The computer the agents run on, silent this long, means nobody can report: red. */
export const COMPUTER_SILENT_MS = 10 * 60 * 1000;

export type FleetSignal = {
  name: string;
  /** Running: at least one of the agent's processes checked in within FLEET_FRESHNESS_MS. */
  live: boolean;
  /** The agent's processes that have ever reported (pm2.<agent>-*), how many are fresh, and how many fresh rows say down. */
  processCount: number;
  runningCount: number;
  downCount: number;
  /** The freshest process check-in. */
  lastSignalAt: string | null;
  /** The agent's own last heartbeat (agent_state_snapshot.last_tick_at). */
  lastTaskAt: string | null;
  tickCount: number | null;
};

/** The agents owner's computer: its name and last check-in. */
export type FleetComputer = { label: string; lastSeenAt: string | null };

/** An agent's last Coding harness job: status and time only. */
export type FleetJob = { status: string; errorCode: string | null; at: string };

export type Liveness = "grey" | "green" | "amber" | "red";

/** The process-ping prefix for an agent: bravo -> "pm2.bravo-". */
export function processPrefixFor(agent: string): string {
  return `pm2.${agent}-`;
}

export type Fleet = {
  agents: string[];
  signals: Map<string, FleetSignal>;
  /** False when either liveness read failed: the page says "unknown", not "never seen". */
  signalsKnown: boolean;
  /** null: no agents owner computer; undefined: its read failed. */
  computer: FleetComputer | null | undefined;
  /** Each agent's last harness job; an absent key is none (or the read failed: jobsKnown). */
  lastJobs: Map<string, FleetJob>;
  jobsKnown: boolean;
};

/**
 * PURE. Per agent: its process pings decide Running; its own heartbeat is the
 * separate "Last tick". Exported for tests.
 */
export function fleetSignals(
  agents: readonly string[],
  states: ReadonlyArray<{ agent_name: string; last_tick_at: string | null; tick_count: number | null }>,
  pings: ReadonlyArray<{ service: string; last_ping_at: string | null; status?: string | null; metadata?: unknown }>,
  now: number,
): Map<string, FleetSignal> {
  const byState = new Map(states.map((s) => [s.agent_name, s]));
  // Newest ping per service: stale duplicate rows must not shadow a fresh one.
  const latest = new Map<string, { at: number; up: boolean; down: boolean }>();
  for (const p of pings) {
    const t = p.last_ping_at ? Date.parse(p.last_ping_at) : NaN;
    const at = Number.isFinite(t) ? t : 0;
    if (latest.has(p.service) && at <= (latest.get(p.service)?.at ?? 0)) continue;
    latest.set(p.service, { at, up: processIsUp(p.status, p.metadata), down: p.status === "down" });
  }
  const out = new Map<string, FleetSignal>();
  for (const name of agents) {
    const prefix = processPrefixFor(name);
    const procs = [...latest.entries()].filter(([service]) => service.startsWith(prefix)).map(([, v]) => v);
    const fresh = (p: { at: number }) => p.at > 0 && now - p.at < FLEET_FRESHNESS_MS;
    const running = procs.filter((p) => p.up && fresh(p)).length;
    const down = procs.filter((p) => p.down && fresh(p)).length;
    const freshest = procs.length > 0 ? Math.max(...procs.map((p) => p.at)) : 0;
    const state = byState.get(name);
    const tick = state?.last_tick_at ? Date.parse(state.last_tick_at) : NaN;
    out.set(name, {
      name,
      live: running > 0,
      processCount: procs.length,
      runningCount: running,
      downCount: down,
      lastSignalAt: freshest > 0 ? new Date(freshest).toISOString() : null,
      lastTaskAt: Number.isFinite(tick) ? new Date(tick).toISOString() : null,
      tickCount: state ? Number(state.tick_count ?? 0) : null,
    });
  }
  return out;
}

/**
 * PURE. One state per agent, at `now`:
 *   grey   never seen: no process has ever reported and it has never ticked;
 *   green  a process checked in within 5 minutes, or its own tick is under 15 minutes old;
 *   red    a fresh process row says down, or the computer it runs on has been silent 10 minutes;
 *   amber  anything else (seen, but quiet).
 */
export function fleetLiveness(signal: FleetSignal | null | undefined, computer: FleetComputer | null | undefined, now: number): Liveness {
  if (!signal || (signal.processCount === 0 && !signal.lastTaskAt)) return "grey";
  const tick = signal.lastTaskAt ? Date.parse(signal.lastTaskAt) : NaN;
  if (signal.live || (Number.isFinite(tick) && now - tick < TICK_FRESH_MS)) return "green";
  const seen = computer?.lastSeenAt ? Date.parse(computer.lastSeenAt) : NaN;
  const silent = Boolean(computer) && (!Number.isFinite(seen) || now - seen >= COMPUTER_SILENT_MS);
  if (signal.downCount > 0 || silent) return "red";
  return "amber";
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

/** The agents owner's most recently seen approved computer, or null. Throws when a read fails. */
async function readFleetComputer(tenantId: string): Promise<FleetComputer | null> {
  const owner = await readAgentsOwner(tenantId);
  if (owner.state === "unavailable") throw new Error("fleet: agents owner read failed");
  if (owner.state !== "set") return null;
  const { data, error } = await getServiceSupabase()
    .from("bridge_pairings")
    .select("label, last_seen_at, claim_enabled_at, paired_via")
    .eq("tenant_id", tenantId)
    .eq("user_id", owner.authUserId)
    .is("revoked_at", null)
    .order("last_seen_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(`fleet: bridge_pairings read failed: ${error.message}`);
  const rows = (data || []) as Array<{ label: string | null; last_seen_at: string | null; claim_enabled_at: string | null; paired_via: string | null }>;
  const pick = rows.find((row) => row.claim_enabled_at && row.paired_via !== "signup_secret");
  return pick ? { label: (pick.label || "").trim() || "your computer", lastSeenAt: pick.last_seen_at } : null;
}

export async function loadFleet(): Promise<Fleet> {
  const profile = await getActiveProfile();
  const tenantId = profile?.tenant_id ?? null;
  const agents = [...OASIS_RUNTIME_AGENT_KEYS];

  const db = getServiceSupabase();
  const [states, pings, computer, jobs] = await Promise.all([
    db.from("agent_state_snapshot").select("agent_name, tick_count, last_tick_at").in("agent_name", agents),
    tenantId
      ? db.from("integrations_health").select("service, last_ping_at, status, metadata").eq("tenant_id", tenantId).like("service", "pm2.%")
      : Promise.resolve({ data: [], error: null }),
    tenantId
      ? readFleetComputer(tenantId).catch((err: unknown) => {
          console.error("[os.fleet.computer]", err instanceof Error ? err.message : String(err));
          return undefined;
        })
      : Promise.resolve(null),
    tenantId
      ? db
          .from("bridge_harness_jobs")
          .select("agent_key, status, error_code, created_at, finished_at")
          .eq("tenant_id", tenantId)
          .in("agent_key", agents)
          .order("created_at", { ascending: false })
          .limit(40)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (states.error) console.error("[os.fleet.state_snapshot]", states.error.message);
  if (pings.error) console.error("[os.fleet.integrations_health]", pings.error.message);
  if (jobs.error) console.error("[os.fleet.harness_jobs]", jobs.error.message);
  const signalsKnown = !states.error && !pings.error;
  const lastJobs = new Map<string, FleetJob>();
  for (const job of (jobs.data || []) as Array<{ agent_key: string; status: string; error_code: string | null; created_at: string; finished_at: string | null }>) {
    if (!lastJobs.has(job.agent_key)) lastJobs.set(job.agent_key, { status: job.status, errorCode: job.error_code, at: job.finished_at || job.created_at });
  }
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
    computer,
    lastJobs,
    jobsKnown: !jobs.error,
  };
}
