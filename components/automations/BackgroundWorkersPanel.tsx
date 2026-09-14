"use client";

/**
 * BackgroundWorkersPanel — an execution-aware view of local, cloud, remote,
 * and retired workers. Renders below the cron-jobs list on /automations so
 * the operator can see at a glance:
 *   - Where each worker runs and whether it is dashboard-controllable
 *   - Which are alive (status: healthy) vs stopped (down) vs unknown
 *     (bridge hasn't pushed a snapshot recently)
 *   - When each was last reported
 *
 * The local/remote bridge populates integrations_health; cloud automations
 * report independently. A bridge outage therefore never makes a cloud row
 * look stale.
 */

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetch-json";
import { runWorkerAction, type WorkerAction } from "@/lib/automations/worker-control";
import {
  countsTowardHealth,
  formatLastSeen,
  isOperatorStopped,
  type WorkerControlMode,
  type WorkerRuntime,
  type WorkerStatusSource,
} from "@/lib/automations/worker-status";
import { Cpu, CheckCircle2, AlertCircle, MinusCircle, HelpCircle, Activity, Play, Square, RotateCw, Loader2 } from "lucide-react";

/**
 * Workers whose Stop or Restart action could break the dashboard's
 * connection back to the operator's machine. Codex audit 2026-06-06
 * flagged that the optimistic-flip pattern is especially risky for
 * these because the bridge's 60s heartbeat is what would correct any
 * stale UI state — stopping the bridge itself stops the corrective
 * signal.
 *
 * For these workers we still allow the action (CC needs the control)
 * but force a confirm() dialog so it's deliberate.
 */
const CRITICAL_WORKERS: ReadonlySet<string> = new Set([
  "pm2.claude-bridge",
  "pm2.claude-bridge-ping",
  "pm2.bravo-scheduler",
]);

type Worker = {
  service: string;
  label: string;
  purpose: string;
  status: "healthy" | "degraded" | "down" | "unconfigured" | "archived";
  /** True when a status row exists but stopped refreshing (>5 min old) — the
   * server already degraded `status` to "down"; this flag only changes the
   * copy from "Stopped" to "stopped reporting". */
  stale?: boolean;
  metadata: Record<string, unknown>;
  last_ping_at: string | null;
  /** Rolling-deploy compatibility for the former PM2-only API contract. */
  manageable_via_pm2?: boolean;
  archived_on?: string;
  archived_reason?: string;
  /** Set when this worker is not meant to run on this machine — the string is
   * the reason. Excluded from the healthy/total pill and rendered neutrally
   * rather than as a fault. See the API's OASIS_WORKERS. */
  not_expected_here?: string;
  /** Execution and lifecycle facts. Optional only for compatibility with a
   * stale API response during deployment. */
  runtime?: WorkerRuntime;
  control_mode?: WorkerControlMode;
  status_source?: WorkerStatusSource;
  /** B4 (2026-07-23): who this daemon belongs to. The API always sends this
   * now (defaults "cc" server-side for the pre-existing CC-only worker list)
   * — optional here only as a defensive fallback against a stale API. */
  owner?: "cc" | "adon" | "shared";
};

const RUNTIME_GROUP_META: Record<WorkerRuntime, { label: string; detail: string }> = {
  local: {
    label: "This computer",
    detail: "OASIS services supervised on this machine.",
  },
  cloud: {
    label: "OASIS cloud",
    detail: "Runs automatically whether this computer is on or off.",
  },
  remote: {
    label: "Remote infrastructure",
    detail: "Runs on this tenant's dedicated host.",
  },
  retired: {
    label: "Inactive / retired",
    detail: "Preserved for reference and excluded from active health.",
  },
};
const RUNTIME_GROUP_ORDER: WorkerRuntime[] = ["local", "cloud", "remote", "retired"];

type ApiResponse = {
  ok: boolean;
  bridge_online: boolean;
  last_seen_at: string | null;
  workers: Worker[];
  /** When true, worker actions route through the server-side bridge proxy
   * (SunBiz VPS daemons) instead of the operator's localhost bridge. */
  remote_control?: boolean;
  error?: string;
  message?: string;
};

function runtimeFor(worker: Worker, legacyRemoteControl = false): WorkerRuntime {
  if (worker.runtime) return worker.runtime;
  if (worker.not_expected_here) return "retired";
  return legacyRemoteControl ? "remote" : "local";
}

