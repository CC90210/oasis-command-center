/**
 * The warm chat pool as the Coding harness shows it — shared by
 * /api/bridge/warm-status (which asks the bridge) and the two client panels
 * (WarmPoolPanel, RunnerStatusHeader) that draw its answer. Pure: no fetch.
 */

export type PoolProcess = { key: string; agent: string; alive: boolean; busy: boolean; age_s: number; idle_s: number };
export type WarmPool = { size: number; max_size: number; idle_timeout_s: number; processes: PoolProcess[] };

export type WarmStatusMachine =
  | { label: string; last_seen_at: string | null; state: "online" | "idle" | "offline" }
  | { unreadable: true }
  | null;

/** The route's answer. `reason` names a bridge failure; a 401 from the bridge is always bridge_refused_token. */
export type WarmStatusBody =
  | { ok: true; pool: WarmPool; machine: WarmStatusMachine }
  | { ok: false; reason: string; message?: string; machine?: WarmStatusMachine };

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/** Only the fields the panels draw, typed; anything else the bridge sends (session ids included) is dropped. */
export function sanitizePool(raw: unknown): WarmPool | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const processes = Array.isArray(r.processes) ? r.processes : [];
  return {
    size: num(r.size),
    max_size: num(r.max_size),
    idle_timeout_s: num(r.idle_timeout_s),
    processes: processes
      .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object" && !Array.isArray(p))
      .slice(0, 50)
      .map((p) => ({
        key: String(p.key ?? "").slice(0, 120),
        agent: String(p.agent ?? "").slice(0, 40),
        alive: p.alive === true,
        busy: p.busy === true,
        age_s: num(p.age_s),
        idle_s: num(p.idle_s),
      })),
  };
}

/** What a failed warm-status answer says. */
export function describeWarmFailure(body: { reason: string; message?: string }, status: number): string {
  if (status === 401 || body.reason === "unauthenticated") return "You're signed out; sign in again to see the pool.";
  if (body.reason === "bridge_refused_token") return "The bridge refused the request (token).";
  return body.message || `Couldn't read the pool (${body.reason}).`;
}
