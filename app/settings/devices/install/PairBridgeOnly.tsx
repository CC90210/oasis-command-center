"use client";

/**
 * PairBridgeOnly — /settings/devices/install for a signed-in viewer who is not
 * the verified platform operator (a client, or anyone whose operator check
 * failed).
 *
 * It pairs a computer that ALREADY has the bridge installed: mint a one-time
 * code, show the self-contained pair command, and watch for the pairing. That
 * command redeems the code against /api/auth/pair-code/redeem and writes the
 * token to ~/.oasis/bridge_token; it clones nothing and installs nothing.
 *
 * Deliberately NOT here (F0 containment, 2026-09-29): the full-install command,
 * the harness repository, the operator's variable names, the /download builds
 * and the Settings › Devices link (operator-only). It imports neither
 * lib/bridge-install-command.ts nor InstallBridgeWizard, and gets no repository
 * prop. A new install is done by OASIS with each workspace while the bridge is
 * in private beta; page.tsx says so beside this card.
 *
 * PairOnlyView is the whole render, with no hooks, so
 * tests/f0-containment.test.ts renders every phase of it for real.
 */

import { useState } from "react";
import Link from "next/link";
import { Loader2, Check, Copy, Clock, AlertCircle, Apple, Monitor, Terminal } from "lucide-react";
import { useBridgePairing, type OS, type Phase } from "@/hooks/useBridgePairing";
import { bridgePairCommand, bridgeRestartCommand } from "@/lib/bridge-install-guidance";

/** Variable prefix for the client's pair command. Neutral on purpose: it names nothing of the harness. */
const CLIENT_ENV_PREFIX = "OASIS";

export function clientPairCommand(os: OS, code: string): string {
  return bridgePairCommand(os, code, CLIENT_ENV_PREFIX);
}

export function PairBridgeOnly() {
  const { os, setOs, code, secondsLeft, phase, error, retryMint } = useBridgePairing();
  const [copied, setCopied] = useState(false);
  const command = code ? clientPairCommand(os, code) : "";

  function handleCopy() {
    if (typeof navigator === "undefined" || !navigator.clipboard || !command) return;
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <PairOnlyView
      os={os}
      onOs={setOs}
      code={code}
      command={command}
      secondsLeft={secondsLeft}
      phase={phase}
      error={error}
      onRetry={retryMint}
      copied={copied}
      onCopy={handleCopy}
    />
  );
}

export type PairOnlyViewProps = {
  os: OS;
  onOs: (os: OS) => void;
  code: string | null;
  command: string;
  secondsLeft: number;
  phase: Phase;
  error: string | null;
  onRetry: () => void;
  copied: boolean;
  onCopy: () => void;
};

export function PairOnlyView({ os, onOs, code, command, secondsLeft, phase, error, onRetry, copied, onCopy }: PairOnlyViewProps) {
  const mm = Math.floor(secondsLeft / 60).toString().padStart(2, "0");
  const ss = (secondsLeft % 60).toString().padStart(2, "0");

  return (
    <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-5 space-y-5">
      <div>
        <h2 className="text-base font-bold text-fg">Pair a computer that already has the bridge</h2>
        <p className="text-xs text-fg-muted mt-0.5">
          One command on that computer links its bridge to your workspace. It installs nothing.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-status-warm/40 bg-status-warm/10 p-3 text-sm text-status-warm flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {phase === "mint" && !error && (
        <div className="text-fg-muted text-sm flex items-center gap-2 py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Generating a one-time pair code…
        </div>
      )}
      {phase === "mint" && error && (
        <div className="py-4 flex justify-center">
          <button type="button" onClick={onRetry} className="btn-primary inline-flex items-center gap-2">
            Try again
          </button>
        </div>
      )}

      {(phase === "command" || phase === "watching") && code && (
        <>
          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-wider font-bold text-fg-dim">
              Step 1 — confirm the computer&apos;s OS
            </div>
            <div className="flex gap-2">
              {(["windows", "macos", "linux"] as OS[]).map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => onOs(o)}
                  className={`flex-1 inline-flex items-center justify-center gap-2 py-2 px-3 rounded-md border text-sm transition ${
                    os === o
                      ? "border-accent bg-accent/10 text-accent font-bold"
                      : "border-bg-border text-fg-muted hover:border-bg-border-strong"
                  }`}
                >
                  {o === "windows" && <Monitor className="w-4 h-4" />}
                  {o === "macos" && <Apple className="w-4 h-4" />}
                  {o === "linux" && <Terminal className="w-4 h-4" />}
                  {o === "windows" ? "Windows" : o === "macos" ? "macOS" : "Linux"}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-1">
              <div className="text-[11px] uppercase tracking-wider font-bold text-fg-dim">
                Step 2 — paste this in its {os === "windows" ? "PowerShell" : "terminal"}
              </div>
              <div className="text-[11px] text-fg-dim font-mono inline-flex items-center gap-1">
                <Clock className="w-3 h-3" /> code expires in {mm}:{ss}
              </div>
            </div>
            <div className="rounded-lg bg-bg-deep border border-bg-border p-3 font-mono text-xs text-fg leading-relaxed break-all select-all">
              {command}
            </div>
            <button type="button" onClick={onCopy} className="btn-primary inline-flex items-center gap-2">
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? "Copied!" : "Copy command"}
            </button>
          </div>

          <div className="rounded-lg border border-bg-border bg-bg-deep/40 p-3">
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <Loader2 className="w-4 h-4 animate-spin text-accent" />
              <span>Run the command, then restart the bridge so it connects with the new token.</span>
            </div>
            <div className="text-[11px] text-fg-dim mt-1.5">
              The code works from any terminal as long as it is used before it expires.
            </div>
          </div>
        </>
      )}

      {phase === "connected" && (
        <div className="space-y-3">
          <div className="rounded-lg border border-status-engaged/40 bg-status-engaged/10 p-4 flex items-start gap-3">
            <Check className="w-5 h-5 text-status-engaged shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-fg">Paired</div>
              <div className="text-sm text-fg-muted mt-1">
                The token is saved in <span className="font-mono">~/.oasis/bridge_token</span>. Restart the bridge so it
                connects with it: <span className="font-mono">{bridgeRestartCommand(os)}</span>
              </div>
            </div>
          </div>
          <Link href="/" className="btn-primary inline-flex items-center gap-2">
            Open a chat
          </Link>
        </div>
      )}
    </div>
  );
}
