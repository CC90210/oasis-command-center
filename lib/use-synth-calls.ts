"use client";

/**
 * useSynthCalls — synthetic activity scheduler for the chat widget.
 *
 * When the model is in cold-start / thinking time and not emitting real
 * tool events, render plausible activity (terminal opening, cd, CLI
 * spawning, file scans) so the user sees motion instead of pure silence.
 *
 * Two phases:
 *   1. LIFECYCLE (0-12s) — what the bridge ACTUALLY does in the
 *      background. These aren't fake; we just don't have telemetry
 *      for them. Each pill completes in 0.5-1.5s.
 *   2. SCAN (12s+) — file-scan / context-check style events. Cycles
 *      until real tool events arrive.
 *
 * Real tool events always win — when hasRealTools flips true, the
 * scheduler bails via cancelled flag.
 *
 * Honesty contract (2026-05-22): the LIFECYCLE pills MUST reflect the
 * runtime the bridge actually spawned. Hardcoding "spawn claude" while
 * the operator picked Gemini is a lie — fixed by threading `cliRuntime`
 * through and selecting the right command string per runtime.
 *
 * Extracted from ChatWidget.tsx 2026-05-08 to keep that file under
 * 1500 lines.
 */

import { useEffect, useState } from "react";

export type SynthCliRuntime = "claude" | "codex" | "gemini" | "cloud";

export type SynthCall = {
  id: string;
  kind: string;
  label: string;
  detail: string;
  createdAt: number;
  completedAt?: number;
  synthetic: true;
};

const REPO_BY_AGENT: Record<string, string> = {
  bravo: "Business-Empire-Agent",
  atlas: "APPS/CFO-Agent",
  maven: "CMO-Agent",
  aura: "AURA",
  hermes: "hermes",
  "life-preservation": "life-preservation",
  // SunBiz personas both live in the SunBiz repo — without these the synthetic
  // trace falls back to bravo's repo and shows the wrong cd path (the real
  // bridge resolves the correct cwd via agent_roots).
  sunbiz: "SunBiz-Agent",
  solara: "SunBiz-Agent",
  helios: "SunBiz-Agent",
};

const SCAN: Array<{ kind: string; label: string; detail: string }> = [
  { kind: "Read", label: "read", detail: "brain/STATE.md" },
  { kind: "Read", label: "read", detail: "memory/ACTIVE_TASKS.md" },
  { kind: "Read", label: "read", detail: "brain/USER.md" },
  { kind: "Read", label: "read", detail: "memory/SESSION_LOG.md" },
  { kind: "Bash", label: "bash", detail: "scanning recent activity" },
  { kind: "Read", label: "read", detail: "brain/CAPABILITIES.md" },
  { kind: "Grep", label: "grep", detail: "open leads · active threads" },
  { kind: "Read", label: "read", detail: "memory/PATTERNS.md" },
  { kind: "Read", label: "read", detail: "brain/AGENT_ROUTER.md" },
  { kind: "Bash", label: "bash", detail: "checking open conversations" },
];

type RuntimeLifecycle = {
  spawnDetail: string;
  runtimeLabel: string;
  contextLabel: string;
};

const RUNTIME_LIFECYCLE: Record<SynthCliRuntime, RuntimeLifecycle> = {
  claude: {
    spawnDetail: "claude --output-format stream-json",
    runtimeLabel: "Claude Code CLI runtime",
    contextLabel: "MCP servers · skills · tools",
  },
  codex: {
    spawnDetail: "codex exec --json",
    runtimeLabel: "OpenAI Codex CLI runtime",
    contextLabel: "Codex skills · tools",
  },
  gemini: {
    spawnDetail: "gemini --yolo --output-format json",
    runtimeLabel: "Gemini CLI runtime",
    contextLabel: "Gemini extensions · tools",
  },
  cloud: {
    spawnDetail: "POST /v1/messages — Anthropic API",
    runtimeLabel: "cloud tool-use loop",
    contextLabel: "cloud tools · dashboard actions",
  },
};

