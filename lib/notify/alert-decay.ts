/**
 * Escalating repeat-suppression for ops watchdogs.
 *
 * WHY. On 2026-08-03 the OASIS group had been receiving the TPS backlog alert
 * every 6 hours for ten days — 21 Live Subs stuck because Adon's workstation
 * worker was off. The alert was true every single time, and by day three nobody
 * was reading it. A watchdog that repeats at a fixed interval trains its audience
 * to ignore it, which is the same outcome as not alerting at all.
 *
 * The ladder here is ported from Business-Empire-Agent/scripts/notify.py, where
 * the same lesson was learned on 2026-07-29 (an identical alert at 10:30, 11:30,
 * 12:30 and 1:30 AM): the FIRST occurrence is always immediate, repeats decay,
 * and a long quiet period resets the escalation so next month's recurrence is a
 * new incident rather than the tail of last month's.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO — edge detection. tps-backlog-watch's header
 * records a Codex decision from 2026-07-24 rejecting a "just crossed the
 * threshold" window, because a window silently misses a backlog that was already
 * stale at deploy time or when a run is skipped. That property is preserved:
 * `shouldAlert` is asked about the CONDITION AS IT STANDS, never about a
 * transition. First observation of a standing problem always sends.
 *
 * The signature is what makes a condition "the same one". Keep it COARSE — a live
 * age or an exact row count changes on every run and would mint a new identity
 * each time, defeating suppression entirely (the original bug: the message text
 * carried `oldest ~236.7h`).
 */

/** 1st repeat 6h later, then 12h, then 24h, capped. */
export const DECAY_LADDER_H = [6, 12, 24] as const;
/** Condition quiet this long → the next occurrence is a NEW incident. */
export const FORGET_H = 72;

export type AlertState = {
  /** Signature stored when we last alerted, if ever. */
  lastSignature?: string | null;
  /** ISO timestamp of the last alert for this key, if ever. */
  lastAlertedAt?: string | null;
  /** How many times this condition has alerted in the current episode. */
  repeatN?: number | null;
};

export type AlertDecision = {
  send: boolean;
  /** Persist this as repeat_n when `send` is true. */
  nextRepeatN: number;
  /** Hours until the next alert would be allowed. Diagnostics only. */
  windowH: number;
  reason: "first" | "signature-changed" | "forgotten" | "window-open" | "suppressed";
};

function windowFor(repeatN: number): number {
  const i = Math.min(Math.max(repeatN, 1), DECAY_LADDER_H.length) - 1;
  return DECAY_LADDER_H[i];
}

/**
 * Decide whether a standing condition should alert now.
 *
 * @param signature Coarse identity of the condition. Same problem → same string.
 * @param state     What we persisted the last time this key alerted.
 * @param now       Injected for testability; defaults to wall clock.
 */
export function shouldAlert(
  signature: string,
  state: AlertState | null | undefined,
  now: Date = new Date(),
): AlertDecision {
  const lastAt = state?.lastAlertedAt ? new Date(state.lastAlertedAt) : null;
  const validLast = lastAt && !Number.isNaN(lastAt.getTime()) ? lastAt : null;

  // Never alerted for this key — a standing problem observed for the first time.
  if (!validLast) {
    return { send: true, nextRepeatN: 1, windowH: windowFor(1), reason: "first" };
  }

  const elapsedH = (now.getTime() - validLast.getTime()) / 3_600_000;

  // A different problem under the same key is news, not a repeat.
  if (state?.lastSignature && state.lastSignature !== signature) {
    return { send: true, nextRepeatN: 1, windowH: windowFor(1), reason: "signature-changed" };
  }

  // Long silence → treat as a fresh episode, so the ladder restarts from 6h
  // rather than inheriting a 24h window set last week.
  if (elapsedH >= FORGET_H) {
    return { send: true, nextRepeatN: 1, windowH: windowFor(1), reason: "forgotten" };
  }

  const repeatN = Math.max(Number(state?.repeatN) || 1, 1);
  const windowH = windowFor(repeatN);
  if (elapsedH >= windowH) {
    const next = Math.min(repeatN + 1, DECAY_LADDER_H.length);
    return { send: true, nextRepeatN: next, windowH: windowFor(next), reason: "window-open" };
  }

  return { send: false, nextRepeatN: repeatN, windowH, reason: "suppressed" };
}
