/**
 * lib/health/checks-core.ts — the pure decision layer of outcome-based health
 * monitoring.
 *
 * WHY THIS EXISTS. On 2026-08-06 SMS was found to have been failing for three
 * weeks and email for a day, with no alert on either. The existing watchdog
 * covers 9 local PM2 processes, 8 of which are checked only for liveness, and
 * has no visibility into the Vercel crons where both failures happened. The
 * 2026-06-30 silent-failure audit named the flaw precisely: "health is modeled
 * as 'PM2 says online,' which is exactly the state a silently dead worker sits
 * in... 'broken' and 'idle' produce the same observable: silence."
 *
 * The design correction: check OUTCOMES in the data, not heartbeats from
 * services. A heartbeat says a loop ran. An outcome says a merchant actually
 * received something. Only the second catches a service that is running
 * perfectly while producing nothing.
 *
 * Pure and free of "server-only" so the rules that decide whether Adon gets
 * woken up are directly testable. All I/O lives in the runner.
 */

export type CheckVerdict = "ok" | "degraded" | "failing" | "check_broken";

export type CheckRule =
  /** Absolute floor. Below it is a failure regardless of history. */
  | { kind: "must_be_above"; floor: number }
  /** Anything above zero is a failure. For invariants that must never occur. */
  | { kind: "must_be_zero" }
  /** Absolute CEILING. Above it is a failure. The mirror of must_be_above, for
   *  observations where bigger is worse: hours of silence, age of the oldest
   *  overdue row, minutes since the last heartbeat. Without it those have to be
   *  expressed as a floor on some inverted quantity, which reads backwards at
   *  3am and is exactly the sort of thing misread under pressure. */
  | { kind: "must_be_below"; ceiling: number }
  /** Absolute TARGET with a degraded band beneath it. Reaching the target is
   *  ok; short of it is degraded; below `failingBelow` is an outage.
   *
   *  must_be_above cannot express this — it has no degraded verdict — so a
   *  floor set at a third of target reported 30-against-40 as ok and said
   *  nothing. "Below the number we agreed" and "the pipe is broken" are
   *  different events needing different reactions, and a monitor asked to
   *  report the first cannot only be able to say the second. */
  | { kind: "must_reach"; target: number; failingBelow: number }
  /** Relative to this check's own trailing median. No thresholds to maintain,
   *  and it adapts as volume grows. */
  | { kind: "baseline_drop"; failingBelowPct: number; degradedBelowPct: number };

export type CheckResult = {
  id: string;
  verdict: CheckVerdict;
  observed: number;
  baseline: number | null;
  reason: string;
};

/** Trailing median. Median rather than mean so one outage day does not drag the
 *  baseline down and quietly normalise the failure. */
export function median(values: number[]): number | null {
  const v = values.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function evaluate(
  id: string,
  rule: CheckRule,
  observed: number | null,
  history: number[],
): CheckResult {
  // A check that could not run is NOT a pass. This is the single most important
  // line in the file: treating an errored check as healthy is how a monitor
  // reports green while the thing it watches is dead.
  if (observed === null || !Number.isFinite(observed)) {
    return { id, verdict: "check_broken", observed: NaN, baseline: null, reason: "check did not return a value" };
  }

  if (rule.kind === "must_be_zero") {
    return observed === 0
      ? { id, verdict: "ok", observed, baseline: 0, reason: "none observed" }
      : { id, verdict: "failing", observed, baseline: 0, reason: `${observed} occurrence(s) of a condition that must never happen` };
  }

  if (rule.kind === "must_be_above") {
    return observed > rule.floor
      ? { id, verdict: "ok", observed, baseline: rule.floor, reason: `above floor ${rule.floor}` }
      : { id, verdict: "failing", observed, baseline: rule.floor, reason: `${observed} is at or below the floor of ${rule.floor}` };
  }

  if (rule.kind === "must_be_below") {
    return observed <= rule.ceiling
      ? { id, verdict: "ok", observed, baseline: rule.ceiling, reason: `within the limit of ${rule.ceiling}` }
      : {
          id,
          verdict: "failing",
          observed,
          baseline: rule.ceiling,
          reason: `${observed} exceeds the limit of ${rule.ceiling}`,
        };
  }

  if (rule.kind === "must_reach") {
    // No grace band. A 10% tolerance here would be the same "grading on a
    // curve" this rule exists to remove, just smaller: the target is the number
    // that was agreed, and missing it is worth saying out loud. Repetition is
    // the decay ladder's job, not the threshold's.
    if (observed >= rule.target) {
      return { id, verdict: "ok", observed, baseline: rule.target, reason: `at or above the target of ${rule.target}` };
    }
    return observed >= rule.failingBelow
      ? { id, verdict: "degraded", observed, baseline: rule.target,
          reason: `${observed} is short of the target of ${rule.target}` }
      : { id, verdict: "failing", observed, baseline: rule.target,
          reason: `${observed} is far below the target of ${rule.target} (outage threshold ${rule.failingBelow})` };
  }

  // baseline_drop
  const base = median(history);
  // Not enough history yet: report ok but say so, rather than inventing a
  // baseline and alerting on noise during the first two weeks.
  if (base === null || history.length < 5) {
    return { id, verdict: "ok", observed, baseline: base, reason: `insufficient history (${history.length} samples)` };
  }
  // A baseline of zero means this check has never seen activity. Nothing to
  // compare against, and alerting on 0 -> 0 would be permanent noise.
  if (base === 0) {
    return { id, verdict: "ok", observed, baseline: 0, reason: "baseline is zero; nothing expected yet" };
  }
  const pct = observed / base;
  if (pct < rule.failingBelowPct) {
    return { id, verdict: "failing", observed, baseline: base,
      reason: `${observed} vs a normal ${base} (${Math.round(pct * 100)}% of baseline)` };
  }
  if (pct < rule.degradedBelowPct) {
    return { id, verdict: "degraded", observed, baseline: base,
      reason: `${observed} vs a normal ${base} (${Math.round(pct * 100)}% of baseline)` };
  }
  return { id, verdict: "ok", observed, baseline: base, reason: `${observed} vs a normal ${base}` };
}

/** Worst verdict across a set, for the digest headline. */
export function worstVerdict(results: CheckResult[]): CheckVerdict {
  const order: CheckVerdict[] = ["ok", "degraded", "check_broken", "failing"];
  return results.reduce<CheckVerdict>(
    (worst, r) => (order.indexOf(r.verdict) > order.indexOf(worst) ? r.verdict : worst),
    "ok",
  );
}

/**
 * ALERT DECAY LIVES IN lib/notify/alert-decay.ts — deliberately NOT here.
 *
 * An earlier draft of this file grew its own shouldAlert() with a parallel
 * ladder. Two decay implementations that must agree is exactly the drift this
 * codebase has been bitten by twice this week (the click allowlist reading a
 * different env var than the link minter; two copies of the variant hash). The
 * existing module is signature-keyed, ladders 6h/12h/24h, and forgets after 72h
 * so a fresh episode restarts the ladder. Use it.
 *
 * The signature passed to it must describe the CONDITION, not the rendered
 * message: embedding a changing number ("oldest ~236.7h") in the signature
 * defeats suppression entirely, which is the bug that module was written for.
 * For a health check the right signature is `health:<id>:<verdict>`.
 */
export function alertSignature(id: string, verdict: CheckVerdict): string {
  return `health:${id}:${verdict}`;
}
