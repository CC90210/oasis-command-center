/**
 * Pure stage-buffer math for the drip engine (2026-07-22 fix). Lives in its
 * own module (no "server-only") so unit tests can exercise it directly.
 */

/**
 * 24h stage-entry buffer: the minimum minutes before the FIRST step of a
 * stage-triggered sequence may fire after enrollment. Fast stage transitions
 * within this window get their pending step-0 cancelled (eagerly at the stage
 * write, and again at dispatch) BEFORE anything sends — leads stable past the
 * buffer deliver normally. Env DRIPS_STAGE_BUFFER_MIN (minutes), default
 * 1440; non-numeric falls back, negatives clamp to 0.
 */
export function stageBufferMinutes(): number {
  const raw = (process.env.DRIPS_STAGE_BUFFER_MIN ?? "").trim();
  const n = raw ? Number(raw) : 1440;
  return Math.max(0, Number.isFinite(n) ? Math.floor(n) : 1440);
}

/** Step-0 effective delay: the sequence's own delay, floored by the stage
 *  buffer. A sequence that already waits longer keeps its own timing. */
export function computeStep0DelayMinutes(delayMinutes: number, bufferMinutes: number): number {
  return Math.max(0, delayMinutes, bufferMinutes);
}
