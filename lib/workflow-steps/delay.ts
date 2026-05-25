/**
 * delay step — V6.9.2.
 *
 * Pauses the run for a fixed duration. Implementation note: for short
 * delays (< 5s) we sleep inline; for longer delays the daemon should
 * re-queue the run with `wake_after` timestamp rather than blocking
 * a worker — that's a V6.9.2.x daemon enhancement, not a step concern.
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
const MAX_DELAY_MS = 24 * 60 * 60 * 1000; // 24h cap to prevent runaway sleeps

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
      status: "complete",
      output: { delayed_ms: ms, mode: "deferred", wake_after_iso: new Date(Date.now() + ms).toISOString() },
    };
  },
};

export default handler;
