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
import { Cpu, CheckCircle2, AlertCircle, MinusCircle, HelpCircle, Activity, Archive, Play, Square, RotateCw, Loader2 } from "lucide-react";

const BRIDGE_BASE =
  process.env.NEXT_PUBLIC_BRIDGE_CHAT_BASE || "http://localhost:9100";

type Worker = {
  service: string;
  label: string;
  purpose: string;
  status: "healthy" | "degraded" | "down" | "unconfigured" | "archived";
  metadata: Record<string, unknown>;
  last_ping_at: string | null;
  archived_on?: string;
  archived_reason?: string;
};

type ApiResponse = {
  ok: boolean;
  bridge_online: boolean;
  last_seen_at: string | null;
  workers: Worker[];
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
          Bridge hasn&apos;t pinged in the last 2 minutes — worker statuses
          below may be stale. Run <span className="font-mono text-fg">pm2 restart claude-bridge-ping</span> on your machine.
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-2">
        {data.workers.map((w) => (
          <WorkerRow key={w.service} worker={w} bridgeOnline={data.bridge_online} onChange={refresh} />
        ))}
      </div>
    </div>
  );
}

/** PM2 control actions exposed in the UI. */
type WorkerAction = "start" | "stop" | "restart";

/**
 * Drive pm2 from the dashboard via the bridge's exec-tool endpoint.
 * The bridge listens on localhost:9100 so the browser POSTs directly
 * (same pattern ChatWidget uses for cloud_bridge_tools). Server-side
 * proxying from Vercel isn't possible because Vercel can't reach the
 * operator's localhost.
 *
 * service is the full Worker.service string ("pm2.claude-bridge"). The
 * pm2 CLI wants the name without the prefix.
 */
async function runWorkerAction(service: string, action: WorkerAction): Promise<{ ok: boolean; output: string }> {
  // Strip "pm2." prefix if present; defense-in-depth allowlist of allowed
  // characters keeps the bash injection surface to literal pm2 names.
  const name = service.replace(/^pm2\./, "");
  if (!/^[a-z0-9._-]+$/i.test(name)) {
    return { ok: false, output: "invalid_service_name" };
  }
  try {
    const res = await fetch(`${BRIDGE_BASE}/exec-tool`, {
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
  onChange,
}: {
  worker: Worker;
  bridgeOnline: boolean;
  onChange: () => void | Promise<void>;
}) {
  if (worker.status === "archived") {
    return (
      <div
        className="rounded-lg border border-bg-border bg-bg-deep/30 p-3 opacity-60"
        title={`Archived ${worker.archived_on || ""}`}
      >
        <div className="flex items-start gap-2">
          <Archive className="w-4 h-4 shrink-0 mt-0.5 text-fg-dim" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <div className="font-bold text-sm text-fg-muted truncate line-through">
                {worker.label}
              </div>
              <span className="text-[10px] uppercase tracking-wider text-fg-dim border border-bg-border rounded-full px-1.5 py-0.5">
                Archived{worker.archived_on ? ` ${worker.archived_on}` : ""}
              </span>
            </div>
            <div className="text-[11px] text-fg-dim mt-1 leading-relaxed">
              {worker.archived_reason || "Not currently running or live."}
            </div>
          </div>
        </div>
      </div>
    );
  }
  const Icon =
    worker.status === "healthy"
      ? CheckCircle2
      : worker.status === "down"
        ? MinusCircle
        : worker.status === "degraded"
          ? AlertCircle
          : HelpCircle;
  const iconClass =
    worker.status === "healthy"
      ? "text-status-engaged"
      : worker.status === "down"
        ? "text-status-warm"
        : worker.status === "degraded"
          ? "text-accent"
          : "text-fg-dim";
  // metadata fields the bridge pushes: pm2_status, pid, restart_count,
  // uptime_ms, memory_bytes, cpu_pct. Render the operator-meaningful
  // subset on the row; pid + memory + cpu live in the hover-only tooltip
  // (title attr) so the card stays scannable.
  // Metadata field names mirror what detect_pm2_daemons() in
  // bravo_cli/local_bridge.py writes — keep these two in sync.
  const meta = worker.metadata || {};
  const pid = (meta.pid as number) || 0;
  const restartCount = (meta.restart_count as number) || 0;
  const uptimeMs = (meta.uptime_ms as number) || 0;
  const memBytes = (meta.memory_bytes as number) || 0;
  const cpuPct = (meta.cpu_pct as number) || 0;
  const memMb = memBytes ? Math.round(memBytes / 1024 / 1024) : 0;
  const uptimeStr = uptimeMs ? formatUptime(Date.now() - uptimeMs) : null;

  return (
    <div
      className={`rounded-lg border p-3 ${
        worker.status === "healthy"
          ? "border-bg-border bg-bg-elev/30"
          : worker.status === "down"
            ? "border-status-warm/30 bg-status-warm/5"
            : "border-bg-border bg-bg-deep/40 opacity-80"
      }`}
      title={pid ? `PID ${pid} · ${memMb}MB · ${cpuPct}% CPU · ${restartCount} restarts` : worker.service}
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
          {uptimeStr && (
            <div className="text-[10px] text-fg-dim mt-1 font-mono">
              up {uptimeStr}
              {restartCount > 0 ? ` · ${restartCount} restart${restartCount === 1 ? "" : "s"}` : ""}
              {memMb > 0 ? ` · ${memMb}MB` : ""}
            </div>
          )}
          {worker.status === "unconfigured" && (
            <div className="text-[10px] text-fg-dim mt-1 italic">
              Not running on your machine.
            </div>
          )}
          <WorkerActions service={worker.service} bridgeOnline={bridgeOnline} status={worker.status} onChange={onChange} />
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
  status,
  onChange,
}: {
  service: string;
  bridgeOnline: boolean;
  status: Worker["status"];
  onChange: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<WorkerAction | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  async function handle(action: WorkerAction) {
    setBusy(action);
    setFeedback(null);
    const result = await runWorkerAction(service, action);
    setBusy(null);
    setFeedback({ ok: result.ok, text: result.ok ? `${action} ✓` : `${action} failed: ${result.output.slice(0, 80)}` });
    // Hide feedback after 3s.
    setTimeout(() => setFeedback(null), 3000);
    // Whether the call succeeded or failed, refresh the panel so the
    // operator sees the current pm2 state.
    await onChange();
  }

  const canStart = status !== "healthy";
  const canStop = status === "healthy" || status === "degraded";
  const disabledHint = !bridgeOnline
    ? "Bridge offline — can't reach pm2"
    : undefined;

  return (
    <div className="mt-2 flex items-center gap-1.5">
      <ActionButton
        icon={busy === "start" ? Loader2 : Play}
        spin={busy === "start"}
        label="Start"
        disabled={!bridgeOnline || busy !== null || !canStart}
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
        disabled={!bridgeOnline || busy !== null || !canStop}
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
        disabled={!bridgeOnline || busy !== null}
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