export function useSynthCalls(opts: {
  streaming: boolean;
  streamStartedAt: number | null;
  hasRealTools: boolean;
  agent: string;
  /** Which runtime the chat actually picked for this turn. The lifecycle
   *  pills MUST match — if the operator selected Gemini we cannot render
   *  "spawn claude" or the trace lies. Defaults to claude so the existing
   *  call site (which doesn't pass a runtime yet) keeps today's behavior. */
  cliRuntime?: SynthCliRuntime;
}): SynthCall[] {
  const { streaming, streamStartedAt, hasRealTools, agent, cliRuntime = "claude" } = opts;
  const [synthCalls, setSynthCalls] = useState<SynthCall[]>([]);

  useEffect(() => {
    if (!streaming || !streamStartedAt) {
      setSynthCalls([]);
      return;
    }
    if (hasRealTools) return;

    const repoPath = REPO_BY_AGENT[agent] || REPO_BY_AGENT.bravo;
    const runtime = RUNTIME_LIFECYCLE[cliRuntime] || RUNTIME_LIFECYCLE.claude;
    // Cloud (API-key) mode doesn't open a terminal — collapse the shell/cd
    // pills and lead straight into the API call so the trace is honest.
    const lifecycle: Array<{ kind: string; label: string; detail: string; runMs: number; gapMs: number }> =
      cliRuntime === "cloud"
        ? [
            { kind: "Bash", label: "call", detail: runtime.spawnDetail, runMs: 800, gapMs: 1000 },
            { kind: "Read", label: "load", detail: runtime.runtimeLabel, runMs: 900, gapMs: 1100 },
            { kind: "Read", label: "load", detail: "agent persona · brain/SOUL.md", runMs: 700, gapMs: 900 },
            { kind: "Read", label: "load", detail: runtime.contextLabel, runMs: 1100, gapMs: 1300 },
          ]
        : [
            { kind: "Bash", label: "shell", detail: "opening terminal session", runMs: 600, gapMs: 800 },
            { kind: "Bash", label: "cd", detail: `cd ~/${repoPath}`, runMs: 400, gapMs: 700 },
            { kind: "Bash", label: "spawn", detail: runtime.spawnDetail, runMs: 900, gapMs: 1200 },
            { kind: "Read", label: "load", detail: runtime.runtimeLabel, runMs: 1100, gapMs: 1300 },
            { kind: "Read", label: "load", detail: "agent persona · brain/SOUL.md", runMs: 900, gapMs: 1100 },
            { kind: "Read", label: "load", detail: runtime.contextLabel, runMs: 1300, gapMs: 1500 },
          ];

    let cancelled = false;
    let lifecycleIdx = 0;
    let scanIdx = 0;

    function fire(ev: { kind: string; label: string; detail: string }, runMs: number) {
      if (cancelled) return;
      const id = `synth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = Date.now();
      setSynthCalls((prev) => [
        ...prev,
        { id, kind: ev.kind, label: ev.label, detail: ev.detail, createdAt, synthetic: true },
      ]);
      setTimeout(() => {
        if (cancelled) return;
        setSynthCalls((prev) =>
          prev.map((c) => (c.id === id ? { ...c, completedAt: Date.now() } : c))
        );
      }, runMs);
    }

    function scheduleNext() {
      if (cancelled) return;
      if (lifecycleIdx < lifecycle.length) {
        const ev = lifecycle[lifecycleIdx];
        lifecycleIdx += 1;
        fire(ev, ev.runMs);
        setTimeout(scheduleNext, ev.gapMs);
        return;
      }
      const ev = SCAN[scanIdx % SCAN.length];
      scanIdx += 1;
      const runMs = 1200 + Math.random() * 1400;
      fire(ev, runMs);
      const gapMs = 2500 + Math.random() * 1500;
      setTimeout(scheduleNext, gapMs);
    }

    setTimeout(scheduleNext, 300);
    return () => {
      cancelled = true;
    };
  }, [streaming, streamStartedAt, hasRealTools, agent, cliRuntime]);

  return synthCalls;
}
