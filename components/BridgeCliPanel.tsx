"use client";

/**
 * BridgeCliPanel — which AI command-line tools (Claude Code, Codex, Gemini)
 * the operator's computer has, and whether each is signed in.
 *
 * READ THROUGH THE SERVER (2026-09-30). This panel used to probe the loopback
 * bridge's /diagnostics/cli straight from the browser. Since the bridge
 * bearer went on (BEA 38139ede, 2026-09-29) the bridge answers 401 to anything
 * without the token, loopback included, and the token must never reach a
 * browser. The 401 then fell into "Bridge is online. Per-CLI install status
 * only renders when you load this page on the bridge machine itself", which
 * was false while CC sat at that machine. It now reads /api/bridge/cli-status:
 * the inventory the bridge pushes with its heartbeat, normalised and refused
 * when older than five minutes (lib/bridge-cli-status.ts).
 *
 * States, each said plainly:
 *   - the report: one row per CLI, in lib/bridge-cli-status.ts's words (Ready /
 *     Needs sign-in / Sign-in not confirmed / Not detected);
 *   - no report yet, a stale report, or one the page can't read: said so, next
 *     to what the heartbeat says about the computer (online / offline / unknown);
 *   - the read failed or the session is gone: "Couldn't check" or "signed out",
 *     never "the bridge is down".
 */

import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, AlertTriangle, Info, Loader2 } from "lucide-react";
import { bridgeHostOSFromPlatform, bridgeRecoveryGuidance } from "@/lib/bridge-install-guidance";
import { AGENTS_RUN_ON_UNKNOWN_NOTE, CLI_STATE_LABEL, cliStatusState, machinesOfBody, type CliMachineSnapshot } from "@/lib/bridge-cli-status";

const POLL_MS = 30_000;
export const CLI_STATUS_ROUTE = "/api/bridge/cli-status";

type CliInfo = { installed: boolean; authenticated: boolean; version: string | null; install_hint_url: string; checked?: boolean };
type CliSnapshotBody =
  | { ok: true; machines?: CliMachineSnapshot[]; data?: Record<"claude" | "codex" | "gemini", CliInfo> }
  | { ok: false; reason: string };

type CliPanelRows = Array<{ name: string; info: CliInfo }>;

/** What one poll found. */
export type CliFetchResult =
  | { kind: "body"; status: number; body: CliSnapshotBody }
  | { kind: "network_error"; message: string };

export type CliPanelState = { loading: boolean; result: CliFetchResult | null };

/** PURE. What the panel says for a poll result and the heartbeat verdict. */
export function describeCliPanel(
  serverBridgeOnline: boolean | null,
  result: CliFetchResult,
): {
  tone: "ok" | "warn" | "neutral";
  title: string;
  detail: string;
  /** One group per paired computer (label null = an old-shape report that names none). */
  machines: Array<{ id: string | null; label: string | null; rows: CliPanelRows }> | null;
} {
  if (result.kind === "network_error") {
    return { tone: "neutral", title: "Couldn't check your computer's AI tools", detail: "The Command Center didn't answer just now. This is not saying anything is down. It retries every 30 seconds.", machines: null };
  }
  const { status, body } = result;
  if (status === 401) {
    return { tone: "neutral", title: "You're signed out", detail: "Sign in again to see your computer's AI tools.", machines: null };
  }
  if (body.ok) {
    const machines = machinesOfBody(body);
    if (machines.length > 0) {
      const many = machines.length > 1;
      return {
        tone: "ok",
        title: many ? "Your computers' AI tools" : "Your computer's AI tools",
        detail: many
          ? `Each computer's own report from the last 5 minutes. ${AGENTS_RUN_ON_UNKNOWN_NOTE}`
          : "As your computer's bridge reported them in the last 5 minutes.",
        machines: machines.map((m) => ({
          id: m.id,
          label: m.label,
          rows: (["claude", "codex", "gemini"] as const).map((name) => ({ name, info: m.data[name] })),
        })),
      };
    }
    return { tone: "warn", title: "Your computer sent a report this page can't read", detail: "Updating the bridge on that computer fixes this.", machines: null };
  }
  const heartbeat =
    serverBridgeOnline === true
      ? "Your computer is checking in"
      : serverBridgeOnline === false
        ? "Your computer isn't checking in"
        : "Couldn't check whether your computer is checking in";
  switch (body.reason) {
    case "missing":
      return {
        tone: serverBridgeOnline === false ? "warn" : "neutral",
        title: "No report of your AI tools yet",
        detail: `${heartbeat}, but its bridge hasn't sent a list of its AI tools. An older bridge doesn't send one.`,
        machines: null,
      };
    case "stale":
      return {
        tone: serverBridgeOnline === false ? "warn" : "neutral",
        title: "The last report of your AI tools is out of date",
        detail: `${heartbeat}. The last list it sent is more than 5 minutes old, so it isn't shown.`,
        machines: null,
      };
    case "invalid_inventory":
      return { tone: "warn", title: "Your computer sent a report this page can't read", detail: `${heartbeat}. Updating the bridge on that computer fixes this.`, machines: null };
    default:
      return { tone: "neutral", title: "Couldn't check your computer's AI tools", detail: "The report couldn't be read just now. This is not saying anything is down.", machines: null };
  }
}

