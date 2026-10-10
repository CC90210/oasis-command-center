"use client";

/**
 * RunnerStatusHeader — the strip above the Coding harness (/agent) that says
 * whether a turn can run before the operator types one (2026-09-30):
 *
 *   - Computer: the freshest paired computer from bridge_pairings (online
 *     under 90 s, idle under 5 min, else offline), via /api/bridge/warm-status;
 *   - AI tools: which CLIs the bridge reports installed and signed in, via
 *     /api/bridge/cli-status (the heartbeat inventory, refused when stale);
 *   - Warm pool: how many chat processes are warm, via /api/bridge/warm-status
 *     (a 401 from the bridge reads "refused the request (token)").
 *
 * Every read goes through the Command Center; the browser never calls the
 * bridge. A read that failed says "Couldn't check", never "offline". Polls
 * every 20 s while mounted; MainShell mounts it only on /agent.
 *
 * Everyday questions belong in Chief of Staff, which is linked here: the
 * harness is the operator's workbench for work in a department's repo.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { timeAgo } from "@/lib/fmt";
import { describeWarmFailure, type WarmStatusBody } from "@/lib/admin/warm-pool";
import { CLI_STATUS_ROUTE } from "@/components/BridgeCliPanel";
import { cliStatusState } from "@/lib/bridge-cli-status";

const POLL_MS = 20_000;
const WARM_STATUS_ROUTE = "/api/bridge/warm-status";

type CliTools = Record<string, { installed: boolean; authenticated: boolean; checked?: boolean; unsupported?: boolean }>;
type CliBody =
  | { ok: true; machines?: Array<{ label: string | null; data: CliTools }>; data?: CliTools }
  | { ok: false; reason: string };

export type RunnerSnapshot = {
  warm: { status: number; body: WarmStatusBody } | { error: string } | null;
  cli: { status: number; body: CliBody } | { error: string } | null;
};

const CLI_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini" };

/** PURE. The three lines the strip shows. */
export function describeRunner(snap: RunnerSnapshot): { computer: string; tools: string; pool: string; computerTone: "ok" | "warn" | "neutral" } {
  let computer = "Checking your computer…";
  let computerTone: "ok" | "warn" | "neutral" = "neutral";
  let pool = "Checking the warm pool…";
  if (snap.warm && "error" in snap.warm) {
    const late = snap.warm.error === "timeout";
    computer = late ? "Couldn't check your computer: no answer in 12 seconds." : "Couldn't check your computer just now.";
    pool = late ? "Couldn't check the warm pool: no answer in 12 seconds." : "Couldn't check the warm pool just now.";
  } else if (snap.warm) {
    const { status, body } = snap.warm;
    // undefined: the route could not read the pairings (it stopped before
    // them); null: it read them and none is paired.
    const machine = "machine" in body ? body.machine : undefined;
    if (status === 401) computer = "You're signed out.";
    else if (machine === undefined) computer = "Couldn't check your computer.";
    else if (machine === null) computer = "No computer is paired.";
    else if ("unreadable" in machine) computer = "Couldn't check your computer's check-ins.";
    else {
      const when = machine.last_seen_at ? timeAgo(machine.last_seen_at) : "never";
      computer =
        machine.state === "online"
          ? `${machine.label}: online, checked in ${when}`
          : machine.state === "idle"
            ? `${machine.label}: idle, checked in ${when}`
            : `${machine.label}: offline, last checked in ${when}`;
      computerTone = machine.state === "online" ? "ok" : machine.state === "idle" ? "neutral" : "warn";
    }
    const busy = body.ok ? body.pool.processes.filter((p) => p.busy).length : 0;
    pool = body.ok
      ? `${body.pool.processes.filter((p) => p.alive).length} of ${body.pool.max_size} chat processes warm${busy ? `, ${busy} busy` : ""}`
      : describeWarmFailure(body, status);
  }
  let tools = "Checking your AI tools…";
  if (snap.cli && "error" in snap.cli) {
    tools = snap.cli.error === "timeout" ? "Couldn't check your AI tools: no answer in 12 seconds." : "Couldn't check your AI tools just now.";
  }
  else if (snap.cli) {
    const { status, body } = snap.cli;
    if (status === 401) tools = "You're signed out.";
    else if (body.ok) {
      // lib/bridge-cli-status.ts's words: a check that did not finish is "not confirmed", never "not signed in".
      // One line per paired computer, so two computers never read as one (CC, 2026-10-09).
      const line = (data: CliTools) => {
        const named = (want: string) =>
          Object.entries(data)
            .filter(([, v]) => cliStatusState({ installed: v.installed, authenticated: v.authenticated, checked: v.checked === true, unsupported: v.unsupported === true }) === want)
            .map(([k]) => CLI_LABEL[k] ?? k);
        const signedIn = named("ready");
        const notSigned = named("needs_sign_in");
        const unconfirmed = named("unknown");
        const unsupported = named("unsupported");
        return (
          (signedIn.length ? `Signed in: ${signedIn.join(", ")}` : "No AI tool is signed in") +
          (notSigned.length ? `. Needs sign-in: ${notSigned.join(", ")}` : "") +
          (unconfirmed.length ? `. Sign-in not confirmed: ${unconfirmed.join(", ")}` : "") +
          (unsupported.length ? `. Not supported on this sign-in: ${unsupported.join(", ")}` : "")
        );
      };
      const machines = body.machines ?? (body.data ? [{ label: null, data: body.data }] : []);
      tools =
        machines.length === 0
          ? "Couldn't read your computer's AI tool report."
          : machines.length === 1
            ? line(machines[0].data)
            : machines.map((m) => `${m.label ?? "A computer"}: ${line(m.data)}`).join(" | ");
    } else if (body.reason === "missing") tools = "Your computer hasn't reported its AI tools yet.";
    else if (body.reason === "stale") tools = "The last report of your AI tools is more than 5 minutes old.";
    else tools = "Couldn't read your computer's AI tool report.";
  }
  return { computer, tools, pool, computerTone };
}

