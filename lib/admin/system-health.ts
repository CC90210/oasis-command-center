/**
 * lib/admin/system-health.ts — the ONE System health loader (2026-09-30).
 *
 * WHY IT EXISTS. /system-health used to fetch its own /api/state-health over
 * HTTP from the server. That fetch carried no session cookie, so the
 * middleware answered 401 before the route ran, and the page showed CC "Local
 * guard substrate not active here … Last fetch error: unauthorized" with a
 * command for a compose file that does not exist. Behind it the route's
 * fallback mislabelled its Turso data, named the wrong host, mapped a
 * months-old "healthy" to green and drew every guard "off" because it had no
 * guard data at all. This loader runs in-process in /health (and backs
 * /api/state-health for the operator), reads only Turso, and says "not
 * reported" or "not verified since T" wherever it does not know.
 *
 * WHAT IT READS (all scoped to the session's workspace):
 *   - bridge_pairings: the paired computers and when each last checked in
 *     (online under 90 s, idle under 5 min, else offline);
 *   - the Command Center's own view of the bridge: the same probe
 *     /api/bridge/health makes, server-side with the bearer, in plain words;
 *   - integrations_health service "guard_substrate": the guard summary the
 *     operator's bridge adds to its ping (contract below). Until the bridge
 *     sends it, every guard reads "Not reported yet"; when it goes stale,
 *     "Not verified since T". A stale or missing report is never "off";
 *   - lib/admin/attention.ts: the workers, cron failures, error and warning
 *     events and cold leads (the one definition of "needs you").
 *
 * GUARD REPORT CONTRACT (service "guard_substrate", metadata):
 *   { contract: 1,
 *     guards: { <exec_guard|secret_guard|state_guard|coord_guard|subprocess_guard>:
 *       { mode: "enforce"|"report"|"off", blocked_24h: int, would_block_24h: int,
 *         last_block_at: ISO|null, categories_24h: { <category>: int } } } }
 * Counts, modes, times and category names only. Command text and file paths
 * never leave the operator's machine, and nothing else in the metadata is read
 * or rendered. The bridge side (BEA bravo_cli/local_bridge.py detect_guards) is
 * a paired change that waits on CC's approval.
 */

import "server-only";

import { safe } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import { DAEMON_HEALTH_STALE_MS } from "@/lib/automations/daemon-backed-crons";
import type { StatusReporter } from "@/lib/automations/worker-status";
import {
  countColdLeads,
  describeBackground,
  loadAttentionEvents,
  loadCronFailures,
  loadMachines,
  loadWorkerRows,
  metadataObject,
  type AdminDb,
  type AttentionEvent,
  type AttentionSummary,
  type CronFailure,
  type PairedMachine,
  type WorkerHealth,
} from "@/lib/admin/attention";

export const GUARD_REPORT_SERVICE = "guard_substrate";
/** A guard report older than the daemon window is not a reading. */
export const GUARD_REPORT_STALE_MS = DAEMON_HEALTH_STALE_MS;

