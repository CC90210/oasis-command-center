/**
 * delay step — V6.9.5 (hotfix from V6.9.2).
 *
 * Pauses the run for a fixed duration. Short delays (≤ INLINE_THRESHOLD_MS)
 * sleep inline. Longer delays need daemon-side requeue support — until
 * `scripts/workflow_runner.py` (V6.9.2.x) lands and the workflow_runs row
 * can be parked with a `wake_after` timestamp, the step returns `failed`
 * with an explicit setup pointer rather than claiming `complete`.
 *
 * Prior version returned `{ status: 'complete', mode: 'deferred' }` for
 * long delays without actually delaying — a fancy stub. Caught in Codex
 * audit 2026-05-25; fixed here to fail honestly.
 *
 * Input shape:
 *   { seconds?: number, minutes?: number, hours?: number }
 */

import type { StepContext, StepResult, WorkflowStep } from "./types";

type DelayInput = {
  seconds?: number;
  minutes?: number;
  hours?: number;
};

const INLINE_THRESHOLD_MS = 5_000;
const MAX_DELAY_MS = 24 * 60 * 60 * 1000; // 24h cap

export function computeDelayMs(input: DelayInput): number {
  const s = typeof input.seconds === "number" ? input.seconds : 0;
  const m = typeof input.minutes === "number" ? input.minutes : 0;
  const h = typeof input.hours === "number" ? input.hours : 0;
  const ms = (s + m * 60 + h * 3600) * 1000;
  return Math.max(0, Math.min(ms, MAX_DELAY_MS));
}

const handler: WorkflowStep = {
  type: "delay",
  async execute(rawInput: unknown, _ctx: StepContext): Promise<StepResult> {
    const input = (rawInput || {}) as DelayInput;
    const ms = computeDelayMs(input);
    if (ms <= INLINE_THRESHOLD_MS) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { status: "complete", output: { delayed_ms: ms, mode: "inline" } };
    }
    return {
      status: "failed",
      error: `delay_requires_daemon_requeue: ${ms}ms exceeds ${INLINE_THRESHOLD_MS}ms inline threshold; awaiting scripts/workflow_runner.py (V6.9.2.x). Until daemon ships, split your workflow into discrete cron-triggered runs.`,
    };
  },
};

export default handler;
