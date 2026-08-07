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
 * Should this condition alert right now, given when it last alerted?
 *
 * Escalating ladder keyed on the CONDITION, not the rendered message, so a
 * reworded alert does not reset the clock. Ten checks failing at once must not
 * produce ten messages a minute; a muted channel is the same outcome as no
 * monitoring at all.
 */
export function shouldAlert(args: {
  verdict: CheckVerdict;
  lastAlertedAtMs: number | null;
  firstFailedAtMs: number | null;
  nowMs: number;
}): boolean {
  if (args.verdict === "ok") return false;
  if (args.lastAlertedAtMs === null) return true; // first time, always

  const sinceAlert = args.nowMs - args.lastAlertedAtMs;
  const failingFor = args.firstFailedAtMs === null ? 0 : args.nowMs - args.firstFailedAtMs;
  const HOUR = 3_600_000;

  // Escalating backoff: hourly for the first 6 hours, then every 6 hours for
  // the rest of the first day, then daily. Keyed on how long the CONDITION has
  // been failing, so a long-running outage stops shouting while a fresh one
  // still gets attention.
  const interval =
    failingFor < 6 * HOUR ? HOUR
    : failingFor < 24 * HOUR ? 6 * HOUR
    : 24 * HOUR;
  return sinceAlert >= interval;
}