function controlModeFor(worker: Worker, legacyRemoteControl = false): WorkerControlMode {
  if (worker.control_mode) return worker.control_mode;
  if (worker.manageable_via_pm2 === false || runtimeFor(worker, legacyRemoteControl) === "retired") {
    return "none";
  }
  return legacyRemoteControl ? "remote_bridge" : "local_fleet";
}

export function BackgroundWorkersPanel() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      // Same guard as the cron list: an empty body must report its HTTP status,
      // not "Unexpected end of JSON input". A throw here used to leave this
      // panel stuck on "Loading..." beside the other panel's error banner.
      const result = await fetchJson<ApiResponse>("/api/automations/background-workers", undefined, { retries: 2 });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const j = result.data;
      if (!j.ok) {
        setError(j.message || j.error || `http_${result.status}`);
        return;
      }
      setData(j);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load_failed");
    }
  }

  useEffect(() => {
    refresh();
    // 30s refresh so newly-started/stopped daemons surface fast without
    // polling so hard we eat tons of dashboard requests.
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, []);

  if (error) {
    return (
      <div className="rounded-xl border border-status-warm/40 bg-status-warm/10 p-3 text-sm text-status-warm flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>Couldn&apos;t load background workers: {error}</span>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-xl border border-bg-border bg-bg-elev/30 p-4 text-xs text-fg-muted">
        Loading background workers…
      </div>
    );
  }

  // Local, cloud, and remote workers are active health. Retired inventory is
  // visible in its own collapsed section but never counts as an outage.
  const active = data.workers.filter(countsTowardHealth);
  const healthy = active.filter((w) => w.status === "healthy").length;
  const total = active.length;
  const legacyRemoteControl = data.remote_control || false;
  const byRuntime = new Map<WorkerRuntime, Worker[]>();
  for (const worker of data.workers) {
    const workerRuntime = runtimeFor(worker, legacyRemoteControl);
    const list = byRuntime.get(workerRuntime) ?? [];
    list.push(worker);
    byRuntime.set(workerRuntime, list);
  }
  const runtimesPresent = RUNTIME_GROUP_ORDER.filter(
    (workerRuntime) => (byRuntime.get(workerRuntime)?.length ?? 0) > 0,
  );
  const hasLocalWorkers = (byRuntime.get("local")?.length ?? 0) > 0;
  const hasRemoteWorkers = (byRuntime.get("remote")?.length ?? 0) > 0;
  const bridgeLabel = hasRemoteWorkers && !hasLocalWorkers ? "Remote bridge" : "Local bridge";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-fg-muted" />
          <div className="text-sm font-bold text-fg">Background workers</div>
          <span className="text-[10px] uppercase tracking-wider text-fg-dim border border-bg-border rounded-full px-1.5 py-0.5">
            {healthy}/{total} healthy
          </span>
        </div>
        {(hasLocalWorkers || hasRemoteWorkers) && data.last_seen_at && (
          <div className="text-[11px] text-fg-dim inline-flex items-center gap-1.5">
            <Activity className="w-3 h-3" />
            {bridgeLabel} last seen {new Date(data.last_seen_at).toLocaleTimeString()}
          </div>
        )}
      </div>

      {!data.bridge_online && (hasLocalWorkers || hasRemoteWorkers) && (
        <div className="rounded-lg border border-bg-border bg-bg-deep/40 p-3 text-xs text-fg-muted">
          {hasRemoteWorkers && !hasLocalWorkers ? (
            <>
              Remote infrastructure has not reported in the last 2 minutes, so
              that section may be lagging. Server-side controls remain available.
            </>
          ) : (
            <>
              This computer has not reported in the last 2 minutes, so its worker
              statuses may be stale. OASIS cloud automations are unaffected.
            </>
          )}
        </div>
      )}

      <div className="space-y-4">
        {runtimesPresent.map((workerRuntime) => {
          const groupWorkers = byRuntime.get(workerRuntime) ?? [];
          const group = RUNTIME_GROUP_META[workerRuntime];
          const cards = (
            <div className="grid sm:grid-cols-2 gap-2">
              {groupWorkers.map((worker) => (
                <WorkerRow
                  key={worker.service}
                  worker={worker}
                  bridgeOnline={data.bridge_online}
                  remoteControl={legacyRemoteControl}
                  onChange={refresh}
                />
              ))}
            </div>
          );

          if (workerRuntime === "retired") {
            return (
              <details key={workerRuntime} className="rounded-lg border border-bg-border bg-bg-deep/20 p-3">
                <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-wider text-fg-dim">
                  {group.label} ({groupWorkers.length})
                </summary>
                <div className="mt-1 mb-3 text-[11px] text-fg-dim">{group.detail}</div>
                {cards}
              </details>
            );
          }

          return (
            <section key={workerRuntime} className="space-y-2">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-fg-dim">
                  {group.label}
                </div>
                <div className="text-[11px] text-fg-dim mt-0.5">{group.detail}</div>
              </div>
              {cards}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function WorkerRow({
  worker,
  bridgeOnline,
  remoteControl,
  onChange,
}: {
  worker: Worker;
  bridgeOnline: boolean;
  /** Route actions through the server-side bridge proxy (SunBiz VPS). */
  remoteControl: boolean;
  onChange: () => void | Promise<void>;
}) {
  // Local "optimistic" override — when the operator clicks Stop/Start/Restart
  // and pm2 returns success, we flip this immediately so the tile reflects
  // the new state without waiting for the bridge's next 60s heartbeat.
  // null = no override, fall through to worker.status from the server.
  const [optimisticStatus, setOptimisticStatus] = useState<Worker["status"] | null>(null);
  const effectiveStatus = optimisticStatus ?? worker.status;
  const workerRuntime = runtimeFor(worker, remoteControl);
  const controlMode = controlModeFor(worker, remoteControl);

  // "Off" is a fourth state, and it is NOT a fault (2026-09-02). The rule lives
  // in lib/automations/worker-status so a test can execute it — see that file
  // for why "Degraded — check logs" was being shown for a deliberate stop.
  // Suppressed while an optimistic flip is pending: that flip has no fresh
  // supervisor reading behind it.
  const operatorStopped = optimisticStatus === null && isOperatorStopped(worker);
  // Not a fault and must not be coloured like one — see the API's
  // OASIS_WORKERS.not_expected_here compatibility field.
  const byDesign =
    (workerRuntime === "retired" || Boolean(worker.not_expected_here)) &&
    optimisticStatus === null;

  const Icon = byDesign || operatorStopped
    ? MinusCircle
    : effectiveStatus === "healthy"
      ? CheckCircle2
      : effectiveStatus === "down"
        ? MinusCircle
        : effectiveStatus === "degraded"
          ? AlertCircle
          : HelpCircle;
  const iconClass = byDesign || operatorStopped
    ? "text-fg-dim"
    : effectiveStatus === "healthy"
      ? "text-status-engaged"
      : effectiveStatus === "down"
        ? "text-status-warm"
        : effectiveStatus === "degraded"
          ? "text-accent"
          : "text-fg-dim";

  // Operator-facing status pill — one word per state, no jargon. Replaces
  // the prior "up 12d · 5 restarts · 12MB" line which was too dense
  // (CC 2026-06-06: "make the metrics a little more simplified but still
  // useful"). Detail (pid + memory + cpu + restart count) survives in the
  // tooltip (title attr) for when you actually need it.
  const meta = worker.metadata || {};
  const pid = (meta.pid as number) || 0;
  const restartCount = (meta.restart_count as number) || 0;
  const uptimeMs = (meta.uptime_ms as number) || 0;
  const memBytes = (meta.memory_bytes as number) || 0;
  const cpuPct = (meta.cpu_pct as number) || 0;
  const memMb = memBytes ? Math.round(memBytes / 1024 / 1024) : 0;
  const uptimeStr = uptimeMs ? formatUptime(Date.now() - uptimeMs) : null;

  // A down tile always says WHEN the worker was last heard from — "Stopped"
  // with no timestamp and a 20-minute-old silence look identical otherwise.
  // The optimistic flip has no fresh ping to quote, so it shows plain
  // "Stopped"/"Running" until the next heartbeat lands.
  //
  // The DATE is not optional (2026-09-02). This printed toLocaleTimeString()
  // alone, so the Skool daemon's "last seen 7:31 PM" was 18 May — 106 days old
  // — and rendered identically to a worker that dropped out twenty minutes ago.
  // A relic and a live incident MUST NOT look the same. Anything older than
  // today carries its date; today's pings stay time-only so the common case
  // reads short.
  const lastSeen =
    optimisticStatus === null && worker.last_ping_at
      ? ` · last seen ${formatLastSeen(worker.last_ping_at)}`
      : "";
  const lastRun =
    optimisticStatus === null && worker.last_ping_at
      ? ` · last run ${formatLastSeen(worker.last_ping_at)}`
      : "";
  let statusLabel: string;
  if (byDesign) {
    statusLabel = worker.not_expected_here || "Retired — preserved for reference";
  } else if (workerRuntime === "cloud") {
    statusLabel =
      effectiveStatus === "healthy"
        ? `Healthy · managed automatically${lastRun}`
        : effectiveStatus === "down"
          ? `Down — cloud schedule stopped reporting${lastRun}`
          : effectiveStatus === "degraded"
            ? `Degraded — check the latest run${lastRun}`
            : "Waiting for first scheduled run";
  } else if (operatorStopped) {
    statusLabel = `Off — you stopped this. Start it to resume.${lastSeen}`;
  } else if (effectiveStatus === "healthy") {
    statusLabel = uptimeStr ? `Running · up ${uptimeStr}` : "Running";
  } else if (effectiveStatus === "down") {
    statusLabel =
      optimisticStatus === null && worker.stale
        ? `Down — stopped reporting${lastSeen}`
        : `Stopped${lastSeen}`;
  } else if (effectiveStatus === "degraded") {
    statusLabel = `Degraded — check logs${lastSeen}`;
  } else {
    statusLabel = workerRuntime === "remote" ? "Waiting for remote status" : "Not yet reporting";
  }

  // Detailed pm2 fields land in the tooltip. Operators who care about
  // memory + cpu + restart count + PID can hover; everyone else sees
  // the clean one-line status.
  const detailTooltip =
    pid
      ? `PID ${pid}${memMb > 0 ? ` · ${memMb}MB` : ""}${cpuPct > 0 ? ` · ${cpuPct}% CPU` : ""}${restartCount > 0 ? ` · ${restartCount} restart${restartCount === 1 ? "" : "s"}` : ""}`
      : worker.service;

  return (
    <div
      className={`rounded-lg border p-3 ${
        byDesign || operatorStopped
          ? "border-bg-border bg-bg-deep/40 opacity-70"
          : effectiveStatus === "healthy"
            ? "border-bg-border bg-bg-elev/30"
            : effectiveStatus === "down"
              ? "border-status-warm/30 bg-status-warm/5"
              : "border-bg-border bg-bg-deep/40 opacity-80"
      }`}
      title={detailTooltip}
    >
      <div className="flex items-start gap-2">
        <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${iconClass}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="font-bold text-sm text-fg truncate">{worker.label}</div>
            <span className="text-[10px] uppercase tracking-wider text-fg-dim font-mono">
              {worker.service.replace(/^pm2\./, "")}
            </span>
            {workerRuntime === "cloud" && (
              <span className="text-[9px] uppercase tracking-wider text-accent border border-accent/30 rounded-full px-1.5 py-0.5">
                Managed automatically
              </span>
            )}
            {workerRuntime === "retired" && (
              <span className="text-[9px] uppercase tracking-wider text-fg-dim border border-bg-border rounded-full px-1.5 py-0.5">
                Retired
              </span>
            )}
          </div>
          <div className="text-[11px] text-fg-muted mt-0.5 leading-relaxed">{worker.purpose}</div>
          <div className="text-[11px] text-fg-dim mt-1">
            {statusLabel}
          </div>
          {worker.control_mode !== "none" && controlMode !== "none" && (
            <WorkerActions
              service={worker.service}
              bridgeOnline={bridgeOnline}
              remoteControl={controlMode === "remote_bridge"}
              status={effectiveStatus}
              onOptimistic={setOptimisticStatus}
              onChange={onChange}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Three icon buttons (Start / Stop / Restart) plus inline feedback.
 *  Buttons grey out when the bridge isn't online (browser can't reach
 *  localhost) and during in-flight requests. The result text shows for
 *  ~3s after each click so the operator gets a confirmation without a
 *  modal. */
function WorkerActions({
  service,
  bridgeOnline,
  remoteControl,
  status,
  onOptimistic,
  onChange,
}: {
  service: string;
  bridgeOnline: boolean;
  /** Route actions through the server-side bridge proxy (SunBiz VPS). */
  remoteControl: boolean;
  status: Worker["status"];
  /** Optimistic local-state flip so the tile reflects success before the
   * bridge's next 60s heartbeat lands. Passing null clears the override
   * and falls back to server data. */
  onOptimistic: (s: Worker["status"] | null) => void;
  onChange: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<WorkerAction | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  async function handle(action: WorkerAction) {
    // Codex audit 2026-06-06 — critical workers need an explicit confirm
    // because stopping them severs the heartbeat that would correct any
    // stale UI state. Browser-native confirm() is the lowest-friction guard.
    const isCritical = CRITICAL_WORKERS.has(service);
    if (isCritical && action !== "start") {
      const ok = window.confirm(
        `You're about to ${action} ${service.replace(/^pm2\./, "")} — this is a CRITICAL worker. ` +
          (action === "stop"
            ? "Stopping it will break the dashboard's ability to refresh worker state until you re-start it from terminal. "
            : "Restarting it will briefly drop the dashboard's connection (~10-30s). ") +
          "Continue?",
      );
      if (!ok) return;
    }

    setBusy(action);
    setFeedback(null);
    const result = await runWorkerAction(service, action, remoteControl);
    setBusy(null);

    // Codex audit — DON'T optimistically flip critical workers. The 90s
    // clear timer relies on the bridge pushing a fresh heartbeat;
    // stopping claude-bridge or claude-bridge-ping prevents exactly
    // that, so the override would never clear and the tile would lie.
    // For criticals we wait for the next genuine heartbeat (or the
    // operator's manual refresh) to update the tile.
    if (result.ok && !isCritical) {
      const nextStatus: Worker["status"] =
        action === "stop" ? "down" : "healthy";
      onOptimistic(nextStatus);
      setTimeout(() => onOptimistic(null), 90_000);
    }

    setFeedback({ ok: result.ok, text: result.ok ? `${action} ✓` : `${action} failed: ${result.output.slice(0, 80)}` });
    setTimeout(() => setFeedback(null), 3000);

    // Trigger an immediate server refetch + a delayed one at 5s. The
    // immediate refetch won't show the change (bridge ping cadence is
    // 60s), but the 5s one starts catching faster bridges that ping on
    // demand. Background polling at 30s also handles it for us.
    await onChange();
    setTimeout(() => { void onChange(); }, 5_000);
  }

  const canStart = status !== "healthy";
  const canStop = status === "healthy" || status === "degraded";
  // Heartbeat freshness only blocks the LOCAL path (browser → localhost bridge):
  // if that bridge is offline the browser can't reach it. For the REMOTE path
  // the control POST goes server-side to the VPS exec-tool (hosted by
  // pm2.claude-bridge), which is independent of the heartbeat (pushed by
  // pm2.claude-bridge-ping). Codex audit 2026-06-17 [medium]: gating remote
  // actions on a stale heartbeat disabled the exact Restart that recovers a
  // dead claude-bridge-ping. So remote stays actionable; a truly-down bridge
  // surfaces a clear error from the POST instead of a greyed-out button.
  const bridgeBlocks = !remoteControl && !bridgeOnline;
  const disabledHint = bridgeBlocks ? "Local bridge offline — can't reach this worker" : undefined;

  return (
    <div className="mt-2 flex items-center gap-1.5">
      <ActionButton
        icon={busy === "start" ? Loader2 : Play}
        spin={busy === "start"}
        label="Start"
        disabled={bridgeBlocks || busy !== null || !canStart}
        title={
          disabledHint ||
          (!canStart ? "Already running" : "Start this worker")
        }
        onClick={() => handle("start")}
      />
      <ActionButton
        icon={busy === "stop" ? Loader2 : Square}
        spin={busy === "stop"}
        label="Stop"
        disabled={bridgeBlocks || busy !== null || !canStop}
        title={
          disabledHint ||
          (!canStop ? "Already stopped" : "Stop this worker")
        }
        onClick={() => handle("stop")}
      />
      <ActionButton
        icon={busy === "restart" ? Loader2 : RotateCw}
        spin={busy === "restart"}
        label="Restart"
        disabled={bridgeBlocks || busy !== null}
        title={disabledHint || "Restart this worker"}
        onClick={() => handle("restart")}
      />
      {feedback && (
        <span className={`text-[10px] font-mono ${feedback.ok ? "text-status-engaged" : "text-status-warm"}`}>
          {feedback.text}
        </span>
      )}
    </div>
  );
}

function ActionButton({
  icon: Icon,
  spin,
  label,
  disabled,
  title,
  onClick,
}: {
  icon: typeof Play;
  spin?: boolean;
  label: string;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1 rounded-md border border-bg-border bg-bg-elev/50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-fg-muted hover:bg-bg-elev hover:text-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <Icon className={`w-3 h-3 ${spin ? "animate-spin" : ""}`} />
      {label}
    </button>
  );
}

function formatUptime(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
