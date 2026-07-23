"use client";

/**
 * BackgroundWorkersPanel — read-only view of the operator's local PM2
 * daemons + standalone Skool daemon. Renders below the cron-jobs list on
 * /automations so the operator can see at a glance:
 *   - Which background workers should be running on their machine
 *   - Which are alive (status: healthy) vs stopped (down) vs unknown
 *     (bridge hasn't pushed a snapshot recently)
 *   - When each was last reported
 *
 * The bridge daemon (bravo_cli/local_bridge.py) is what populates the
 * underlying data — it calls `pm2 jlist` on each 60s heartbeat and POSTs
 * the snapshot to /api/bridge/ping. If the bridge itself is offline, this
 * panel will say so + degrade gracefully (all workers as "unknown").
 */

import { useEffect, useState } from "react";
import { Cpu, CheckCircle2, AlertCircle, MinusCircle, HelpCircle, Activity, Play, Square, RotateCw, Loader2 } from "lucide-react";

const BRIDGE_BASE =
  process.env.NEXT_PUBLIC_BRIDGE_CHAT_BASE || "http://localhost:9100";

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
  metadata: Record<string, unknown>;
  last_ping_at: string | null;
  /** True when the worker is registered with pm2 and the dashboard's
   * Start/Stop/Restart buttons can drive it. False for standalone
   * Python scripts (Skool engine) — UI hides the buttons. */
  manageable_via_pm2?: boolean;
  archived_on?: string;
  archived_reason?: string;
  /** B4 (2026-07-23): who this daemon belongs to. The API always sends this
   * now (defaults "cc" server-side for the pre-existing CC-only worker list)
   * — optional here only as a defensive fallback against a stale API. */
  owner?: "cc" | "adon" | "shared";
};

const OWNER_GROUP_LABEL: Record<"cc" | "adon" | "shared", string> = {
  cc: "CC",
  adon: "Adon — Breeze / MCA underwriting",
  shared: "Shared",
};
// Fixed display order so the grouping doesn't reshuffle between refreshes.
const OWNER_GROUP_ORDER: Array<"cc" | "adon" | "shared"> = ["cc", "adon", "shared"];

type ApiResponse = {
  ok: boolean;
  bridge_online: boolean;
  last_seen_at: string | null;
  workers: Worker[];
  /** When true, worker actions route through the server-side bridge proxy
   * (SunBiz VPS daemons) instead of the operator's localhost bridge. */
  remote_control?: boolean;
  error?: string;
};

