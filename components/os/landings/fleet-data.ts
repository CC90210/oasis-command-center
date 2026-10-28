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
 *   - the computer: the pairing that carried the agents' latest heartbeat (agent_state_snapshot
 *     .reported_by_pairing_id, stamped by the ping), never whichever of the owner's devices checked in last;
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

/**
 * The computer the agents report from: the agents owner's pairing that carried the freshest heartbeat
 * (`reportingPairingId`, from agent_state_snapshot.reported_by_pairing_id). Null when no heartbeat names one, or it
 * is not the owner's live pairing in this workspace: then nobody's silence is judged (Codex review, #769:
 * any other device of the owner's checking in must not make stale agents read as merely quiet).
 * Throws when a read fails.
 */
export async function readFleetComputer(tenantId: string, reportingPairingId: string | null): Promise<FleetComputer | null> {
  if (!reportingPairingId) return null;
  const owner = await readAgentsOwner(tenantId);
  if (owner.state === "unavailable") throw new Error("fleet: agents owner read failed");
  if (owner.state !== "set") return null;
  const { data, error } = await getServiceSupabase()
    .from("bridge_pairings")
    .select("label, last_seen_at")
    .eq("tenant_id", tenantId)
    .eq("user_id", owner.authUserId)
    .eq("id", reportingPairingId)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw new Error(`fleet: bridge_pairings read failed: ${error.message}`);
  const row = data as { label: string | null; last_seen_at: string | null } | null;
  return row ? { label: (row.label || "").trim() || "your computer", lastSeenAt: row.last_seen_at } : null;
}

/**
 * Each agent's latest Coding harness job in this workspace: one read per agent (Codex review, #769: one
 * shared limit let a busy agent's history push another agent's last job, even a failed one, out of the
 * result). Throws when any read fails.
 */
export async function readLastJobs(tenantId: string, agents: readonly string[]): Promise<Map<string, FleetJob>> {
  const db = getServiceSupabase();
  const results = await Promise.all(
    agents.map((agent) =>
      db
        .from("bridge_harness_jobs")
        .select("agent_key, status, error_code, created_at, finished_at")
        .eq("tenant_id", tenantId)
        .eq("agent_key", agent)
        .order("created_at", { ascending: false })
        .limit(1),
    ),
  );
  const failed = results.find((r) => r.error)?.error;
  if (failed) throw new Error(`fleet: bridge_harness_jobs read failed: ${failed.message}`);
  const out = new Map<string, FleetJob>();
  for (const result of results) {
    const job = ((result.data || []) as Array<{ agent_key: string; status: string; error_code: string | null; created_at: string; finished_at: string | null }>)[0];
    if (job) out.set(job.agent_key, { status: job.status, errorCode: job.error_code, at: job.finished_at || job.created_at });
  }
  return out;
}

/** The pairing that carried the freshest heartbeat among the agents, or null. PURE. */
export function reportingPairingOf(states: ReadonlyArray<{ last_tick_at: string | null; reported_by_pairing_id?: string | null }>): string | null {
  let best: { at: number; id: string } | null = null;
  for (const s of states) {
    const at = s.last_tick_at ? Date.parse(s.last_tick_at) : NaN;
    if (!s.reported_by_pairing_id || !Number.isFinite(at)) continue;
    if (!best || at > best.at) best = { at, id: s.reported_by_pairing_id };
  }
  return best?.id ?? null;
}

export async function loadFleet(): Promise<Fleet> {
  const profile = await getActiveProfile();
  const tenantId = profile?.tenant_id ?? null;
  const agents = [...OASIS_RUNTIME_AGENT_KEYS];

  const db = getServiceSupabase();
  const [states, pings, lastJobs] = await Promise.all([
    db.from("agent_state_snapshot").select("agent_name, tick_count, last_tick_at, reported_by_pairing_id").in("agent_name", agents),
    tenantId
      ? db.from("integrations_health").select("service, last_ping_at, status, metadata").eq("tenant_id", tenantId).like("service", "pm2.%")
      : Promise.resolve({ data: [], error: null }),
    tenantId
      ? readLastJobs(tenantId, agents).catch((err: unknown) => {
          console.error("[os.fleet.harness_jobs]", err instanceof Error ? err.message : String(err));
          return null;
        })
      : Promise.resolve(new Map<string, FleetJob>()),
  ]);
  if (states.error) console.error("[os.fleet.state_snapshot]", states.error.message);
  if (pings.error) console.error("[os.fleet.integrations_health]", pings.error.message);
  const signalsKnown = !states.error && !pings.error;
  const stateRows = (states.data || []) as Array<{ agent_name: string; last_tick_at: string | null; tick_count: number | null; reported_by_pairing_id: string | null }>;
  const computer: FleetComputer | null | undefined = tenantId
    ? await readFleetComputer(tenantId, reportingPairingOf(stateRows)).catch((err: unknown) => {
        console.error("[os.fleet.computer]", err instanceof Error ? err.message : String(err));
        return undefined;
      })
    : null;
  return {
    agents,
    signals: signalsKnown
      ? fleetSignals(
          agents,
          stateRows,
          (pings.data || []) as Array<{ service: string; last_ping_at: string | null; status: string | null; metadata: unknown }>,
          Date.now(),
        )
      : new Map(),
    signalsKnown,
    computer,
    lastJobs: lastJobs ?? new Map(),
    jobsKnown: lastJobs !== null,
  };
}