/**
 * How long one read may take. These reads had no limit, and the strip set both
 * lines from ONE Promise.all: a request that never answered (the warm-pool read
 * waits on the computer's bridge) left "Checking your computer..." AND
 * "Checking your AI tools..." on screen for good (CC, 2026-10-09). Each read
 * now gives up after this, and each line updates on its own.
 */
export const RUNNER_READ_TIMEOUT_MS = 12_000;

export async function readRunner<T>(
  url: string,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (u, i) => fetch(u, i),
): Promise<{ status: number; body: T } | { error: string }> {
  try {
    const res = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(RUNNER_READ_TIMEOUT_MS) });
    return { status: res.status, body: (await res.json()) as T };
  } catch (e) {
    console.error("[runner_status_header]", url, e);
    const name = e instanceof Error ? e.name : "";
    return { error: name === "TimeoutError" || name === "AbortError" ? "timeout" : e instanceof Error ? e.message : "fetch_failed" };
  }
}

export function RunnerStatusHeader() {
  const [snap, setSnap] = useState<RunnerSnapshot>({ warm: null, cli: null });

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      // Each line on its own: a slow read never holds the other one.
      void readRunner<WarmStatusBody>(WARM_STATUS_ROUTE).then((warm) => alive && setSnap((s) => ({ ...s, warm })));
      void readRunner<CliBody>(CLI_STATUS_ROUTE).then((cli) => alive && setSnap((s) => ({ ...s, cli })));
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const view = describeRunner(snap);
  return (
    <div className="border-b border-hairline bg-bg-panel px-4 py-2.5 text-xs md:px-5" aria-label="Coding harness status">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="text-sm font-semibold text-fg">Coding harness</div>
        <Link href="/team/chief-of-staff" className="text-accent hover:underline">
          Everyday questions go to Chief of Staff
        </Link>
      </div>
      <p className="mt-0.5 text-fg-muted">
        Runs Claude Code or Codex in a department&apos;s repo on your computer, through the bridge. Operators only.
      </p>
      <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-fg-dim">Computer</dt>
          <dd className={view.computerTone === "ok" ? "text-status-engaged" : view.computerTone === "warn" ? "text-status-warm" : "text-fg"}>
            {view.computer}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-fg-dim">AI tools</dt>
          <dd className="text-fg">{view.tools}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-fg-dim">Warm pool</dt>
          <dd className="text-fg">{view.pool}</dd>
        </div>
      </dl>
    </div>
  );
}