export function BackgroundWorkersPanel() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/automations/background-workers");
      const j = (await res.json()) as ApiResponse;
      if (!j.ok) {
        setError(j.error || `http_${res.status}`);
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

  const active = data.workers.filter((w) => w.status !== "archived");
  const healthy = active.filter((w) => w.status === "healthy").length;
  const total = active.length;

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
        {data.last_seen_at && (
          <div className="text-[11px] text-fg-dim inline-flex items-center gap-1.5">
            <Activity className="w-3 h-3" />
            Bridge last seen {new Date(data.last_seen_at).toLocaleTimeString()}
          </div>
        )}
      </div>

      {!data.bridge_online && (
        <div className="rounded-lg border border-bg-border bg-bg-deep/40 p-3 text-xs text-fg-muted">
          {data.remote_control ? (
            <>
              The VPS heartbeat hasn&apos;t landed in the last 2 minutes — the
              statuses below may be lagging. The controls still work: hit{" "}
              <span className="font-mono text-fg">Restart</span> on the
              &ldquo;Bridge heartbeat&rdquo; worker to recover it.
            </>
          ) : (
            <>
              Bridge hasn&apos;t pinged in the last 2 minutes — worker statuses
              below may be stale. Run <span className="font-mono text-fg">pm2 restart claude-bridge-ping</span> on your machine.
            </>
          )}
        </div>
      )}

      {(() => {
        // B4 (2026-07-23): group by owner (cc / adon / shared) so a mixed
        // worker list (SunBiz core + Breeze/MCA underwriting daemons) reads
        // as two clearly-attributed sets instead of one undifferentiated
        // grid. Skip the group headers entirely when everything belongs to
        // one owner (e.g. CC's own OASIS worker list has no adon entries) —
        // no reason to add label noise to the common single-owner case.
        const byOwner = new Map<"cc" | "adon" | "shared", Worker[]>();
        for (const w of data.workers) {
          const owner = w.owner ?? "cc";
          const list = byOwner.get(owner) ?? [];
          list.push(w);
          byOwner.set(owner, list);
        }
        const groupsPresent = OWNER_GROUP_ORDER.filter((o) => (byOwner.get(o)?.length ?? 0) > 0);
        const showGroupHeaders = groupsPresent.length > 1;

        if (!showGroupHeaders) {
          return (
            <div className="grid sm:grid-cols-2 gap-2">
              {data.workers.map((w) => (
                <WorkerRow
                  key={w.service}
                  worker={w}
                  bridgeOnline={data.bridge_online}
                  remoteControl={data.remote_control || false}
                  onChange={refresh}
                />
              ))}
            </div>
          );
        }

        return (
          <div className="space-y-4">
            {groupsPresent.map((owner) => (
              <div key={owner} className="space-y-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-fg-dim">
                  {OWNER_GROUP_LABEL[owner]}
                </div>
                <div className="grid sm:grid-cols-2 gap-2">
                  {(byOwner.get(owner) ?? []).map((w) => (
                    <WorkerRow
                      key={w.service}
                      worker={w}
                      bridgeOnline={data.bridge_online}
                      remoteControl={data.remote_control || false}
                      onChange={refresh}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

/** PM2 control actions exposed in the UI. */
type WorkerAction = "start" | "stop" | "restart";

/**
 * Drive pm2 from the dashboard. Two routes:
 *   - LOCAL (operator's machine): the browser POSTs the bridge's localhost
 *     exec-tool directly (Vercel can't reach localhost).
 *   - REMOTE (SunBiz VPS daemons): route through the server-side proxy
 *     /api/automations/background-workers/control, which holds the bridge
 *     bearer + allowlists the command. The browser never sees the bearer and
 *     can only ask for `pm2 <action> <allowlisted-name>`.
 *
 * service is the full Worker.service string ("pm2.claude-bridge"). The
 * pm2 CLI wants the name without the prefix.
 */
async function runWorkerAction(
  service: string,
  action: WorkerAction,
  remoteControl: boolean,
): Promise<{ ok: boolean; output: string }> {
  // Strip "pm2." prefix if present; defense-in-depth allowlist of allowed
  // characters keeps the bash injection surface to literal pm2 names.
  const name = service.replace(/^pm2\./, "");
  if (!/^[a-z0-9._-]+$/i.test(name)) {
    return { ok: false, output: "invalid_service_name" };
  }
  try {
    const res = remoteControl
      ? await fetch(`/api/automations/background-workers/control`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ service, action }),
        })
      : await fetch(`${BRIDGE_BASE}/exec-tool`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tool_name: "bash",
            input: { command: `pm2 ${action} ${name}` },
          }),
        });
    const data = (await res.json()) as { ok?: boolean; output?: string; is_error?: boolean; error?: string };
    if (!res.ok || data.ok === false || data.is_error === true) {
      return { ok: false, output: data.error || data.output || `http_${res.status}` };
    }
    return { ok: true, output: data.output || "ok" };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : "network_failure" };
  }
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

  const Icon =
    effectiveStatus === "healthy"
      ? CheckCircle2
      : effectiveStatus === "down"
        ? MinusCircle
        : effectiveStatus === "degraded"
          ? AlertCircle
          : HelpCircle;
  const iconClass =
    effectiveStatus === "healthy"
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

  const statusLabel =
    effectiveStatus === "healthy"
      ? uptimeStr
        ? `Running · up ${uptimeStr}`
        : "Running"
      : effectiveStatus === "down"
        ? "Stopped"
        : effectiveStatus === "degraded"
          ? "Degraded — check logs"
          : "Not running on your machine";

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
        effectiveStatus === "healthy"
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
          </div>
          <div className="text-[11px] text-fg-muted mt-0.5 leading-relaxed">{worker.purpose}</div>
          <div className="text-[11px] text-fg-dim mt-1">
            {statusLabel}
          </div>
          <WorkerActions
            service={worker.service}
            bridgeOnline={bridgeOnline}
            remoteControl={remoteControl}
            status={effectiveStatus}
            // pm2-controllable? Pass through so WorkerActions can disable
            // the buttons for standalones (Skool) without hiding them —
            // hiding was confusing CC ("I don't see the three buttons").
            // Disabled + tooltip is clearer than absent.
            pm2Managed={worker.manageable_via_pm2 !== false}
            onOptimistic={setOptimisticStatus}
            onChange={onChange}
          />
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
  pm2Managed = true,
  onOptimistic,
  onChange,
}: {
  service: string;
  bridgeOnline: boolean;
  /** Route actions through the server-side bridge proxy (SunBiz VPS). */
  remoteControl: boolean;
  status: Worker["status"];
  /** When false, the worker isn't registered with pm2 (e.g., Skool engine
   * owns its own lock file). Buttons render but stay disabled with a
   * tooltip explaining why — hiding them confused CC ("I don't see the
   * three buttons under it to start or stop it"). */
  pm2Managed?: boolean;
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
  // Disable reasons stack. Most specific wins (non-pm2 wins over bridge
  // offline wins over already-running/stopped) so the tooltip always
  // surfaces the most actionable reason.
  const nonPm2Hint = !pm2Managed
    ? "Standalone — manages its own lifecycle outside pm2. Start / stop via direct CLI."
    : undefined;
  // Heartbeat freshness only blocks the LOCAL path (browser → localhost bridge):
  // if that bridge is offline the browser can't reach it. For the REMOTE path
  // the control POST goes server-side to the VPS exec-tool (hosted by
  // pm2.claude-bridge), which is independent of the heartbeat (pushed by
  // pm2.claude-bridge-ping). Codex audit 2026-06-17 [medium]: gating remote
  // actions on a stale heartbeat disabled the exact Restart that recovers a
  // dead claude-bridge-ping. So remote stays actionable; a truly-down bridge
  // surfaces a clear error from the POST instead of a greyed-out button.
  const bridgeBlocks = !remoteControl && !bridgeOnline;
  const disabledHint = nonPm2Hint || (bridgeBlocks ? "Bridge offline — can't reach pm2" : undefined);

  return (
    <div className="mt-2 flex items-center gap-1.5">
      <ActionButton
        icon={busy === "start" ? Loader2 : Play}
        spin={busy === "start"}
        label="Start"
        disabled={!pm2Managed || bridgeBlocks || busy !== null || !canStart}
        title={
          disabledHint ||
          (!canStart ? "Already running" : "Start this worker via pm2")
        }
        onClick={() => handle("start")}
      />
      <ActionButton
        icon={busy === "stop" ? Loader2 : Square}
        spin={busy === "stop"}
        label="Stop"
        disabled={!pm2Managed || bridgeBlocks || busy !== null || !canStop}
        title={
          disabledHint ||
          (!canStop ? "Already stopped" : "Stop this worker via pm2")
        }
        onClick={() => handle("stop")}
      />
      <ActionButton
        icon={busy === "restart" ? Loader2 : RotateCw}
        spin={busy === "restart"}
        label="Restart"
        disabled={!pm2Managed || bridgeBlocks || busy !== null}
        title={disabledHint || "Restart this worker via pm2"}
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