export function BridgeCliPanel({
  serverBridgeOnline = null,
}: {
  /** The page's bridge_pairings verdict. null = the page could not read it. */
  serverBridgeOnline?: boolean | null;
}) {
  const [state, setState] = useState<CliPanelState>({ loading: true, result: null });

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      let result: CliFetchResult;
      try {
        const res = await fetch(CLI_STATUS_ROUTE, { cache: "no-store" });
        const body = (await res.json()) as CliSnapshotBody;
        result = { kind: "body", status: res.status, body };
      } catch (e) {
        console.error("[bridge_cli_panel]", e);
        result = { kind: "network_error", message: e instanceof Error ? e.message : "fetch_failed" };
      }
      if (!cancelled) setState({ loading: false, result });
    }
    void poll();
    const iv = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, []);

  if (state.loading || !state.result) {
    return (
      <div className="flex items-center gap-2 text-fg-muted text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Reading your computer&apos;s report…</span>
      </div>
    );
  }

  const view = describeCliPanel(serverBridgeOnline, state.result);
  if (view.machines) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-fg-muted">{view.detail}</p>
        {view.machines.map((m, i) => (
          <div key={m.id ?? m.label ?? `computer-${i}`} className="space-y-2" data-cli-machine={m.label ?? "unlabeled"}>
            {m.label && <div className="text-xs font-bold text-fg">{m.label}</div>}
            {m.rows.map((r) => (
              <CliRow key={r.name} name={r.name} info={r.info} />
            ))}
          </div>
        ))}
      </div>
    );
  }
  const recovery =
    serverBridgeOnline === false
      ? bridgeRecoveryGuidance(bridgeHostOSFromPlatform(typeof navigator === "undefined" ? null : navigator.platform))
      : null;
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 text-sm flex items-start gap-2 ${
        view.tone === "warn" ? "border-status-warm/40 bg-status-warm/5" : "border-hairline bg-bg-panel"
      }`}
    >
      {view.tone === "warn" ? (
        <AlertTriangle className="w-4 h-4 mt-0.5 text-status-warm flex-shrink-0" />
      ) : (
        <Info className="w-4 h-4 mt-0.5 text-fg-dim flex-shrink-0" />
      )}
      <div>
        <div className={`font-semibold ${view.tone === "warn" ? "text-status-warm" : "text-fg"}`}>{view.title}</div>
        <div className="text-xs text-fg-muted mt-1 leading-relaxed">
          {view.detail}
          {recovery ? ` To bring it back: ${recovery}.` : null}
        </div>
      </div>
    </div>
  );
}

function CliRow({ name, info }: { name: string; info: CliInfo }) {
  const label = name === "claude" ? "Claude Code" : name === "codex" ? "Codex" : "Gemini";
  // The words Settings > AI brain uses too (lib/bridge-cli-status.ts): a check
  // that did not finish is "not confirmed", never "not signed in".
  const cli = cliStatusState({ installed: info.installed, authenticated: info.authenticated, checked: info.checked === true });
  const state = CLI_STATE_LABEL[cli];
  const good = cli === "ready";
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 flex items-start gap-3 ${
        good ? "border-status-engaged/30 bg-bg-panel" : "border-hairline bg-bg-panel"
      }`}
    >
      {good ? (
        <CheckCircle2 className="w-4 h-4 mt-0.5 text-status-engaged flex-shrink-0" />
      ) : (
        <XCircle className="w-4 h-4 mt-0.5 text-fg-dim flex-shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-fg">{label}</span>
          <span className={`text-xs ${good ? "text-status-engaged" : "text-fg-muted"}`}>{state}</span>
        </div>
        {info.version && <div className="mt-0.5 text-xs text-fg-dim font-mono break-all">{info.version}</div>}
        {!info.installed && (
          <a href={info.install_hint_url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs text-accent hover:underline">
            How to install {label}
          </a>
        )}
      </div>
    </div>
  );
}
