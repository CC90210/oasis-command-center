/**
 * lib/bridge/fleet-ticks.ts - the house agents' heartbeats, carried by the agents owner's computer
 * (2026-10-28, Admin > Fleet).
 *
 * WHAT TRAVELS: an agent's name, when it last ticked, its tick count and its health. Nothing else.
 * CC's decision: the dashboard shows that an agent is alive, never what it is working on, so the
 * Mac sends no focus text (bravo_cli/fleet_ticks.py reads only those columns), and every write here
 * resets agent_state_snapshot.working_memory to '{}', which also wipes the old focus text earlier
 * mirrors left behind.
 *
 * WHO MAY SEND: only the workspace's agents owner's computer, on OASIS's own workspace
 * (app/api/bridge/ping checks both before calling this). Only the house agents
 * (OASIS_RUNTIME_AGENT_KEYS), at most four ticks, and a tick only moves an agent FORWARD: an older
 * report never overwrites a newer one.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { OASIS_RUNTIME_AGENT_KEYS } from "@/lib/agents";

export const MAX_AGENT_TICKS = 4;
/** A tick this far ahead of the server clock is a wrong clock, not a heartbeat. */
const FUTURE_SLACK_MS = 5 * 60 * 1000;

export type AgentTick = { agent: string; lastTickAt: string; tickCount: number; health: "healthy" | "degraded" | "down" };

const HEALTH: Record<string, AgentTick["health"]> = {
  green: "healthy",
  healthy: "healthy",
  ok: "healthy",
  yellow: "degraded",
  amber: "degraded",
  degraded: "degraded",
  red: "down",
  down: "down",
};

/**
 * The ticks a ping carries, or null when the field is malformed (the caller ignores it and logs;
 * a bad tick never fails the heartbeat itself). Absent field: [].
 */
export function parseAgentTicks(raw: unknown, now: number): AgentTick[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_AGENT_TICKS) return null;
  const seen = new Set<string>();
  const out: AgentTick[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const rec = item as Record<string, unknown>;
    if (Object.keys(rec).some((k) => !["agent", "last_tick_at", "tick_count", "health"].includes(k))) return null;
    const agent = typeof rec.agent === "string" ? rec.agent.trim().toLowerCase() : "";
    if (!OASIS_RUNTIME_AGENT_KEYS.includes(agent) || seen.has(agent)) return null;
    const at = typeof rec.last_tick_at === "string" ? Date.parse(rec.last_tick_at) : NaN;
    if (!Number.isFinite(at) || at > now + FUTURE_SLACK_MS) return null;
    const count = rec.tick_count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 1_000_000_000) return null;
    const health = typeof rec.health === "string" ? HEALTH[rec.health.trim().toLowerCase()] : undefined;
    if (!health) return null;
    seen.add(agent);
    out.push({ agent, lastTickAt: new Date(at).toISOString(), tickCount: count, health });
  }
  return out;
}

/**
 * Write each tick into agent_state_snapshot (a global table: the house agents, not a workspace's),
 * forward only, wiping working_memory and pending_actions. reported_by_pairing_id records the pairing
 * that carried the tick (bravo__248), so Admin > Fleet judges THAT computer's silence, never another of
 * the owner's devices. last_tick_id is cleared: it is the agent's own tick id, which a dashboard
 * heartbeat does not carry, and /operations would print an old one beside the new time.
 * Returns how many rows moved. Throws on a failed write; the ping catches it, logs, and still answers.
 */
export async function recordAgentTicks(db: Client, ticks: readonly AgentTick[], now: number, pairingId: string): Promise<number> {
  let moved = 0;
  const nowIso = new Date(now).toISOString();
  for (const tick of ticks) {
    const rs = await db.execute({
      sql: `INSERT INTO agent_state_snapshot (agent_name, tick_count, last_tick_at, last_tick_id, reported_by_pairing_id, health_status, working_memory, pending_actions, updated_at)
            VALUES (?, ?, ?, NULL, ?, ?, '{}', '[]', ?)
            ON CONFLICT (agent_name) DO UPDATE SET
              tick_count = excluded.tick_count,
              last_tick_at = excluded.last_tick_at,
              last_tick_id = NULL,
              reported_by_pairing_id = excluded.reported_by_pairing_id,
              health_status = excluded.health_status,
              working_memory = '{}',
              pending_actions = '[]',
              updated_at = excluded.updated_at
            WHERE agent_state_snapshot.last_tick_at IS NULL
               OR julianday(excluded.last_tick_at) > julianday(agent_state_snapshot.last_tick_at)`,
      args: [tick.agent, tick.tickCount, tick.lastTickAt, pairingId, tick.health, nowIso],
    });
    moved += rs.rowsAffected > 0 ? 1 : 0;
  }
  return moved;
}
