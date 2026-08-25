"use client";

/**
 * LocalCliProvidersCard — second SETTINGS section: "Connect via local
 * CLI subscription".
 *
 * Phase 8.2 of the OASIS HQ redesign. CC wants a parallel UX path to
 * the API-key cards: instead of pasting an Anthropic / OpenAI key, the
 * operator can run their EXISTING Claude Code, Codex CLI, or Gemini CLI
 * subscription. The bridge already spawns `claude -p` for the chat
 * surface — this card just makes the same capability visible + adds
 * Codex / Gemini parity.
 *
 * Detection flow:
 *   1. The paired bridge runs `claude --version`,
 *      scripts/codex_health.py --json, and `gemini --version` locally.
 *   2. Its pairing-token-authenticated heartbeat publishes a safe snapshot.
 *   3. Component mounts → GET /api/bridge/cli-status, which returns
 *      {claude, codex, gemini: {installed, authenticated,
 *      version, install_hint_url}}
 *   4. Each card renders one of: Ready / Needs auth / Not installed.
 *
 * Reachability and heartbeat are separate signals. A fresh tenant heartbeat
 * renders "online, inventory unavailable" if this browser's probe fails;
 * "offline" appears only when both signals are down.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, AlertCircle, Terminal, RefreshCw } from "lucide-react";
import { Card, Tag } from "@/components/Card";
import { bridgeClientUrl, isProxyModeRuntime } from "@/lib/bridge-client-routing";
import { deriveDropdownState } from "@/lib/bridge-dropdown-state";
import {
  readCliRuntime,
  writeCliRuntime,
  type CliRuntime,
} from "@/lib/cli-runtime";

type CliInfo = {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  install_hint_url: string;
};

type CliStatusResponse = {
  claude: CliInfo;
  codex: CliInfo;
  gemini: CliInfo;
};

type ProbeState =
  | { kind: "loading" }
  | { kind: "bridge_unreachable" }
  | { kind: "error"; message: string }
  | { kind: "ok"; data: CliStatusResponse };

const CARDS: Array<{
  key: keyof CliStatusResponse;
  label: string;
  blurb: string;
  install_url: string;
  install_command: string;
}> = [
  {
    key: "claude",
    label: "Claude Code",
    blurb: "Uses your Claude Max / Pro subscription. Spawns the local `claude` CLI.",
    install_url: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
    install_command: "npm install -g @anthropic-ai/claude-code",
  },
  {
    key: "codex",
    label: "Codex CLI",
    blurb: "Uses your OpenAI subscription via the Codex CLI / plugin.",
    install_url: "https://github.com/openai/codex",
    install_command: "npm install -g @openai/codex",
  },
  {
    key: "gemini",
    label: "Gemini CLI",
    blurb: "Uses your Google AI Studio account via the Gemini CLI.",
    install_url: "https://github.com/google-gemini/gemini-cli",
    install_command: "npm install -g @google/gemini-cli",
  },
];

async function probeCliStatus(signal: AbortSignal): Promise<ProbeState> {
  try {
    const r = await fetch("/api/bridge/cli-status", { signal, cache: "no-store" });
    if (!r.ok) {
      return { kind: "error", message: `bridge returned ${r.status}` };
    }
    const body = (await r.json()) as {
      ok?: boolean;
      data?: CliStatusResponse;
      reason?: string;
    };
    if (!body.ok || !body.data) {
      return { kind: "bridge_unreachable" };
    }
    return { kind: "ok", data: body.data };
  } catch (err) {
    // AbortError fires when the 10s timeout in the caller elapses. The
    // previous return `{ kind: "loading" }` left the spinner forever
    // because the parent state never moved off "loading" — exactly the
    // perpetual-spinner bug CC reported. Surface as bridge_unreachable
    // instead: if the probe couldn't complete in 10s the local bridge
    // is effectively unreachable from the operator's POV, and the
    // bridge-offline card already has the right "install + refresh"
    // affordance.
    if ((err as Error).name === "AbortError") {
      return { kind: "bridge_unreachable" };
    }
    return { kind: "error", message: (err as Error).message };
  }
}

function statusFor(info: CliInfo): { label: string; tone: "engaged" | "warm" | "neutral"; icon: React.ReactNode } {
  if (info.installed && info.authenticated) {
    return { label: "Ready", tone: "engaged", icon: <CheckCircle2 className="w-3.5 h-3.5" /> };
  }
  if (info.installed && !info.authenticated) {
    return { label: "Needs auth", tone: "warm", icon: <AlertCircle className="w-3.5 h-3.5" /> };
  }
  return { label: "Not installed", tone: "neutral", icon: <Terminal className="w-3.5 h-3.5" /> };
}

type Busy =
  | { kind: "idle" }
  | { kind: "installing"; provider: keyof CliStatusResponse }
  | { kind: "authing"; provider: keyof CliStatusResponse };

// Key, type and accessors all come from lib/cli-runtime, which the chat header
// also imports. This file used to declare its own copy of the literal plus its
// own reader, synchronised with ChatWidget by a comment — a contract enforced
// by a comment is not enforced.

export function LocalCliProvidersCard({
  serverBridgeOnline,
}: {
  serverBridgeOnline: boolean;
}) {
  const [state, setState] = useState<ProbeState>({ kind: "loading" });
  const [busy, setBusy] = useState<Busy>({ kind: "idle" });
  const [localActionsAvailable, setLocalActionsAvailable] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Persistent CLI selection — same key the ChatWidget reads. Selecting
  // a CLI here flips the chat header dropdown on next render too.
  const [activeCli, setActiveCli] = useState<CliRuntime>("claude");
  useEffect(() => {
    setActiveCli(readCliRuntime());
    // A hosted dashboard can read the outbound, pairing-authenticated
    // heartbeat, but it cannot prove that a tenant bridge proxy points back
    // to the same paired machine. Only allow install/auth mutations when the
    // dashboard itself is loaded on loopback, where /exec-tool necessarily
    // targets this browser's machine.
    setLocalActionsAvailable(!isProxyModeRuntime());
  }, []);

  function chooseCli(next: CliRuntime) {
    setActiveCli(next);
    // Storage failures are swallowed inside writeCliRuntime: the in-memory
    // state already updated, so the click registers even where storage is off.
    writeCliRuntime(next);
  }

  async function refresh() {
    setState({ kind: "loading" });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    const next = await probeCliStatus(ctl.signal);
    clearTimeout(timer);
    setState(next);
  }

  /**
   * Invoke a bridge tool with a {provider} payload and return the
   * parsed result. Shared by Install + Sign-in buttons.
   */
  async function runBridgeTool(toolName: "install_cli" | "cli_auth_start", provider: keyof CliStatusResponse) {
    if (!localActionsAvailable) {
      return {
        ok: false as const,
        text: "For safety, hosted Settings cannot run commands on an unverified tenant bridge. Run the shown command on the paired machine, then click Refresh.",
      };
    }
    const ctl = new AbortController();
    // npm install can take up to 5 minutes on first run; auth_start
    // returns immediately. 5.5 min ceiling covers both.
    const timer = setTimeout(() => ctl.abort(), 330_000);
    try {
      const r = await fetch(bridgeClientUrl("exec-tool"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool_name: toolName, input: { provider } }),
        signal: ctl.signal,
      });
      const body = (await r.json().catch(() => ({}))) as { output?: string; is_error?: boolean };
      if (!r.ok || body.is_error) {
        return { ok: false as const, text: body.output || `http_${r.status}` };
      }
      return { ok: true as const, text: body.output || "" };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return { ok: false as const, text: "Bridge call timed out." };
      }
      return { ok: false as const, text: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  async function handleInstall(provider: keyof CliStatusResponse) {
    setBusy({ kind: "installing", provider });
    setActionMessage(null);
    const res = await runBridgeTool("install_cli", provider);
    setActionMessage({ kind: res.ok ? "ok" : "err", text: res.text });
    setBusy({ kind: "idle" });
    // Re-probe so the card flips to Ready / Needs auth automatically.
    await refresh();
  }

  async function handleSignIn(provider: keyof CliStatusResponse) {
    setBusy({ kind: "authing", provider });
    setActionMessage(null);
    const res = await runBridgeTool("cli_auth_start", provider);
    setActionMessage({ kind: res.ok ? "ok" : "err", text: res.text });
    setBusy({ kind: "idle" });
    // Claude Code has no auth subcommand — the bridge returns guidance
    // text only and there's no OAuth flow to poll for. Polling cli_status
    // every 3s for 2 minutes would just burn cycles waiting for an event
    // that requires the operator to manually run `claude /login` first.
    // Skip the polling loop entirely; operator clicks Refresh when done.
    if (!res.ok || provider === "claude") return;

    // Codex + Gemini: OAuth round-trip is operator-driven (they click
    // "Sign in" in their browser tab). Poll cli_status every 3s, in-
    // flight guarded so a slow probe doesn't stack with the next tick.
    const startMs = Date.now();
    let probeInFlight = false;
    const poll = async () => {
      if (Date.now() - startMs > 120_000) return;
      if (probeInFlight) {
        setTimeout(() => void poll(), 3_000);
        return;
      }
      probeInFlight = true;
      try {
        const next = await probeCliStatus(new AbortController().signal);
        setState(next);
        if (
          next.kind === "ok" &&
          next.data[provider]?.installed &&
          next.data[provider]?.authenticated
        ) {
          setActionMessage({ kind: "ok", text: `${provider} is ready.` });
          return;
        }
      } finally {
        probeInFlight = false;
      }
      setTimeout(() => void poll(), 3_000);
    };
    setTimeout(() => void poll(), 3_000);
  }

  useEffect(() => {
    void refresh();

  }, []);

  return (
    <Card
      title="Local AI CLIs"
      subtitle="See the CLIs reported by your paired machine and choose which one powers local-bridge chat. Setup commands run directly only when this dashboard is opened on that machine; hosted Settings fails closed and shows the exact local command instead."
      action={
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={state.kind === "loading"}
          className="text-xs text-fg-dim hover:text-accent inline-flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${state.kind === "loading" ? "animate-spin" : ""}`} />
          Refresh
        </button>
      }
    >
      {state.kind === "loading" && (
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 className="w-4 h-4 animate-spin" />
          Probing local CLIs...
        </div>
      )}

      {state.kind === "bridge_unreachable" && deriveDropdownState(false, serverBridgeOnline) === "degraded" && (
        <div className="flex items-start gap-2 text-sm text-accent bg-accent/5 border border-accent/30 rounded-lg p-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold">Bridge online · CLI inventory syncing</div>
            <p className="mt-1 text-xs text-fg-muted leading-relaxed">
              The paired bridge is online, matching the sidebar, but its latest CLI inventory has not reached this workspace yet. Refresh after the next heartbeat; installed status is unknown—not offline.
            </p>
            <Link
              href="/settings#devices"
              className="mt-2 inline-flex text-xs font-bold text-accent hover:text-accent-bright"
            >
              View paired devices →
            </Link>
          </div>
        </div>
      )}

      {state.kind === "bridge_unreachable" && deriveDropdownState(false, serverBridgeOnline) === "offline" && (
        <div className="flex items-start gap-2 text-sm text-status-warm bg-status-warm/5 border border-status-warm/30 rounded-lg p-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold">Bridge offline</div>
            <p className="mt-1 text-xs text-fg-muted leading-relaxed">
              These cards probe your machine for installed CLIs, which needs the bridge
              running here. Until it is, the dashboard can&apos;t tell which CLIs you have —
              that&apos;s an unknown, not a &ldquo;none installed&rdquo;.
            </p>
            {/* A LINK, not a treasure hunt. This used to say "use the Install
                Claude Code CLI bridge button in Devices above", which asks the
                operator to scroll and pattern-match for a control that already
                has its own route. If the next step is known, it should be one
                click, not a set of directions. */}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Link
                href="/settings/devices/install"
                className="btn-primary inline-flex items-center gap-1.5 !text-xs !py-1.5"
              >
                <Terminal className="w-3 h-3" />
                Install the bridge
              </Link>
              <span className="text-[11px] text-fg-dim">
                Already installed? Start it on this machine, then Refresh above.
              </span>
            </div>
          </div>
        </div>
      )}

      {state.kind === "error" && (
        <div className="flex items-start gap-2 text-sm text-status-hot bg-status-hot/5 border border-status-hot/30 rounded-lg p-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold">CLI probe failed</div>
            <p className="mt-1 text-xs text-fg-muted">{state.message}</p>
          </div>
        </div>
      )}

      {actionMessage && (
        <div
          className={`mb-3 rounded-md border p-2.5 text-[11.5px] leading-relaxed whitespace-pre-wrap ${
            actionMessage.kind === "ok"
              ? "border-status-engaged/30 bg-status-engaged/10 text-status-engaged"
              : "border-status-warm/30 bg-status-warm/10 text-status-warm"
          }`}
        >
          {actionMessage.text}
        </div>
      )}

      {state.kind === "ok" && (
        <>
          {/* Active CLI picker — surfaces the same selection the chat
              header dropdown shows. Operator picks here once and every
              chat session uses that subscription until they change it.
              Disabled options (not installed / not auth'd) still render
              as radios so the operator sees the full set + can click
              Install on the card below. */}
          <div className="mb-3 rounded-lg border border-bg-border bg-bg-elev/30 p-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-xs font-bold uppercase tracking-wider text-fg">
                  Active CLI
                </div>
                <div className="text-[11px] text-fg-muted mt-0.5 leading-snug">
                  Which local CLI powers the chat when you talk to an agent in
                  local-bridge mode. This also drives the dropdown in the chat
                  header.
                </div>
              </div>
              <div role="radiogroup" aria-label="Active CLI" className="flex flex-wrap gap-1.5">
                {CARDS.map((card) => {
                  const info = state.data[card.key];
                  const ready = info.installed && info.authenticated;
                  const selected = activeCli === card.key;
                  return (
                    <button
                      key={card.key}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => chooseCli(card.key)}
                      disabled={!ready}
                      title={ready ? `Use ${card.label} for chat` : `${card.label} isn't ready yet`}
                      className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-md border transition-colors ${
                        selected
                          ? "border-accent bg-accent/15 text-accent"
                          : ready
                            ? "border-bg-border bg-bg-deep/60 text-fg-muted hover:text-fg hover:border-accent/40"
                            : "border-bg-border bg-bg-deep/30 text-fg-faint opacity-60 cursor-not-allowed"
                      }`}
                    >
                      {card.label}
                      {selected && <span className="ml-1.5">✓</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        <div className="grid sm:grid-cols-3 gap-3">
          {CARDS.map((card) => {
            const info = state.data[card.key];
            const s = statusFor(info);
            return (
              <div
                key={card.key}
                className={`rounded-lg border p-3 space-y-2 ${
                  info.installed && info.authenticated
                    ? "border-status-engaged/30 bg-status-engaged/5"
                    : info.installed
                      ? "border-status-warm/30 bg-status-warm/5"
                      : "border-bg-border bg-bg-elev/30"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-sm text-fg">{card.label}</span>
                  <Tag tone={s.tone}>
                    <span className="inline-flex items-center gap-1">
                      {s.icon}
                      {s.label}
                    </span>
                  </Tag>
                </div>
                <p className="text-xs text-fg-muted leading-snug">{card.blurb}</p>
                {info.version && (
                  <div className="text-[10px] font-mono text-fg-dim truncate" title={info.version}>
                    {info.version}
                  </div>
                )}
                {!info.installed && (
                  <div className="space-y-1.5">
                    <p className="text-[11px] text-fg-muted leading-relaxed">
                      {localActionsAvailable ? "Click Install to run " : "Run "}
                      <code className="text-fg-dim">{card.install_command}</code>
                      {localActionsAvailable ? " on this machine." : " on the paired machine, then click Refresh."}
                    </p>
                    {localActionsAvailable && (
                      <button
                        type="button"
                        disabled={busy.kind !== "idle"}
                        onClick={() => void handleInstall(card.key)}
                        className="w-full inline-flex items-center justify-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1.5 rounded-md bg-accent text-bg-deep hover:bg-accent-bright disabled:opacity-50"
                      >
                        {busy.kind === "installing" && busy.provider === card.key ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Installing…
                          </>
                        ) : (
                          <>Install</>
                        )}
                      </button>
                    )}
                  </div>
                )}
                {info.installed && !info.authenticated && (
                  <div className="space-y-1.5">
                    <p className="text-[11px] text-status-warm leading-relaxed">
                      {localActionsAvailable
                        ? "Installed. Click Sign in — your browser opens for the OAuth flow."
                        : `Installed. Sign in from a terminal on the paired machine, then click Refresh.`}
                    </p>
                    {localActionsAvailable && (
                      <button
                        type="button"
                        disabled={busy.kind !== "idle"}
                        onClick={() => void handleSignIn(card.key)}
                        className="w-full inline-flex items-center justify-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1.5 rounded-md bg-status-warm/20 text-status-warm border border-status-warm/40 hover:bg-status-warm/30 disabled:opacity-50"
                      >
                        {busy.kind === "authing" && busy.provider === card.key ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Waiting for sign-in…
                          </>
                        ) : (
                          <>Sign in</>
                        )}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </>
      )}
    </Card>
  );
}