/** "40 s ago", "3 min ago", "3 h ago", "2 days ago". */
export function formatAgo(iso: string | null, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "at an unknown time";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// ── The Command Center's view of the bridge ───────────────────────────────

/** `reason` is /api/bridge/health's code; `sentence` says what it means. */
export type CloudReach = { ok: boolean; reason: string; sentence: string };

const CLOUD_REACH_SENTENCE: Record<string, string> = {
  ok: "The Command Center can reach your computer's bridge right now.",
  vps_unauthorized:
    "The bridge refused the Command Center's request (token): the token on your computer doesn't match the one the Command Center sends.",
  vps_timeout: "The Command Center reached the tunnel, but your computer didn't answer within 1.5 seconds.",
  vps_unreachable: "The Command Center couldn't reach your computer's bridge at all: the tunnel is down or its address is wrong.",
  vps_upstream_error: "Your computer's bridge answered with an error, so it is running but unhealthy.",
  bridge_not_configured: "No bridge address or token is set for this workspace, so the Command Center can't reach your computer.",
  bridge_not_enabled_for_tenant: "This workspace isn't allowed to use the bridge.",
};

export function describeCloudReach(reason: string): CloudReach {
  return {
    ok: reason === "ok",
    reason,
    sentence: CLOUD_REACH_SENTENCE[reason] ?? `Couldn't check from the Command Center (${reason}).`,
  };
}

/**
 * The probe /api/bridge/health makes, run in-process for the operator: the
 * session's tenant, its bridge target, GET /health with the bearer.
 */
export async function probeCloudReach(): Promise<CloudReach> {
  const { authorizeBridgeRequest } = await import("@/lib/bridge-proxy");
  const auth = await authorizeBridgeRequest();
  if (!auth.ok) return describeCloudReach(auth.error);
  try {
    const r = await fetch(`${auth.target.baseUrl}/health`, {
      headers: { authorization: `Bearer ${auth.target.bearerToken}` },
      signal: AbortSignal.timeout(1500),
    });
    if (r.ok) return describeCloudReach("ok");
    return describeCloudReach(r.status === 401 ? "vps_unauthorized" : "vps_upstream_error");
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const msg = err instanceof Error ? err.message : String(err);
    if (name === "TimeoutError" || name === "AbortError" || /timeout/i.test(msg)) return describeCloudReach("vps_timeout");
    console.error("[system-health.cloud_reach]", msg);
    return describeCloudReach("vps_unreachable");
  }
}

// ── Safety guards ─────────────────────────────────────────────────────────

export const GUARDS: ReadonlyArray<{ key: string; name: string; plain: string }> = [
  {
    key: "exec_guard",
    name: "Command guard",
    plain: "Stops destructive commands on your computer before they run: dropping tables, wiping folders, force-pushing to main.",
  },
  {
    key: "secret_guard",
    name: "Secrets guard",
    plain: "Keeps your passwords and API keys out of the AI's reach: it can't open your .env or key files.",
  },
  {
    key: "state_guard",
    name: "Session-log guard",
    plain: "Stops hand edits to the auto-generated session log, so the record of what happened stays honest.",
  },
  {
    key: "coord_guard",
    name: "Shared-file guard",
    plain: "Stops Bravo editing a file while Adon's agent (APEX) holds it.",
  },
  {
    key: "subprocess_guard",
    name: "Pop-up guard",
    plain: "Catches new background code that would flash a terminal window on your computer.",
  },
];

export type GuardState = "on" | "watching" | "off" | "not_reported" | "not_verified" | "failing";

export type GuardStatus = {
  key: string;
  name: string;
  plain: string;
  state: GuardState;
  /** What the tag says. */
  label: string;
  blocked24h: number | null;
  wouldBlock24h: number | null;
  lastBlockAt: string | null;
};

export type GuardReport = {
  /** fresh: inside the window. stale: older. missing: never sent. failing: the computer said it couldn't read its guard logs. */
  freshness: "fresh" | "stale" | "missing" | "failing";
  reportedAt: string | null;
  guards: GuardStatus[];
};

export type GuardRow = { status: string | null; last_ping_at: string | null; metadata: unknown };

function countOrNull(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

function isoOrNull(v: unknown): string | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
}

/**
 * PURE. The guard report, guard by guard, from the latest guard_substrate row
 * (or none). A report that is stale, missing or unreadable is never "off".
 */
export function describeGuards(row: GuardRow | null, now: number): GuardReport {
  const all = (state: GuardState, label: string): GuardStatus[] =>
    GUARDS.map((g) => ({ ...g, state, label, blocked24h: null, wouldBlock24h: null, lastBlockAt: null }));
  if (!row) return { freshness: "missing", reportedAt: null, guards: all("not_reported", "Not reported yet") };
  const pinged = row.last_ping_at ? Date.parse(row.last_ping_at) : NaN;
  if (!Number.isFinite(pinged) || now - pinged > GUARD_REPORT_STALE_MS) {
    const since = Number.isFinite(pinged) ? new Date(pinged).toISOString() : null;
    return {
      freshness: "stale",
      reportedAt: since,
      guards: all("not_verified", since ? `Not verified since ${since}` : "Not verified"),
    };
  }
  if (row.status !== "healthy") {
    return { freshness: "failing", reportedAt: row.last_ping_at, guards: all("failing", "Couldn't be read on your computer") };
  }
  const meta = metadataObject(row.metadata);
  const reported =
    meta?.guards && typeof meta.guards === "object" && !Array.isArray(meta.guards) ? (meta.guards as Record<string, unknown>) : null;
  return {
    freshness: "fresh",
    reportedAt: row.last_ping_at,
    guards: GUARDS.map((g) => {
      const raw = reported?.[g.key];
      const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
      const mode = typeof entry?.mode === "string" ? entry.mode.toLowerCase() : null;
      const state: GuardState =
        mode === "enforce" ? "on" : mode === "report" ? "watching" : mode === "off" ? "off" : "not_reported";
      const label = state === "on" ? "On" : state === "watching" ? "Watching only" : state === "off" ? "Off" : "Not reported yet";
      return {
        ...g,
        state,
        label,
        blocked24h: entry ? countOrNull(entry.blocked_24h) : null,
        wouldBlock24h: entry ? countOrNull(entry.would_block_24h) : null,
        lastBlockAt: entry ? isoOrNull(entry.last_block_at) : null,
      };
    }),
  };
}

async function loadGuardRow(db: AdminDb, tenantId: string): Promise<GuardRow | null> {
  const r = await db
    .from("integrations_health")
    .select("status, last_ping_at, metadata")
    .eq("tenant_id", tenantId)
    .eq("service", GUARD_REPORT_SERVICE)
    .order("last_ping_at", { ascending: false })
    .limit(1);
  if (r.error) throw new Error(`guard report read failed: ${r.error.message}`);
  return ((r.data || []) as GuardRow[])[0] ?? null;
}

// ── The page model ────────────────────────────────────────────────────────

export type Verdict = { tone: "ok" | "warn" | "unknown"; text: string };

export type SystemHealth = {
  generatedAt: string;
  verdict: Verdict;
  /** null = the pairings read failed. */
  machines: PairedMachine[] | null;
  cloud: CloudReach | null;
  /** null = the guard report read failed. */
  guards: GuardReport | null;
  /** null = the worker heartbeats read failed. */
  workers: WorkerHealth[] | null;
  reporter: StatusReporter | null;
  cron: { count: number; rows: CronFailure[] } | null;
  events: { errors: number; warnings: number; rows: AttentionEvent[] } | null;
  attention: AttentionSummary;
};

/**
 * PURE. The one sentence at the top: protection and the computer. It says
 * "can't" wherever a read failed or a report is old.
 */
export function describeVerdict(input: { machines: PairedMachine[] | null; guards: GuardReport | null; now: number }): Verdict {
  const { machines, guards, now } = input;
  if (machines === null) {
    return { tone: "unknown", text: "Couldn't check your computer: its check-ins couldn't be read. Reload to try again." };
  }
  const pc = machines[0] ?? null;
  if (!pc) return { tone: "warn", text: "No computer is paired, so nothing runs or reports your guards." };
  const clause =
    pc.state === "offline"
      ? `${pc.label} last checked in ${formatAgo(pc.lastSeenAt, now)}.`
      : `${pc.label} checked in ${formatAgo(pc.lastSeenAt, now)}.`;
  if (guards === null) return { tone: "unknown", text: `Couldn't check your guards: their report couldn't be read. ${clause}` };
  if (guards.freshness === "missing") {
    return { tone: "unknown", text: `Your guards aren't reported here yet: they run on your computer, which doesn't send them yet. ${clause}` };
  }
  if (guards.freshness === "stale") {
    return { tone: "warn", text: `Can't verify your guards: ${pc.label} last reported them ${formatAgo(guards.reportedAt, now)}.` };
  }
  if (guards.freshness === "failing") {
    return { tone: "warn", text: `Can't verify your guards: ${pc.label} couldn't read its guard logs. ${clause}` };
  }
  const notOn = guards.guards.filter((g) => g.state !== "on");
  if (notOn.length === 0) return { tone: "ok", text: `Everything is protected. ${clause}` };
  const names = notOn.map((g) => `${g.name.toLowerCase()} (${g.label.toLowerCase()})`).join(", ");
  return { tone: "warn", text: `${GUARDS.length - notOn.length} of ${GUARDS.length} guards are on. Not fully on: ${names}. ${clause}` };
}

export type SystemHealthDeps = {
  db?: AdminDb;
  now?: number;
  /** The Command Center's probe of the bridge; the page uses probeCloudReach. */
  probeCloud?: () => Promise<CloudReach>;
};

/**
 * Everything /health shows about the system, for the session's workspace.
 * Each read fails on its own (logged): its section says "Couldn't check" and
 * the rest still render. Never throws.
 */
export async function loadSystemHealth(tenantId: string, deps: SystemHealthDeps = {}): Promise<SystemHealth> {
  const db = deps.db ?? getServiceSupabase();
  const now = deps.now ?? Date.now();
  const [machines, cloud, guardRow, workerRows, cron, events, coldLeads] = await Promise.all([
    safe("system_health.machines", loadMachines(db, tenantId, now), null),
    safe("system_health.cloud_reach", (deps.probeCloud ?? probeCloudReach)(), null),
    // Wrapped so "no report" (null) and "the read failed" (safe's null) differ.
    safe("system_health.guards", loadGuardRow(db, tenantId).then((row) => ({ row })), null),
    safe("system_health.workers", loadWorkerRows(db, tenantId), null),
    safe("system_health.cron_failures", loadCronFailures(db, tenantId, now), null),
    safe("system_health.events", loadAttentionEvents(db, tenantId, now), null),
    safe("system_health.cold_leads", countColdLeads(db, tenantId, now), null),
  ]);
  const guards = guardRow === null ? null : describeGuards(guardRow.row, now);
  const background = describeBackground(workerRows, machines, now);
  return {
    generatedAt: new Date(now).toISOString(),
    verdict: describeVerdict({ machines, guards, now }),
    machines,
    cloud,
    guards,
    workers: background.workers,
    reporter: background.reporter,
    cron,
    events,
    attention: {
      errors: events?.errors ?? null,
      warnings: events?.warnings ?? null,
      cronFailures: cron?.count ?? null,
      workersDown: background.workersDown,
      coldLeads,
    },
  };
}
