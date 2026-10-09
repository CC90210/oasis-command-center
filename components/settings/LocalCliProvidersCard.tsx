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
 *   4. Each card renders lib/bridge-cli-status.ts's state: Ready / Needs
 *      sign-in / Sign-in not confirmed (a check did not finish) / Not detected.
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
// What this card shows. It chooses nothing: what powers your agents AND the
// coding harness is the one setting above (What powers your agents).
import { LOCAL_CLI_SCOPE } from "@/components/settings/local-cli-scope";
import { CLI_SIGN_IN, CLI_STATE_LABEL, cliStatusState, type CliState } from "@/lib/bridge-cli-status";

type CliInfo = {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  install_hint_url: string;
  /** Whether the computer's checks finished (lib/bridge-cli-status.ts). */
  checked?: boolean;
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
      return { kind: "error", message: `Couldn't reach this computer's bridge (status ${r.status})` };
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

/** The computer's report in lib/bridge-cli-status.ts's words: a check that did not finish is never "Needs sign-in". */
function cliState(info: CliInfo): CliState {
  return cliStatusState({ installed: info.installed, authenticated: info.authenticated, checked: info.checked === true });
}

function statusFor(info: CliInfo): { label: string; tone: "engaged" | "warm" | "neutral"; icon: React.ReactNode } {
  const s = cliState(info);
  if (s === "ready") return { label: CLI_STATE_LABEL[s], tone: "engaged", icon: <CheckCircle2 className="w-3.5 h-3.5" /> };
  if (s === "needs_sign_in") return { label: CLI_STATE_LABEL[s], tone: "warm", icon: <AlertCircle className="w-3.5 h-3.5" /> };
  if (s === "unknown") return { label: CLI_STATE_LABEL[s], tone: "neutral", icon: <AlertCircle className="w-3.5 h-3.5" /> };
  return { label: CLI_STATE_LABEL[s], tone: "neutral", icon: <Terminal className="w-3.5 h-3.5" /> };
}

type Busy =
  | { kind: "idle" }
  | { kind: "installing"; provider: keyof CliStatusResponse }
  | { kind: "authing"; provider: keyof CliStatusResponse };

/**
 * Connect / Reconnect: asks the paired computer's bridge to start the app's own
 * sign-in there (app/api/bridge/cli-auth), which opens the vendor's page in
 * that computer's browser. Never a sign-in inside OASIS. No React, so a test
 * drives it.
 */
export async function startCliSignIn(
  provider: "claude" | "codex" | "gemini",
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (u, i) => fetch(u, i),
): Promise<{ ok: boolean; text: string }> {
  const command = CLI_SIGN_IN[provider].command;
  try {
    const r = await fetchImpl("/api/bridge/cli-auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string; output?: string };
    const message = typeof body.message === "string" && body.message ? body.message : `On your paired computer, run: ${command}`;
    const output = typeof body.output === "string" && body.output.trim() ? `\n\n${body.output.trim()}` : "";
    return { ok: r.ok && body.ok === true, text: message + output };
  } catch {
    return { ok: false, text: `The Command Center didn't answer. On your paired computer, run: ${command}` };
  }
}

export function LocalCliProvidersCard({
  serverBridgeOnline,
}: {
  /** null = the tenant heartbeat could not be read. "Offline" needs both the
   *  browser probe AND the heartbeat down, so an unread heartbeat is never it. */
  serverBridgeOnline: boolean | null;
}) {
  const [state, setState] = useState<ProbeState>({ kind: "loading" });
  const [busy, setBusy] = useState<Busy>({ kind: "idle" });
  const [localActionsAvailable, setLocalActionsAvailable] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  useEffect(() => {
    // A hosted dashboard can read the outbound, pairing-authenticated
    // heartbeat, but it cannot prove that a tenant bridge proxy points back
    // to the same paired machine. Only allow install/auth mutations when the
    // dashboard itself is loaded on loopback, where /exec-tool necessarily
    // targets this browser's machine.
    setLocalActionsAvailable(!isProxyModeRuntime());
  }, []);

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
    // Through the server, hosted or not: the bridge it reaches is this
    // workspace's own paired computer (app/api/bridge/cli-auth).
    const res = await startCliSignIn(provider);
    setActionMessage({ kind: res.ok ? "ok" : "err", text: res.text });
    setBusy({ kind: "idle" });
    if (!res.ok) return;

    // The sign-in finishes in that computer's browser. The bridge re-checks
    // its apps on its next heartbeat (about a minute), so poll the report
    // every 5 s for 3 minutes, one probe at a time.
    const startMs = Date.now();
    let probeInFlight = false;
    const poll = async () => {
      if (Date.now() - startMs > 180_000) return;
      if (probeInFlight) {
        setTimeout(() => void poll(), 5_000);
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
          setActionMessage({ kind: "ok", text: `${CLI_SIGN_IN[provider].label} is signed in and ready.` });
          return;
        }
      } finally {
        probeInFlight = false;
      }
      setTimeout(() => void poll(), 5_000);
    };
    setTimeout(() => void poll(), 5_000);
  }

  useEffect(() => {
    void refresh();

  }, []);

  return (
    <Card
      title="AI apps on your paired computer"
      subtitle={LOCAL_CLI_SCOPE}
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

      {state.kind === "bridge_unreachable" && serverBridgeOnline === null && (
        <div className="flex items-start gap-2 text-sm text-fg-muted bg-bg-deep/40 border border-bg-border rounded-lg p-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold text-fg">Couldn&apos;t check the bridge</div>
            <p className="mt-1 text-xs leading-relaxed">
              This browser can&apos;t reach a bridge, and the paired machine&apos;s heartbeat could not be read just now, so this is not saying it is offline. Refresh in a minute.
            </p>
          </div>
        </div>
      )}

      {state.kind === "bridge_unreachable" && serverBridgeOnline !== null && deriveDropdownState(false, serverBridgeOnline) === "degraded" && (
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

      {state.kind === "bridge_unreachable" && serverBridgeOnline !== null && deriveDropdownState(false, serverBridgeOnline) === "offline" && (
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
          {/* No picker here (CC, 2026-10-09: "they should be on the same
              functionality"): which app answers your agents AND the coding
              harness is the one setting above, What powers your agents. These
              cards are the paired computer's report, with each app's
              Connect / Reconnect. */}
        <div className="grid sm:grid-cols-3 gap-3">
          {CARDS.map((card) => {
            const info = state.data[card.key];
            const s = statusFor(info);
            const cs = cliState(info);
            return (
              <div
                key={card.key}
                data-cli-state={cs}
                className={`rounded-lg border p-3 space-y-2 ${
                  cs === "ready"
                    ? "border-status-engaged/30 bg-status-engaged/5"
                    : cs === "needs_sign_in"
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
                {cs === "unknown" && (
                  <p className="text-[11px] text-fg-muted leading-relaxed">
                    It is installed, but the computer&apos;s sign-in check did not finish, so it isn&apos;t
                    confirmed. If it answers in a terminal there, it will answer here: choose it above and use Test.
                  </p>
                )}
                {/* Connect / Reconnect (CC, 2026-10-09): starts the app's own
                    sign-in on the paired computer, which opens the vendor's
                    page there. Every not-ready card has it, with the exact
                    command for when it can't be started remotely. */}
                {cs !== "ready" && (
                  <div className="space-y-1.5" data-testid={`cli-connect-${card.key}`}>
                    <button
                      type="button"
                      disabled={busy.kind !== "idle"}
                      onClick={() => void handleSignIn(card.key)}
                      className="w-full inline-flex items-center justify-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-md bg-accent text-bg-deep hover:bg-accent-bright disabled:opacity-50"
                    >
                      {busy.kind === "authing" && busy.provider === card.key ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Starting sign-in...
                        </>
                      ) : (
                        <>{cs === "needs_sign_in" ? "Connect" : "Reconnect"}</>
                      )}
                    </button>
                    <p className="text-[11px] text-fg-muted leading-relaxed">
                      Opens {CLI_SIGN_IN[card.key].label}&apos;s own sign-in in the browser on your paired computer. Or run there:{" "}
                      <code className="text-fg-dim">{CLI_SIGN_IN[card.key].command}</code>
                    </p>
                  </div>
                )}
                {cs === "ready" && (
                  <button
                    type="button"
                    disabled={busy.kind !== "idle"}
                    onClick={() => void handleSignIn(card.key)}
                    className="text-[11px] text-fg-dim underline underline-offset-2 hover:text-fg disabled:opacity-50"
                    title={`Sign in to ${CLI_SIGN_IN[card.key].label} again on your paired computer`}
                  >
                    Reconnect
                  </button>
                )}
                {!info.installed && (
                  <div className="space-y-1.5">
                    <p className="text-[11px] text-fg-muted leading-relaxed">
                      The computer did not report it. If it is installed there, its check may have timed out: Connect above, or
                      choose it in What powers your agents and use Test.{" "}
                      {localActionsAvailable ? "If it isn't installed, click Install to run " : "If it isn't installed, run "}
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
              </div>
            );
          })}
        </div>
        </>
      )}
    </Card>
  );
}
