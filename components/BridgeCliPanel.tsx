"use client";

/**
 * BridgeCliPanel — live status of the per-CLI install on the operator's
 * local bridge. Polls the bridge at http://localhost:9100/diagnostics/cli
 * directly from the browser (the dashboard is on Vercel and can't reach
 * localhost itself, but the user's browser CAN — same pattern the chat
 * widget uses for /exec-tool).
 *
 * Renders three rows: Claude · Codex · Gemini. Each row shows installed/
 * missing badge, the resolved path, and the --version string. Refreshes
 * every 20s while the page is visible.
 *
 * Two-state fallback when the localhost probe fails (matters because the
 * sidebar reads a different signal — bridge_pairings.last_seen_at — and
 * we used to contradict it):
 *   - serverBridgeOnline === true → AMBER "online but unreachable from
 *     this browser". The daemon is heartbeating to the DB; this browser
 *     just can't reach localhost:9100 (common when on a different machine
 *     or when the browser is blocking localhost calls).
 *   - serverBridgeOnline === false / null → RED "bridge isn't reachable".
 *     Neither signal is fresh; the daemon is genuinely down.
 */

import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, AlertTriangle, Info, Loader2 } from "lucide-react";

const BRIDGE_BASE =
  process.env.NEXT_PUBLIC_BRIDGE_CHAT_BASE || "http://localhost:9100";
const POLL_MS = 20_000;

type CliStatus = {
  installed: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
};

type DiagnosticsResponse = {
  ok: boolean;
  platform: string;
  cli: Record<string, CliStatus>;
  search_paths: string[];
};

type FetchState = {
  loading: boolean;
  reachable: boolean;
  data: DiagnosticsResponse | null;
  error: string | null;
};

export function BridgeCliPanel({
  serverBridgeOnline = null,
}: {
  /** Server-side bridge_pairings freshness check from the page's
   * getBridgeOnline() call. When the localhost probe fails but this is
   * true, we render the amber "online elsewhere" state instead of red. */
  serverBridgeOnline?: boolean | null;
}) {
  const [state, setState] = useState<FetchState>({
    loading: true,
    reachable: false,
    data: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const res = await fetch(`${BRIDGE_BASE}/diagnostics/cli`, {
          method: "GET",
          signal: controller.signal,
          cache: "no-store",
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`probe_${res.status}`);
        const body = (await res.json()) as DiagnosticsResponse;
        if (!cancelled) {
          setState({ loading: false, reachable: true, data: body, error: null });
        }
      } catch (e) {
        if (!cancelled) {
          setState({
            loading: false,
            reachable: false,
            data: null,
            error: e instanceof Error ? e.message : "probe_failed",
          });
        }
      }
    }
    void probe();
    const iv = window.setInterval(() => void probe(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, []);

  if (state.loading) {
    return (
      <div className="flex items-center gap-2 text-fg-muted text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Probing local bridge…</span>
      </div>
    );
  }

  if (!state.reachable) {
    // The localhost probe failed. Decide tone from the server-side
    // heartbeat: if the daemon is heartbeating to bridge_pairings, the
    // bridge IS running — this browser just can't reach it (common when
    // you're on the dashboard from a phone or a different machine than
    // the one running the daemon). Render amber instead of red so the
    // signal matches the sidebar's "BRIDGE ONLINE" badge.
    if (serverBridgeOnline === true) {
      return (
        <div className="rounded-lg border border-accent/40 bg-accent/5 px-3 py-2.5 text-sm flex items-start gap-2">
          <Info className="w-4 h-4 mt-0.5 text-accent flex-shrink-0" />
          <div>
            <div className="font-bold text-accent">Bridge online — but this browser can&apos;t reach it directly</div>
            <div className="text-xs text-fg-muted mt-1 font-sans leading-relaxed">
              Your bridge daemon is heartbeating to the database (sidebar
              shows BRIDGE ONLINE), but this browser can&apos;t reach
              <code className="text-accent"> {BRIDGE_BASE}/diagnostics/cli</code>. That&apos;s normal when
              you&apos;re viewing the dashboard from a different machine
              than the one running the bridge. Per-CLI status will populate
              when you load this page on the bridge machine.
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="rounded-lg border border-status-warm/40 bg-status-warm/5 px-3 py-2.5 text-sm flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 text-status-warm flex-shrink-0" />
        <div>
          <div className="font-bold text-status-warm">Local bridge isn&apos;t reachable</div>
          <div className="text-xs text-fg-muted mt-1 font-sans leading-relaxed">
            The dashboard couldn&apos;t reach <code className="text-accent">{BRIDGE_BASE}/diagnostics/cli</code> and
            no recent heartbeat is on file in <code className="text-accent">bridge_pairings</code>.
            Either the bridge daemon isn&apos;t running or your browser blocked the localhost call.
            Install the desktop app to host the bridge, or run <code className="text-accent">pm2 logs claude-bridge</code> in Terminal.
          </div>
        </div>
      </div>
    );
  }

  const cli = state.data?.cli || {};
  return (
    <div className="space-y-2">
      {(["claude", "codex", "gemini"] as const).map((name) => {
        const entry = cli[name];
        return <CliRow key={name} name={name} entry={entry} />;
      })}
    </div>
  );
}

function CliRow({ name, entry }: { name: string; entry: CliStatus | undefined }) {
  const installed = !!entry?.installed;
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 flex items-start gap-3 ${
        installed
          ? "border-status-engaged/30 bg-status-engaged/5"
          : "border-bg-border bg-bg-elev/40"
      }`}
    >
      {installed ? (
        <CheckCircle2 className="w-4 h-4 mt-0.5 text-status-engaged flex-shrink-0" />
      ) : (
        <XCircle className="w-4 h-4 mt-0.5 text-fg-dim flex-shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold capitalize">{name}</span>
          <span
            className={`text-[10px] uppercase tracking-wider font-bold ${
              installed ? "text-status-engaged" : "text-fg-dim"
            }`}
          >
            {installed ? "found" : "not installed"}
          </span>
        </div>
        {installed ? (
          <div className="mt-1 space-y-0.5 text-xs text-fg-muted font-mono break-all">
            {entry?.path && <div>path: {entry.path}</div>}
            {entry?.version && <div>version: {entry.version}</div>}
            {entry?.error && (
              <div className="text-status-warm">probe error: {entry.error}</div>
            )}
          </div>
        ) : (
          <div className="mt-1 text-xs text-fg-muted font-sans leading-relaxed">
            Not on the bridge&apos;s PATH. Install it and the chat path for {name}-as-provider will start working immediately — no restart needed.
          </div>
        )}
      </div>
    </div>
  );
}
