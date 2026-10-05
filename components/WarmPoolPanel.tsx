"use client";

/**
 * WarmPoolPanel — the chat processes the operator's bridge keeps warm, so the
 * next Coding harness turn skips a 5 to 30 second start.
 *
 * Read through the server (2026-09-30): GET /api/bridge/warm-status asks the
 * bridge with the bearer the Command Center holds. The panel used to fetch the
 * bridge from the browser at the public bridge-base build variable, which the deployed
 * bundle had inlined as http://localhost:3000, so it said "bridge offline?"
 * while the bridge was up; and since the bridge bearer went on (09-29) a
 * browser cannot read it at all. A 401 from the bridge reads "The bridge
 * refused the request (token)", never "offline". Refreshes every 5 s.
 *
 * Row states: busy = a turn in flight; warm = waiting for input, with the idle
 * reaper's countdown (a process is killed after the idle timeout).
 */

import { useEffect, useState } from "react";
import { Activity, Loader2, Zap } from "lucide-react";
import { describeWarmFailure, type WarmPool, type WarmStatusBody } from "@/lib/admin/warm-pool";

export const WARM_STATUS_ROUTE = "/api/bridge/warm-status";

function fmtSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function WarmPoolPanel() {
  const [status, setStatus] = useState<WarmPool | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(WARM_STATUS_ROUTE, { cache: "no-store" });
        const body = (await r.json()) as WarmStatusBody;
        if (!alive) return;
        if (!body.ok) {
          setError(describeWarmFailure(body, r.status));
          return;
        }
        setStatus(body.pool);
        setError(null);
      } catch (e) {
        if (!alive) return;
        console.error("[warm_pool_panel]", e);
        setError("The Command Center didn't answer just now. This is not saying the bridge is down.");
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (error) {
    return <div className="text-xs text-fg-muted">{error}</div>;
  }
  if (!status) {
    return (
      <div className="text-xs text-fg-dim flex items-center gap-2">
        <Loader2 className="w-3 h-3 animate-spin" /> Reading the pool…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-fg-muted">
        {status.size} of {status.max_size} processes · an idle one is closed after {fmtSeconds(status.idle_timeout_s)} · refreshes every 5 s
      </div>
      {status.processes.length === 0 ? (
        <div className="text-xs text-fg-dim">Nothing warm right now. The first Coding harness turn starts one.</div>
      ) : (
        <ul className="divide-y divide-hairline">
          {status.processes.map((p) => {
            const reaperRemaining = Math.max(0, status.idle_timeout_s - p.idle_s);
            const dot = p.busy ? "bg-status-engaged" : p.alive ? "bg-accent" : "bg-status-warm";
            const stateLabel = p.busy ? "busy" : p.alive ? "warm" : "dead";
            return (
              <li key={p.key} className="py-2.5 flex items-start justify-between gap-3 text-xs">
                <div className="flex items-start gap-2.5 min-w-0">
                  <span className={`w-2 h-2 rounded-full shrink-0 mt-1 ${dot}`} title={stateLabel} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-fg">{p.agent}</span>
                      <span className="text-fg-dim font-mono text-[10px]">{p.key}</span>
                    </div>
                    <div className="text-fg-muted mt-0.5">
                      {p.busy ? (
                        <span className="inline-flex items-center gap-1">
                          <Zap className="w-3 h-3 text-status-engaged" /> turn in flight
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <Activity className="w-3 h-3" />
                          warm · idle {fmtSeconds(p.idle_s)} · closes in {fmtSeconds(reaperRemaining)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="text-right text-fg-dim font-mono shrink-0">age {fmtSeconds(p.age_s)}</div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
