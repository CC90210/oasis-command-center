/**
 * lib/devices/presence.ts - the one rule for whether a paired computer is
 * online, idle or offline, for every screen and check that says so: Settings
 * > Devices, Operations, System health and the coding header (lib/admin/
 * attention.ts), the chat's bridge check (lib/queries.ts), Background workers
 * and the worker-status check.
 *
 * They used four rules (5 minutes; 90 seconds then 5 minutes; 2 minutes), so
 * one computer read "online" on one page and "offline" on the next (PR #553,
 * "Not in this change"; plan track devices-online-rule).
 *
 * The bridge checks in every HEARTBEAT_S seconds (bravo_cli: /api/bridge/ping).
 *   online   a check-in inside ONLINE_MS: two and a half heartbeats, so one
 *            late or lost ping does not flip it
 *   idle     inside IDLE_MS: a laptop asleep, a restart, a dropped network
 *   offline  older, or never
 *
 * PURE AND CLIENT-SAFE: Settings > Devices draws its rows in the browser.
 */

export const HEARTBEAT_S = 60;
export const ONLINE_MS = 150_000;
export const IDLE_MS = 600_000;

export type MachineState = "online" | "idle" | "offline";

/** A computer's state from its last check-in (bridge_pairings.last_seen_at). */
export function machineState(lastSeenAt: string | null | undefined, nowMs: number): MachineState {
  const t = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  if (!Number.isFinite(t)) return "offline";
  const age = nowMs - t;
  if (age < ONLINE_MS) return "online";
  if (age < IDLE_MS) return "idle";
  return "offline";
}

/** Online by the one rule (an idle computer is not online). */
export function isOnline(lastSeenAt: string | null | undefined, nowMs: number): boolean {
  return machineState(lastSeenAt, nowMs) === "online";
}
