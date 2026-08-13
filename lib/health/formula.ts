/**
 * lib/health/formula.ts — the customizable health formula engine.
 *
 * Pure functions, no I/O, no clock. Everything the scorer needs is an argument,
 * which is what makes the whole thing testable without a database.
 *
 * The contract, in one line:
 *
 *   score = SUM(normalize(component) * weight) / SUM(weight)   over REPORTED components
 *
 * Two rules do the real work:
 *
 *   1. A component that was not reported is EXCLUDED and its weight is
 *      redistributed. It is never treated as 0. A check with no latency signal
 *      must not be punished for having no latency signal.
 *   2. A component weighted 0 is excluded too. That is how an operator says
 *      "latency is meaningless here" without editing code.
 */
// Deliberately NOT "server-only": this module is pure math with no I/O and no
// secrets, and keeping it importable is what makes the scoring contract
// unit-testable. Same convention as lib/notify/telegram-format.ts.
import {
  type ComponentKey,
  type HealthStatus,
  type HealthThresholds,
  type HealthWeights,
  type Observation,
  type ScoreBreakdown,
  type ScoreResult,
} from "./types";

/** Clamp to [0,1]. Guards against a bad observer poisoning the score. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Latency: full marks at or under budget, linear decay to 0 at 3x budget.
 * Chosen over a step function so a check degrades visibly before it breaches.
 */
export function normalizeLatency(p95Ms: number, budgetMs: number): number {
  if (!Number.isFinite(p95Ms) || p95Ms < 0) return 0;
  if (budgetMs <= 0) return 1; // no budget configured => latency cannot fail
  if (p95Ms <= budgetMs) return 1;
  const ceiling = budgetMs * 3;
  if (p95Ms >= ceiling) return 0;
  return clamp01(1 - (p95Ms - budgetMs) / (ceiling - budgetMs));
}

/** Error rate: 0 errors = 1.0, linear decay to 0 at the configured ceiling. */
export function normalizeErrorRate(errorRate: number, ceiling: number): number {
  const r = clamp01(errorRate);
  if (ceiling <= 0) return r === 0 ? 1 : 0;
  if (r >= ceiling) return 0;
  return clamp01(1 - r / ceiling);
}

/**
 * Outcome: did the feature actually produce anything, judged against its own
 * trailing median rather than a hand-tuned constant.
 *
 * The `min_absolute` escape hatch exists because median-relative rules are
 * noise at low volume: with a median of 2, one quiet hour reads as a 50%
 * collapse. When min_absolute is set and met, the check passes outright.
 *
 * With no median yet (a new check), we cannot judge a drop, so we report full
 * marks rather than invent an outage. A brand-new check must not page.
 */
export function normalizeOutcome(
  value: number,
  median: number | undefined,
  thresholds: Pick<HealthThresholds, "outcome_floor_pct" | "min_absolute">,
): number {
  const v = Number.isFinite(value) ? Math.max(0, value) : 0;

  if (thresholds.min_absolute != null && v >= thresholds.min_absolute) return 1;

  if (median == null || !Number.isFinite(median) || median <= 0) {
    // No baseline to compare against. Absence of evidence is not evidence of
    // an outage; a check with no history reports healthy on this component.
    return 1;
  }

  const floorPct = thresholds.outcome_floor_pct > 0 ? thresholds.outcome_floor_pct : 0.25;
  const ratio = v / median;
  if (ratio >= 1) return 1;
  if (ratio <= floorPct) return 0;
  // Between the floor and the median, decay linearly so the dashboard shows
  // the slide before the breach.
  return clamp01((ratio - floorPct) / (1 - floorPct));
}

/**
 * Score an observation against a check's weights and thresholds.
 *
 * An observer-level `error` yields status 'unknown', NOT 'down'. Conflating
 * "the monitor could not look" with "the feature is broken" is how a monitor
 * outage turns into a false page storm about healthy features.
 */
export function scoreObservation(
  obs: Observation,
  weights: HealthWeights,
  thresholds: HealthThresholds,
  bands: { healthyAt: number; degradedAt: number },
): ScoreResult {
  const breakdown: ScoreBreakdown = { components: {}, excluded: [], weightSum: 0 };

  if (obs.error) {
    return {
      score: 0,
      status: "unknown",
      breakdown: { ...breakdown, excluded: ["uptime", "error_rate", "latency", "outcome"] },
    };
  }

  const raws: Record<ComponentKey, number | null> = {
    uptime: obs.uptime ?? null,
    error_rate: obs.errorRate ?? null,
    latency: obs.latencyP95Ms ?? null,
    outcome: obs.outcomeValue ?? null,
  };

  const normalizers: Record<ComponentKey, (v: number) => number> = {
    uptime: (v) => clamp01(v),
    error_rate: (v) => normalizeErrorRate(v, thresholds.error_rate_ceiling),
    latency: (v) => normalizeLatency(v, thresholds.latency_budget_ms),
    outcome: (v) => normalizeOutcome(v, obs.outcomeMedian, thresholds),
  };

  const keys: ComponentKey[] = ["uptime", "error_rate", "latency", "outcome"];
  let weighted = 0;
  let totalWeight = 0;

  for (const key of keys) {
    const weight = Number(weights[key] ?? 0);
    const raw = raws[key];
    // Excluded when unreported OR explicitly zero-weighted.
    if (raw == null || !Number.isFinite(weight) || weight <= 0) {
      breakdown.excluded.push(key);
      continue;
    }
    const normalized = clamp01(normalizers[key](raw));
    weighted += normalized * weight;
    totalWeight += weight;
    breakdown.components[key] = { raw, normalized, weight, effectiveWeight: 0 };
  }

  breakdown.weightSum = totalWeight;

  if (totalWeight <= 0) {
    // Nothing reported anything scoreable. Not healthy, not down — unknown.
    return { score: 0, status: "unknown", breakdown };
  }

  // Renormalize so the score is comparable across checks that report different
  // component sets. Without this, a check that only reports outcome would cap
  // at 0.4 and look permanently broken.
  for (const key of keys) {
    const c = breakdown.components[key];
    if (c) c.effectiveWeight = c.weight / totalWeight;
  }

  const score = clamp01(weighted / totalWeight);
  let status: HealthStatus =
    score >= bands.healthyAt ? "healthy" : score >= bands.degradedAt ? "degraded" : "down";

  // Dominant-component override. A weighted average lets cheap liveness signals
  // outvote the expensive one: up + fast + error-free + producing nothing
  // averages to 0.6 and reports 'degraded', which nobody pages on. If the
  // component carrying most of the weight has gone to zero, the feature is
  // down, and the average is hiding it.
  if (thresholds.dominant_zero_is_down !== false) {
    const minWeight = thresholds.dominant_weight_min ?? 0.4;
    for (const key of keys) {
      const c = breakdown.components[key];
      if (c && c.normalized === 0 && c.effectiveWeight >= minWeight) {
        status = "down";
        breakdown.dominantFailure = key;
        break;
      }
    }
  }

  return { score, status, breakdown };
}

/**
 * Trailing median. Used for the outcome baseline so no threshold is
 * hand-tuned and the check adapts as volume grows.
 */
export function median(values: number[]): number | undefined {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return undefined;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}
